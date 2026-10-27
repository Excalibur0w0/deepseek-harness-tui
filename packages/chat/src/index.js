/**
 * @dsh-sdk/chat — the conversation controller. It creates one Agent through
 * the core registry, routes terminal input to the Agent or to slash commands,
 * waits for each run to settle as the headless runner does, and saves the
 * Session on exit. Prompts with pasted images are admitted through
 * `ctx.attachments` first, as dsh's Web session controller does. It provides
 * `ctx.tuiChat` and emits `tui/queued` (text, image count) when a message is
 * queued behind a running turn.
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { errorMessage } from '@dsh-sdk/render'

/** Stable Cordis plugin name. */
export const name = 'tui-chat'

/** Core services required before the first Agent can be created, and the terminal. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'tuiConsole']

/** Two Ctrl-C presses within this window exit while idle. */
const DOUBLE_INTERRUPT_MS = 1500

/**
 * Mount the conversation controller.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying core services and the launcher's exit request.
 */
export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-chat: the launcher must provide ctx.appExit before the tree mounts')
  }
  const chat = new TuiChat(ctx, exit)
  ctx.effect(() => () => { chat.closing = true }, 'tui chat')
  ctx.on('tui/submit', (line, parts) => chat.onSubmit(line, parts))
  ctx.on('tui/interrupt', key => chat.onInterrupt(key))
  ctx.on('tui/close', () => { void chat.quit(0) })
  ctx.provide('tuiChat', chat)
  void chat.start().catch(error => chat.fatal(error))
}

class TuiChat {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {(code: number) => void} exit - launcher exit request.
   */
  constructor(ctx, exit) {
    this.ctx = ctx
    this.exit = exit
    this.terminal = ctx.get('tuiConsole')
    /** The Agent the prompt talks to; replaced by `newSession()`. */
    this.agent = undefined
    /** The current Agent's model selection on dsh releases without `agent.model`. */
    this.selectionRef = undefined
    this.cwd = process.cwd()
    this.running = false
    this.closing = false
    this.lastInterrupt = 0
    /** Orders message admission so queued prompts keep their submission order. */
    this.admissions = Promise.resolve()
  }

  async start() {
    // Loader siblings mount concurrently; create the Agent only after the
    // whole application is composed, as the headless runner does.
    await this.ctx.get('loader')?.await()
    if (this.ctx.get('agents') === undefined || this.ctx.get('sessions') === undefined) return
    const fs = this.ctx.get('fs')
    if (fs !== undefined) this.cwd = fs.processPath(await fs.resolve('.'))
    this.agent = await this.createAgent()
    await this.terminal.open()
    this.showModel()
    this.terminal.setMeta({ cwd: this.cwd })
    this.prompt()
  }

