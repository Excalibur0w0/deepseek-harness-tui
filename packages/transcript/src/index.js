/**
 * @dsh-sdk/transcript — renders the current Agent's run in the transcript,
 * following opencode's session view: user messages as left-barred panels,
 * reasoning as a collapsible 已思考 line, replies as streamed markdown,
 * tool calls as one-line rows or panels (shell output, diffs, todos), and a
 * `▣ model · duration` footer per turn. Text and reasoning come from the
 * in-process `agent/assistant-stream` feed; everything else comes from the
 * durable Session log (`session/event`).
 */

import { errorMessage, filetypeOf, formatDuration, oneLine, previewLines, resultText, toolView, unifiedDiff } from '@dsh-sdk/render'
import { BoxRenderable, DiffRenderable, MarkdownRenderable, Spinner, discard, spans, splitBlock, text } from '@dsh-sdk/ui'

/** Stable Cordis plugin name. */
export const name = 'tui-transcript'

/** The terminal to draw on and the controller that owns the current Agent. */
export const inject = ['tuiConsole', 'tuiChat']

/** Output lines shown in a shell block. */
const SHELL_PREVIEW_LINES = 10
/** Error lines shown under a failed tool row. */
const ERROR_PREVIEW_LINES = 3

/**
 * Render the current Agent's output.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the TUI services.
 */
export function apply(ctx) {
  const view = new Transcript(ctx.get('tuiConsole'), ctx.get('tuiChat'))
  ctx.effect(() => () => view.dispose(), 'tui transcript')
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (view.follows(agent)) view.onFrame(frame)
  })
  ctx.on('session/event', (session, event) => {
    if (view.follows(view.chat.agent) && session === view.chat.agent.session) view.onEvent(event)
  })
  ctx.on('agent/error', ({ agent, error }) => {
    if (view.follows(agent)) view.errorBlock(errorMessage(error))
  })
  ctx.on('tui/queued', (message, images) => { if (view.follows(view.chat.agent)) view.queued(message, images) })
  ctx.on('tui/approval', (callId, outcome) => view.approvalSettled(callId, outcome))
  ctx.on('tui/toggle-thinking', () => view.toggleThinking())
}

class Transcript {
  /**
   * @param {object} terminal - the TUI console.
   * @param {object} chat - the TUI conversation controller.
   */
  constructor(terminal, chat) {
    this.terminal = terminal
    this.chat = chat
    this.showThinking = false
    /** Tool calls whose approval the user refused, so their rows are struck through. */
    this.denied = new Set()
    this.reset(undefined)
  }

  /**
   * @param {unknown} agent - the Agent an event belongs to.
   * @returns {boolean} whether the event is for the current Agent while the screen is up.
   */
  follows(agent) {
    if (agent === undefined || agent !== this.chat.agent || !this.terminal.isOpen) return false
    if (this.agent !== agent) this.reset(agent)
    return true
  }

  /** Forget the previous Agent's parts; `/new` already cleared the screen. */
  reset(agent) {
    this.stopSpinners()
    this.agent = agent
    this.markdown = undefined
    this.reasoning = undefined
    this.reasonings = []
    this.tools = new Map()
    this.pending = []
    this.lastKind = undefined
    this.turnStart = undefined
    /** When the current stretch of model output began: the request start or the previous part's end. */
    this.boundary = undefined
  }

  dispose() {
    this.stopSpinners()
  }

  stopSpinners() {
    this.reasoning?.spinner.stop()
    for (const tool of this.tools?.values() ?? []) tool.spinner.stop()
  }

  get renderer() {
    return this.terminal.renderer
  }

  get palette() {
    return this.terminal.palette
  }

