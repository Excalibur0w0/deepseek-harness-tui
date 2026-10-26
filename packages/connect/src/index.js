/**
 * @dsh-tui/connect — the `/connect` command, after opencode's provider
 * dialog. It lists dsh's configurable provider directory
 * (`ctx.llm.listConfigurableProviders()`), stores an API key through
 * `ctx.credentials`, and records the route through `ctx.settings`, the same
 * services dsh's Web Models page writes through. A custom route asks for its
 * endpoint and protocol and adopts models from `ctx.llm.discoverModels()`.
 */

import { errorMessage } from '@dsh-tui/render'
import { inputPanel, selectPanel, spans } from '@dsh-tui/ui'

/** Stable Cordis plugin name. */
export const name = 'tui-connect'

/** The terminal that shows the panels and the registry the command joins. */
export const inject = ['tuiConsole', 'tuiCommands']

/** Directory routes that sign in through an account flow the TUI does not offer. */
const ACCOUNT_ROUTES = new Set(['deepseek-account'])

/** Wire protocols a custom route may speak, in the order offered. */
const PROTOCOLS = [
  { api: 'openai-completions', label: 'OpenAI Chat Completions', description: '大多数兼容 OpenAI 的服务' },
  { api: 'openai-responses', label: 'OpenAI Responses', description: 'OpenAI 的新接口' },
  { api: 'anthropic-messages', label: 'Anthropic Messages', description: 'Claude 系列和兼容服务' },
]

/** Marks the "custom provider" row in the provider list. */
const CUSTOM = Symbol('custom provider')

/**
 * Register `/connect`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the TUI services.
 */
export function apply(ctx) {
  const terminal = ctx.get('tuiConsole')
  ctx.effect(() => ctx.get('tuiCommands').register({
    name: 'connect',
    help: [['/connect', '连接模型服务：填写 API key，或添加自定义服务']],
    run: () => terminal.exclusive(() => connect(ctx, terminal)),
  }), 'tui command /connect')
}

/**
 * The credential reference a route reads, as dsh's Web Models page derives it.
 * @param {string} provider - route id such as `minimax-cn`.
 * @returns {string} the reference name such as `MINIMAX_CN_API_KEY`.
 */
function deriveKeyRef(provider) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * @param {unknown} value - a settings section.
 * @param {readonly string[]} path - path inside it.
 * @returns {Record<string, unknown> | undefined} the object at `path`, when there is one.
 */
function valueAt(value, path) {
  let node = value
  for (const key of path) node = node !== null && typeof node === 'object' ? node[key] : undefined
  return node !== null && typeof node === 'object' && !Array.isArray(node) ? node : undefined
}

/**
 * @param {{ configured: boolean, source?: string }} info - a credential description.
 * @returns {string} where the stored value comes from, for display.
 */
function sourceLabel(info) {
  return { file: '凭据文件', env: '环境变量' }[info.source] ?? info.source ?? '未知来源'
}

async function connect(ctx, terminal) {
  const llm = ctx.get('llm')
  const credentials = ctx.get('credentials')
  const settings = ctx.get('settings')
  if (llm === undefined || credentials === undefined || settings === undefined) {
    throw new Error('当前 profile 没有模型、凭据或设置服务，无法连接')
  }
  const rows = await providerRows(llm, credentials, settings)
  const { palette } = terminal
  const choice = await selectPanel(terminal, {
    title: '连接模型服务',
    lines: ['选一个服务后填写 API key；列表里没有的，选最后一项「自定义服务」。'],
    filterable: true,
    rows: 12,
    items: [
      ...rows.map(row => ({
        parts: [
          { text: row.connected ? '● ' : '  ', fg: palette.success },
          { text: row.label, fg: palette.text },
        ],
        description: row.note,
        search: `${row.label} ${row.entry.provider}`,
        value: row,
      })),
      { parts: ['  ', { text: '自定义服务…', fg: palette.text }], description: '任何兼容 OpenAI 或 Anthropic 接口的服务', search: 'custom 自定义', value: CUSTOM },
    ],
  })
  if (choice === undefined) return
  if (choice === CUSTOM) await connectCustom(llm, credentials, settings, terminal, rows)
  else await connectKnown(llm, credentials, settings, terminal, choice)
}

/**
 * Join the provider directory with each route's credential state.
 * @returns {Promise<object[]>} rows: DeepSeek first, connected routes next, the rest in directory order.
 */
