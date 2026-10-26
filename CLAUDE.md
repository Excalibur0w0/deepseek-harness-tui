# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本仓库是 DeepSeek Harness（dsh）的全屏终端对话界面，界面照 opencode 的会话页做，用 OpenTUI 渲染。它是一个 pnpm monorepo：根目录是装进 `tui` profile 的 bundle，`packages/` 下是运行在 dsh 进程内的几个 Cordis 插件和两个库。用法见 `README.md`；本文件只记录开发命令、运行时约束，以及需要去 dsh 仓库和 opencode 源码对照的接口，不重复 README。行为或限制变化后同步更新 `README.md`。

## 常用命令

```sh
pnpm install      # 建立 packages/* 的 workspace 链接并安装 OpenTUI；新增或改名子包、改依赖后重跑
pnpm check        # 对 packages/*/src/*.js 逐个 node --check（没有构建）

# 运行：在任意目录启动，agent 的工作区就是当前目录
dshcli                                         # ~/.local/bin/dshcli -> bin/dshcli
DSH_REPO=/path/to/deepseek-harness dshcli      # dsh 仓库不在同级目录 ../deepseek-harness 时
DSH_TUI_NODE=/path/to/node dshcli              # 指定带 node:ffi 的 Node

# 以下在 dsh 仓库执行
pnpm dsh --profile tui --dump-config           # 确认有 "# == deepseek-harness-tui" 层、tui-* 行和 tool-ask-user 行
pnpm dsh plugin --profile tui add "$(cd ../deepseek-harness-tui && pwd)"   # 重新安装
```

- 改代码后重启 `dshcli` 即生效：profile 以 `link:` 指向本仓库根目录。改了根 `package.json` 的 `dsh` 或 `engines` 字段才需要重新 add。
- 不要用 `pnpm dsh --profile tui` 跑 TUI：pnpm 脚本总在 dsh 仓库根目录执行，工作区会变成 dsh 仓库，而且 pnpm 用的 Node 不带 FFI。`bin/dshcli` 保留调用者的 cwd，挑一个带 `node:ffi` 的 Node 并加 `--experimental-ffi --disable-warning=ExperimentalWarning`，再把 `TSX_TSCONFIG_PATH` 指向 dsh 仓库的 `tsconfig.json`，复现 `pnpm dsh` 的 tsx 源码启动。
- 带 FFI 的 Node 默认放在 `~/.local/share/dsh-tui/node`（nodejs.org 的官方构建，`node` 是指向版本目录的符号链接）。Homebrew 的 Node 编译时没带 FFI，`--experimental-ffi` 会报 bad option。

## 验证

- 没有测试套件和 linter。TUI 要求 stdin 和 stdout 都是 TTY，在 Bash 工具里直接运行会报错退出（`--help` 和非 TTY 报错这两条路径可以直接跑）；`script` 命令在这个沙箱里也拿不到 TTY。
- 交互验证分两步：
  1. 用 Python `pty.fork()` 启动 `bin/dshcli`，窗口设成 120×40，按步骤写入输入并把原始输出录下来。
     - 普通字符逐个写入；转义序列（方向键 `\x1b[C`）必须一次写完，拆开会被解析成单独的 Esc。
     - 回车写 `\r`，Ctrl-C 写 `\x03`，Ctrl-T 写 `\x14`，Esc 单独写 `\x1b`。
     - 以状态栏的「发送」判断就绪，以回合脚注的 `▣` 判断回合结束，以「需要确认」「enter 确认」判断面板出现。
  2. 再用 `@xterm/headless`（dsh 的 pnpm store 里有 6.0.0）把录下的字节回放成屏幕文本来检查。查看时保留空行，否则看不出块之间的间距。
- 交互验证会调用真实模型，先确认 tui profile 配置的模型服务可用。本机的模型服务、网关和注意事项写在不入库的 `CLAUDE.local.md` 里。
- 测审批时选一个会被 workspace-write 沙箱拦下的操作，例如写 `~` 下的文件（`/tmp` 可写，不会触发审批），并选「拒绝」。测提问让模型调用 `ask_user_question`。每次验证都会在 `~/.dsh/sessions` 留下会话。
- 中文输入法、鼠标滚动和复制在 pty 里测不了，要请用户在真实终端里试。

## 架构

- `cordis.patch.yml` 是叠在 `@deepseek-ai/dsh-base` 之后的 bundle 层：
  - 插入 5 个 `tui-*` 行，加上 `tool-ask-user`（`dsh-base` 不带 `ask_user_question` 工具）。
  - 覆盖 `system-prompt` 的 `personaPrefix`，关闭 `hmr`（配置热重载会在对话中途重新挂载 TUI）。
  - 行里按包名写插件（`name: '@dsh-tui/chat'`）：dsh 从 bundle 的 `package.json` 出发遍历 `dependencies`，为 bundle 建解析条目，所以根 `package.json` 用 `workspace:*` 列出每个插件包。
