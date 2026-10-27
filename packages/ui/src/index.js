/**
 * @dsh-sdk/ui — the TUI's OpenTUI layer. It is the only package that imports
 * `@opentui/core`; the plugins use the classes it re-exports so the whole
 * repository loads one OpenTUI instance. It also holds the opencode-style
 * pieces the plugins share: the split border, styled spans, spinners,
 * syntax styles, and left-bordered blocks.
 */

import {
  BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  decodePasteBytes,
} from '@opentui/core'
import { syntaxRules } from '@dsh-sdk/render'

export {
  BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
  decodePasteBytes,
}

/** Border characters that draw nothing; spread and override one side. */
export const EMPTY_BORDER = Object.freeze({
  topLeft: '',
  bottomLeft: '',
  vertical: '',
  topRight: '',
  bottomRight: '',
  horizontal: ' ',
  bottomT: '',
  topT: '',
  cross: '',
  leftT: '',
  rightT: '',
})

/** opencode's `SplitBorder`: a heavy vertical bar on the left edge. */
export const SPLIT_BORDER = Object.freeze({ ...EMPTY_BORDER, vertical: '┃' })

/** Braille spinner frames. */
export const SPINNER_FRAMES = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])

const SPINNER_INTERVAL_MS = 80

/**
 * A spinner frame source. It calls `onFrame` with each frame until stopped.
 */
export class Spinner {
  /**
   * @param {(frame: string) => void} onFrame - receives each frame, starting immediately.
   */
  constructor(onFrame) {
    this.onFrame = onFrame
    this.index = 0
    this.timer = undefined
  }

  start() {
    if (this.timer !== undefined) return
    this.onFrame(SPINNER_FRAMES[0])
    this.timer = setInterval(() => {
      this.index = (this.index + 1) % SPINNER_FRAMES.length
      this.onFrame(SPINNER_FRAMES[this.index])
    }, SPINNER_INTERVAL_MS)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  get running() {
    return this.timer !== undefined
  }
}

const ATTRIBUTE_FLAGS = [
  ['bold', TextAttributes.BOLD],
  ['dim', TextAttributes.DIM],
  ['italic', TextAttributes.ITALIC],
  ['underline', TextAttributes.UNDERLINE],
  ['strikethrough', TextAttributes.STRIKETHROUGH],
]

/**
 * @typedef {object} Span
 * @property {string} text - the text.
 * @property {string} [fg] - foreground hex color.
 * @property {string} [bg] - background hex color.
 * @property {boolean} [bold]
 * @property {boolean} [dim]
 * @property {boolean} [italic]
 * @property {boolean} [underline]
 * @property {boolean} [strikethrough]
 */

/**
 * Build styled text from plain strings and styled spans.
 * @param {...(string | Span | false | undefined)} parts - pieces in order; falsy parts are skipped.
 * @returns {StyledText} text for a `TextRenderable`.
 */
export function spans(...parts) {
  const chunks = []
  for (const part of parts) {
    if (part === false || part === undefined || part === '') continue
    if (typeof part === 'string') {
      chunks.push({ __isChunk: true, text: part })
      continue
    }
    if (part.text === '') continue
    let attributes = 0
    for (const [key, bit] of ATTRIBUTE_FLAGS) if (part[key] === true) attributes |= bit
    chunks.push({
      __isChunk: true,
      text: part.text,
      ...part.fg === undefined ? {} : { fg: RGBA.fromHex(part.fg) },
      ...part.bg === undefined ? {} : { bg: RGBA.fromHex(part.bg) },
      ...attributes === 0 ? {} : { attributes },
    })
  }
  return new StyledText(chunks)
}

/**
 * Create the syntax styles for one renderer.
 * @param {import('@opentui/core').CliRenderer} renderer - owner of the native styles.
 * @param {Readonly<Record<string, string>>} palette - theme colors.
 * @returns {{ syntax: SyntaxStyle, subtleSyntax: SyntaxStyle }} full-color styles and muted styles for reasoning.
 */
export function createSyntaxStyles(renderer, palette) {
  return {
    syntax: SyntaxStyle.fromTheme(syntaxRules(palette), renderer.nativeScene),
    subtleSyntax: SyntaxStyle.fromTheme(syntaxRules(palette, palette.textMuted), renderer.nativeScene),
  }
}

/**
 * A box with opencode's left split border, used for user messages, block
 * tools, errors, and panels.
 * @param {import('@opentui/core').CliRenderer} renderer - render context.
 * @param {object} options - `BoxOptions`; `borderColor` colors the bar.
 * @returns {BoxRenderable} the block.
 */
export function splitBlock(renderer, options) {
  return new BoxRenderable(renderer, { border: ['left'], customBorderChars: SPLIT_BORDER, flexShrink: 0, ...options })
}

/**
 * A single text line or paragraph. Use margins to offset it: OpenTUI 0.6.8
 * reserves a text's padding in layout but draws the text at its top-left.
 * @param {import('@opentui/core').CliRenderer} renderer - render context.
 * @param {string | StyledText} content - text content.
 * @param {object} [options] - `TextOptions`.
 * @returns {TextRenderable} the text.
 */
export function text(renderer, content, options = {}) {
  return new TextRenderable(renderer, { content, flexShrink: 0, ...options })
}

/**
 * opencode's panel layout (permission and question prompts): a colored left
 * bar over the panel background, a padded body, and a footer strip on the
 * element background whose children spread to both ends.
 * @param {import('@opentui/core').CliRenderer} renderer - render context.
 * @param {Readonly<Record<string, string>>} palette - theme colors.
 * @param {string} accent - the bar color.
 * @returns {{ root: BoxRenderable, body: BoxRenderable, footer: BoxRenderable }} the panel and the boxes to fill.
 */
export function panelFrame(renderer, palette, accent) {
  const root = splitBlock(renderer, { flexDirection: 'column', borderColor: accent, backgroundColor: palette.backgroundPanel })
  const body = new BoxRenderable(renderer, { flexDirection: 'column', gap: 1, paddingLeft: 2, paddingRight: 3, paddingTop: 1, paddingBottom: 1, flexShrink: 0 })
  const footer = new BoxRenderable(renderer, {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 1,
    paddingLeft: 2,
    paddingRight: 3,
    paddingTop: 1,
    paddingBottom: 1,
    backgroundColor: palette.backgroundElement,
    flexShrink: 0,
  })
  root.add(body)
  root.add(footer)
  return { root, body, footer }
}

/**
 * A vertical list with one highlighted row that scrolls to keep it visible.
 */
export class ListView {
  /**
   * @param {import('@opentui/core').CliRenderer} renderer - render context.
   * @param {Readonly<Record<string, string>>} palette - theme colors.
   * @param {number} maxVisible - rows shown at once.
   */
  constructor(renderer, palette, maxVisible) {
    this.renderer = renderer
    this.palette = palette
    this.maxVisible = maxVisible
    this.items = []
    this.active = 0
    this.renderable = new BoxRenderable(renderer, { flexDirection: 'column', flexShrink: 0 })
  }

