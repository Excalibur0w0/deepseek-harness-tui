/**
 * @dsh-tui/connect — the `/connect` command, after opencode's provider
 * dialog. It lists dsh's configurable provider directory
 * (`ctx.llm.listConfigurableProviders()`), stores an API key through
 * `ctx.credentials`, and records the route through `ctx.settings`, the same
 * services dsh's Web Models page writes through. A custom route asks for its
 * endpoint and protocol and adopts models from `ctx.llm.discoverModels()`,
 * adding the input modalities the endpoint's listing reports, which dsh's
 * listing parser does not keep.
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

/** API keys are header values: visible ASCII without spaces. */
const KEY_PATTERN = /^[\x21-\x7e]+$/

/** How long a just-written route may take to register before its models are reported. */
const REGISTRATION_WAIT_MS = 2000

/** How long the modality lookup may take before the picker shows models without it. */
const LISTING_TIMEOUT_MS = 15_000

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
 * Refuse a pasted value that cannot be an API key, such as text copied by
 * mistake: dsh rejects a key with characters an HTTP header cannot carry only
 * at request time, after it has been stored.
 * @param {string} value - the trimmed input.
 * @param {boolean} [optional] - whether an empty value is allowed.
 * @returns {string | undefined} the problem to show, or undefined when the value is usable.
 */
function keyProblem(value, optional = false) {
  if (value === '') return optional ? undefined : '请输入 API key'
  if (KEY_PATTERN.test(value)) return undefined
  return '这不像 API key：里面有空格、中文或全角符号。请重新复制 key 再粘贴'
}

/**
 * @param {{ configured: boolean, source?: string }} info - a credential description.
 * @returns {string} where the stored value comes from, for display.
 */
function sourceLabel(info) {
  return { file: '凭据文件', env: '环境变量', 'project-env': '项目的 .env', 'user-env': '~/.dsh/.env' }[info.source] ?? info.source ?? '未知来源'
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
  else if (isCustomRoute(choice)) await manageCustom(llm, credentials, settings, terminal, choice, rows)
  else await connectKnown(llm, credentials, settings, terminal, choice)
}

/**
 * @param {object} row - a provider row.
 * @returns {boolean} whether the row is a route configuration declares, with its own endpoint.
 */
function isCustomRoute(row) {
  return row.entry.declared === true && typeof row.profile?.baseURL === 'string'
}

/**
 * Offer what can change on a custom route: its models, its key, or the route itself.
 * @param {object} row - the chosen custom route.
 * @param {object[]} rows - every provider row, to tell whether its key is shared.
 */
async function manageCustom(llm, credentials, settings, terminal, row, rows) {
  const count = Array.isArray(row.profile.models) ? row.profile.models.length : 0
  const action = await selectPanel(terminal, {
    title: `管理 ${row.label}`,
    lines: [`${row.profile.baseURL} · 已启用 ${count} 个模型`],
    items: [
      { parts: ['增减模型'], description: '从服务拉取最新列表，已启用的预先勾好', value: 'models' },
      { parts: ['更换 API key'], value: 'key' },
      { parts: ['删除这个服务'], description: '从配置里移除，模型不再出现在 /model', value: 'delete' },
    ],
  })
  if (action === 'models') await reselectModels(llm, credentials, settings, terminal, row)
  else if (action === 'key') await connectKnown(llm, credentials, settings, terminal, row)
  else if (action === 'delete') await deleteCustom(credentials, settings, terminal, row, rows)
}

/**
 * Re-pick a custom route's models from its endpoint's current listing. Kept
 * models keep their configured entries, such as a hand-added `input`.
 * @param {object} row - the custom route.
 */
async function reselectModels(llm, credentials, settings, terminal, row) {
  const { provider } = row.entry
  const { baseURL, api } = row.profile
  terminal.flashStatus('正在获取模型列表…', 'textMuted')
  let discovered
  try {
    // Naming the route lets dsh use its stored key and headers.
    discovered = await llm.discoverModels(row.entry.settingsNs, { provider, baseURL, ...typeof api === 'string' ? { api } : {} })
  } catch (error) {
    terminal.note(`获取 ${row.label} 的模型列表失败：${errorMessage(error)}`, 'error')
    return
  }
  const key = (await credentials.resolve(row.ref).catch(() => undefined))?.value ?? ''
  discovered = withListingModalities(discovered, await listingModalities(baseURL, api, key))
  const current = new Map((Array.isArray(row.profile.models) ? row.profile.models : []).map(model => [model.id, model]))
  const listed = new Set(discovered.map(model => model.id))
  // Models the endpoint no longer lists stay pickable, so keeping them is a choice.
  const candidates = [...discovered, ...[...current.values()].filter(model => !listed.has(model.id))]
  const picked = await pickModels(terminal, row.label, candidates, model => current.has(model.id))
  if (picked === undefined) return
  const models = picked.map(model => current.get(model.id) ?? modelEntry(model))
  await settings.mutate(row.entry.settingsNs, [{ op: 'set', path: [...row.entry.settingsPath, 'models'], value: models }])
  const added = models.filter(model => !current.has(model.id)).length
  const removed = [...current.keys()].filter(id => !models.some(model => model.id === id)).length
  terminal.note(`已更新 ${row.label}：启用 ${models.length} 个模型（新增 ${added} 个，移除 ${removed} 个）。`, 'success')
}

/**
 * Remove a custom route, and its key when no other route reads it.
 * @param {object} row - the custom route.
 * @param {object[]} rows - every provider row.
 */