  /**
   * Append a part, separating it from the previous one by a blank line
   * unless both are one-line tool rows, as opencode does.
   * @param {(marginTop: number) => import('@opentui/core').Renderable} build - builds the part with its top margin.
   * @param {string} kind - `'inline'` for one-line tool rows.
   * @returns {import('@opentui/core').Renderable} the appended part.
   */
  add(build, kind) {
    const marginTop = kind === 'inline' && this.lastKind === 'inline' ? 0 : 1
    this.lastKind = kind
    return this.terminal.append(build(marginTop))
  }

  // ── assistant stream ────────────────────────────────────────────────────

  onFrame(frame) {
    if (frame.type === 'start') {
      this.boundary = Date.now()
      return
    }
    if (frame.type === 'end') {
      this.endText()
      this.endReasoning()
      return
    }
    const chunk = frame.chunk
    switch (chunk.type) {
      case 'text-delta':
        this.appendText(chunk.text)
        return
      case 'reasoning-delta':
        this.appendReasoning(chunk.text)
        return
      case 'block-end':
        if (chunk.block?.type === 'reasoning') this.endReasoning()
        else this.endText()
        return
      default:
        return
    }
  }

  appendText(delta) {
    if (delta === '') return
    this.endReasoning()
    if (this.markdown === undefined) {
      if (delta.trim() === '') return
      const markdown = { content: '', renderable: undefined }
      markdown.renderable = this.add(marginTop => new MarkdownRenderable(this.renderer, {
        content: '',
        syntaxStyle: this.terminal.syntax,
        fg: this.palette.markdownText,
        conceal: true,
        streaming: true,
        paddingLeft: 3,
        marginTop,
        flexShrink: 0,
      }), 'text')
      this.markdown = markdown
    }
    this.markdown.content += delta
    this.markdown.renderable.content = this.markdown.content.trimStart()
  }

  endText() {
    if (this.markdown === undefined) return
    this.markdown.renderable.content = this.markdown.content.trim()
    this.markdown.renderable.streaming = false
    this.markdown = undefined
    this.boundary = Date.now()
  }

  appendReasoning(delta) {
    if (delta === '') return
    this.endText()
    if (this.reasoning === undefined) {
      // Providers may deliver reasoning in one burst after thinking, so time it from the stretch's start.
      const part = { content: '', start: this.boundary ?? Date.now(), end: undefined, frame: '' }
      part.box = this.add(marginTop => new BoxRenderable(this.renderer, { flexDirection: 'column', paddingLeft: 3, marginTop, flexShrink: 0 }), 'reasoning')
      part.header = text(this.renderer, '', { wrapMode: 'none', truncate: true })
      part.body = new MarkdownRenderable(this.renderer, {
        content: '',
        syntaxStyle: this.terminal.subtleSyntax,
        fg: this.palette.textMuted,
        conceal: true,
        streaming: true,
        marginTop: 1,
        paddingLeft: 2,
        flexShrink: 0,
        visible: this.showThinking,
      })
      part.box.add(part.header)
      part.box.add(part.body)
      part.spinner = new Spinner(frame => {
        part.frame = frame
        this.renderReasoningHeader(part)
      })
      part.spinner.start()
      this.reasoning = part
      this.reasonings.push(part)
    }
    const part = this.reasoning
    part.content += delta
    const { title, body } = reasoningSummary(part.content)
    part.title = title
    part.body.content = body
    this.renderReasoningHeader(part)
  }

  endReasoning() {
    const part = this.reasoning
    if (part === undefined) return
    this.reasoning = undefined
    part.spinner.stop()
    part.end = Date.now()
    this.boundary = part.end
    part.body.streaming = false
    this.renderReasoningHeader(part)
  }

  renderReasoningHeader(part) {
    const color = this.palette.warning
    part.header.content = part.end === undefined
      ? spans({ text: `${part.frame} 思考中${part.title === undefined ? '' : `：${part.title}`}`, fg: color })
      : spans({
        text: `${this.showThinking ? '-' : '+'} 已思考${part.title === undefined ? '' : `：${part.title}`} · ${formatDuration(part.end - part.start)}`,
        fg: color,
      })
  }