  /**
   * @param {Array<{ parts: Array<string | Span>, description?: string }>} items - rows; `parts` is the label.
   */
  setItems(items) {
    this.items = items
    this.active = Math.min(this.active, Math.max(0, items.length - 1))
    this.render()
  }

  /**
   * @param {number} step - rows to move; wraps around.
   */
  move(step) {
    if (this.items.length === 0) return
    this.active = (this.active + step + this.items.length) % this.items.length
    this.render()
  }

  render() {
    for (const child of [...this.renderable.getChildren()]) discard(child)
    const start = Math.max(0, Math.min(this.active - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible))
    const visible = this.items.slice(start, start + this.maxVisible)
    if (start > 0) this.renderable.add(text(this.renderer, `  ↑ 还有 ${start} 项`, { fg: this.palette.textMuted }))
    visible.forEach((item, offset) => {
      const active = start + offset === this.active
      this.renderable.add(text(this.renderer, spans(
        { text: active ? '› ' : '  ', fg: this.palette.secondary },
        ...item.parts,
        item.description !== undefined && item.description !== '' && { text: `  ${item.description}`, fg: this.palette.textMuted },
      ), { wrapMode: 'none', truncate: true, ...active ? { bg: this.palette.backgroundElement } : {} }))
    })
    const rest = this.items.length - start - visible.length
    if (rest > 0) this.renderable.add(text(this.renderer, `  ↓ 还有 ${rest} 项`, { fg: this.palette.textMuted }))
  }
}

/**
 * Status-row hint spans: each key in text color followed by its action.
 * @param {Readonly<Record<string, string>>} palette - theme colors.
 * @param {Array<[string, string]>} pairs - key and action pairs.
 * @returns {Span[]} spans for `spans()` or a panel's `hints`.
 */
export function keyHints(palette, pairs) {
  return pairs.flatMap(([key, action], index) => [
    { text: `${index === 0 ? '' : '  '}${key}`, fg: palette.text },
    { text: ` ${action}`, fg: palette.textMuted },
  ])
}

/**
 * Remove a renderable from its parent and free it with its children.
 * @param {import('@opentui/core').Renderable | undefined} renderable - the renderable; undefined is ignored.
 */
export function discard(renderable) {
  if (renderable === undefined) return
  renderable.parent?.remove(renderable)
  renderable.destroyRecursively()
}

/**
 * Whether a key press types text: a printable sequence without Ctrl or Meta.
 * @param {import('@opentui/core').KeyEvent} key - the key event.
 * @returns {boolean} whether `key.sequence` should be inserted.
 */
export function isTypedKey(key) {
  return !key.ctrl && !key.meta && typeof key.sequence === 'string' && key.sequence.length > 0
    && !/[\u0000-\u001f\u007f]/.test(key.sequence)
}

/**
 * A one-line text field drawn as styled text, for panels that own every key.
 * It edits at the end only, which suits the short values panels ask for.
 */
export class TextField {
  /**
   * @param {object} options - field options.
   * @param {boolean} [options.mask] - draw each character as a dot, for secrets.
   * @param {string} [options.initial] - starting value.
   */
  constructor({ mask = false, initial = '' } = {}) {
    this.mask = mask
    this.value = initial
  }

