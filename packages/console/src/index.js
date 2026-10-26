/**
 * @dsh-tui/console — owns the terminal for the TUI as a full-screen OpenTUI
 * app laid out like opencode's session view: a scrolling transcript, the
 * prompt box with its model line, and a status row. It provides
 * `ctx.tuiConsole` and reports input as Cordis events: `tui/submit` (the
 * prompt text and its ordered text and image parts), `tui/interrupt`
 * (`'ctrl-c'` or `'escape'`), `tui/close` (Ctrl-D on an empty prompt), and
 * `tui/toggle-thinking` (Ctrl-T). Ctrl+V and dropped image files attach
 * images as `[图片 N]` placeholders, as opencode does. While a panel is open,
 * every key goes to the panel instead.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { currentPalette, errorMessage, imageMediaType, pastedPath } from '@dsh-tui/render'
import {
  BoxRenderable,
  EMPTY_BORDER,
  SPLIT_BORDER,
  ScrollBoxRenderable,
  Spinner,
  TextareaRenderable,
  createCliRenderer,
  createSyntaxStyles,
  decodePasteBytes,
  discard,
  keyHints,
  spans,
  text,
} from '@dsh-tui/ui'
import { readClipboardImage, readClipboardText } from './clipboard.js'

/** Stable Cordis plugin name. */
export const name = 'tui-console'

const USAGE = `Usage: dsh --profile tui

Interactive terminal chat over DeepSeek Harness. The working directory is the
directory you launch from; sessions are saved under $DSH_HOME/sessions.
`

/** Prompt history entries kept for ↑/↓ recall. */
const HISTORY_LIMIT = 500
/** Visible slash-command completions. */
const COMPLETION_LIMIT = 8
/** How long a status flash such as 已复制 stays visible. */
const FLASH_MS = 1500

/**
 * Mount the terminal. Without an interactive terminal it provides no service,
 * so the plugins that inject `tuiConsole` never mount.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the launcher's exit request.
 */
export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-console: the launcher must provide ctx.appExit before the tree mounts')
  }
  const args = ctx.get('cmdlineArgs')?.get() ?? []
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE)
    exit(0)
    return
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write('dsh: the tui profile needs an interactive terminal; use --profile headless for scripts\n')
    exit(1)
    return
  }
  const terminal = new TuiConsole(ctx)
  // Registered before the service so dependents unload before the renderer closes.
  ctx.effect(() => () => { void terminal.close() }, 'tui terminal')
  ctx.provide('tuiConsole', terminal)
}

class TuiConsole {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context that emits the input events.
   */
  constructor(ctx) {
    this.ctx = ctx
    /** Theme colors by opencode token. */
    this.palette = currentPalette()
    this.renderer = undefined
    this.closing = false
    /** Serializes tasks that ask the user. */
    this.chain = Promise.resolve()
    /** The open panel: its root renderable, key handler, and cancel callback. */
    this.panel = undefined
    this.completionProvider = undefined
    this.completions = []
    this.completionIndex = 0
    /** Pasted images by placeholder extmark id, until the prompt is submitted or cleared. */
    this.images = new Map()
    this.imageCount = 0
    this.history = []
    /** Position while recalling history; `history.length` means the draft. */
    this.historyIndex = 0
    this.draft = ''
    this.meta = { cwd: '', model: '', provider: '', effort: undefined }
    this.busy = false
    this.flash = undefined
    /** stderr output captured while the renderer owns the screen. */
    this.diagnostics = []
    this.restoreStderr = undefined
    this.spinnerFrame = ''
    this.spinner = new Spinner(frame => {
      this.spinnerFrame = frame
      this.renderStatus()
    })
  }

  /** Whether the screen is up and not shutting down. */
  get isOpen() {
    return this.renderer !== undefined && !this.closing
  }

