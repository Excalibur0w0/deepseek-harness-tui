/**
 * @dsh-sdk/commands — the TUI's slash-command registry, provided as
 * `ctx.tuiCommands`, the prompt's `/` completions, and the built-in commands
 * /help, /model, /new, /session, and /exit. Another plugin adds a command
 * with `ctx.effect(() => ctx.tuiCommands.register(command))`.
 */

import { errorMessage, formatSelection } from '@dsh-sdk/render'
import { selectPanel, spans } from '@dsh-sdk/ui'

/** Stable Cordis plugin name. */
export const name = 'tui-commands'

/** The terminal commands print to and the controller they act on. */
export const inject = ['tuiConsole', 'tuiChat']

/**
 * @typedef {object} TuiCommand
 * @property {string} name - command name without the slash.
 * @property {string[]} [aliases] - other names that run the same command; not listed by /help.
 * @property {Array<[string, string]>} help - /help lines as [syntax, description] pairs.
 * @property {(args: string) => unknown} run - handler for the text after the name; may return a Promise.
 */

/** Key bindings listed by /help after the commands. */
const KEY_HELP = [
  ['enter', '发送；运行中按下则排队，当前回合结束后发送'],
  ['shift+enter', '换行（也可以 alt+enter、ctrl+j）'],
  ['esc', '运行中中断当前回合'],
  ['ctrl+c', '复制选中的文字；运行中中断；空闲时清空输入，连按两次退出'],
  ['ctrl+d', '输入为空时退出'],
  ['ctrl+v', '粘贴剪贴板里的图片或文字；把图片文件拖进终端也会作为图片附上'],
  ['↑ / ↓', '翻看输入历史'],
  ['pgup / pgdn', '滚动对话；也可以用鼠标滚轮'],
  ['ctrl+t', '展开或折叠思考过程'],
]

/** Models visible at once in the /model panel. */
const MODEL_ROWS = 10

/**
 * Provide the registry and register the built-in commands.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the TUI services.
 */
export function apply(ctx) {
  const terminal = ctx.get('tuiConsole')
  const chat = ctx.get('tuiChat')
  const registry = new CommandRegistry(terminal)
  ctx.provide('tuiCommands', registry)
  ctx.effect(() => terminal.setCompletionProvider(prefix => registry.list()
    .filter(command => command.name.startsWith(prefix))
    .map(command => ({ name: command.name, description: command.help[0]?.[1] ?? '' }))), 'tui command completions')

  /** @type {TuiCommand[]} */
  const builtins = [
    {
      name: 'help',
      help: [['/help', '显示帮助']],
      run: () => { terminal.note(helpText(terminal.palette, registry.list())) },
    },
    {
      name: 'model',
      help: [['/model', '选择模型（当前会话）'], ['/model <p>/<m>', '直接切换到 provider/model']],
      run: argument => switchModel(ctx, terminal, chat, argument),
    },
    {
      name: 'new',
      help: [['/new', '开始新会话']],
      run: async () => {
        const agent = await chat.newSession()
        terminal.note(`已开始新会话 ${agent.id}`)
      },
    },
    {
      name: 'session',
      help: [['/session', '显示当前会话信息']],
      run: () => {
        const { palette } = terminal
        const row = (label, value) => [{ text: `${label}  `, fg: palette.textMuted }, { text: `${value}\n`, fg: palette.text }]
        terminal.note(spans(
          ...row('会话', chat.agent.id),
          ...row('模型', formatSelection(chat.currentModel())),
          ...row('目录', chat.cwd),
        ))
      },
    },
    {
      name: 'exit',
      aliases: ['quit'],
      help: [['/exit', '保存并退出（也可以 ctrl+d）']],
      run: () => chat.quit(0),
    },
  ]
  for (const command of builtins) ctx.effect(() => registry.register(command), `tui command /${command.name}`)
}

class CommandRegistry {
  /**
   * @param {{ note(content: unknown, tone?: string): void }} terminal - where unknown commands and failures are reported.
   */
  constructor(terminal) {
    this.terminal = terminal
    /** Commands by name and alias, in registration order. */
    this.commands = new Map()
  }

