/**
 * @dsh-tui/render — presentation data and pure formatting shared by the TUI
 * plugins: the opencode color palette and syntax rules, how each dsh tool
 * call is titled, and one-line summaries of arguments, results, paths,
 * durations, model selections, and errors. No terminal or dsh imports.
 */

import { structuredPatch } from 'diff'

/**
 * opencode's default dark theme (`theme/assets/opencode.json`), flattened to
 * hex colors. Keys match opencode's theme tokens.
 */
export const darkPalette = Object.freeze({
  primary: '#fab283',
  secondary: '#5c9cf5',
  accent: '#9d7cd8',
  error: '#e06c75',
  warning: '#f5a742',
  success: '#7fd88f',
  info: '#56b6c2',
  text: '#eeeeee',
  textMuted: '#808080',
  background: '#0a0a0a',
  backgroundPanel: '#141414',
  backgroundElement: '#1e1e1e',
  border: '#484848',
  borderActive: '#606060',
  borderSubtle: '#3c3c3c',
  diffAdded: '#4fd6be',
  diffRemoved: '#c53b53',
  diffContext: '#828bb8',
  diffHighlightAdded: '#b8db87',
  diffHighlightRemoved: '#e26a75',
  diffAddedBg: '#20303b',
  diffRemovedBg: '#37222c',
  diffContextBg: '#141414',
  diffLineNumber: '#8f8f8f',
  diffAddedLineNumberBg: '#1b2b34',
  diffRemovedLineNumberBg: '#2d1f26',
  markdownText: '#eeeeee',
  markdownHeading: '#9d7cd8',
  markdownLink: '#fab283',
  markdownLinkText: '#56b6c2',
  markdownCode: '#7fd88f',
  markdownBlockQuote: '#e5c07b',
  markdownEmph: '#e5c07b',
  markdownStrong: '#f5a742',
  markdownListItem: '#fab283',
  syntaxComment: '#808080',
  syntaxKeyword: '#9d7cd8',
  syntaxFunction: '#fab283',
  syntaxVariable: '#e06c75',
  syntaxString: '#7fd88f',
  syntaxNumber: '#f5a742',
  syntaxType: '#e5c07b',
  syntaxOperator: '#56b6c2',
  syntaxPunctuation: '#eeeeee',
})

/** A grayscale palette with the same keys, used when `NO_COLOR` is set. */
export const monochromePalette = Object.freeze(Object.fromEntries(Object.keys(darkPalette).map(key => {
  if (/^background|Bg$/.test(key)) return [key, key === 'background' ? '#000000' : '#1a1a1a']
  if (/Muted|Comment|LineNumber|border/i.test(key)) return [key, '#808080']
  return [key, '#e0e0e0']
})))

/** @returns {Readonly<Record<string, string>>} the palette for this process's environment. */
export function currentPalette() {
  return process.env.NO_COLOR === undefined ? darkPalette : monochromePalette
}

/**
 * Tree-sitter scope styles ported from opencode's `getSyntaxRules`
 * (`packages/tui/src/theme/index.ts`, MIT): scopes, foreground palette key,
 * flags (b bold, i italic, u underline), and an optional background key.
 */
