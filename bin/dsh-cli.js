#!/usr/bin/env node
// Launcher for dsh-cli. OpenTUI calls its native core through node:ffi, which
// needs Node >= 26.4 built with FFI and started with --experimental-ffi, while
// this script may run on any Node (a version manager's default, say). It picks
// a Node that has FFI, makes sure the dsh profile loads this package as a
// bundle, and starts dsh in a child process with the caller's cwd, which
// becomes the agent's workspace.
//
// dsh comes from this package's own dependency unless DSH_REPO names a
// deepseek-harness source checkout, which is then started through tsx the way
// `pnpm dsh` does.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NAME = '@dsh-sdk/cli'
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
const FFI_FLAGS = ['--experimental-ffi', '--disable-warning=ExperimentalWarning']
const PROFILE = process.env.DSH_CLI_PROFILE?.trim() || 'tui'

function fail(...lines) {
  for (const line of lines) process.stderr.write(`dsh-cli：${line}\n`)
  process.exit(1)
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

// Mirrors dsh's resolveDshHome: a blank DSH_HOME counts as unset.
function dshHome() {
  const configured = process.env.DSH_HOME
  return resolve(expandHome(configured?.trim() ? configured : join(homedir(), '.dsh')))
}

function hasFfi(node) {
  const probe = spawnSync(node, [...FFI_FLAGS, '--input-type=module', '-e', "await import('node:ffi')"], { stdio: 'ignore' })
  return probe.status === 0
}

function findNode() {
  const userNode = process.platform === 'win32' ? 'node.exe' : join('bin', 'node')
  const candidates = [
    process.env.DSH_TUI_NODE,
    process.execPath,
    join(homedir(), '.local', 'share', 'dsh-tui', 'node', userNode),
    'node',
  ]
  for (const candidate of candidates) {
    if (candidate && hasFfi(candidate)) return candidate
  }
  fail(
    '找不到支持 node:ffi 的 Node.js（需要 nodejs.org 官方构建的 26.4 或更新版本）。',
    '用 nvm 装一个 Node 26，或者把官方压缩包解压到 ~/.local/share/dsh-tui/node，也可以用 DSH_TUI_NODE 指定 node 的路径。',
    'Homebrew 的 Node 编译时没带 FFI，不能用。',
  )
}

// The node arguments that start dsh, and extra environment for them.
function dshEntry() {
  const repo = process.env.DSH_REPO?.trim()
  if (repo) {
    const checkout = resolve(expandHome(repo))
    const bin = join(checkout, 'apps', 'cli', 'src', 'bin.ts')
    const tsx = join(checkout, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
    if (!existsSync(bin)) fail(`DSH_REPO 指向的 ${checkout} 不是 deepseek-harness 源码目录。`)
    if (!existsSync(tsx)) fail(`${checkout} 还没装依赖，先在里面执行 pnpm install。`)
    // dsh's workspace packages resolve through tsconfig.base.json paths.
    return { args: ['--import', pathToFileURL(tsx).href, bin], env: { TSX_TSCONFIG_PATH: join(checkout, 'tsconfig.json') } }
  }
  try {
    createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  } catch {
    fail(`${ROOT} 里没有 @deepseek-ai/dsh，先在这个目录执行 pnpm install。`)
  }
  return { args: [join(ROOT, 'bin', 'run.js')], env: {} }
}

function realpathOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

// Whether the profile already loads this very directory as a bundle: its
// manifest links NAME here and lists it, and the link exists on disk.
function profileLinksHere(profileDir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return false
  }
  const spec = manifest.dependencies?.[NAME]
  if (typeof spec !== 'string' || !spec.startsWith('link:')) return false
  if (!manifest.dsh?.profile?.bundles?.includes(NAME)) return false
  return realpathOrNull(resolve(profileDir, spec.slice('link:'.length))) === ROOT
    && realpathOrNull(join(profileDir, 'node_modules', NAME)) === ROOT
}

function run(node, args, env, forwardSignals = false) {
  return new Promise(done => {
    const child = spawn(node, args, { stdio: 'inherit', env: { ...process.env, ...env } })
    // The terminal delivers Ctrl-C to the whole foreground group, so the child
    // already receives SIGINT; the launcher only has to outlive it.
    const ignore = () => {}
    const forward = signal => child.kill(signal)
    process.on('SIGINT', ignore)
    if (forwardSignals) {
      process.on('SIGTERM', forward)
      process.on('SIGHUP', forward)
    }
    child.on('error', error => fail(`无法启动 ${node}：${error.message}`))
    child.on('exit', (code, signal) => {
      process.off('SIGINT', ignore)
      process.off('SIGTERM', forward)
      process.off('SIGHUP', forward)
      done(code ?? 128 + (constants.signals[signal] ?? 0))
    })
  })
}

const node = findNode()
const dsh = dshEntry()
const profileDir = join(dshHome(), 'profiles', PROFILE)

if (!profileLinksHere(profileDir)) {
  process.stderr.write(`dsh-cli：把 ${ROOT} 装进 dsh 的 ${PROFILE} profile…\n`)
  const code = await run(node, [...FFI_FLAGS, ...dsh.args, 'plugin', '--profile', PROFILE, 'add', ROOT], dsh.env)
  if (code !== 0) fail(`没能装进 ${PROFILE} profile（退出码 ${code}），上面是 dsh 的输出。`)
}

process.exit(await run(node, [...FFI_FLAGS, ...dsh.args, '--profile', PROFILE, ...process.argv.slice(2)], dsh.env, true))