- 插件之间不互相 import，只通过 `ctx.provide` 的服务和 Cordis 事件协作。
  - 服务是普通对象，`ctx.get()` 拿到的就是原对象（没有 tracker 就不包代理），可以直接比较 Agent 身份。
  - 依赖方向：`chat → console`，`transcript`/`commands → chat, console`，`interaction → console`。`chat` 用 `ctx.get('tuiCommands')`、`interaction` 用 `ctx.get('tuiChat')` 按需获取，不写进 `inject`，避免成环。
  - 事件：
    - console 发 `tui/submit`、`tui/interrupt`（`'ctrl-c'`/`'escape'`）、`tui/close`、`tui/toggle-thinking`；
    - chat 发 `tui/queued`（排队的文本）；
    - interaction 发 `tui/approval`（callId、outcome），transcript 据此划掉被拒绝的工具行。
- `packages/ui`：唯一 import `@opentui/core` 的包，其他包都用它重新导出的类，保证全仓库只加载一份 OpenTUI。
  - 构件：`splitBlock`（opencode 的左 `┃` 竖线块）、`spans()`（字符串和 `{ text, fg, bg, bold, strikethrough… }` 拼成 `StyledText`）、`Spinner`、`createSyntaxStyles`、`panelFrame`、`ListView`、`keyHints`、`discard`。
- `packages/render`：纯函数，不碰 OpenTUI。
  - 主题：opencode 默认暗色色板 `darkPalette`，`NO_COLOR` 时用 `monochromePalette`；`syntaxRules` 移植自 opencode `theme/index.ts` 的 `getSyntaxRules`。
  - 工具：`toolView` 把 dsh 工具名映射成 opencode 风格的图标和中文标题；`unifiedDiff` 把 dsh-tool-fs 的 `meta.diffs` 转成 unified diff。
- `packages/console`（`tuiConsole`）：OpenTUI 全屏宿主。
  - 布局：`apply` 处理 `--help` 和 TTY 检查，不满足时不提供服务，下游插件就不会挂载。`open()` 创建备用屏幕渲染器，布局是 ScrollBox 对话区、`/` 补全列表、输入框（Textarea 加模型行和 `╹▀` 半高底边）、面板槽位、状态栏。
  - 按键：都在 `renderer.keyInput` 的全局 keypress 里处理，处理了就 `preventDefault()`，没处理的才会到输入框。
    - 面板打开时所有键交给面板；面板的 `onKey` 返回 `false` 时放行给面板自己的输入框。
  - 接口：
    - 对话区：`append()`、`clearTranscript()`、`note()`
    - 输入框和状态栏：`setMeta()`、`setBusy()`、`flashStatus()`、`setCompletionProvider()`
    - 面板：`runPanel(build, signal)`，以及串行化所有面板的 `exclusive(task)`
  - stderr：渲染器运行期间截获 `process.stderr.write`，状态栏显示条数，`close()` 销毁渲染器后再写回。
- `packages/chat`（`tuiChat`）：唯一 import dsh 运行时的包。
  - 启动：`start()` 先 `await ctx.get('loader')?.await()`，再创建 Agent、`await console.open()`、设置模型行。
  - 发送：`agent.followup(createUserMessage(...))`，然后循环 `agent.whenIdle()` + `subagents.waitForChildren()`，直到 Agent 和子 agent 都空闲（与 `dsh-headless` 相同），结束后 `sessions.flush()`。
  - 输入路由：运行中回车排队 followup；Esc/Ctrl-C 调 `agent.cancel({ kind: 'user' })`，这会同时清空排队的消息。空闲时 `/` 开头交给 `tuiCommands.execute()`，其余作为消息发送。
  - 退出：`quit()` 取消运行中的回合、flush、`await console.close()`，回到主屏后打印「会话已保存」，再调 `ctx.appExit(code)`。
- `packages/transcript`：只渲染 `tuiChat.agent` 的输出，部件对应 opencode `routes/session/index.tsx` 的 `UserMessage`、`ReasoningPart`、`TextPart`、`InlineTool`、`BlockTool`、`AssistantMessage` 脚注。
  - 数据来源：正文和思考来自进程内的 `agent/assistant-stream`（逐字增量只在进程内广播，SDK 和官方 ACP 都拿不到）；用户消息、工具调用和结果、回合起止来自持久化的 `session/event`（`tool/result` 只渲染 `surfaceOp === 'append'`）。
  - 间距：连续的行内工具行之间不空行，其余部件之间空一行。
- `packages/interaction`：`approval/request` 和 `user-questions/request` 都是 waterfall。
  - 它是 profile 里唯一的终端答题者，回答所有 agent（包括子 agent）的请求；TUI 关闭或 `tuiChat.closing` 后必须 `return next()`。
  - 它自己记录所有 session 的 `tool/call`，审批面板据此显示要批准的工具行。
- `packages/commands`（`tuiCommands`）：`register({ name, aliases?, help, run })` 返回注销函数，调用方用 `ctx.effect()` 包住。
  - `/help` 和 `/` 补全都由注册表生成。
  - 内置命令 `/help`、`/model`（可过滤的选择面板）、`/new`、`/session`、`/exit`（别名 `/quit`）。

## 运行时约束