async function providerRows(llm, credentials, settings) {
  const sections = new Map(settings.describe({ redactSecrets: true }).map(view => [String(view.ns), view.value]))
  const entries = llm.listConfigurableProviders().filter(entry => !ACCOUNT_ROUTES.has(entry.provider))
  const rows = await Promise.all(entries.map(async (entry, order) => {
    const profile = valueAt(sections.get(entry.settingsNs), entry.settingsPath)
    const named = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? profile.apiKeyEnv : undefined
    const ref = named ?? deriveKeyRef(entry.provider)
    // Without a named reference the route also authenticates from its native environment variables.
    const candidates = named === undefined ? [ref, ...entry.nativeAuth?.env ?? []] : [ref]
    const infos = await Promise.all(candidates.map(candidate => credentials.describe(candidate)))
    const found = infos.findIndex(info => info.configured)
    const oauthOnly = named === undefined && entry.nativeAuth?.oauth === true && (entry.nativeAuth.env ?? []).length === 0
    const label = entry.provider === 'deepseek-official' ? 'DeepSeek' : entry.displayName
    const note = entry.provider === 'deepseek-official'
      ? 'DeepSeek 官方 API'
      : oauthOnly ? '只支持账号登录，请在网页版连接'
        : entry.declared === true ? '自定义服务' : undefined
    return {
      entry,
      order,
      label,
      note,
      profile,
      ref,
      oauthOnly,
      connected: found !== -1,
      credential: found === -1 ? undefined : { ref: candidates[found], info: infos[found] },
    }
  }))
  const rank = row => row.entry.provider === 'deepseek-official' ? 0 : row.connected ? 1 : 2
  return rows.sort((left, right) => rank(left) - rank(right) || left.order - right.order)
}

/**
 * Store a key for a route the directory already describes.
 * @param {object} row - the chosen provider row.
 */
async function connectKnown(llm, credentials, settings, terminal, row) {
  if (row.oauthOnly) {
    terminal.note(`${row.label} 只支持账号登录，TUI 里还不能完成登录。请在 dsh 网页版的「模型」设置里连接。`, 'warning')
    return
  }
  const lines = [`key 会保存到 ~/.dsh/.credentials.yaml，名称是 ${row.ref}。`]
  if (row.credential !== undefined) {
    lines.push(`已经配置过（${row.credential.ref}，来自${sourceLabel(row.credential.info)}），输入新的 key 会替换。`)
  }
  const key = await inputPanel(terminal, {
    title: `连接 ${row.label}`,
    lines,
    placeholder: '粘贴 API key',
    mask: true,
    validate: value => value === '' ? '请输入 API key' : undefined,
  })
  if (key === undefined) return
  await credentials.set(row.ref, key)
  const path = row.entry.settingsPath
  if (path.length > 0 && row.profile?.apiKeyEnv === undefined) {
    // A catalog route needs no profile until it names the stored reference.
    await settings.mutate(row.entry.settingsNs, row.profile === undefined
      ? [{ op: 'set', path: [...path], value: { apiKeyEnv: row.ref } }]
      : [{ op: 'set', path: [...path, 'apiKeyEnv'], value: row.ref }])
  }
  await reportConnected(llm, terminal, row.entry.provider, row.label)
}

/**
 * Add a route the directory does not describe: endpoint, protocol, key, and
 * the models to enable, discovered from the endpoint when it lists them.
 * @param {object[]} rows - the current provider rows, for name collisions.
 */
