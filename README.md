# deepseek-harness-tui

在终端里和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下面简称 dsh）的 agent 对话。界面照着 [opencode](https://github.com/anomalyco/opencode) 做：上面是对话，下面是输入框，agent 读文件、跑命令、改代码的过程都会显示出来，需要权限时会弹出确认。

```
 ┃
 ┃  读一下 package.json 的 name
 ┃

     → 读取 package.json

     pty-demo

     ▣ deepseek-flash · 5.7s

 ┃
 ┃  输入消息，/ 查看命令
 ┃
 ┃  deepseek-flash deepseek-official
 ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 ~/project                  enter 发送  / 命令  ctrl+c 退出
```

它不是一个独立的程序，而是 dsh 的插件：你在哪个目录启动 `dshcli`，agent 就在哪个目录里干活，会话记录和 dsh 网页版共用。

## 安装

下面的步骤按顺序做一遍就能用。假设你把两个仓库都放在 `~/dsh` 目录下，换成别的目录也行，只要两个仓库在同一个父目录里。

目前只在 macOS（Apple Silicon）上测过。Linux 应该能用，Windows 不支持。

### 1. 准备 Node.js 26 和 pnpm

界面库 OpenTUI 需要 Node.js 的 `node:ffi` 模块，这个模块要 Node 26.4 以上，而且只有 nodejs.org 发布的官方版本带。Homebrew 装的 Node 不带，用不了。

最省事的是用 [nvm](https://github.com/nvm-sh/nvm) 装（它下载的就是官方版本）：

```sh
nvm install 26
nvm use 26
npm install -g pnpm
```

装完检查一下，输出 `ok` 就对了：

```sh
node --experimental-ffi --input-type=module -e "await import('node:ffi'); console.log('ok')"
```

如果你想继续用 Homebrew 的 Node 做别的事，也可以只给本项目准备一份官方 Node：从 nodejs.org 下载对应平台的压缩包，解压后把目录链接到 `~/.local/share/dsh-tui/node`。`dshcli` 启动时会优先找这里。

```sh
V=v26.12.1
ARCH=darwin-arm64        # Intel Mac 用 darwin-x64，Linux 用 linux-x64
curl -fLO https://nodejs.org/dist/$V/node-$V-$ARCH.tar.xz
mkdir -p ~/.local/share/dsh-tui
tar -xJf node-$V-$ARCH.tar.xz -C ~/.local/share/dsh-tui
ln -sfn node-$V-$ARCH ~/.local/share/dsh-tui/node
```

### 2. 下载并构建 dsh

```sh
mkdir -p ~/dsh && cd ~/dsh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

`pnpm run build` 要跑一会儿。

### 3. 下载本仓库

```sh
cd ~/dsh
git clone https://github.com/Excalibur0w0/deepseek-harness-tui.git
cd deepseek-harness-tui
pnpm install
```

### 4. 把本仓库装进 dsh

dsh 用 profile 区分不同的用法，本项目装在名为 `tui` 的 profile 里。这一步要回到 dsh 的目录执行：

```sh
cd ~/dsh/deepseek-harness
pnpm dsh plugin --profile tui add ~/dsh/deepseek-harness-tui
```

第一次执行会创建 `~/.dsh/profiles/tui` 目录。装的是链接，以后改本仓库的代码，重启 `dshcli` 就生效，不用重装。

检查是否装好：

```sh
pnpm dsh --profile tui --dump-config | grep "id: tui-"
```

能看到 `tui-console`、`tui-chat`、`tui-transcript`、`tui-interaction`、`tui-commands` 五行就对了。

### 5. 配置 API key

默认用 DeepSeek 官方 API 的 `deepseek-flash` 模型。先到 [platform.deepseek.com](https://platform.deepseek.com) 申请一个 key，第 7 步启动后在输入框里输入 `/connect`，选 DeepSeek，把 key 粘贴进去就行。

也可以现在就写进 `~/.dsh/.env`：

```sh
echo 'DEEPSEEK_API_KEY=sk-你的key' >> ~/.dsh/.env
```

想用别的模型服务，看后面的「换成别的模型」。

### 6. 把 `dshcli` 加到命令行

```sh
mkdir -p ~/.local/bin
ln -s ~/dsh/deepseek-harness-tui/bin/dshcli ~/.local/bin/dshcli
```

`~/.local/bin` 要在 `PATH` 里。如果敲 `dshcli` 提示找不到命令，在 `~/.zshrc`（或 `~/.bashrc`）里加一行 `export PATH="$HOME/.local/bin:$PATH"`，然后开一个新终端。

### 7. 启动

进到你想让 agent 干活的项目目录，运行：

```sh
cd ~/某个项目
dshcli
```

看到底部的输入框就说明成功了。随便问一句，比如「这个项目是做什么的」。按 Ctrl-D 或输入 `/exit` 退出，会话会自动保存。

## 使用

### 按键

| 按键 | 作用 |
|---|---|
| Enter | 发送。agent 还在跑时按下，消息会排队，等这一轮结束再发 |
| Shift+Enter、Alt+Enter、Ctrl-J | 换行 |
| Esc | 打断正在跑的这一轮 |
| Ctrl-C | 有选中的文字时复制；agent 在跑时打断；空闲时清空输入，连按两次退出 |
| Ctrl-D | 输入框为空时退出 |
| Ctrl-V | 粘贴剪贴板里的图片或文字 |
| ↑ / ↓ | 翻看之前输入过的内容 |
| PgUp / PgDn、鼠标滚轮 | 上下滚动对话 |
| Ctrl-T | 展开或收起模型的思考过程 |

用鼠标选中对话里的文字，松开就复制好了。

### 命令

在输入框里打 `/` 会弹出命令列表，上下键选，回车执行。

| 命令 | 作用 |
|---|---|
| `/help` | 列出所有命令和按键 |
| `/model` | 切换模型，可以打字过滤。只对当前会话有效 |
| `/model <provider>/<model>` | 直接切到指定模型 |
| `/connect` | 连接模型服务：填 API key，或者添加自定义服务 |
| `/new` | 保存当前会话，开一个新的 |
| `/session` | 看当前会话的 id、模型和目录 |
| `/exit` | 保存并退出 |

### 确认权限

agent 要做超出当前目录的事（比如往家目录写文件），输入框会换成一个黄色的「△ 需要确认」面板。左右键在「允许一次」和「拒绝」之间切换，回车确认；也可以直接按 `y` 允许、`n` 或 Esc 拒绝。

### 回答 agent 的提问

agent 有时会给你几个选项让你选。上下键或数字键选，多选题用空格勾选，回车确认。最后一项「输入自己的答案…」可以自己打字。

### 发图片

截图后在输入框按 Ctrl-V，会插入一个 `[图片 1]`。把图片文件拖进终端也一样。支持 png、jpg、webp、gif。按一次退格可以把整个 `[图片 1]` 删掉。

模型得支持看图才能发。不支持的模型会提示「不支持图片输入」，消息不会发出去。怎么告诉 dsh 一个模型能看图，见下一节。

## 换成别的模型

### 用 /connect

在输入框里输入 `/connect`，会列出 dsh 认识的四十多家服务（OpenAI、Anthropic、Google、OpenRouter、Moonshot、智谱、MiniMax 等），已经连上的前面有 `●`。打字可以过滤。

- 选一家，粘贴 API key，回车。key 存在 `~/.dsh/.credentials.yaml`，屏幕上只显示圆点。保存后马上能在 `/model` 里选到这家的模型，不用重启。
- 列表里没有的服务，选最后一项「自定义服务」，按提示依次填名字、接口地址、协议和 key。程序会去这个服务的 `/models` 接口拉模型列表让你勾选；拉不到的话手动填模型名。
- 标着「只支持账号登录」的服务（比如 openai-codex）要在 dsh 网页版里连接，TUI 还不能完成账号登录。

`/connect` 写的是 `~/.dsh/profiles/tui/cordis.patch.yml` 和 `~/.dsh/.credentials.yaml`，和手动改配置效果一样。

### 手动改配置

切换模型只对当前会话有效。想换默认模型，或者给模型标上能看图，就编辑 `~/.dsh/profiles/tui/cordis.patch.yml`。下面是一个例子，按你的服务改名字、地址和模型：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-gateway:
        displayName: My Gateway
        api: openai-completions        # 也可以是 openai-responses 或 anthropic-messages
        baseURL: https://api.example.com/v1
        apiKeyEnv: MY_GATEWAY_KEY      # key 写进 ~/.dsh/.env：MY_GATEWAY_KEY=...
        models:
          - { id: some-model, contextWindow: 200000, maxTokens: 32000, input: [text, image] }

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: my-gateway
    model: some-model
```

`input: [text, image]` 表示这个模型能看图，不写就只能发文字。改完重启 `dshcli` 生效。

## 遇到问题

| 看到的提示 | 怎么办 |
|---|---|
| `dshcli: no deepseek-harness checkout at …` | dsh 不在本仓库的同级目录。把两个仓库放到同一个父目录，或者运行前设置 `DSH_REPO=/dsh的路径` |
| `dshcli: workspace packages are not linked` | 在本仓库目录里执行 `pnpm install` |
| `dshcli: no Node.js with node:ffi found` | 当前的 Node 不带 FFI，回到第 1 步。也可以用 `DSH_TUI_NODE=/某个/node` 指定 |
| `the tui profile needs an interactive terminal` | 要在真正的终端里运行，不能接管道或重定向 |
| 发消息后报 `MISSING_CREDENTIAL` | 没配 API key，回到第 5 步 |
| `/model` 列表里没有某个模型 | 那个服务的 key 没配上（用 `/connect` 配），或者配置文件里没写这个模型 |

dsh 运行时往 stderr 输出的信息不会弄乱界面，状态栏会显示「⚠ N 条诊断」，退出后再打印出来。

## 已知限制

- 依赖 Node 的实验特性 `node:ffi`，以后 Node 或 OpenTUI 升级可能要跟着改。
- 全屏界面不会把对话留在终端的滚动记录里。想回看完整对话，用 dsh 的网页版（在 dsh 目录执行 `pnpm dsh web`）。
- 还不能恢复之前的会话，只能 `/new` 开新的；旧会话可以在网页版里继续。
- 代码高亮只支持 JavaScript、TypeScript、Markdown 和 Zig，其他语言显示成普通文字。
- 打断一轮对话时，排在后面的消息也会一起取消，界面上会标「已取消，未发送」。
- 中文输入法还没在多种终端里试过，遇到问题欢迎提 issue。

## 开发

代码在 `packages/` 下，每个子目录一个包：

- `console`：全屏界面的骨架，管输入框、状态栏、弹出面板和粘贴。
- `chat`：管和 agent 的对话：发消息、等回复、退出时保存。
- `transcript`：把 agent 的输出画成对话里的各种块。
- `interaction`：权限确认和提问面板。
- `commands`：`/` 命令。
- `connect`：`/connect`，作为一个独立插件注册命令，可以照着它给 TUI 加新命令。
- `ui`：对 OpenTUI 的一层封装，只有它直接用 OpenTUI。
- `render`：配色、工具标题这类不涉及界面的小函数。

改完代码重启 `dshcli` 就能看到效果，`pnpm check` 做语法检查。更多实现细节和约定写在 `CLAUDE.md` 里。

## 致谢

界面设计、配色和语法高亮规则来自 [opencode](https://github.com/anomalyco/opencode)（MIT）。界面用 [OpenTUI](https://opentui.com) 绘制。
