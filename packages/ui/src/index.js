/**
 * @dsh-tui/ui — the TUI's OpenTUI layer. It is the only package that imports
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
} from '@opentui/core'
import { syntaxRules } from '@dsh-tui/render'

export {
  BoxRenderable,
  DiffRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
  createCliRenderer,
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
