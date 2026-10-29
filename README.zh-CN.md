# @ricardochen1996/browser-use-mcp

[![CI](https://github.com/ricardochen1996/browser-use-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ricardochen1996/browser-use-mcp/actions/workflows/ci.yml)

[English](README.md) · **中文**

> 一个 MCP 服务器，给**任何 agent** 一双能看、能点的浏览器：页面被读成一张**带索引的动作空间表**，模型每步只做一个操作、只对一个来自那张表的目标。

`browser-use-mcp` 是一个 [Model Context Protocol](https://modelcontextprotocol.io) 服务器。Claude Code、Claude Desktop、Cursor、Codex、DeepSeek Harness 会话，或者任何其他 MCP 客户端连上它，它的 agent 就得到一个浏览器：打开页面，把页面读成一张带编号目标的表，然后指明一个操作和一个目标。模型永远不用写选择器、坐标或脚本，服务器也永远不会自己重试一次改动。

它建立在 [`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use) 之上：同一个 Python 引擎、同一套 sidecar 协议、同一个“页面即带索引动作空间”的想法——只是把 DeepSeek Harness 插件宿主换成了 MCP 宿主。所以它本身不含浏览器逻辑：这个包是适配层，让任何 MCP 客户端都能驱动 [Jev Ultrafast](https://github.com/ricardochen1996/jev-ultrafast) 引擎。引擎以固定版本的 wheel 随包发布，sidecar 的依赖按版本和每个产物的哈希锁定；首次使用时它们被装进一个由本服务器管理的 Python 环境。不用克隆引擎，不手动配 Python。

---

## 这是什么

浏览器工具只暴露一条循环：

1. **读。** `browser_open` 打开页面，把它的**动作空间**作为文本返回：每个可达元素一行，写明该元素支持哪些操作，以及这些操作接受的确切目标索引。结果里带一个**观测号**。
2. **选。** agent 从**那个观测**里挑一个操作和一个目标：`browser_act({ observation, operation, target })`。
3. **守。** 服务器把操作连同那个观测的指纹一起发给引擎。引擎先重读页面。页面变了就**什么都不执行**，结果以 `Nothing was executed:` 开头，并附上新的表。这是一次拒绝，不是错误：agent 从一件仍然为真的事上重新选。
4. **验。** 页面没变，那一个操作才执行，服务器返回新的观测号。下一步引用新的编号。工具结果本身从来不是结果的证明；下一次观测才是。

下面是一张真实的表，由随包的测试页面产生（可见文本那一行做了截断）：

```text
Page file:///…/test/fixtures/fixture.html — 🐴 Forma · Find a place to slow down
Observation 1. Targets below are valid only for this observation.
Visible text: forma. Find a stay Reading room PLACES WITH CHARACTER THE SLOWER WAY TO STAY …
[1] link forma. — CLICK
[2] link Find a stay — CLICK
[3] link Reading room — CLICK
[4] searchbox Destination — TYPE_TEXT, CLICK
[5] button Find stays — CLICK
[6] combobox Stay category · "All stays" — SELECT
      6:1 → Stay category → Design
      6:2 → Stay category → Nature
      6:3 → Stay category → Coastal
[7] checkbox Free cancellation · "on" (not checked) — CLICK
[8] button View Casa Flora — CLICK
[9] button View The Glasshouse — CLICK
[10] button View Serra Lodge — CLICK
Without a target: SCROLL_DOWN, WAIT
```

对这张表的一步是一个对象，不是代码：

```jsonc
{ "observation": 1, "operation": "CLICK", "target": "5" }             // button Find stays
{ "observation": 1, "operation": "TYPE_TEXT", "target": "4", "text": "Lisbon" }
{ "observation": 1, "operation": "SELECT", "target": "6:1" }          // Stay category → Design
```

如果页面在读和点之间变了，回答是一次拒绝，并直接把当前观测交回来：

```text
Nothing was executed: The page changed since that observation. Choose from the new one.

Page … — …
Observation 3. Targets below are valid only for this observation.
```

引擎通过本服务器会话持有的一条 CDP 连接读页面。每个工具——包括 `browser_eval`——都用这一条连接。自己再起第二个客户端（裸 websocket、puppeteer/playwright 脚本、另一个 `browser-harness` daemon）时，Chrome 144+ 的 “Allow remote debugging?” 提示（每个连接都要点一次）就会变成一堆弹窗，页面也会被两套循环同时驱动。

## 与基于选择器的浏览器 MCP 有什么不同

| | 基于选择器的浏览器 MCP | `browser-use-mcp` |
| --- | --- | --- |
| 模型发送什么 | 选择器、坐标或代码 | 对刚读到的那张表里的一个索引做一个操作 |
| 页面变了会怎样 | 选择器可能点空，或点到错的元素 | 操作被**拒绝**，并返回最新的表 |
| 重试 | 由客户端或模型决定 | **从不**——拒绝就是重新选择的起点，不是自动重放 |
| 模型怎么知道能做什么 | 得猜 | 每一行写明该元素的目标与操作，下拉选项也在内 |
| CDP 连接 | 取决于实现 | 每个浏览器会话恰好一条，所有工具共用 |
| 每步 token 成本 | 常常是一张截图或整棵 DOM | 结构化文本：可见文本加元素表 |

`browser_eval` 是唯一一处有意的例外：它在同一条连接上求值一个 JavaScript 表达式，把结果当数据返回，并且**不产生观测**——所以下一次受保护的操作仍然指向上一张表。它存在的原因，是需要程序化读取的模型不必再起第二个 CDP 客户端。`--no-eval` 可以把它收回。

---

## 快速开始

**需要** Node.js `^22.19.0 || >=24.0.0`、Chrome 或 Chromium，以及一个能拿到 Python 3.12+ 的途径：`PATH` 上的 `python3.12`–`python3.14`、`python3`（3.12 或更新），或者 [uv](https://docs.astral.sh/uv/)（它能自己下载 Python）。

**驱动哪个浏览器。** 默认是 **attach** 模式：服务器直接驱动你日常用的 Chrome，agent 看到的登录态和标签页就是你自己的。先在那个 Chrome 里打开一次远程调试（`chrome://inspect/#remote-debugging` → 允许）；macOS 上还需要给运行服务器的应用**完全磁盘访问权限**（系统设置 → 隐私与安全性 → 完全磁盘访问权限）。想要一个隔离的浏览器，就加 `--mode launch`，服务器会在状态根下用自己的 profile 启动一个专属 Chrome。

**安装。** 这个包已发布到 npm：
[`@ricardochen1996/browser-use-mcp`](https://www.npmjs.com/package/@ricardochen1996/browser-use-mcp)，
不装任何东西也可以直接跑最新版：

```bash
npx -y @ricardochen1996/browser-use-mcp@latest --version
```

或者安装 `browser-use-mcp` 命令，下面终端里的命令都按这个写法：

```bash
npm install -g @ricardochen1996/browser-use-mcp@latest
browser-use-mcp --version
```

两种方式跑的是同一个服务器：下文任意命令里的 `browser-use-mcp` 都可以换成
`npx -y @ricardochen1996/browser-use-mcp@latest`。客户端配置用 `npx` 或已安装的命令都可以；
GUI 客户端的 `PATH` 比较短、找不到它们时，把 `command -v browser-use-mcp` 给出的绝对路径填进去
（用 `npx` 形式则取 `command -v npx`）；每个客户端的片段见 [docs/clients.md](docs/clients.md)。

然后检查这台机器（新机器上首次浏览器调用会构建环境；`install` 可以提前做）。下面的例子用
`--mode launch` 看专属浏览器；默认 attach 模式下 `Connection:` 行会写成你所连的 Chrome，且
`Status: ready` 要求那个浏览器能应答调试端点。输出大致如下，与机器相关的路径做了省略：

```bash
browser-use-mcp doctor --mode launch
```

```text
browser-use-mcp v0.1.4 — self-check (Node v22.23.2, darwin-arm64)

Transport: stdio (MCP over stdin/stdout)
Connection: launch Chrome/Chromium, profile "default" at /Users/you/.browser-use-mcp/profiles/default
State   : /Users/you/.browser-use-mcp (managed Python environment)
Timeouts: 180s per browser request
Logging : info (stderr)
Jev     : on, typesafe decider: default endpoint (model default), key unset; …
Tools   : browser_open, browser_page, browser_act, browser_eval, browser_screenshot, browser_console, browser_goal, browser_close, browser_doctor
Session : idle (this transport has no browser session yet)

Engine   : /Users/you/.browser-use-mcp/env/bin/python (Python 3.12.14, chosen by managed environment)
           jev_ultrafast 0.1.2 at …/env/lib/python3.12/site-packages/jev_ultrafast
           browser-harness 0.1.13
Install  : none in this process; the engine is already importable
Sidecar  : /…/node_modules/@ricardochen1996/browser-use-mcp/sidecar/bridge.py
Browser  : /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
Goal mode: enabled: browser_goal and browser_act intents spend model quota; …
Status   : ready
```

`Status: ready` 表示浏览器工具可用。`Jev … NOT READY` 在没配策略密钥时是正常的：只有 `browser_goal` 和 `browser_act` 的 `intent` 需要它，其余功能照常。

想提前构建环境、而不是等第一次浏览器调用时再装：

```bash
browser-use-mcp install
# 或者不装全局命令：
npx -y @ricardochen1996/browser-use-mcp@latest install
```

它会在 `<state root>/env`（默认 `~/.browser-use-mcp/env`）里建好环境，装上随包的引擎 wheel 与 `browser-harness`，并把构建记录写进 `<state root>/install.json`。可以放心重跑。安装在后台进行时，先到的浏览器调用会等它，而不是直接失败。

### 接到你的 agent 上

下面的片段用 `npx` 启动已发布的包，不需要全局安装。如果你装了 `browser-use-mcp` 命令，把
`npx -y @ricardochen1996/browser-use-mcp@latest` 换成 `browser-use-mcp`（或它的绝对路径）即可。
每个客户端（包括 launch 模式的变体）的完整配置在 **[docs/clients.md](docs/clients.md)**。

Claude Code：

```bash
# 使用你日常的 Chrome（默认 attach 模式）：
claude mcp add --scope user browser-use \
  -- npx -y @ricardochen1996/browser-use-mcp@latest

# 或者给 agent 一个专属的、看不到你日常会话的浏览器：
claude mcp add --scope user browser-use \
  --env BROWSER_USE_MCP_MODE=launch --env BROWSER_USE_MCP_HEADLESS=1 \
  -- npx -y @ricardochen1996/browser-use-mcp@latest
```

通用的 `mcpServers` JSON（Claude Desktop、Cursor 以及多数宿主都认这个形状）：

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["-y", "@ricardochen1996/browser-use-mcp@latest"],
      "env": { "BROWSER_USE_MCP_MODE": "launch", "BROWSER_USE_MCP_HEADLESS": "1" }
    }
  }
}
```

`env` 里用 launch 模式是为了让这个例子自成一体；想驱动你日常的 Chrome 就把这段 `env` 去掉。
客户端也可以直接运行装好的命令（`"command": "browser-use-mcp"`）；如果希望整个团队跑同一个
版本，就把 `@latest` 换成具体的版本号。GUI 客户端的 `PATH` 比较短时，用命令的绝对路径
（`command -v browser-use-mcp`；Homebrew 装的 Node 通常是 `/opt/homebrew/bin/browser-use-mcp`）。

然后让 agent 去 `browser_open` 一个 URL。新机器上的第一次调用可能要等一两分钟来装环境，之后的调用立即开始。

### 从源码运行

想跑一个还没发布的提交，或者参与开发：

```bash
git clone https://github.com/ricardochen1996/browser-use-mcp.git
cd browser-use-mcp
npm install
node bin/browser-use-mcp.mjs doctor --mode launch
```

在 checkout 里执行 `npm link` 会把一个 `browser-use-mcp` 命令放进 `PATH`，运行的就是这份
checkout。发布包和 checkout 的文件完全一致，区别只在于 `browser-use-mcp` 来自 npm 还是
`node bin/browser-use-mcp.mjs`。

---

## 九个工具

| 工具 | 参数 | 做什么 |
| --- | --- | --- |
| `browser_open` | `url`（必填） | 启动（或复用）本会话的浏览器，打开页面，返回第一张动作空间表和观测号。 |
| `browser_page` | — | 重读当前页面，给出**新的**观测号。页面自己变了、或者操作被拒绝之后用它。 |
| `browser_act` | `observation`（必填）、`operation`、`target`、`text`、`intent` | 在那个观测上对一个目标做一个操作：`CLICK`、`TYPE_TEXT`、`SELECT`、`SCROLL_UP`、`SCROLL_DOWN`、`WAIT`。页面已变时返回拒绝和最新的表。Jev 开启时，只给 `intent`（不给 operation）就把这一步的决策交给策略。 |
| `browser_eval` | `expression`（必填）、`timeout_ms` | 在本会话的 CDP 连接上求值一个 JavaScript 表达式；把值当数据返回，不产生观测。`--no-eval` 时隐藏。 |
| `browser_screenshot` | — | 把可见视口作为 MCP 图片（JPEG）返回；不画目标框。`--no-screenshots` 时隐藏。 |
| `browser_console` | — | 上一次读取以来的 console 消息、未捕获异常、失败请求和 `4xx`/`5xx` 响应。每次读取都会清空缓冲。 |
| `browser_goal` | `url`、`goal` | 把整个目标交给策略，在它自己的标签页里跑；策略自己选每一步的操作和目标。会消耗模型配额。`--no-jev` 时隐藏。 |
| `browser_close` | — | 关闭本会话的标签页。launch 模式下浏览器留着给下一次 `browser_open`；attach 模式下绝不关闭你所连的浏览器。 |
| `browser_doctor` | `install`（可选布尔值） | 自检：解释器、引擎、浏览器、attach 目标、配置、会话，每个问题都带修法。`install: true` 会先构建缺失的环境。 |

缺策略密钥、目标不支持、`TYPE_TEXT` 没给文本、页面已变，这些都是**正常工具结果里的拒绝**。浏览器或环境坏了才是失败调用（`isError`）。agent 应该报告失败，而不是盲目重试。

---

## 传输与并发

| 传输 | 一个 agent 得到什么 | 两个 agent 得到什么 |
| --- | --- | --- |
| **stdio**（默认） | 一个服务器进程、一个浏览器会话 | 两个进程：attach 模式下各开一个标签页驱动同一个浏览器，launch 模式下是两个浏览器 |
| **Streamable HTTP** | 一个 MCP 会话、一个浏览器会话 | 一个常驻服务器：attach 模式共用正在运行的浏览器，launch 模式下每个会话在专属浏览器里各用一个标签页 |

想多个 agent 共用一个装好的服务器时，起一个 HTTP 端点：

```bash
browser-use-mcp \
  --transport http --host 127.0.0.1 --port 7331 --path /mcp
```

端点默认是 `http://127.0.0.1:7331/mcp`。每个 MCP `initialize` 会话都有自己的浏览器会话；默认 attach 模式下它们都驱动你日常用的 Chrome（见下面的 `--attach-sharing`），`--mode launch` 则让每个会话在专属浏览器里各用一个标签页。静默 15 分钟的会话会被关掉浏览器，并删除它的匿名 profile（`BROWSER_USE_MCP_HTTP_IDLE_MS` 可以改这个时限）。它没有认证：默认只绑回环地址，绑到非回环地址时启动日志会给出警告。确实要离开本机，就放在你自己控制的隧道或反向代理后面。

**命名 profile（launch 模式）。** launch 模式下，匿名的 HTTP 会话拿到的是临时 profile，会话结束就删除。希望登录态跨重连保留的客户端，在 initialize 请求上给自己的 profile 起个名字：

```text
http://127.0.0.1:7331/mcp?profile=claude      （或请求头 X-Browser-Use-Profile: claude）
```

命名 profile 位于 `<状态根>/profiles/<服务器 profile>-<名字>`，会话结束后保留，同名的新会话会复用它。不同名字可以同时跑在各自 profile 上；两个同时存活的同名会话会被 profile 锁拒绝，而不是悄悄共用一个浏览器。名字是 1–32 个 `[A-Za-z0-9_-]` 字符。

### 浏览器：attach（默认）还是 launch

**`attach`（默认）**驱动你日常用的 Chrome：

- 不带端点时，服务器通过 Chrome 写进 profile 的 `DevToolsActivePort` 找到它。先在那个 Chrome 里打开远程调试（`chrome://inspect/#remote-debugging`）。macOS 上这个文件受隐私保护，所以运行本服务器的应用需要**完全磁盘访问权限**（系统设置 → 隐私与安全性 → 完全磁盘访问权限），然后重启它。
- **`--cdp-endpoint http://127.0.0.1:9333`**（或 `ws://…` 端点）驱动一个你指定、开着远程调试的浏览器。
- `--attach-sharing shared`（默认）允许同时有多个 MCP 会话——甚至多个服务器进程——驱动同一个浏览器，各自一个标签页、各自一条 CDP 连接。Chrome 144+ 对每条连接都会问一次 “Allow remote debugging?”，所以两个 agent 至少会有两次弹窗；每个只批准一次，没被批准的弹窗不要重试。`--attach-sharing exclusive` 则拒绝第二个持有者，并给出修法——当两个 agent 绝不能碰同一个浏览器时，这是更安全的选择。
- `browser_close` 只停本会话的标签页和 daemon，从不关闭所连的浏览器。

**`--mode launch`** 会在状态根下用自己的 profile 启动一个专属 Chrome，日常浏览器和登录态不进入自动化。`browser_close` 把这个浏览器留给下一次 `browser_open`，连接结束时服务器关闭它。无头 CI 机器，或者不该看到你真实会话的 agent，适合用这个模式。

---

## 配置要点

服务器设置都是一个 flag 配一个环境变量（策略用的是 `TYPESAFE_*`/`TEXT_MODEL_*`；少数几项只有环境变量）；两者同时出现时 flag 生效。完整的表格、解析规则、默认值和退出码在 **[docs/config.md](docs/config.md)**。

| 设置 | Flag | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| 传输 | `--transport`、`--host`、`--port`、`--path` | `BROWSER_USE_MCP_TRANSPORT`、`BROWSER_USE_MCP_HOST`、`BROWSER_USE_MCP_PORT`、`BROWSER_USE_MCP_PATH` | `stdio`、`127.0.0.1`、`7331`、`/mcp` |
| 自己启动或接入 | `--mode`、`--cdp-endpoint` | `BROWSER_USE_MCP_MODE`、`BROWSER_USE_MCP_CDP_ENDPOINT` | `attach` |
| attach 共享 | `--attach-sharing` | `BROWSER_USE_MCP_ATTACH_SHARING` | `shared`（仅 attach） |
| 浏览器窗口 | `--headless` | `BROWSER_USE_MCP_HEADLESS` | 显示窗口 |
| Profile | `--profile`、`--user-data-dir` | `BROWSER_USE_MCP_PROFILE`、`BROWSER_USE_MCP_USER_DATA_DIR` | 状态根下的 `default` |
| 状态根 | `--home` | `BROWSER_USE_MCP_HOME` | `~/.browser-use-mcp` |
| 解释器 | `--python` | `BROWSER_USE_MCP_PYTHON` | 托管环境 |
| 工具面 | `--no-eval`、`--no-screenshots`、`--no-jev` | `BROWSER_USE_MCP_NO_EVAL`、`…_NO_SCREENSHOTS`、`…_NO_JEV` | 全部提供 |
| 策略 | `--jev-decider` 及 `--typesafe-*` / `--text-model-*` | `JEV_DECIDER`、`TYPESAFE_*`、`TEXT_MODEL_*` | `typesafe` |
| 请求时限 | `--request-timeout-ms` | `BROWSER_USE_MCP_REQUEST_TIMEOUT_MS` | `180000` ms |
| 日志 | `--log-level` | `BROWSER_USE_MCP_LOG_LEVEL` | `info`，始终走 stderr |

状态根目录结构：

```text
~/.browser-use-mcp/
├── env/                        托管 Python 虚拟环境（引擎 + browser-harness）
├── install.json                装了什么，用的哪种策略、哪个 Python
├── profiles/<name>/            启动的 Chrome profile（登录态、标签页）；HTTP 命名 profile 也在这里
└── attachments/<hash>.lock     attach 模式的 claim，每个 DevTools 端点一份
```

### Jev 策略

`browser_goal` 在引擎里跑完整个决策循环；`browser_act` 只给 `intent`（不给 operation）时，把恰好一步决策交给同一个策略。两者都会消耗模型配额。由谁回答是配置决定的：

- **`--jev-decider typesafe`**（默认）：TypeSafe 端点上的 Jev。需要 `TYPESAFE_API_KEY`；可选 `TYPESAFE_BASE_URL`、`TYPESAFE_MODEL`、`TYPESAFE_FALLBACK_URL`。
- **`--jev-decider chat`**：引擎在回环地址上提供自己的 System One 协议，由一个聊天模型来回答。需要 `TEXT_MODEL_BASE_URL` 和 `TEXT_MODEL`（端点需要的话再加 `TEXT_MODEL_API_KEY`）。

`TEXT_MODEL_*` 也负责在 agent 只给 intent、没给文本时写出 `TYPE_TEXT` 的值。两种都不配，其余工具面完全不变；策略工具会以一句话拒绝，并点名要设的变量。`--no-jev` 会彻底收回 `browser_goal` 和 `intent` 参数。

把凭据放在客户端的 `env` 块（或 flag）里，不要放在 `args` 里：

```json
"env": {
  "TYPESAFE_API_KEY": "…",
  "TEXT_MODEL_BASE_URL": "https://your-endpoint/v1",
  "TEXT_MODEL": "your-model",
  "TEXT_MODEL_API_KEY": "…"
}
```

服务器只在消耗配额的那一次请求里带上这些变量，不会把它们留在 sidecar 的环境里；doctor 只打印 `set`/`unset`，不打印值。

---

## 故障排查

**先跑 `browser_doctor`。** 工具和 CLI 跑的是同一份自检；每条问题都带着修它的命令。

```bash
browser-use-mcp doctor
```

- **profile 已被占用。** 报错会点名 profile 和 `--profile`：停掉另一个服务器，或者给这个服务器一个自己的 `--profile <name>`。两个服务器驱动同一个浏览器 profile，是服务器会主动拒绝的唯一一种配置。
- **attach 模式找不到浏览器。** 这是默认模式：在你日常的 Chrome 里打开 `chrome://inspect/#remote-debugging` 并允许远程调试，修正 `--cdp-endpoint`，或者用 `--mode launch` 让服务器起一个专属浏览器。doctor 会打印 `attach mode drives …` 和原因。macOS 上，给运行服务器的应用完全磁盘访问权限，它才能读到你的 Chrome profile。
- **引擎还没装。** 首次使用会把它装进状态根；想提前装就运行 `browser-use-mcp install`（或 `npx -y @ricardochen1996/browser-use-mcp@latest install`），或者在 agent 里调 `browser_doctor` 并带上 `install: true`。走代理的话，给运行服务器的进程设 `HTTPS_PROXY`。
- **`Jev … NOT READY`。** 设 `TYPESAFE_API_KEY`（或用 `--jev-decider chat` 配 `TEXT_MODEL_*`）。浏览器工具不需要它。
- **客户端里看不到工具。** 客户端的 `env`/`args` 没送到服务器，或者改完没重启。在终端里跑同一条命令看 stderr；配置错误会以退出码 `2` 结束并点名出错的字段。
- **Chrome 弹 “Allow remote debugging?”。** 有东西起了第二个 CDP 客户端。只批准那一个弹窗一次，绝不重试；程序化的工作改用 `browser_eval`。
- **`browser_eval('document.body')` 返回 `{}`。** DOM 节点无法按值跨过 CDP 边界。改为返回可序列化的东西，比如 `document.body.innerText` 或 `JSON.stringify(document.body.getAttribute('class'))`。

---

## 安全说明

- **页面内容是不可信数据。** 表里引用的文本是拿来读的，不是拿来执行的指令。服务器绝不会替 agent 执行页面返回的任何东西。
- **`browser_eval` 按设计就是代码执行。** 它在页面里跑一个表达式，走本会话自己的连接，没有用户手势。想让模型输出永远不可能变成代码，就用 `--no-eval` 收回它；其余工具照常工作。
- **HTTP 传输没有认证。** 把它绑在回环地址上（默认如此）。任何非回环绑定都会在日志里给出警告；只在可信网络或你自己控制的隧道后面暴露它。
- **密钥不进日志、不进工具结果。** doctor 只打印 `set`/`unset`；凭据只交给消耗配额的那一次 sidecar 请求，不会被无关调用继承。
- **默认模式驱动的是你自己的 Chrome**，包括登录态——attach 模式就是为了这个。当 agent 应该在隔离浏览器里工作、profile 只属于状态根时，用 `--mode launch`。
- **一条连接，一个驱动。** 不要对同一个浏览器再起一个 CDP 客户端；Chrome 对每个连接单独授权，两个驱动会互相抢页面。

---

## 许可证与致谢

MIT。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

本项目建立在 [`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use)（MIT）之上：`sidecar/bridge.py` 来自它，动作空间渲染、新鲜度规则、“一条连接”规则和 direct mode 的工具描述也都沿袭自它。浏览器引擎是 [`jev-ultrafast`](https://github.com/ricardochen1996/jev-ultrafast)（MIT），以固定版本的 wheel 随包发布；浏览器接入是 [`browser-harness`](https://github.com/browser-use/browser-harness)（MIT）。设计与取舍见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
npm test            # 快速单元测试（node --test）
npm run test:e2e  # 真实 headless Chrome 跑真实 MCP 协议
                  # （stdio、HTTP、attach 模式、用回环 stub 验证的 Jev intent、
                  #  以及手写 JSON-RPC 客户端）
npm run release:check  # 校验版本、CHANGELOG 与真正会被打包的文件清单
npm run release:pack   # 构建 tarball、校验内容并把 integrity 记录到 dist/
npm run doctor      # CLI 自检
```

默认测试不花模型调用、不需要任何凭据；e2e 测试首次运行会把引擎装进一个测试用的状态根。版本历史见 [CHANGELOG.md](CHANGELOG.md)。

**发布**：在 `main` 上打标注 tag `vX.Y.Z`，[release 工作流](.github/workflows/release.yml) 会校验 tag 与 `package.json` 一致、重跑 CI（单元 + 真浏览器 e2e）、带 provenance 发布到 npm，并创建 GitHub Release，附上校验过的 tarball。凭据二选一：仓库 secret `NPM_TOKEN`（automation 或带 publish 权限的 granular token），或在 npm 上把本仓库与 `.github/workflows/release.yml` 配成 **Trusted Publisher**，工作流会用 OIDC 换取短期发布凭据。已发布的版本会被跳过，重跑只刷新 GitHub Release。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