const SYNTAX_RULES = [
  [['default'], 'text', ''],
  [['prompt'], 'accent', ''],
  [['comment'], 'syntaxComment', 'i'],
  [['comment.documentation'], 'syntaxComment', 'i'],
  [['string', 'symbol'], 'syntaxString', ''],
  [['number', 'boolean'], 'syntaxNumber', ''],
  [['character.special'], 'syntaxString', ''],
  [['keyword.return', 'keyword.conditional', 'keyword.repeat', 'keyword.coroutine'], 'syntaxKeyword', 'i'],
  [['keyword.type'], 'syntaxType', 'bi'],
  [['keyword.function', 'function.method'], 'syntaxFunction', ''],
  [['keyword'], 'syntaxKeyword', 'i'],
  [['keyword.import'], 'syntaxKeyword', ''],
  [['operator', 'keyword.operator', 'punctuation.delimiter'], 'syntaxOperator', ''],
  [['keyword.conditional.ternary'], 'syntaxOperator', ''],
  [['variable', 'variable.parameter', 'function.method.call', 'function.call'], 'syntaxVariable', ''],
  [['variable.member', 'function', 'constructor'], 'syntaxFunction', ''],
  [['type', 'module'], 'syntaxType', ''],
  [['constant'], 'syntaxNumber', ''],
  [['property'], 'syntaxVariable', ''],
  [['class'], 'syntaxType', ''],
  [['parameter'], 'syntaxVariable', ''],
  [['punctuation', 'punctuation.bracket'], 'syntaxPunctuation', ''],
  [['variable.builtin', 'type.builtin', 'function.builtin', 'module.builtin', 'constant.builtin'], 'error', ''],
  [['variable.super'], 'error', ''],
  [['string.escape', 'string.regexp'], 'syntaxKeyword', ''],
  [['keyword.directive'], 'syntaxKeyword', 'i'],
  [['punctuation.special'], 'syntaxOperator', ''],
  [['keyword.modifier'], 'syntaxKeyword', 'i'],
  [['keyword.exception'], 'syntaxKeyword', 'i'],
  [['markup.heading'], 'markdownHeading', 'b'],
  [['markup.heading.1'], 'markdownHeading', 'bu'],
  [['markup.heading.2', 'markup.heading.3', 'markup.heading.4', 'markup.heading.5', 'markup.heading.6'], 'markdownHeading', 'b'],
  [['markup.bold', 'markup.strong'], 'markdownStrong', 'b'],
  [['markup.italic'], 'markdownEmph', 'i'],
  [['markup.list'], 'markdownListItem', ''],
  [['markup.quote'], 'markdownBlockQuote', 'i'],
  [['markup.raw', 'markup.raw.block'], 'markdownCode', ''],
  [['markup.raw.inline'], 'markdownCode', '', 'background'],
  [['markup.link'], 'markdownLink', 'u'],
  [['markup.link.label'], 'markdownLinkText', 'u'],
  [['markup.link.url'], 'markdownLink', 'u'],
  [['label'], 'markdownLinkText', ''],
  [['spell', 'nospell'], 'text', ''],
  [['conceal'], 'textMuted', ''],
  [['string.special', 'string.special.url'], 'markdownLink', 'u'],
  [['character'], 'syntaxString', ''],
  [['float'], 'syntaxNumber', ''],
  [['comment.error'], 'error', 'bi'],
  [['comment.warning'], 'warning', 'bi'],
  [['comment.todo', 'comment.note'], 'info', 'bi'],
  [['namespace'], 'syntaxType', ''],
  [['field'], 'syntaxVariable', ''],
  [['type.definition'], 'syntaxType', 'b'],
  [['keyword.export'], 'syntaxKeyword', ''],
  [['attribute', 'annotation'], 'warning', ''],
  [['tag'], 'error', ''],
  [['tag.attribute'], 'syntaxKeyword', ''],
  [['tag.delimiter'], 'syntaxOperator', ''],
  [['markup.strikethrough'], 'textMuted', ''],
  [['markup.underline'], 'text', 'u'],
  [['markup.list.checked'], 'success', ''],
  [['markup.list.unchecked'], 'textMuted', ''],
  [['diff.plus'], 'diffAdded', '', 'diffAddedBg'],
  [['diff.minus'], 'diffRemoved', '', 'diffRemovedBg'],
  [['diff.delta'], 'diffContext', '', 'diffContextBg'],
  [['error'], 'error', 'b'],
  [['warning'], 'warning', 'b'],
  [['info'], 'info', ''],
  [['debug'], 'textMuted', ''],
]

/**
 * Syntax highlighting rules in OpenTUI's theme-token form.
 * @param {Readonly<Record<string, string>>} palette - colors by token.
 * @param {string} [foreground] - overrides every rule's foreground, for muted text such as reasoning.
 * @returns {Array<{ scope: string[], style: object }>} rules for `SyntaxStyle.fromTheme`.
 */
export function syntaxRules(palette, foreground) {
  return SYNTAX_RULES.map(([scope, fg, flags, bg]) => ({
    scope,
    style: {
      foreground: foreground ?? palette[fg],
      ...bg === undefined ? {} : { background: palette[bg] },
      ...flags.includes('b') ? { bold: true } : {},
      ...flags.includes('i') ? { italic: true } : {},
      ...flags.includes('u') ? { underline: true } : {},
    },
  }))
}

/** Argument keys that best identify what a tool call does, in display priority. */
const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'name']