async function connectCustom(llm, credentials, settings, terminal, rows) {
  const settingsNs = rows.find(row => row.entry.settingsPath[0] === 'providers')?.entry.settingsNs ?? 'llm-pi-ai'
  const taken = new Set([...rows.map(row => row.entry.provider), ...llm.listProviders().map(provider => provider.id)])
  const id = await inputPanel(terminal, {
    title: '添加自定义服务（1/4）',
    lines: ['给服务起个名字。只能用小写字母、数字、- 和 _，以后在 /model 里显示成「名字/模型」。'],
    placeholder: 'my-gateway',
    validate: value => !/^[a-z0-9][a-z0-9_-]*$/.test(value)
      ? '只能用小写字母、数字、- 和 _，并以字母或数字开头'
      : taken.has(value) ? `${value} 已经存在，换一个名字` : undefined,
  })
  if (id === undefined) return
  const baseURL = await inputPanel(terminal, {
    title: '添加自定义服务（2/4）',
    lines: ['接口地址，通常以 /v1 结尾。'],
    placeholder: 'https://api.example.com/v1',
    validate: value => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol) ? undefined : '要以 http:// 或 https:// 开头'
      } catch {
        // Not a URL at all; ask again.
        return '这不是一个有效的网址'
      }
    },
  })
  if (baseURL === undefined) return
  const api = await selectPanel(terminal, {
    title: '添加自定义服务（3/4）',
    lines: ['这个服务用哪种接口协议？不确定就选第一个。'],
    items: PROTOCOLS.map(protocol => ({ parts: [protocol.label], description: protocol.description, value: protocol.api })),
  })
  if (api === undefined) return
  const ref = deriveKeyRef(id)
  const key = await inputPanel(terminal, {
    title: '添加自定义服务（4/4）',
    lines: [`API key 会保存到 ~/.dsh/.credentials.yaml，名称是 ${ref}。服务不需要 key 就直接回车。`],
    placeholder: '粘贴 API key',
    mask: true,
  })
  if (key === undefined) return

  terminal.flashStatus('正在获取模型列表…', 'textMuted')
  let discovered = []
  let failure
  try {
    discovered = await llm.discoverModels(settingsNs, { baseURL, api, ...key === '' ? {} : { apiKey: key } })
  } catch (error) {
    failure = errorMessage(error)
  }
  let models
  if (discovered.length > 0) {
    models = await selectPanel(terminal, {
      title: `选择要启用的模型（${id}）`,
      lines: [`服务返回了 ${discovered.length} 个模型。空格勾选，回车确认；什么都不勾就启用当前这一个。`],
      filterable: true,
      multi: true,
      rows: 12,
      items: discovered.map(model => ({
        parts: [model.id],
        description: [model.name !== undefined && model.name !== model.id ? model.name : '', model.inputModalities?.includes('image') ? '能看图' : ''].filter(Boolean).join(' · ') || undefined,
        search: `${model.id} ${model.name ?? ''}`,
        value: model,
      })),
    })
    if (models === undefined) return
  } else {
    const typed = await inputPanel(terminal, {
      title: `填写模型（${id}）`,
      lines: [
        failure === undefined ? '服务没有返回模型列表。' : `获取模型列表失败：${failure}`,
        '手动输入模型 id，多个用逗号分隔。',
      ],
      placeholder: 'model-a, model-b',
      validate: value => value === '' ? '至少填一个模型 id' : undefined,
    })
    if (typed === undefined) return
    models = typed.split(/[,，\s]+/).filter(Boolean).map(modelId => ({ id: modelId }))
  }

  if (key !== '') await credentials.set(ref, key)
  await settings.mutate(settingsNs, [{
    op: 'set',
    path: ['providers', id],
    value: {
      displayName: id,
      api,
      baseURL,
      ...key === '' ? {} : { apiKeyEnv: ref },
      models: models.map(modelEntry),
    },
  }])
  await reportConnected(llm, terminal, id, id)
}

/**
 * @param {{ id: string, name?: string, contextWindow?: number, maxTokens?: number, inputModalities?: string[] }} model - a discovered or typed model.
 * @returns {Record<string, unknown>} the llm-pi-ai model entry.
 */
function modelEntry(model) {
  const input = model.inputModalities?.filter(modality => modality === 'text' || modality === 'image')
  return {
    id: model.id,
    ...model.name !== undefined && model.name !== model.id ? { name: model.name } : {},
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...input === undefined || input.length === 0 ? {} : { input },
  }
}

/**
 * Report the connected route and how many models it now serves.
 * @param {string} provider - route id.
 * @param {string} label - display name.
 */
async function reportConnected(llm, terminal, provider, label) {
  // Settings writes apply live; the route re-registers on the next tick.
  await new Promise(resolve => setTimeout(resolve, 50))
  const models = await llm.listModels(provider).catch(() => [])
  const { palette } = terminal
  terminal.note(spans(
    { text: '已连接 ', fg: palette.success },
    { text: label, fg: palette.text, bold: true },
    models.length > 0 ? `，可用 ${models.length} 个模型。用 /model 切换。` : '。模型列表暂时为空，可以稍后用 /model 查看。',
  ))
}