  async createAgent() {
    const selection = this.ctx.get('agentDefaultModel').currentSelection()
    // dsh 0.2.1-rc.3 routes requests through a selection ref owned by the
    // caller; later releases ignore the ref and expose agent.model instead.
    const selectionRef = { current: { ...selection }, assembled: undefined }
    const { agent } = await this.ctx.get('agents').create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: this.cwd },
      agentOptions: { ...selection },
      setup: agentCtx => { installModelSelection(agentCtx, selectionRef) },
    })
    await agent.whenIdle()
    this.selectionRef = selectionRef
    return agent
  }

  /** @returns {{ provider: string, model: string, reasoningEffort?: string }} the current Agent's model selection. */
  currentModel() {
    if (this.agent.model === undefined) return this.selectionRef.current ?? this.agent.options
    return this.agent.model.current() ?? this.agent.options
  }

  /**
   * Select the model for the current Session's next request.
   * @param {{ provider: string, model: string }} target - provider/model pair.
   */
  selectModel(target) {
    if (this.agent.model === undefined) this.selectionRef.current = { ...target }
    else this.agent.model.select(target)
    this.showModel()
  }

  /**
   * Save the current Session and continue in a fresh one with an empty transcript.
   * @returns {Promise<import('@deepseek-ai/dsh-agent').Agent>} the new Agent.
   */
  async newSession() {
    await this.ctx.get('sessions').flush(this.agent.session)
    this.agent = await this.createAgent()
    this.terminal.clearTranscript()
    this.showModel()
    return this.agent
  }

  showModel() {
    const { provider, model, reasoningEffort } = this.currentModel()
    this.terminal.setMeta({ model, provider, effort: reasoningEffort })
  }

  prompt() {
    if (!this.closing) this.terminal.prompt()
  }

  // ── input ───────────────────────────────────────────────────────────────

  /**
   * @param {string} line - the prompt text, image placeholders included.
   * @param {Array<{ type: 'text', text: string } | { type: 'image', mediaType: string, data: string, name?: string }>} [parts] - ordered text and encoded images.
   */
  onSubmit(line, parts = [{ type: 'text', text: line.trim() }]) {
    const text = line.trim()
    const images = parts.filter(part => part.type === 'image').length
    if (text === '' && images === 0) return
    if (!this.running && images === 0 && text.startsWith('/')) {
      void this.slash(text, parts)
      return
    }
    this.submit(parts, images)
  }

  /**
   * Queue one message; admissions keep submission order while images are stored.
   * @param {Array<object>} parts - ordered text and encoded images.
   * @param {number} images - how many of `parts` are images.
   */
  submit(parts, images) {
    const admitted = this.admissions.then(() => this.buildMessage(parts, images))
    this.admissions = admitted.catch(() => undefined)
    void admitted.then(
      message => this.deliver(message, parts, images),
      error => { this.terminal.note(`未发送：${errorMessage(error)}`, 'error') },
    )
  }

  /**
   * A `/name` line runs a TUI command. When no command has that name but a
   * user-invocable skill does, the line goes to the Agent as a message and dsh
   * injects the skill — the only entry to `disable-model-invocation` skills.
   * @param {string} text - the trimmed line, starting with `/`.
   * @param {Array<object>} parts - the line's parts, for sending it as a message.
   */
  async slash(text, parts) {
    const name = text.slice(1).split(/\s+/, 1)[0]
    const commands = this.ctx.get('tuiCommands')?.list() ?? []
    const isCommand = commands.some(command => command.name === name || command.aliases?.includes(name))
    if (!isCommand && await this.userSkill(name)) this.submit(parts, 0)
    else await this.command(text)
  }

  /**
   * @param {string} name - a skill name typed after `/`.
   * @returns {Promise<boolean>} whether the current Agent's workspace has a user-invocable skill by that name.
   */
  async userSkill(name) {
    const skills = this.ctx.get('skills')
    if (skills === undefined || name === '') return false
    try {
      const skill = await skills.get(name, { cwd: this.cwd, scope: this.agent })
      return skill?.invocation?.userInvocable === true
    } catch {
      // Invalid names and unavailable sources are not skills; the line stays a command.
      return false
    }
  }

  /**
   * Send the message, or queue it behind the running turn.
   * @param {import('@deepseek-ai/dsh-llm').UserMessage} message - the admitted message.
   * @param {Array<{ type: string, text?: string }>} parts - the prompt parts, for the queued display.
   * @param {number} images - how many images the message carries.
   */
  async deliver(message, parts, images) {
    if (this.closing) return
    if (this.running) {
      this.agent.followup(message)
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n\n')
      this.ctx.emit('tui/queued', text, images)
      return
    }
    await this.send(message)
  }

  /**
   * Build the user message; images are stored through `ctx.attachments` and
   * refused for a model that declares no image input.
   * @returns {Promise<import('@deepseek-ai/dsh-llm').UserMessage>} the message.
   */
  async buildMessage(parts, images) {
    if (images === 0) return createUserMessage({ content: parts, source: { kind: 'user' } })
    const { provider, model } = this.currentModel()
    const info = await this.ctx.get('llm')?.resolveModelInfo(provider, model)
    if (info?.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new Error(`模型 ${model} 不支持图片输入`)
    }
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new Error('附件服务不可用')
    const content = await attachments.admitPromptContent(parts)
    return createUserMessage({ content, source: { kind: 'user' } })
  }

  /**
   * @param {'ctrl-c' | 'escape'} key - which key interrupted.
   */
  onInterrupt(key) {
    if (this.running) {
      this.terminal.flashStatus('正在中断…', 'warning')
      this.agent.cancel({ kind: 'user' })
      return
    }
    if (key === 'escape') return
    if (this.terminal.hasInput()) {
      this.terminal.clearInput()
      return
    }
    const now = Date.now()
    if (now - this.lastInterrupt < DOUBLE_INTERRUPT_MS) {
      void this.quit(0)
      return
    }
    this.lastInterrupt = now
    this.terminal.flashStatus('再按一次 Ctrl-C 退出', 'warning')
  }

  async command(text) {
    const commands = this.ctx.get('tuiCommands')
    if (commands === undefined) this.terminal.note('命令不可用：tui-commands 未加载', 'warning')
    else await commands.execute(text)
    this.prompt()
  }

  /**
   * @param {import('@deepseek-ai/dsh-llm').UserMessage} message - the message to send.
   */
  async send(message) {
    const agent = this.agent
    this.running = true
    this.terminal.setBusy(true)
    try {
      agent.followup(message)
      await this.waitForQuiescence(agent)
      await this.ctx.get('sessions').flush(agent.session)
    } catch (error) {
      this.terminal.note(`错误：${errorMessage(error)}`, 'error')
    } finally {
      this.running = false
      this.terminal.setBusy(false)
      this.prompt()
    }
  }

  /** Wait until the Agent and its managed children are idle, as the headless runner does. */
  async waitForQuiescence(agent) {
    const subagents = this.ctx.get('subagents')
    while (true) {
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      // Child settlement can wake the parent before the child wait observes it.
      if (!await subagents?.waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === idleSeq) return
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Cancel any running turn, save the Session, restore the terminal, and exit.
   * @param {number} code - process exit code; becomes 1 when saving fails.
   */
  async quit(code) {
    if (this.closing) return
    this.closing = true
    this.terminal.cancelPending()
    const agent = this.agent
    let saved = false
    try {
      if (agent !== undefined) {
        if (this.running) agent.cancel({ kind: 'user' })
        await agent.whenIdle()
        await this.ctx.get('sessions')?.flush(agent.session)
        saved = true
      }
    } catch (error) {
      await this.terminal.close()
      process.stderr.write(`dsh: failed to save the session: ${errorMessage(error)}\n`)
      code = 1
    }
    await this.terminal.close()
    if (saved) process.stdout.write(`会话已保存：${agent.id}\n`)
    this.exit(code)
  }

  async fatal(error) {
    this.closing = true
    await this.terminal.close()
    process.stderr.write(`dsh: ${errorMessage(error)}\n`)
    this.exit(1)
  }
}