  /**
   * @param {import('@opentui/core').KeyEvent} key - the key event.
   * @returns {boolean} whether the key changed the value.
   */
  handleKey(key) {
    if (key.name === 'backspace') {
      this.value = [...this.value].slice(0, -1).join('')
      return true
    }
    if (key.ctrl && key.name === 'u') {
      this.value = ''
      return true
    }
    if (key.ctrl && key.name === 'w') {
      this.value = this.value.replace(/\S*\s*$/, '')
      return true
    }
    if (!isTypedKey(key)) return false
    this.value += key.sequence
    return true
  }

  /**
   * @param {string} pasted - pasted text; line breaks are dropped.
   */
  paste(pasted) {
    this.value += pasted.replace(/[\r\n]+/g, '')
  }

  /**
   * @param {Readonly<Record<string, string>>} palette - theme colors.
   * @param {string} [placeholder] - shown while the value is empty.
   * @returns {StyledText} the field with a block cursor at the end of the value.
   */
  render(palette, placeholder = '') {
    const prompt = { text: '› ', fg: palette.secondary }
    const shown = this.mask ? '•'.repeat([...this.value].length) : this.value
    if (shown === '') {
      // Empty: the cursor sits at the start, drawn over the placeholder's first character.
      const [first = ' ', ...rest] = [...placeholder]
      return spans(prompt, { text: first, fg: palette.background, bg: palette.text }, { text: rest.join(''), fg: palette.textMuted })
    }
    return spans(prompt, { text: shown, fg: palette.text }, { text: ' ', bg: palette.text })
  }
}

/**
 * @typedef {object} SelectItem
 * @property {Array<string | Span | false | undefined>} parts - the row label.
 * @property {string} [description] - muted text after the label.
 * @property {string} [search] - text the filter matches; defaults to the label text.
 * @property {unknown} value - what selecting the row returns.
 */

/**
 * Ask the user to pick from a list in a panel, optionally filtered by typing
 * or with several rows checked by Space.
 * @param {object} terminal - the TUI console.
 * @param {object} options - panel options.
 * @param {string} options.title - panel heading.
 * @param {Array<string | StyledText>} [options.lines] - muted explanation lines under the heading.
 * @param {SelectItem[]} options.items - rows.
 * @param {number} [options.initial] - row highlighted first.
 * @param {boolean} [options.filterable] - typing narrows the rows.
 * @param {boolean} [options.multi] - Space checks rows, Ctrl-A checks or clears every shown row, and Enter returns every checked value.
 * @param {(value: unknown) => boolean} [options.checked] - rows checked when the panel opens, for `multi`.
 * @param {number} [options.rows] - rows visible at once.
 * @returns {Promise<unknown>} the chosen value (an array when `multi`), or undefined when cancelled.
 */
export function selectPanel(terminal, { title, lines = [], items, initial = 0, filterable = false, multi = false, checked: isChecked = () => false, rows = 10 }) {
  const { renderer, palette } = terminal
  return terminal.runPanel(done => {
    const { root, body, footer } = panelFrame(renderer, palette, palette.secondary)
    body.add(text(renderer, spans({ text: title, fg: palette.text, bold: true })))
    for (const line of lines) body.add(text(renderer, line, { fg: palette.textMuted }))
    const filterLine = filterable ? text(renderer, '', { wrapMode: 'none' }) : undefined
    if (filterLine !== undefined) body.add(filterLine)
    const list = new ListView(renderer, palette, rows)
    body.add(list.renderable)
    const countLine = multi ? text(renderer, '', { fg: palette.textMuted }) : undefined
    if (countLine !== undefined) body.add(countLine)
    footer.add(text(renderer, spans(...keyHints(palette, [
      ...filterable ? [['输入', '过滤']] : [],
      ['↑↓', '选择'],
      ...multi ? [['space', '勾选'], ['ctrl+a', '全选']] : [],
      ['enter', '确认'],
      ['esc', '取消'],
    ])), { wrapMode: 'none' }))
    const field = new TextField()
    const checked = new Set(multi ? items.filter(item => isChecked(item.value)) : [])
    let shown = items
    const labelOf = item => item.parts.map(part => typeof part === 'string' ? part : part ? part.text : '').join('')
    const render = () => {
      const needle = field.value.toLowerCase()
      shown = items.filter(item => (item.search ?? labelOf(item)).toLowerCase().includes(needle))
      if (filterLine !== undefined) filterLine.content = field.render(palette, '输入以过滤')
      if (countLine !== undefined) countLine.content = checked.size === 0 ? '还没有勾选；直接回车只启用光标所在的一项' : `已勾选 ${checked.size} 个`
      list.setItems(shown.map(item => ({
        parts: [
          multi && { text: checked.has(item) ? '[✓] ' : '[ ] ', fg: checked.has(item) ? palette.success : palette.textMuted },
          ...item.parts,
        ],
        description: item.description,
      })))
    }
    list.active = Math.max(0, Math.min(initial, items.length - 1))
    render()
    return {
      renderable: root,
      onKey: key => {
        switch (key.name) {
          case 'up':
          case 'down':
            list.move(key.name === 'up' ? -1 : 1)
            return
          case 'return': {
            if (multi) {
              const picked = items.filter(item => checked.has(item))
              const fallback = shown[list.active]
              done((picked.length > 0 ? picked : fallback === undefined ? [] : [fallback]).map(item => item.value))
              return
            }
            const item = shown[list.active]
            if (item !== undefined) done(item.value)
            return
          }
          case 'escape':
            done(undefined)
            return
          case 'space':
            if (multi && shown[list.active] !== undefined) {
              const item = shown[list.active]
              if (checked.has(item)) checked.delete(item)
              else checked.add(item)
              render()
              return
            }
            break
          default:
            break
        }
        if (key.ctrl && key.name === 'c') {
          done(undefined)
          return
        }
        if (multi && key.ctrl && key.name === 'a') {
          // Toggle every row the filter shows: check them all, or clear them when all are checked.
          const all = shown.length > 0 && shown.every(item => checked.has(item))
          for (const item of shown) {
            if (all) checked.delete(item)
            else checked.add(item)
          }
          render()
          return
        }
        if (filterable && field.handleKey(key)) {
          list.active = 0
          render()
        }
      },
      onPaste: pasted => {
        if (!filterable) return
        field.paste(pasted)
        list.active = 0
        render()
      },
    }
  })
}

/**
 * Ask for one line of text in a panel.
 * @param {object} terminal - the TUI console.
 * @param {object} options - panel options.
 * @param {string} options.title - panel heading.
 * @param {Array<string | StyledText>} [options.lines] - muted explanation lines under the heading.
 * @param {string} [options.placeholder] - shown while the field is empty.
 * @param {boolean} [options.mask] - hide the typed characters.
 * @param {string} [options.initial] - starting value.
 * @param {(value: string) => string | undefined} [options.validate] - returns an error to show, or undefined to accept.
 * @returns {Promise<string | undefined>} the trimmed value, or undefined when cancelled.
 */
export function inputPanel(terminal, { title, lines = [], placeholder = '', mask = false, initial = '', validate = () => undefined }) {
  const { renderer, palette } = terminal
  return terminal.runPanel(done => {
    const { root, body, footer } = panelFrame(renderer, palette, palette.secondary)
    body.add(text(renderer, spans({ text: title, fg: palette.text, bold: true })))
    for (const line of lines) body.add(text(renderer, line, { fg: palette.textMuted }))
    const field = new TextField({ mask, initial })
    const fieldLine = text(renderer, '', { wrapMode: 'char' })
    const errorLine = text(renderer, '', { fg: palette.error })
    body.add(fieldLine)
    body.add(errorLine)
    footer.add(text(renderer, spans(...keyHints(palette, [['enter', '确认'], ['esc', '取消']])), { wrapMode: 'none' }))
    const render = error => {
      fieldLine.content = field.render(palette, placeholder)
      errorLine.content = error ?? ''
    }
    render()
    return {
      renderable: root,
      onKey: key => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          done(undefined)
          return
        }
        if (key.name === 'return') {
          const value = field.value.trim()
          const error = validate(value)
          if (error === undefined) done(value)
          else render(error)
          return
        }
        if (field.handleKey(key)) render()
      },
      onPaste: pasted => {
        field.paste(pasted)
        render()
      },
    }
  })
}