/**
 * Collapse whitespace and cut a string to `max` characters.
 * @param {string} text - text to shorten.
 * @param {number} max - maximum length including the ellipsis.
 * @returns {string} single-line text no longer than `max`.
 */
export function oneLine(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Parse a tool call's arguments.
 * @param {unknown} raw - the call's arguments, as a JSON string or an object.
 * @returns {Record<string, unknown> | undefined} the argument object, or undefined when it is not one.
 */
export function parseArgs(raw) {
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      // Partial or non-JSON arguments have no fields to show.
      return undefined
    }
  }
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : undefined
}

/**
 * Summarize a tool call's arguments for one display line.
 * @param {unknown} raw - the call's arguments, as a JSON string or an object.
 * @returns {string} the most identifying argument, or compact JSON.
 */
export function summarizeArgs(raw) {
  const args = parseArgs(raw)
  if (args === undefined) return oneLine(typeof raw === 'string' ? raw : String(raw ?? ''), 120)
  for (const key of SUMMARY_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return oneLine(value, 120)
  }
  return oneLine(JSON.stringify(args), 120)
}

/**
 * Show a path relative to the working directory, or under `~`.
 * @param {unknown} path - absolute or relative path.
 * @param {string} [cwd] - the session's working directory.
 * @returns {string} the display path; empty when `path` is not a non-empty string.
 */
