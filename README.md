# deepseek-harness-tui

一个 DeepSeek Harness（dsh）的全屏终端对话界面，界面照着 [opencode](https://github.com/anomalyco/opencode) 的会话页做，用 [OpenTUI](https://opentui.com) 渲染。它作为 dsh 的一个 bundle 运行在 dsh 进程内（`dsh --profile tui`），所以能拿到逐字流式输出、工具调用、审批和提问这些进程内事件。

```
 ┃
 ┃  读一下 package.json 的 name
 ┃

   → 读取 package.json

     pty-demo

   ▣ deepseek-v4-flash · 5.7s

 ┃
 ┃  输入消息，/ 查看命令
 ┃  deepseek-v4-flash deepseek
 ┃
 ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 ~/project                  enter 发送  / 命令  ctrl+c 退出
```

## 安装

需要：

- 一个已经 `pnpm install && pnpm run build` 过的 deepseek-harness 源码仓库。
- 一个带 `node:ffi` 的 Node.js（≥ 26.4）。OpenTUI 的原生核心通过 `node:ffi` 调用。Homebrew 的 Node 编译时没带 FFI，要用 nodejs.org 的官方构建：

  ```sh
  # 版本按需替换；解压到 ~/.local/share/dsh-tui/node 后 bin/dshcli 会自动使用
  V=v26.12.1
  curl -fLO https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.xz
  mkdir -p ~/.local/share/dsh-tui && tar -xJf node-$V-darwin-arm64.tar.xz -C ~/.local/share/dsh-tui
  ln -sfn node-$V-darwin-arm64 ~/.local/share/dsh-tui/node
  ```

然后安装本仓库的依赖，再在 dsh 仓库里把本仓库根目录装进一个独立的 `tui` profile。下面假设两个仓库放在同一个目录下：

```sh
cd deepseek-harness-tui && pnpm install
cd ../deepseek-harness
pnpm dsh plugin --profile tui add "$(cd ../deepseek-harness-tui && pwd)"
```

这是 `link:` 安装，改本仓库的代码后重启 TUI 即生效，不用重装。`pnpm install` 会把 `packages/*` 链接进 `node_modules`，并装上 OpenTUI；dsh 靠这些链接按包名加载各个插件。

模型配置写在 `~/.dsh/profiles/tui/cordis.patch.yml`（`llm-pi-ai` 提供商和 `agent-default-model` 默认模型），凭据和 Web 共用 `~/.dsh/.credentials.yaml`。

## 运行

在你要工作的项目目录里执行（可以把 `bin/dshcli` 链接到 `PATH` 里的目录，例如 `ln -s "$PWD/bin/dshcli" ~/.local/bin/dshcli`）：

```sh
/path/to/deepseek-harness-tui/bin/dshcli
```

`bin/dshcli` 用和 `pnpm dsh` 相同的方式从源码启动 dsh，但保留当前目录作为 agent 的工作区（`pnpm dsh` 总是以 dsh 仓库根目录为工作目录）。它按 `$DSH_TUI_NODE`、`~/.local/share/dsh-tui/node/bin/node`、`PATH` 里的 `node` 的顺序找第一个带 `node:ffi` 的 Node，并加上 `--experimental-ffi` 启动。dsh 仓库默认在本仓库的同级目录 `../deepseek-harness`，不在那里时设置 `DSH_REPO`。

### 命令

| 命令 | 作用 |
|---|---|
| `/help` | 列出命令和按键 |
| `/model` | 打开模型选择面板，输入文字过滤（只影响当前会话） |
| `/model <provider>/<model>` | 直接切换 |
| `/new` | 保存当前会话，清屏开始新会话 |
| `/session` | 显示会话 id、模型、目录 |
| `/exit` | 保存并退出 |

输入 `/` 时输入框上方会列出匹配的命令：↑↓ 选择，Tab 补全，回车直接执行。

### 按键

| 按键 | 作用 |
|---|---|
| Enter | 发送；运行中按下则排队（显示「排队中」），当前回合结束后发送 |
| Shift+Enter / Alt+Enter / Ctrl-J | 换行 |
| Esc | 运行中中断当前回合 |
| Ctrl-C | 有选中文字时复制；运行中中断；空闲时清空输入，连按两次退出 |
| Ctrl-D | 输入为空时退出 |
| Ctrl-V | 粘贴剪贴板里的图片（插入 `[图片 N]` 占位）或文字 |
| ↑ / ↓ | 翻看输入历史 |
| PgUp / PgDn、鼠标滚轮 | 滚动对话 |
| Ctrl-T | 展开或折叠思考过程 |

用鼠标拖选对话中的文字，松开即复制（OSC 52，macOS 上同时走 `pbcopy`）。

### 图片

和 opencode 一样，按 Ctrl-V 时如果剪贴板里是图片，输入框会插入一个高亮的 `[图片 N]` 占位，退格可以整块删掉；把图片文件（png、jpg、webp、gif）拖进终端也一样。发送时图片按占位的位置和文字一起组成消息，先存进 dsh 的附件存储，消息里只记录引用；对话里的用户消息下方会显示 ` 图片 ` 和尺寸。

读取剪贴板用的是系统工具：macOS 用 `osascript`，Linux 用 `wl-paste` 或 `xclip`，Windows 用 PowerShell。

模型要在配置里声明支持图片输入，图片才会发出去；没有声明的模型会拒绝发送并提示「不支持图片输入」。`llm-pi-ai` 里自定义的模型默认只有文本输入，可以在模型条目上写 `input: [text, image]`，或者在 provider 上写 `defaultInput: [text, image]`。

### 审批和提问

工具需要更高权限时，输入框会换成黄色竖线的「△ 需要确认」面板：←/→ 在「允许一次」「拒绝」之间切换，回车确认，`y`/`n` 直接选，Esc 拒绝。被拒绝的工具行会划掉。

模型调用 `ask_user_question` 时会出现提问面板：↑↓ 或数字键选择，多选题用空格勾选，回车确认；最后一项「输入自己的答案…」切换成输入框，Esc 返回选项或撤回提问。`dsh-base` 默认不带这个工具，本 bundle 额外插入了 `tool-ask-user` 行。

## 界面

照 opencode 的会话页：

- **用户消息**：左侧蓝色 `┃` 竖线加深色面板。
- **回复**：按 Markdown 渲染（代码块高亮支持 js/ts/markdown/zig）。
- **思考**：流式时显示「思考中」，结束后折叠成「+ 已思考 · 耗时」，Ctrl-T 展开。
- **工具调用**：一行图标加标题，运行中图标换成 spinner，失败标红：
  - `→ 读取`、`← 写入/编辑`、`$ 命令`、`✱ 查找文件/搜索`、`% 抓取`、`◈ 搜索网页`
  - bash 显示为带输出的面板，edit 显示 diff，todo_write 显示待办列表
- **回合脚注**：每个回合结束显示 `▣ 模型 · 耗时`，被中断时加「已中断」。
- **配色**：opencode 默认暗色主题；设置 `NO_COLOR` 时用灰度。

## 模块

仓库是 pnpm monorepo。根目录是 bundle `deepseek-harness-tui`，`cordis.patch.yml` 为每个插件包插入一行 `tui-*`。插件之间不互相 import，只通过 `ctx` 服务和 `tui/*` 事件协作：

| 包 | 行 id | 职责 | 提供 / 依赖 |
|---|---|---|---|
| `@dsh-tui/render` | — | 纯函数库：opencode 色板和语法高亮规则、工具标题、路径/时长/diff 等格式化 | 不依赖 dsh 和 OpenTUI |
| `@dsh-tui/ui` | — | OpenTUI 组件库：唯一 import `@opentui/core` 的包，提供竖线块、带样式文本、spinner、面板外框、列表 | 依赖 `@opentui/core` |
| `@dsh-tui/console` | `tui-console` | 全屏宿主：对话区、输入框、状态栏、面板、命令补全；把输入转成 `tui/submit`、`tui/interrupt`、`tui/close`、`tui/toggle-thinking` 事件 | 提供 `tuiConsole` |
| `@dsh-tui/chat` | `tui-chat` | 会话控制：创建 Agent、分派输入、等待 Agent 和子 agent 空闲、保存会话、退出 | 提供 `tuiChat`；依赖 `tuiConsole` |
| `@dsh-tui/transcript` | `tui-transcript` | 渲染当前 Agent 的消息、思考、工具调用和回合脚注 | 依赖 `tuiConsole`、`tuiChat` |
| `@dsh-tui/interaction` | `tui-interaction` | 审批和提问面板，回答所有 agent（含子 agent）的 `approval/request` 和 `user-questions/request` | 依赖 `tuiConsole` |
| `@dsh-tui/commands` | `tui-commands` | 斜杠命令注册表、`/` 补全和内置命令 | 提供 `tuiCommands`；依赖 `tuiConsole`、`tuiChat` |

扩展方式：

- 在 `~/.dsh/profiles/tui/cordis.patch.yml` 里写 `- id: tui-interaction` 加 `disabled: true` 可以禁用某一行，也可以插入一个提供同名服务的插件来替换它。
- 新插件可以注册自己的斜杠命令：`ctx.effect(() => ctx.tuiCommands.register({ name, help: [[语法, 说明]], run }))`，它会自动出现在 `/help` 和 `/` 补全里。
- bundle 关闭了 HMR，避免配置热重载把对话中的 TUI 重新挂载。

## 已知限制

- 依赖实验性的 `node:ffi`，必须用带 FFI 的 Node 并加 `--experimental-ffi` 启动；npm 安装的 dsh 默认不带这个参数。
- 全屏模式下终端自己的滚动历史里没有对话内容，退出后也不会留下；要看完整记录请用 `dsh web` 打开会话。
- 中文输入法还没在真实终端里验证过（自动化测试只能逐字写入）。
- 代码高亮只支持 OpenTUI 内置的 javascript、typescript、markdown、zig；其他语言按普通文本显示。
- edit/write 的 diff 行号从每个改动块的第一行算起，所以不显示行号。
- 中断回合时 dsh 会清空排队的消息，这些消息会标为「已取消，未发送」。
- 不能恢复历史会话（只有 `/new`）；会话可以在 `dsh web` 里继续。`/model` 只改当前会话，不写回默认模型。
- 依赖 dsh 尚未稳定的内部接口（`agents.create`、`agent/assistant-stream`、审批和提问的 waterfall），`engines.dsh` 限定在 `>=0.2.1-rc.3 <0.3.0`；dsh 升级后可能需要跟着改。