  toggleThinking() {
    this.showThinking = !this.showThinking
    for (const part of this.reasonings) {
      part.body.visible = this.showThinking
      this.renderReasoningHeader(part)
    }
    this.terminal.flashStatus(this.showThinking ? '展开思考' : '折叠思考', 'textMuted')
  }

  // ── session log ─────────────────────────────────────────────────────────

  onEvent(event) {
    switch (event.type) {
      case 'user/message': {
        const message = event.data
        if (message.source?.kind !== 'user') return
        this.userMessage(messageText(message), messageImages(message))
        return
      }
      case 'turn/start':
        this.turnStart = Date.now()
        return
      case 'tool/call':
        this.toolCall(event.data)
        return
      case 'tool/result':
        // Compaction rewrites older results; only fresh appends are output.
        if (event.surfaceOp === 'append') this.toolResult(event.data)
        return
      case 'turn/end':
        this.turnEnd(event.data.reason)
        return
      default:
        return
    }
  }

  /**
   * @param {string} message - the user's text.
   * @param {Array<{ width?: number, height?: number }>} images - the message's images, shown as opencode's attachment badges.
   * @param {boolean} [queued] - whether it waits behind the running turn.
   * @returns {{ block: import('@opentui/core').Renderable, badge?: import('@opentui/core').TextRenderable }} the message block and its queued badge.
   */
  userBlock(message, images, queued = false) {
    const palette = this.palette
    let badge
    const block = this.add(marginTop => {
      const block = splitBlock(this.renderer, { borderColor: palette.secondary, marginTop })
      const inner = new BoxRenderable(this.renderer, {
        flexDirection: 'column',
        flexGrow: 1,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
        backgroundColor: palette.backgroundPanel,
      })
      if (message !== '') inner.add(text(this.renderer, message, { fg: palette.text }))
      if (images.length > 0) {
        inner.add(text(this.renderer, spans(...images.flatMap((image, index) => [
          index > 0 && ' ',
          { text: ' 图片 ', bg: palette.secondary, fg: palette.background },
          { text: ` ${image.width === undefined ? index + 1 : `${image.width}×${image.height}`} `, bg: palette.backgroundElement, fg: palette.textMuted },
        ])), { marginTop: message === '' ? 0 : 1 }))
      }
      if (queued) {
        badge = text(this.renderer, spans({ text: ' 排队中 ', bg: palette.secondary, fg: palette.background, bold: true }), { marginTop: 1 })
        inner.add(badge)
      }
      block.add(inner)
      return block
    }, 'user')
    return { block, badge }
  }

  userMessage(message, images) {
    this.endText()
    this.endReasoning()
    const index = this.pending.findIndex(item => item.message === message && item.images === images.length)
    if (index !== -1) discard(this.pending.splice(index, 1)[0].block)
    this.userBlock(message, images)
  }

  /**
   * @param {string} message - the queued text.
   * @param {number} [images] - how many images it carries; their sizes are known only once stored.
   */
  queued(message, images = 0) {
    this.pending.push({ message, images, ...this.userBlock(message, Array.from({ length: images }, () => ({})), true) })
  }

  toolCall({ callId, name, arguments: args }) {
    this.endText()
    this.endReasoning()
    const tool = { name, view: toolView(name, args, this.chat.cwd), start: Date.now(), frame: '' }
    tool.container = this.add(marginTop => new BoxRenderable(this.renderer, { flexDirection: 'column', marginTop, flexShrink: 0 }), 'inline')
    tool.row = text(this.renderer, '', { marginLeft: 3 })
    tool.container.add(tool.row)
    tool.spinner = new Spinner(frame => {
      tool.frame = frame
      this.renderToolRow(tool, 'running')
    })
    tool.spinner.start()
    this.tools.set(callId, tool)
  }