export function formatPath(path, cwd) {
  if (typeof path !== 'string' || path === '') return ''
  if (cwd !== undefined && path === cwd) return '.'
  if (cwd !== undefined && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  const home = process.env.HOME
  if (home !== undefined && home !== '' && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

/**
 * @typedef {object} ToolView
 * @property {string} icon - one-column glyph before the title.
 * @property {string} title - the call's one-line description.
 * @property {'inline' | 'shell' | 'edit' | 'todos'} kind - how the call renders once it has a result.
 * @property {Array<{ content: string, status: string }>} [todos] - `todo_write` items.
 */

/**
 * Title a tool call the way opencode does: a glyph plus a verb and its target.
 * @param {string} name - tool name.
 * @param {unknown} raw - the call's arguments.
 * @param {string} [cwd] - working directory paths are shown relative to.
 * @returns {ToolView} the call's presentation.
 */
export function toolView(name, raw, cwd) {
  const args = parseArgs(raw) ?? {}
  const text = key => typeof args[key] === 'string' ? args[key] : ''
  const path = key => formatPath(args[key], cwd)
  const inPath = key => args[key] === undefined ? '' : `（${path(key)}）`
  switch (name) {
    case 'read': {
      const range = [args.offset === undefined ? '' : `offset=${args.offset}`, args.limit === undefined ? '' : `limit=${args.limit}`].filter(Boolean)
      return { icon: '→', title: `读取 ${path('file_path')}${range.length === 0 ? '' : ` [${range.join(', ')}]`}`, kind: 'inline' }
    }
    case 'read_image':
      return { icon: '→', title: `读取 ${path('file_path')}`, kind: 'inline' }
    case 'write':
      return { icon: '←', title: `写入 ${path('file_path')}`, kind: 'edit' }
    case 'edit':
      return { icon: '←', title: `编辑 ${path('file_path')}${args.replace_all === true ? ' [全部替换]' : ''}`, kind: 'edit' }
    case 'str_replace_editor': {
      const verb = { view: '读取', create: '写入', undo_edit: '撤销编辑' }[text('command')] ?? '编辑'
      return { icon: verb === '读取' ? '→' : '←', title: `${verb} ${path('path')}`, kind: verb === '读取' ? 'inline' : 'edit' }
    }
    case 'bash':
    case 'pwsh':
      return { icon: '$', title: oneLine(text('command'), 200), kind: 'shell' }
    case 'run_code':
      return { icon: '$', title: oneLine(text('description') || '运行代码', 200), kind: 'shell' }
    case 'glob':
      return { icon: '✱', title: `查找文件 "${text('pattern')}"${inPath('path')}`, kind: 'inline' }
    case 'grep':
      return { icon: '✱', title: `搜索 "${text('pattern')}"${inPath('path')}`, kind: 'inline' }
    case 'web_fetch':
      return { icon: '%', title: `抓取 ${text('url')}`, kind: 'inline' }
    case 'web_search': {
      const queries = Array.isArray(args.queries) ? args.queries.filter(query => typeof query === 'string') : []
      return { icon: '◈', title: `搜索网页 ${queries.map(query => `"${query}"`).join('、')}`, kind: 'inline' }
    }
    case 'todo_write':
      return { icon: '⚙', title: '待办', kind: 'todos', todos: parseTodos(args.todos) }
    case 'ask_user_question': {
      const count = Array.isArray(args.questions) ? args.questions.length : 0
      return { icon: '?', title: `提问 ${count} 个问题`, kind: 'inline' }
    }
    case 'subagent':
      return { icon: '│', title: `子任务 ${oneLine(text('description'), 120)}`, kind: 'inline' }
    case 'skill':
      return { icon: '→', title: `技能 "${text('name')}"`, kind: 'inline' }
    default:
      return { icon: '⚙', title: `${name} ${summarizeArgs(raw)}`, kind: 'inline' }
  }
}

/**
 * @param {unknown} value - `todo_write`'s `todos` argument.
 * @returns {Array<{ content: string, status: string }>} the well-formed items.
 */
function parseTodos(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item?.content === 'string' && typeof item?.status === 'string')
}

/**
 * Join the text blocks of a tool result message.
 * @param {{ content?: ReadonlyArray<{ type: string, text?: string }> }} message - the tool result message.
 * @returns {string} the concatenated text content.
 */
export function resultText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

/**
 * Preview the first lines of a tool result.
 * @param {string} text - full result text.
 * @param {number} maxLines - number of lines to keep.
 * @returns {string[]} display lines, ending with an omission note when cut.
 */
export function previewLines(text, maxLines) {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length === 1 && lines[0] === '') return ['(无输出)']
  const shown = lines.slice(0, maxLines).map(line => oneLine(line, 160))
  if (lines.length > maxLines) shown.push(`… 另有 ${lines.length - maxLines} 行`)
  return shown
}

/**
 * Turn the `write`/`edit` result metadata of dsh-tool-fs (`{ diffs: [{ path,
 * oldText, newText }] }`, one entry per applied hunk with context) into one
 * unified diff. Hunk line numbers count from each hunk's first line.
 * @param {unknown} meta - the tool result's `meta`.
 * @returns {{ path: string, diff: string } | undefined} the diff, or undefined without well-formed hunks.
 */
export function unifiedDiff(meta) {
  const diffs = Array.isArray(meta?.diffs) ? meta.diffs : []
  const hunks = diffs.filter(item => typeof item?.path === 'string' && typeof item?.newText === 'string'
    && (item.oldText === null || typeof item.oldText === 'string'))
  if (hunks.length === 0) return undefined
  const path = hunks[0].path
  const withNewline = text => text === '' ? '' : `${text}\n`
  const body = []
  for (const hunk of hunks) {
    const patch = structuredPatch(path, path, withNewline(hunk.oldText ?? ''), withNewline(hunk.newText), '', '', { context: 3 })
    for (const part of patch.hunks) {
      body.push(`@@ -${part.oldStart},${part.oldLines} +${part.newStart},${part.newLines} @@`)
      body.push(...part.lines.filter(line => !line.startsWith('\\')))
    }
  }
  if (body.length === 0) return undefined
  return { path, diff: [`--- a/${path}`, `+++ b/${path}`, ...body].join('\n') }
}

/**
 * @param {string} path - file path.
 * @returns {string | undefined} the tree-sitter filetype OpenTUI ships a parser for.
 */
export function filetypeOf(path) {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  if (extension === undefined) return undefined
  if (['js', 'mjs', 'cjs', 'jsx'].includes(extension)) return 'javascript'
  if (['ts', 'mts', 'cts', 'tsx'].includes(extension)) return 'typescript'
  if (['md', 'markdown'].includes(extension)) return 'markdown'
  if (extension === 'zig') return 'zig'
  return undefined
}

/**
 * @param {number} ms - elapsed milliseconds.
 * @returns {string} a short duration such as `850ms`, `2.1s`, or `1m 3s`.
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * Format a provider/model selection.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} selection - model selection.
 * @returns {string} `provider/model`, with the effort when one is set.
 */
export function formatSelection(selection) {
  if (selection === undefined) return '(未选择模型)'
  const effort = selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`
  return `${selection.provider}/${selection.model}${effort}`
}

/**
 * Describe a thrown value for display.
 * @param {unknown} error - the caught value.
 * @returns {string} the Error message, or the value as a string.
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
