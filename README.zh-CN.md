# @ricardochen1996/browser-use-mcp

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

这个包**还没有发布到 npm**——从 checkout 直接运行：

```bash
cd /Users/ricardo.chen/PersonalGit/browser-use-mcp
npm install
```

在 checkout 里执行 `npm link` 还会把 `browser-use-mcp` 命令放进 `PATH`，方便在终端里用；
GUI 客户端用下面给出的绝对路径更可靠。

然后检查这台机器（新机器上首次浏览器调用会构建环境；`install` 可以提前做）。输出大致如下，
与机器相关的路径做了省略：

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs doctor
```

```text
browser-use-mcp v0.1.0 — self-check (Node v22.23.2, darwin-arm64)

Transport: stdio (MCP over stdin/stdout)
Connection: launch Chrome/Chromium, profile "default" at /Users/you/.browser-use-mcp/profiles/default
State   : /Users/you/.browser-use-mcp (managed Python environment)
Timeouts: 180s per browser request
Logging : info (stderr)
Jev     : on, typesafe decider: default endpoint (model default), key unset; …
Tools   : browser_open, browser_page, browser_act, browser_eval, browser_screenshot, browser_console, browser_goal, browser_close, browser_doctor
Session : idle (this transport has no browser session yet)

Engine   : /Users/you/.browser-use-mcp/env/bin/python (Python 3.12.14, chosen by managed environment)
           jev_ultrafast 0.1.1 at …/env/lib/python3.12/site-packages/jev_ultrafast
           browser-harness 0.1.13
Install  : none in this process; the engine is already importable
Sidecar  : /…/browser-use-mcp/sidecar/bridge.py
Browser  : /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
Goal mode: enabled: browser_goal and browser_act intents spend model quota; …
Status   : ready
```

`Status: ready` 表示浏览器工具可用。`Jev … NOT READY` 在没配策略密钥时是正常的：只有 `browser_goal` 和 `browser_act` 的 `intent` 需要它，其余功能照常。

想提前构建环境、而不是等第一次浏览器调用时再装：

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs install
```

它会在 `<state root>/env`（默认 `~/.browser-use-mcp/env`）里建好环境，装上随包的引擎 wheel 与 `browser-harness`，并把构建记录写进 `<state root>/install.json`。可以放心重跑。安装在后台进行时，先到的浏览器调用会等它，而不是直接失败。

### 接到你的 agent 上

下面的绝对路径都来自这份 checkout——换成你自己克隆的位置。

Claude Code：

```bash
claude mcp add --scope user browser-use \
  --env BROWSER_USE_MCP_HEADLESS=1 \
  -- node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs
```

通用的 `mcpServers` JSON（Claude Desktop、Cursor 以及多数宿主都认这个形状）：

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs"],
      "env": { "BROWSER_USE_MCP_HEADLESS": "1" }
    }
  }
}
```

Claude Code、Claude Desktop、Cursor、Codex、DSH 以及 Streamable HTTP 的可直接复制片段——包括“换成你自己的绝对路径”这条规则——都在 **[docs/clients.md](docs/clients.md)**。

然后让 agent 去 `browser_open` 一个 URL。新机器上的第一次调用可能要等一两分钟来装环境，之后的调用立即开始。

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
| **stdio**（默认） | 一个服务器进程、一个浏览器 | 两个进程、两个浏览器——什么都不共享 |
| **Streamable HTTP** | 一个 MCP 会话、一个浏览器（自己的 profile 和 sidecar） | 一个长期运行的服务器，每个 MCP 会话一个浏览器 |

想多个 agent 共用一个装好的服务器时，起一个 HTTP 端点：

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs \
  --transport http --host 127.0.0.1 --port 7331 --path /mcp
```

端点默认是 `http://127.0.0.1:7331/mcp`。每个 MCP `initialize` 会话都有自己的浏览器；一个静默 15 分钟的会话会被关掉浏览器并删除它的 profile（`BROWSER_USE_MCP_HTTP_IDLE_MS` 可以改这个时限）。它没有认证：默认只绑回环地址，绑到非回环地址时启动日志会给出警告。确实要离开本机，就放在你自己控制的隧道或反向代理后面。

两个服务器配了**同一个浏览器 profile** 时会被拒绝，而不是悄悄共用一个浏览器：第一个在 profile 目录里持锁，第二个得到一条写明 `--profile` 和修法的工具错误。崩溃进程留下的锁会被自动回收。