  /**
   * @param {object} tool - the tool part.
   * @param {'running' | 'done' | 'failed' | 'denied' | 'stopped'} state - what the row shows.
   */
  renderToolRow(tool, state) {
    const palette = this.palette
    const { icon, title } = tool.view
    const color = { running: palette.text, done: palette.textMuted, failed: palette.error, denied: palette.textMuted, stopped: palette.textMuted }[state]
    tool.row.content = spans(
      { text: `${state === 'running' ? tool.frame : icon} `, fg: state === 'failed' ? palette.error : color },
      { text: title, fg: color, strikethrough: state === 'denied' },
    )
  }

  toolResult({ message, error, meta }) {
    const callId = message.toolCallId
    const tool = this.tools.get(callId)
    if (tool === undefined) return
    this.tools.delete(callId)
    tool.spinner.stop()
    const output = resultText(message)
    const failed = message.isError === true || error !== undefined
    if (this.denied.delete(callId)) {
      this.renderToolRow(tool, 'denied')
      return
    }
    if (tool.view.kind === 'shell') {
      this.shellBlock(tool, output, failed)
      return
    }
    if (tool.view.kind === 'edit' && !failed) {
      const diff = unifiedDiff(meta)
      if (diff !== undefined) {
        this.diffBlock(tool, diff)
        return
      }
    }
    if (tool.view.kind === 'todos' && !failed && tool.view.todos.length > 0) {
      this.todoBlock(tool)
      return
    }
    this.renderToolRow(tool, failed ? 'failed' : 'done')
    if (failed) {
      const reason = output || error?.reason || error?.code || ''
      for (const line of previewLines(reason, ERROR_PREVIEW_LINES)) {
        tool.container.add(text(this.renderer, line, { fg: this.palette.error, marginLeft: 5 }))
      }
    }
  }

  /**
   * Replace a tool's row with opencode's block-tool panel.
   * @param {object} tool - the tool part.
   * @returns {BoxRenderable} the panel to fill.
   */
  blockFor(tool) {
    const palette = this.palette
    discard(tool.row)
    tool.container.marginTop = 1
    this.lastKind = 'block'
    const block = splitBlock(this.renderer, {
      flexDirection: 'column',
      borderColor: palette.background,
      backgroundColor: palette.backgroundPanel,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      gap: 1,
    })
    tool.container.add(block)
    return block
  }

  shellBlock(tool, output, failed) {
    const palette = this.palette
    const block = this.blockFor(tool)
    block.add(text(this.renderer, spans({ text: `$ ${tool.view.title}`, fg: palette.text })))
    if (output.trim() !== '') {
      const lines = previewLines(output, SHELL_PREVIEW_LINES)
      block.add(text(this.renderer, lines.join('\n'), { fg: failed ? palette.error : palette.text }))
    }
  }

  diffBlock(tool, { path, diff }) {
    const palette = this.palette
    const block = this.blockFor(tool)
    block.add(text(this.renderer, `${tool.view.icon} ${tool.view.title}`, { fg: palette.textMuted }))
    block.add(new DiffRenderable(this.renderer, {
      diff,
      view: 'unified',
      filetype: filetypeOf(path),
      syntaxStyle: this.terminal.syntax,
      showLineNumbers: false,
      wrapMode: 'word',
      width: '100%',
      fg: palette.text,
      addedBg: palette.diffAddedBg,
      removedBg: palette.diffRemovedBg,
      contextBg: palette.diffContextBg,
      addedSignColor: palette.diffHighlightAdded,
      removedSignColor: palette.diffHighlightRemoved,
      lineNumberFg: palette.diffLineNumber,
      lineNumberBg: palette.diffContextBg,
      addedLineNumberBg: palette.diffAddedLineNumberBg,
      removedLineNumberBg: palette.diffRemovedLineNumberBg,
      flexShrink: 0,
    }))
  }