- 纯 ESM JavaScript，不构建。不要改成 TypeScript：npm 安装的 dsh 不经 tsx 加载插件。不要引入 JSX：opencode 的 Solid 组件只能对照着用 OpenTUI 的命令式接口重写。
- OpenTUI：
  - **版本**：`@opentui/core` 用精确版本（现为 0.6.8），它的 peer `web-tree-sitter` 也写进 `ui` 的 `dependencies`（因为 `autoInstallPeers: false`）。升级时先在 scratchpad 里用最小脚本验证；0.6 起 `SyntaxStyle.fromTheme/fromStyles` 的第二个参数要传 `renderer.nativeScene`。
  - **运行要求**：OpenTUI 在 Node 上依赖 `node:ffi`，需要 Node ≥ 26.4，且编译时带 FFI，启动时加 `--experimental-ffi`。
  - **代码高亮**：只启用了 OpenTUI 内置的 javascript、typescript、markdown、zig parser，不在线下载其他语言。
- 运行时只有 `packages/chat` import `@deepseek-ai/dsh-agent` 和 `@deepseek-ai/dsh-llm`，由 dsh 的 peer 拦截解析到宿主 dsh 自己的副本。
  - 某个子包新增 dsh 运行时 import 时，必须加进**该子包**的 `peerDependencies`；拦截按 import 所在文件向上找最近的 `package.json` 判断。
  - 其余 dsh 能力用 `ctx.get('<service>')` 获取。
  - `pnpm-workspace.yaml` 设了 `autoInstallPeers: false`，不会从 registry 装 dsh 的副本。
- peer 拦截只覆盖 profile 里直接 `link:` 的目录。所以只能 link 仓库根目录，不能单独 `plugin add` 某个子包，否则其他子包里的 dsh import 会找不到宿主副本。规则见 dsh 仓库的 `.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.md`。
- 新增插件包：
  1. 在 `packages/<名字>/` 建 `package.json`：`@dsh-tui/<名字>`、`exports`、`engines.dsh`，`dependencies` 里写用到的 `@dsh-tui/render`、`@dsh-tui/ui`（`workspace:*`）。每个插件行的包都要过 dsh 的版本兼容检查，所以插件包都写 `engines.dsh`。
  2. 在根 `package.json` 的 `dependencies` 和 `cordis.patch.yml` 里各加一项。
  3. 再 `pnpm install`。
- `link:` 安装不会安装本仓库的 `dependencies`，依赖都靠本仓库自己的 `pnpm install`。要引入第三方包，加到用它的子包的 `dependencies` 里；pnpm 11 有最小发布时长检查，太新的版本会被拦下（`pnpm add` 会往 `pnpm-workspace.yaml` 写豁免），优先选已经发布几天的版本。
- 用到的都是 dsh 尚未稳定的内部接口，`engines.dsh` 限定为 `>=0.2.1-rc.3 <0.3.0`。dsh 升级后先跑 `--dump-config` 和一次交互验证。接口签名对照 dsh 仓库：
  - `packages/bundle/headless/src/index.ts`：创建 Agent、等待空闲、流式输出思考的参考实现
  - `packages/core/agent/src/runtime-types.ts`：`Agent`（`followup`、`cancel`、`whenIdle`、`model.select`）
  - `packages/llm/llm/src/types.ts`：`StreamChunk`
  - `packages/core/session/src/types.ts`：`SessionEventMap`、`TurnEndReason`
  - `packages/fs/tool-fs/src/diff.ts`：write/edit 结果 `meta.diffs` 的格式
  - `packages/interaction/user-approval/src/types.ts`、`packages/interaction/user-questions/src/types.ts`
  - `docs/tool-catalog.md`：各工具的参数名（`toolView` 用到）
- 界面照 opencode 源码（[anomalyco/opencode](https://github.com/anomalyco/opencode) 的 `packages/tui/src`，本机副本的位置见 `CLAUDE.local.md`）：
  - `routes/session/index.tsx`：消息和工具部件
  - `component/prompt/index.tsx`：输入框
  - `routes/session/permission.tsx`、`question.tsx`：审批和提问面板
  - `theme/assets/opencode.json`、`theme/index.ts`：色板和语法规则
- stdout 归 TUI 独占，诊断写 stderr（运行期间会被缓存，退出后写出）。监听一律通过 `ctx.on`/`ctx.effect` 注册，随插件卸载自动撤销。

## 配置

- 模型配置不在本仓库，在用户级的 `~/.dsh` 里：`~/.dsh/profiles/tui/cordis.patch.yml` 的 `llm-pi-ai`（provider）和 `agent-default-model`（默认模型）两行；patch 会替换整行 config，修改时保留其他 provider。凭据在 `~/.dsh/.credentials.yaml`，所有 profile 共用。
- 不要把具体的 provider、模型名、网关地址或凭据写进仓库，这些只写在 `CLAUDE.local.md`。

## 约定

- 界面文案用中文（工具标题也是，例如「读取」「编辑」），代码注释用英文。
- 两空格缩进、无分号、单引号，与现有代码一致。