  /**
   * Register a command.
   * @param {TuiCommand} command - the command definition.
   * @returns {() => void} disposer that unregisters exactly this command.
   * @throws when the name or an alias is already registered.
   */
  register(command) {
    const names = [command.name, ...(command.aliases ?? [])]
    const taken = names.find(name => this.commands.has(name))
    if (taken !== undefined) throw new Error(`tui-commands: /${taken} is already registered`)
    for (const name of names) this.commands.set(name, command)
    return () => {
      for (const name of names) {
        if (this.commands.get(name) === command) this.commands.delete(name)
      }
    }
  }

  /** @returns {TuiCommand[]} the registered commands, in registration order. */
  list() {
    return [...new Set(this.commands.values())]
  }

  /**
   * Run one slash-command line, reporting an unknown name or a failure in the transcript.
   * @param {string} line - the input line, starting with `/`.
   * @returns {Promise<boolean>} whether the line named a registered command.
   */
  async execute(line) {
    const [head, ...rest] = line.trim().split(/\s+/)
    const command = this.commands.get(head.slice(1))
    if (command === undefined) {
      this.terminal.note(`未知命令 ${head}，输入 /help 查看`, 'warning')
      return false
    }
    try {
      await command.run(rest.join(' '))
    } catch (error) {
      this.terminal.note(`错误：${errorMessage(error)}`, 'error')
    }
    return true
  }
}

/**
 * @param {Readonly<Record<string, string>>} palette - theme colors.
 * @param {TuiCommand[]} commands - registered commands.
 * @returns {import('@opentui/core').StyledText} the /help text.
 */
function helpText(palette, commands) {
  const row = ([syntax, description]) => [{ text: `  ${syntax.padEnd(16)}`, fg: palette.text }, { text: `${description}\n`, fg: palette.textMuted }]
  return spans(
    { text: '命令\n', fg: palette.accent, bold: true },
    ...commands.flatMap(command => command.help.flatMap(row)),
    { text: '\n按键\n', fg: palette.accent, bold: true },
    ...KEY_HELP.flatMap(row),
  )
}

/**
 * Switch the current Session's model, from the argument or a filterable list.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the model service.
 * @param {object} terminal - the TUI console.
 * @param {object} chat - the TUI conversation controller.
 * @param {string} argument - `<provider>/<model>`, or empty to pick from a list.
 */
async function switchModel(ctx, terminal, chat, argument) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('模型服务不可用')
  let target
  if (argument !== '') {
    const slash = argument.indexOf('/')
    if (slash <= 0) throw new Error('格式：/model <provider>/<model>')
    target = { provider: argument.slice(0, slash), model: argument.slice(slash + 1) }
  } else {
    const lists = await Promise.all(llm.listProviders().map(provider =>
      llm.listModels(provider.id).then(
        models => models,
        // A provider without credentials cannot list models; leave it out.
        () => [],
      )))
    const models = lists.flat()
    if (models.length === 0) throw new Error('没有可用模型，请先配置模型提供商')
    target = await terminal.exclusive(() => pickModel(terminal, models, chat.currentModel()))
    if (target === undefined) return
  }
  chat.selectModel(target)
  terminal.note(spans('已切换到 ', { text: formatSelection(target), fg: terminal.palette.accent }, '（下一次请求生效）'))
}

/**
 * Pick a model in a panel: type to filter, ↑↓ to move, enter to choose.
 * @returns {Promise<{ provider: string, model: string } | undefined>} the choice, or undefined when cancelled.
 */
function pickModel(terminal, models, current) {
  const { palette } = terminal
  const isCurrent = model => model.provider === current.provider && model.id === current.model
  return selectPanel(terminal, {
    title: '选择模型',
    filterable: true,
    initial: Math.max(0, models.findIndex(isCurrent)),
    items: models.map(model => ({
      parts: [
        { text: isCurrent(model) ? '● ' : '  ', fg: palette.success },
        { text: `${model.provider}/`, fg: palette.textMuted },
        { text: model.id, fg: palette.text },
      ],
      description: model.name !== model.id ? model.name : undefined,
      search: `${model.provider}/${model.id} ${model.name}`,
      value: { provider: model.provider, model: model.id },
    })),
  })
}