async function deleteCustom(credentials, settings, terminal, row, rows) {
  const confirmed = await selectPanel(terminal, {
    title: `删除 ${row.label}？`,
    lines: ['它的模型会从 /model 里消失。之后想用可以重新添加。'],
    initial: 1,
    items: [{ parts: ['删除'], value: true }, { parts: ['取消'], value: false }],
  })
  if (confirmed !== true) return
  await settings.mutate(row.entry.settingsNs, [{ op: 'unset', path: [...row.entry.settingsPath] }])
  const shared = rows.some(other => other !== row && other.ref === row.ref && other.profile !== undefined)
  if (!shared && row.credential?.info.source === 'file') await credentials.unset(row.ref)
  terminal.note(`已删除 ${row.label}${shared ? '' : row.credential?.info.source === 'file' ? `，并移除了保存的 key（${row.ref}）` : ''}。`, 'success')
}

/**
 * Let the user check models; shared by adding a custom route and re-picking its models.
 * @param {string} label - the route's display name.
 * @param {object[]} candidates - models to offer.
 * @param {(model: object) => boolean} [isChecked] - models checked when the panel opens.
 * @returns {Promise<object[] | undefined>} the checked models, or undefined when cancelled.
 */
function pickModels(terminal, label, candidates, isChecked = () => false) {
  return selectPanel(terminal, {
    title: `选择要启用的模型（${label}）`,
    lines: [`共 ${candidates.length} 个模型。空格勾选，ctrl+a 全选当前过滤出的模型，回车确认。`],
    filterable: true,
    multi: true,
    checked: isChecked,
    rows: 12,
    items: candidates.map(model => ({
      parts: [model.id],
      description: [model.name !== undefined && model.name !== model.id ? model.name : '', model.inputModalities?.includes('image') || model.input?.includes('image') ? '能看图' : ''].filter(Boolean).join(' · ') || undefined,
      search: `${model.id} ${model.name ?? ''}`,
      value: model,
    })),
  })
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
    validate: value => keyProblem(value),
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
    validate: value => keyProblem(value, true),
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
  if (discovered.length > 0) discovered = withListingModalities(discovered, await listingModalities(baseURL, api, key))
  let models
  if (discovered.length > 0) {
    models = await pickModels(terminal, id, discovered)
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
 * Read each model's input modalities from an OpenAI-style `GET {baseURL}/models`
 * listing. dsh's discovery parser keeps only ids, names, and capacities, while
 * gateways report modalities in their own fields: OpenRouter under
 * `architecture.input_modalities`, models.dev-style directories under
 * `modalities.input`, others as `input_modalities` or a `vision` flag.
 * Best effort: any failure returns an empty map.
 * @param {string} baseURL - the endpoint root.
 * @param {string} api - the route's protocol; Anthropic listings report no modalities.
 * @param {string} key - the API key, or empty.
 * @returns {Promise<Map<string, string[]>>} modalities by model id.
 */
async function listingModalities(baseURL, api, key) {
  const found = new Map()
  if (api === 'anthropic-messages') return found
  let reply
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: key === '' ? {} : { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
    })
    if (!response.ok) return found
    reply = await response.json()
  } catch {
    // Unreachable, slow, or not JSON: the picker shows the models without modalities.
    return found
  }
  const entries = Array.isArray(reply) ? reply
    : Array.isArray(reply?.data) ? reply.data
      : reply?.models !== null && typeof reply?.models === 'object' ? Object.entries(reply.models).map(([id, entry]) => ({ id, ...entry }))
        : []
  for (const entry of entries) {
    if (typeof entry?.id !== 'string') continue
    const listed = [entry.architecture?.input_modalities, entry.input_modalities, entry.modalities?.input].find(Array.isArray)
    const flag = entry.capabilities?.vision ?? entry.supports_vision
    const vision = listed?.includes('image') ?? (typeof flag === 'boolean' ? flag : undefined)
    if (vision !== undefined) found.set(entry.id, vision ? ['text', 'image'] : ['text'])
  }
  return found
}

/**
 * Fill in modalities the discovery reply left out.
 * @param {Array<{ id: string, inputModalities?: string[] }>} models - discovered models.
 * @param {Map<string, string[]>} modalities - modalities by model id from the raw listing.
 * @returns {Array<object>} the models, each with modalities when either source has them.
 */
function withListingModalities(models, modalities) {
  return models.map(model => model.inputModalities !== undefined || !modalities.has(model.id)
    ? model
    : { ...model, inputModalities: modalities.get(model.id) })
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
 * Report the connected route and how many models it now serves, or why its
 * models cannot be listed, such as a key dsh refuses.
 * @param {string} provider - route id.
 * @param {string} label - display name.
 */
async function reportConnected(llm, terminal, provider, label) {
  const { palette } = terminal
  // Settings writes apply live, but the route registers asynchronously.
  const deadline = Date.now() + REGISTRATION_WAIT_MS
  let models = []
  let failure
  while (true) {
    try {
      models = await llm.listModels(provider)
      failure = undefined
    } catch (error) {
      failure = error
    }
    if (failure?.code !== 'NO_ADAPTER' || Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (failure !== undefined) {
    terminal.note(spans(
      { text: '已保存 ', fg: palette.warning },
      { text: label, fg: palette.text, bold: true },
      `，但列模型时出错：${errorMessage(failure)}`,
    ))
    return
  }
  terminal.note(spans(
    { text: '已连接 ', fg: palette.success },
    { text: label, fg: palette.text, bold: true },
    models.length > 0 ? `，可用 ${models.length} 个模型。用 /model 切换。` : '，但这个服务没有列出任何模型。',
  ))
}