  /** Take over the terminal; later calls do nothing. */
  async open() {
    if (this.renderer !== undefined || this.closing) return
    this.captureStderr()
    try {
      this.renderer = await createCliRenderer({
        screenMode: 'alternate-screen',
        exitOnCtrlC: false,
        exitSignals: [],
        useMouse: true,
        autoFocus: false,
        openConsoleOnError: false,
        useKittyKeyboard: {},
        targetFps: 60,
        backgroundColor: this.palette.background,
      })
    } catch (error) {
      this.releaseStderr()
      throw error
    }
    Object.assign(this, createSyntaxStyles(this.renderer, this.palette))
    this.buildLayout()
    this.renderer.keyInput.on('keypress', key => this.onKey(key))
    this.renderer.keyInput.on('paste', event => this.onPanelPaste(event))
    this.input.focus()
  }

  /**
   * Withdraw the open panel, restore the terminal, and replay captured stderr.
   * Later calls wait for the first.
   * @returns {Promise<void>} settles once the terminal is restored.
   */
  close() {
    this.closed ??= this.shutdown()
    return this.closed
  }

  async shutdown() {
    this.closing = true
    this.cancelPending()
    this.spinner.stop()
    clearTimeout(this.flash?.timer)
    const renderer = this.renderer
    if (renderer !== undefined) {
      renderer.destroy()
      await renderer.closed
    }
    this.releaseStderr()
  }