### 接到你自己的 Chrome（可选）

默认情况下服务器**启动一个专用 Chrome**，profile 放在状态根目录下。它不碰你日常用的浏览器，因此不会出现授权弹窗，你的登录态也不会进入自动化。

确实想用你自己的浏览器时：

- **`--mode attach --cdp-endpoint http://127.0.0.1:9333`**（或 `ws://…` 端点）驱动一个你开着远程调试的浏览器。
- **`--mode attach`** 不带端点时，通过 Chrome 写进 profile 的 `DevToolsActivePort` 找到你日常用的 Chrome。先在那个 Chrome 里打开远程调试（`chrome://inspect/#remote-debugging`）。在 macOS 上这个文件受隐私保护，所以运行本服务器的应用需要**完全磁盘访问权限**（系统设置 → 隐私与安全性 → 完全磁盘访问权限），然后重启它。

一个外部浏览器只由一个服务器驱动：会话会为自己的 DevTools 端点持有一份 claim，第二个连到同一端点的服务器会被拒绝。`browser_close` 只停本会话的标签页和 daemon，从不关闭所连的浏览器。

---

## 配置要点

服务器设置都是一个 flag 配一个环境变量（策略用的是 `TYPESAFE_*`/`TEXT_MODEL_*`；少数几项只有环境变量）；两者同时出现时 flag 生效。完整的表格、解析规则、默认值和退出码在 **[docs/config.md](docs/config.md)**。

| 设置 | Flag | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| 传输 | `--transport`、`--host`、`--port`、`--path` | `BROWSER_USE_MCP_TRANSPORT`、`BROWSER_USE_MCP_HOST`、`BROWSER_USE_MCP_PORT`、`BROWSER_USE_MCP_PATH` | `stdio`、`127.0.0.1`、`7331`、`/mcp` |
| 自己启动或接入 | `--mode`、`--cdp-endpoint` | `BROWSER_USE_MCP_MODE`、`BROWSER_USE_MCP_CDP_ENDPOINT` | `launch` |
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
├── profiles/<name>/            启动的 Chrome profile（登录态、标签页）
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
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs doctor
```

- **profile 已被占用。** 报错会点名 profile 和 `--profile`：停掉另一个服务器，或者给这个服务器一个自己的 `--profile <name>`。两个服务器驱动同一个浏览器 profile，是服务器会主动拒绝的唯一一种配置。
- **attach 模式找不到浏览器。** doctor 会打印 `attach mode drives …` 和原因。把那个浏览器开着远程调试（`chrome://inspect/#remote-debugging`），改正 `--cdp-endpoint`，或者改用 `--mode launch`。macOS 上，给这个应用完全磁盘访问权限，它才能读你 Chrome 的 profile。
- **引擎还没装。** 首次使用会把它装进状态根；想提前装，就在 checkout 里跑 `node bin/browser-use-mcp.mjs install`，或者在 agent 里调 `browser_doctor` 并带上 `install: true`。走代理的话，给运行服务器的进程设 `HTTPS_PROXY`。
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
- **启动的浏览器有自己的 profile。** 除非你显式用 `--mode attach` 接入，否则它不是你的日常 Chrome profile。
- **一条连接，一个驱动。** 不要对同一个浏览器再起一个 CDP 客户端；Chrome 对每个连接单独授权，两个驱动会互相抢页面。

---

## 许可证与致谢

MIT。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

本项目建立在 [`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use)（MIT）之上：`sidecar/bridge.py` 来自它，动作空间渲染、新鲜度规则、“一条连接”规则和 direct mode 的工具描述也都沿袭自它。浏览器引擎是 [`jev-ultrafast`](https://github.com/ricardochen1996/jev-ultrafast)（MIT），以固定版本的 wheel 随包发布；浏览器接入是 [`browser-harness`](https://github.com/browser-use/browser-harness)（MIT）。设计与取舍见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
npm test          # 快速单元测试（node --test）
npm run test:e2e  # 真实 headless Chrome 跑真实 MCP 协议
                  # （stdio、HTTP、attach 模式、用回环 stub 验证的 Jev intent）
npm run doctor    # CLI 自检
```

默认测试不花模型调用、不需要任何凭据；e2e 测试首次运行会把引擎装进一个测试用的状态根。版本历史见 [CHANGELOG.md](CHANGELOG.md)。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
