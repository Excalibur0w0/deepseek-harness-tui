/**
 * @dsh-tui/chat — the conversation controller. It creates one Agent through
 * the core registry, routes terminal input to the Agent or to slash commands,
 * waits for each run to settle as the headless runner does, and saves the
 * Session on exit. It provides `ctx.tuiChat` and emits `tui/queued` (text)
 * when a message is queued behind a running turn.
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { errorMessage } from '@dsh-tui/render'

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
  ctx.on('tui/submit', line => chat.onSubmit(line))
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
    this.cwd = process.cwd()
    this.running = false
    this.closing = false
    this.lastInterrupt = 0
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
    const { agent } = await this.ctx.get('agents').create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: this.cwd },
      agentOptions: { ...selection },
      setup: agentCtx => { installModelSelection(agentCtx) },
    })
    await agent.whenIdle()
    return agent
  }

  /** @returns {{ provider: string, model: string, reasoningEffort?: string }} the current Agent's model selection. */
  currentModel() {
    return this.agent.model.current() ?? this.agent.options
  }

  /**
   * Select the model for the current Session's next request.
   * @param {{ provider: string, model: string }} target - provider/model pair.
   */
  selectModel(target) {
    this.agent.model.select(target)
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

  onSubmit(line) {
    const text = line.trim()
    if (this.running) {
      if (text === '') return
      this.agent.followup(this.userMessage(text))
      this.ctx.emit('tui/queued', text)
      return
    }
    if (text === '') return
    if (text.startsWith('/')) {
      void this.command(text)
      return
    }
    void this.send(text)
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

  userMessage(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  async send(text) {
    const agent = this.agent
    this.running = true
    this.terminal.setBusy(true)
    try {
      agent.followup(this.userMessage(text))
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