  buildLayout() {
    const renderer = this.renderer
    const palette = this.palette
    const root = new BoxRenderable(renderer, {
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      paddingLeft: 2,
      paddingRight: 2,
      paddingBottom: 1,
      gap: 1,
      backgroundColor: palette.background,
      // Selecting in the transcript copies on release; a panel, where keys are
      // pasted, copies only on Ctrl-C so a stray selection cannot replace the clipboard.
      onMouseUp: () => { if (this.panel === undefined) this.copySelection() },
    })
    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      minHeight: 0,
      stickyScroll: true,
      stickyStart: 'bottom',
      verticalScrollbarOptions: {
        paddingLeft: 1,
        trackOptions: { backgroundColor: palette.backgroundElement, foregroundColor: palette.border },
      },
    })
    root.add(this.scroll)

    const bottom = new BoxRenderable(renderer, { flexDirection: 'column', flexShrink: 0, width: '100%' })
    this.completionBox = new BoxRenderable(renderer, {
      flexDirection: 'column',
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.backgroundPanel,
      visible: false,
    })
    bottom.add(this.completionBox)

    // The prompt box: opencode's left bar, element background, and a
    // half-height bottom edge drawn with ╹ and ▀.
    this.promptBox = new BoxRenderable(renderer, {
      width: '100%',
      border: ['left'],
      borderColor: palette.secondary,
      customBorderChars: { ...SPLIT_BORDER, bottomLeft: '╹' },
      flexShrink: 0,
    })
    const inner = new BoxRenderable(renderer, {
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 0,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      backgroundColor: palette.backgroundElement,
    })
    this.input = new TextareaRenderable(renderer, {
      width: '100%',
      minHeight: 1,
      maxHeight: 8,
      backgroundColor: palette.backgroundElement,
      focusedBackgroundColor: palette.backgroundElement,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholder: '输入消息，/ 查看命令',
      placeholderColor: palette.textMuted,
      wrapMode: 'word',
      keyBindings: [
        { name: 'return', action: 'submit' },
        { name: 'return', shift: true, action: 'newline' },
        { name: 'return', meta: true, action: 'newline' },
        { name: 'j', ctrl: true, action: 'newline' },
      ],
      syntaxStyle: this.syntax,
      onSubmit: () => this.submit(),
      onContentChange: () => this.updateCompletions(),
      onPaste: event => this.onPaste(event),
    })
    this.imageType = this.input.extmarks.registerType('image')
    this.imageStyle = this.syntax.getStyleId('extmark.paste') ?? undefined
    inner.add(this.input)
    this.metaText = text(renderer, '', { marginTop: 1, wrapMode: 'none', truncate: true })
    inner.add(this.metaText)
    this.promptBox.add(inner)
    this.promptCap = new BoxRenderable(renderer, {
      height: 1,
      border: ['left'],
      borderColor: palette.secondary,
      customBorderChars: { ...EMPTY_BORDER, vertical: '╹' },
      flexShrink: 0,
    })
    this.promptCap.add(new BoxRenderable(renderer, {
      height: 1,
      flexGrow: 1,
      border: ['bottom'],
      borderColor: palette.backgroundElement,
      customBorderChars: { ...EMPTY_BORDER, horizontal: '▀' },
    }))
    bottom.add(this.promptBox)
    bottom.add(this.promptCap)

    this.panelSlot = new BoxRenderable(renderer, { flexDirection: 'column', flexShrink: 0, width: '100%', visible: false })
    bottom.add(this.panelSlot)

    const status = new BoxRenderable(renderer, { flexDirection: 'row', justifyContent: 'space-between', flexShrink: 0, gap: 2 })
    this.statusLeft = text(renderer, '', { wrapMode: 'none', truncate: true, flexShrink: 1 })
    this.statusRight = text(renderer, '', { wrapMode: 'none' })
    status.add(this.statusLeft)
    status.add(this.statusRight)
    bottom.add(status)
    root.add(bottom)
    renderer.root.add(root)
    this.renderMeta()
    this.renderStatus()
  }

  // ── transcript ──────────────────────────────────────────────────────────

  /**
   * Append a renderable to the end of the transcript.
   * @template {import('@opentui/core').Renderable} T
   * @param {T} renderable - the renderable.
   * @returns {T} the same renderable.
   */
  append(renderable) {
    this.scroll.add(renderable)
    return renderable
  }

  /** Remove every transcript entry, as when a new session starts. */
  clearTranscript() {
    for (const child of [...this.scroll.content.getChildren()]) discard(child)
  }

  /**
   * Append a short notice under the transcript, indented like assistant text.
   * @param {string | import('@opentui/core').StyledText} content - the notice.
   * @param {'muted' | 'text' | 'error' | 'warning' | 'success'} [tone] - text color; muted by default.
   */
  note(content, tone = 'muted') {
    const fg = { muted: this.palette.textMuted, text: this.palette.text, error: this.palette.error, warning: this.palette.warning, success: this.palette.success }[tone]
    this.append(text(this.renderer, content, { fg, marginLeft: 3, marginTop: 1 }))
  }

  // ── prompt ──────────────────────────────────────────────────────────────

  /**
   * Update the model line and working directory.
   * @param {{ cwd?: string, model?: string, provider?: string, effort?: string }} meta - fields to change.
   */
  setMeta(meta) {
    Object.assign(this.meta, meta)
    this.renderMeta()
    this.renderStatus()
  }

  /**
   * Show or hide the running indicator.
   * @param {boolean} busy - whether a turn is running.
   */
  setBusy(busy) {
    this.busy = busy
    if (busy) this.spinner.start()
    else this.spinner.stop()
    this.renderStatus()
  }

  /** Focus the prompt; kept for callers that re-prompt after a command. */
  prompt() {
    if (this.isOpen && this.panel === undefined) this.input.focus()
  }

  /** Whether the prompt holds unsubmitted text. */
  hasInput() {
    return this.input !== undefined && this.input.plainText !== ''
  }

  /** Clear the prompt and its pasted images. */
  clearInput() {
    this.input?.setText('')
    this.forgetImages()
    this.historyIndex = this.history.length
  }

  forgetImages() {
    this.input?.extmarks.clear()
    this.images.clear()
    this.imageCount = 0
  }

  /**
   * Supply slash-command completions.
   * @param {(prefix: string) => Array<{ name: string, description: string }>} provider - matches for the text after `/`.
   * @returns {() => void} disposer that removes this provider.
   */
  setCompletionProvider(provider) {
    this.completionProvider = provider
    return () => {
      if (this.completionProvider === provider) this.completionProvider = undefined
      this.hideCompletions()
    }
  }

  submit() {
    const value = this.input.plainText
    const parts = this.promptParts(value)
    // History recalls text only; pasted images are not kept after sending.
    const recalled = parts.filter(part => part.type === 'text').map(part => part.text).join(' ')
    if (recalled !== '' && this.history.at(-1) !== recalled) {
      this.history.push(recalled)
      if (this.history.length > HISTORY_LIMIT) this.history.shift()
    }
    this.historyIndex = this.history.length
    this.input.setText('')
    this.forgetImages()
    this.hideCompletions()
    this.ctx.emit('tui/submit', value, parts)
  }

  /**
   * Split the prompt at each image placeholder that is still intact.
   * Placeholders are found by their text: OpenTUI measures extmark offsets
   * in display columns, which differ from string indices for CJK text.
   * @param {string} value - the prompt text.
   * @returns {Array<{ type: 'text', text: string } | { type: 'image', mediaType: string, data: string, name?: string }>} trimmed text and encoded images in prompt order.
   */
  promptParts(value) {
    const found = this.input.extmarks.getAllForTypeId(this.imageType)
      .map(mark => this.images.get(mark.id))
      .filter(image => image !== undefined)
      .map(image => ({ image, index: value.indexOf(image.label) }))
      .filter(item => item.index !== -1)
      .sort((left, right) => left.index - right.index)
    const parts = []
    const pushText = segment => {
      const trimmed = segment.trim()
      if (trimmed !== '') parts.push({ type: 'text', text: trimmed })
    }
    let cursor = 0
    for (const { image, index } of found) {
      pushText(value.slice(cursor, index))
      parts.push({ type: 'image', mediaType: image.mediaType, data: image.data, ...image.name === undefined ? {} : { name: image.name } })
      cursor = index + image.label.length
    }
    pushText(value.slice(cursor))
    return parts
  }

  // ── paste ───────────────────────────────────────────────────────────────

  /**
   * Insert an image placeholder at the cursor and keep the image for submit.
   * @param {Buffer} data - encoded image bytes.
   * @param {string} mediaType - the image media type.
   * @param {string} [name] - display name, such as the dropped file's base name.
   */
  attachImage(data, mediaType, name) {
    this.imageCount += 1
    const label = `[图片 ${this.imageCount}]`
    const start = this.input.cursorOffset
    this.input.insertText(label)
    // Offsets are display columns, so measure the label through the cursor.
    const end = this.input.cursorOffset
    this.input.insertText(' ')
    const id = this.input.extmarks.create({ start, end, virtual: true, styleId: this.imageStyle, typeId: this.imageType })
    this.images.set(id, { label, mediaType, data: data.toString('base64'), ...name === undefined ? {} : { name } })
  }

  /**
   * Attach an image file when `text` names one, as when a file is dropped onto the terminal.
   * @param {string} text - pasted text.
   * @returns {Promise<boolean>} whether `text` named an image file that was attached.
   */
  async attachImageFile(text) {
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.includes('\n')) return false
    const path = pastedPath(trimmed)
    const mediaType = imageMediaType(path)
    if (mediaType === undefined || !existsSync(path)) return false
    try {
      this.attachImage(await readFile(path), mediaType, basename(path))
      return true
    } catch (error) {
      this.flashStatus(`读取图片失败：${errorMessage(error)}`, 'warning')
      return true
    }
  }

  /**
   * Bracketed paste: an empty paste may be an image-only clipboard, and a
   * single image path is attached; other text is inserted as usual.
   * @param {import('@opentui/core').PasteEvent} event - the paste event.
   */
  onPaste(event) {
    const pasted = decodePasteBytes(event.bytes)
    const trimmed = pasted.trim()
    if (trimmed === '') {
      event.preventDefault()
      void this.pasteClipboard()
      return
    }
    const path = pastedPath(trimmed)
    if (trimmed.includes('\n') || imageMediaType(path) === undefined || !existsSync(path)) return
    event.preventDefault()
    void this.attachImageFile(trimmed)
  }

  /** Ctrl+V: paste the clipboard image, or its text when it holds no image. */
  async pasteClipboard() {
    const image = await readClipboardImage()
    if (!this.isOpen || this.panel !== undefined) return
    if (image !== undefined) {
      this.attachImage(image, 'image/png', 'clipboard.png')
      return
    }
    const pasted = await readClipboardText()
    if (pasted === undefined || !this.isOpen || this.panel !== undefined) {
      if (pasted === undefined) this.flashStatus('剪贴板里没有图片或文字', 'textMuted')
      return
    }
    if (await this.attachImageFile(pasted)) return
    this.input.insertText(pasted.replace(/\r\n?/g, '\n'))
  }

  renderMeta() {
    if (this.metaText === undefined) return
    const palette = this.palette
    const { model, provider, effort } = this.meta
    this.metaText.content = spans(
      { text: model, fg: palette.text },
      provider !== '' && { text: ` ${provider}`, fg: palette.textMuted },
      effort !== undefined && { text: ' · ', fg: palette.textMuted },
      effort !== undefined && { text: effort, fg: palette.warning, bold: true },
    )
  }

  renderStatus() {
    if (this.statusLeft === undefined) return
    const palette = this.palette
    this.statusLeft.content = this.busy
      ? spans({ text: this.spinnerFrame, fg: palette.accent }, { text: ' 运行中', fg: palette.textMuted })
      : spans({ text: this.meta.cwd, fg: palette.textMuted })
    const right = []
    if (this.flash !== undefined) right.push({ text: this.flash.text, fg: palette[this.flash.tone] }, '  ')
    if (this.diagnostics.length > 0) right.push({ text: `⚠ ${this.diagnostics.length} 条诊断`, fg: palette.warning }, '  ')
    // An open panel shows its own key hints in its footer.
    if (this.panel === undefined) {
      right.push(...keyHints(palette, this.busy ? [['esc', '中断'], ['enter', '排队']] : [['enter', '发送'], ['/', '命令'], ['ctrl+c', '退出']]))
    }
    this.statusRight.content = spans(...right)
  }

  /**
   * Show a short message in the status row.
   * @param {string} message - the message.
   * @param {'success' | 'warning' | 'textMuted'} [tone] - palette color; success by default.
   */
  flashStatus(message, tone = 'success') {
    clearTimeout(this.flash?.timer)
    this.flash = { text: message, tone, timer: setTimeout(() => { this.flash = undefined; this.renderStatus() }, FLASH_MS) }
    this.renderStatus()
  }

  // ── completions ─────────────────────────────────────────────────────────

  updateCompletions() {
    const value = this.input.plainText
    const match = /^\/(\S*)$/.exec(value)
    if (match === null || this.completionProvider === undefined || this.panel !== undefined) {
      this.hideCompletions()
      return
    }
    this.completions = this.completionProvider(match[1]).slice(0, COMPLETION_LIMIT)
    this.completionIndex = 0
    this.renderCompletions()
  }

  hideCompletions() {
    this.completions = []
    this.renderCompletions()
  }

  renderCompletions() {
    if (this.completionBox === undefined) return
    for (const child of [...this.completionBox.getChildren()]) discard(child)
    this.completionBox.visible = this.completions.length > 0
    const palette = this.palette
    this.completions.forEach((item, index) => {
      const active = index === this.completionIndex
      this.completionBox.add(text(this.renderer, spans(
        { text: `/${item.name}`, fg: active ? palette.primary : palette.text, bold: active },
        { text: `  ${item.description}`, fg: palette.textMuted },
      ), { wrapMode: 'none', truncate: true, ...active ? { bg: palette.backgroundElement } : {} }))
    })
  }

  /**
   * Put the highlighted command into the prompt, or run it as opencode does.
   * @param {boolean} run - submit the command instead of leaving it for arguments.
   */
  acceptCompletion(run) {
    const item = this.completions[this.completionIndex]
    if (item === undefined) return
    this.hideCompletions()
    if (run) {
      this.input.setText(`/${item.name}`)
      this.submit()
      return
    }
    this.input.setText(`/${item.name} `)
    this.input.gotoBufferEnd()
  }

  // ── keys ────────────────────────────────────────────────────────────────

  /**
   * Route one key press. Global handlers run before the focused prompt, so a
   * handled key calls `preventDefault()` to keep it from the prompt.
   * @param {import('@opentui/core').KeyEvent} key - the key event.
   */
  onKey(key) {
    if (this.closing) return
    if (this.panel !== undefined) {
      // A panel returns false to pass the key to its own focused input.
      if (this.panel.onKey(key) !== false) key.preventDefault()
      return
    }
    const name = key.name
    if (key.ctrl && name === 'c') {
      key.preventDefault()
      if (!this.copySelection()) this.ctx.emit('tui/interrupt', 'ctrl-c')
      return
    }
    if (key.ctrl && name === 'd') {
      if (this.hasInput()) return
      key.preventDefault()
      this.ctx.emit('tui/close')
      return
    }
    if (key.ctrl && name === 't') {
      key.preventDefault()
      this.ctx.emit('tui/toggle-thinking')
      return
    }
    if (key.ctrl && name === 'v') {
      key.preventDefault()
      void this.pasteClipboard()
      return
    }
    if (name === 'pageup' || name === 'pagedown') {
      key.preventDefault()
      this.scroll.scrollBy(name === 'pageup' ? -0.5 : 0.5, 'viewport')
      return
    }
    if (this.completions.length > 0 && this.onCompletionKey(key)) return
    if (name === 'escape') {
      key.preventDefault()
      this.ctx.emit('tui/interrupt', 'escape')
      return
    }
    if ((name === 'up' || name === 'down') && !key.ctrl && !key.meta && !key.shift && !this.input.plainText.includes('\n')) {
      if (this.recallHistory(name === 'up' ? -1 : 1)) key.preventDefault()
    }
  }

  /** @returns {boolean} whether the completion list consumed the key. */
  onCompletionKey(key) {
    // Content-change notifications can trail fast typing; match the prompt as it is now.
    const index = this.completionIndex
    this.updateCompletions()
    this.completionIndex = Math.min(index, Math.max(0, this.completions.length - 1))
    const count = this.completions.length
    if (count === 0) return false
    switch (key.name) {
      case 'up':
      case 'down':
        key.preventDefault()
        this.completionIndex = (this.completionIndex + (key.name === 'up' ? -1 : 1) + count) % count
        this.renderCompletions()
        return true
      case 'tab':
        key.preventDefault()
        this.acceptCompletion(false)
        return true
      case 'escape':
        key.preventDefault()
        this.hideCompletions()
        return true
      case 'return':
        if (key.shift || key.meta) return false
        key.preventDefault()
        this.acceptCompletion(true)
        return true
      default:
        return false
    }
  }

  /**
   * Step through prompt history, keeping the unsent draft at the end.
   * @param {-1 | 1} step - older or newer.
   * @returns {boolean} whether the prompt changed.
   */
  recallHistory(step) {
    const next = this.historyIndex + step
    if (next < 0 || next > this.history.length) return false
    if (this.historyIndex === this.history.length) this.draft = this.input.plainText
    this.historyIndex = next
    this.input.setText(next === this.history.length ? this.draft : this.history[next])
    this.input.gotoBufferEnd()
    return true
  }

  /** @returns {boolean} whether a selection was copied. */
  copySelection() {
    const selected = this.renderer?.getSelection()?.getSelectedText()
    if (selected === undefined || selected === '') return false
    this.renderer.copyToClipboardOSC52(selected)
    // Terminal.app ignores OSC 52, so macOS also goes through pbcopy.
    if (process.platform === 'darwin') {
      const child = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => { /* pbcopy missing: OSC 52 was the only copy */ })
      child.stdin.end(selected)
    }
    this.renderer.clearSelection()
    this.flashStatus('已复制')
    return true
  }

  // ── panels ──────────────────────────────────────────────────────────────

  /**
   * Replace the prompt with a panel that receives every key until closed.
   * Callers open panels inside `exclusive()` so only one is shown at a time.
   * @param {object} options - the panel.
   * @param {import('@opentui/core').Renderable} options.renderable - the panel's root.
   * @param {(key: import('@opentui/core').KeyEvent) => boolean | void} options.onKey - key handler; returning false lets the key reach the panel's focused input.
   * @param {(text: string) => void} [options.onPaste] - receives pasted text; without it a paste reaches the panel's focused input.
   * @param {() => void} [options.onCancel] - called when the terminal withdraws the panel.
   * @returns {() => void} closes the panel and restores the prompt.
   */
  showPanel({ renderable, onKey, onPaste, onCancel }) {
    const panel = { renderable, onKey, onPaste, onCancel }
    this.panel = panel
    this.hideCompletions()
    this.input.blur()
    this.promptBox.visible = false
    this.promptCap.visible = false
    this.panelSlot.add(renderable)
    this.panelSlot.visible = true
    this.renderStatus()
    return () => {
      if (this.panel !== panel) return
      this.panel = undefined
      discard(renderable)
      if (this.closing) return
      this.panelSlot.visible = false
      this.promptBox.visible = true
      this.promptCap.visible = true
      this.input.focus()
      this.renderStatus()
    }
  }

  /**
   * Show a panel and settle with the value its handlers pass to `done`. The
   * panel closes on settlement, on `signal` abort, and when the terminal
   * withdraws it; the last two settle with `undefined`.
   * @template T
   * @param {(done: (value: T | undefined) => void) => { renderable: import('@opentui/core').Renderable, onKey: (key: import('@opentui/core').KeyEvent) => boolean | void, onPaste?: (text: string) => void }} build - builds the panel.
   * @param {AbortSignal} [signal] - withdraws the panel when aborted.
   * @returns {Promise<T | undefined>} the settled value.
   */
  runPanel(build, signal) {
    if (signal?.aborted === true || !this.isOpen) return Promise.resolve(undefined)
    return new Promise(resolve => {
      let close = () => {}
      let settled = false
      const done = value => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        close()
        resolve(value)
      }
      const onAbort = () => done(undefined)
      signal?.addEventListener('abort', onAbort)
      close = this.showPanel({ ...build(done), onCancel: () => done(undefined) })
    })
  }

  /**
   * Run a task that shows a panel once every earlier one has settled, even
   * when parallel tool calls ask together.
   * @template T
   * @param {() => T | Promise<T>} task - the task; its failure does not block later tasks.
   * @returns {Promise<T>} the task's result.
   */
  exclusive(task) {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => undefined)
    return run
  }

  /**
   * Give a bracketed paste to the open panel when it takes pastes itself.
   * @param {import('@opentui/core').PasteEvent} event - the paste event.
   */
  onPanelPaste(event) {
    if (this.panel?.onPaste === undefined) return
    event.preventDefault()
    this.panel.onPaste(decodePasteBytes(event.bytes))
  }

  /** Withdraw the open panel through its cancel callback. */
  cancelPending() {
    this.panel?.onCancel?.()
  }

  // ── stderr ──────────────────────────────────────────────────────────────

  captureStderr() {
    const original = process.stderr.write
    process.stderr.write = (chunk, encoding, callback) => {
      this.diagnostics.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'))
      this.renderStatus()
      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') queueMicrotask(() => done())
      return true
    }
    this.restoreStderr = () => { process.stderr.write = original }
  }

  releaseStderr() {
    this.restoreStderr?.()
    this.restoreStderr = undefined
    for (const chunk of this.diagnostics.splice(0)) process.stderr.write(chunk)
  }
}