  todoBlock(tool) {
    const palette = this.palette
    const block = this.blockFor(tool)
    block.add(text(this.renderer, '# 待办', { fg: palette.textMuted }))
    const items = new BoxRenderable(this.renderer, { flexDirection: 'column', flexShrink: 0 })
    for (const todo of tool.view.todos) {
      const mark = { completed: '[✓]', in_progress: '[•]' }[todo.status] ?? '[ ]'
      const color = { completed: palette.textMuted, in_progress: palette.warning }[todo.status] ?? palette.text
      items.add(text(this.renderer, spans({ text: `${mark} ${todo.content}`, fg: color, strikethrough: todo.status === 'completed' })))
    }
    block.add(items)
  }

  approvalSettled(callId, outcome) {
    if (outcome !== 'allowed-once') this.denied.add(callId)
  }

  turnEnd(reason) {
    this.endText()
    this.endReasoning()
    for (const tool of this.tools.values()) {
      tool.spinner.stop()
      this.renderToolRow(tool, 'stopped')
    }
    this.tools.clear()
    const kind = reason?.kind
    // Cancelling a turn also clears the Agent's queued followups.
    if (kind === 'aborted') {
      for (const item of this.pending.splice(0)) {
        item.badge.content = spans({ text: ' 已取消，未发送 ', bg: this.palette.backgroundElement, fg: this.palette.textMuted })
      }
    }
    if (kind === 'error') this.errorBlock(`${reason.error?.code ?? 'error'}: ${reason.error?.message ?? ''}`)
    const palette = this.palette
    const duration = this.turnStart === undefined ? undefined : formatDuration(Date.now() - this.turnStart)
    this.turnStart = undefined
    const model = this.chat.currentModel().model
    this.add(marginTop => text(this.renderer, spans(
      { text: '▣ ', fg: kind === 'aborted' ? palette.textMuted : palette.secondary },
      { text: model, fg: palette.text },
      duration !== undefined && { text: ` · ${duration}`, fg: palette.textMuted },
      kind === 'aborted' && { text: ' · 已中断', fg: palette.textMuted },
      kind === 'max-tokens' && { text: ' · 回复达到输出上限被截断', fg: palette.warning },
      kind !== undefined && !['completed', 'aborted', 'error', 'max-tokens'].includes(kind) && { text: ` · ${kind}`, fg: palette.textMuted },
    ), { marginLeft: 3, marginTop }), 'footer')
  }

  /**
   * @param {string} message - the failure to show.
   */
  errorBlock(message) {
    const palette = this.palette
    this.add(marginTop => {
      const block = splitBlock(this.renderer, {
        borderColor: palette.error,
        backgroundColor: palette.backgroundPanel,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2,
        marginTop,
      })
      block.add(text(this.renderer, oneLine(message, 2000), { fg: palette.textMuted }))
      return block
    }, 'error')
  }
}

/**
 * @param {{ content?: ReadonlyArray<{ type: string, text?: string }> }} message - a user message.
 * @returns {string} its text blocks joined.
 */
function messageText(message) {
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n')
}

/**
 * @param {{ content?: ReadonlyArray<{ type: string, attachment?: { width: number, height: number } }> }} message - a user message.
 * @returns {Array<{ width: number, height: number }>} its stored images' dimensions, in order.
 */
function messageImages(message) {
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks.filter(block => block.type === 'image' && block.attachment !== undefined)
    .map(block => ({ width: block.attachment.width, height: block.attachment.height }))
}

/**
 * Split reasoning into opencode's header title and body: a leading
 * `**Title**` or `# Title` line becomes the title.
 * @param {string} content - reasoning text so far.
 * @returns {{ title: string | undefined, body: string }} the title and the remaining markdown.
 */
function reasoningSummary(content) {
  const trimmed = content.replace('[REDACTED]', '').trim()
  const match = /^(?:\*\*(.+?)\*\*|#{1,6}\s+(.+))\s*(?:\n|$)/.exec(trimmed)
  if (match === null) return { title: undefined, body: trimmed }
  return { title: oneLine(match[1] ?? match[2], 80), body: trimmed.slice(match[0].length).trim() }
}
