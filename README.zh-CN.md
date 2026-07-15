<p align="center">
  <img src="extension/icons/icon128.png" width="96" height="96" alt="Browser Relay logo">
</p>

<h1 align="center">Browser Relay</h1>

<p align="center">
  让 AI Agent 和你共用同一个 Chrome 浏览器。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Agent-Skill%20%2B%20CLI-blue" alt="Agent Skill 与 CLI">
  <img src="https://img.shields.io/badge/远程-多机器控制-7c3aed" alt="远程多机器控制">
  <img src="https://img.shields.io/badge/开源-MIT-green" alt="MIT 开源">
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#agent-友好">Agent Skill</a>
  ·
  <a href="#cli">CLI</a>
  ·
  <a href="#远程控制remote-relay">远程</a>
</p>

<p align="center">
  <a href="https://github.com/reliefeai/browser-relay/blob/main/docs/assets/browser-relay-mobile-to-office.mp4">
    <img src="https://raw.githubusercontent.com/reliefeai/browser-relay/main/docs/assets/browser-relay-mobile-to-office.gif" width="960" alt="Browser Relay 示意流程：手机上的 Agent 通过 Skill 和 CLI 操作办公室电脑现有 Chrome 中的 mock 内网页面">
  </a>
</p>

<p align="center"><sub>示意流程使用 mock 数据，不含真实凭据。点击动画可查看 MP4 版本。</sub></p>

Browser Relay 通过面向 Agent 的 **Skill + CLI**，让 AI Agent 加入你每天正在使用的 Chrome。它不会创建空白的自动化浏览器，不需要反复把另一个浏览器窗口拉到前台，也不用重新登录。你和 Agent 共用同一个日常浏览器——既可以在本机，也可以跨多台机器。

它特别适合这些任务：人在外面用手机上的 Agent 操作电脑浏览器；在家里让 Agent 使用公司电脑上已有内网、SSO 和设备信任的 Chrome；或者让一个 Agent 根据登录态和网络环境，在多台机器的浏览器之间工作。

## 真实 Chrome,而非临时配置

大多数浏览器自动化会开一个全新的空白浏览器配置。这适合测试,但对需要操作你**已登录**的 Web 应用的 Agent 毫无用处 —— SaaS 后台、管理面板、内网工具、文档、私有会话,这些页面在无头浏览器或全新配置里根本没有登录态。

Browser Relay 补的就是这一层(也是很多人在找的 OpenClaw Browser Relay 替代方案):

- **就是你自己的 Chrome 会话** —— Cookie、localStorage、扩展、登录状态,原样共用。
- **不弹自动化浏览器** —— 不开额外窗口、不在背后建标签;普通导航复用已附加的标签页。
- **本地或远程** —— 一个 Agent 可以操作本机或多台远程机器上的浏览器；浏览器通过出站连接接入，不暴露公网浏览器端口。
- **面向 Agent** —— 安装自带 Skill 后，Claude Code、Codex、Cursor、Windsurf 等 Agent 会知道何时、如何调用可检查的 CLI。
- **本地优先边界** —— 默认只监听 `127.0.0.1`。

## 来源说明

源代码整理自 [chengyixu/openclaw-browser-relay](https://github.com/chengyixu/openclaw-browser-relay),自动附加标签页的逻辑参考了 [blakesabatinelli/openclaw-chrome-relay](https://github.com/blakesabatinelli/openclaw-chrome-relay)。移除了 OpenClaw 专属的网关握手、token 鉴权和平台绑定,整理为通用的本地浏览器桥。

## 工作方式

```text
本地
  AI Agent ──Skill + CLI──▶ Relay 服务器 (Node, 127.0.0.1)
                                        │ WebSocket
                                        ▼
                                 Chrome 扩展 ──chrome.debugger / CDP──▶ 你的 Chrome 标签页

远程（Remote Relay）
  AI Agent ──HTTPS──▶ 公网 Relay 服务 (relay.linso.ai) ◀──WSS── Chrome 扩展 ──▶ 你的 Chrome 标签页
```

**本地模式**是默认:Agent 连本机 `127.0.0.1` 上的 relay 服务器,由它把 Chrome DevTools Protocol 命令转发给扩展。

**远程模式**不暴露任何东西。打开 Remote Relay 后,扩展会主动**出站**连到公网 Relay 服务;远程的 CLI 连到同一个服务,由它顺着这条已有连接把每条命令下发到你的浏览器 —— 没有开放端口,网络上也没有本地服务。命令由扩展用 `chrome.debugger` 自己执行,所以远程控制不依赖本地 relay。可以用默认的托管服务,也可以一键部署到 Cloudflare 自建(见下文)。

## 快速开始

使用分四步。需要桌面版 Chrome 和 Node.js/npm。macOS、Linux 会自动安装用户级后台服务；Windows 原生后台服务支持落地前，请在终端里保持 `browser-relay` 运行。

### 1. 安装

```bash
npm install -g @linsoai/browser-relay
browser-relay status
```

macOS 和 Linux 上,全局安装会自动注册用户级后台服务,登录后自动启动。若服务未启动,可以执行 `browser-relay start`。

### 2. 安装 Chrome 扩展

先获取扩展目录:

```bash
browser-relay path
```

然后打开 `chrome://extensions`,打开右上角开发者模式,点击 `Load unpacked`,选择 `browser-relay path` 输出的 `extension` 目录。

升级用 `browser-relay update`:它会全局安装 `@linsoai/browser-relay@latest`、刷新后台服务并输出状态检查;扩展会在下次重连(约 30 秒内)自动重载。

### 3. 验证浏览器连接

安装 Skill 前先执行两项检查：

```bash
browser-relay status
browser-relay tabs
```

`status` 应显示 `HTTP: responding`；`tabs` 应至少输出一条标签页 ID、标题和 URL：

```text
ABC123    Example Domain    https://example.com/
```

如果没有标签页，先重新加载 unpacked 扩展，再执行 `browser-relay fix`，然后重试 `browser-relay tabs`。扩展仍未连接时，用 `browser-relay logs` 查看日志。

### 4. 安装 Agent Skill 并完成第一个任务

Browser Relay 自带 Agent Skill:

```bash
browser-relay skill
```

命令会输出一条 `npx skills ...` 安装命令,按提示安装到对应 Agent;也可以直接执行 `$(browser-relay skill)`。安装后就能让 Agent 操作你自己的浏览器,而不用另开自动化浏览器。

第一次先给 Agent 一个只读的小任务：

```text
使用 Browser Relay 告诉我当前 Chrome 标签页的标题和 URL，不要导航。
```

Agent 能正确回答，就证明整条链路已经打通：Agent Skill → CLI → relay → 扩展 → 你正在使用的 Chrome 标签页。

## Agent 友好

Browser Relay 专门为 Agent 工作流做了设计,不只是给底层脚本用:

- 自带 Skill,告诉 Agent 何时用 Browser Relay 以及如何安全交互。
- 页面快照会标注链接、按钮、输入框等交互元素,方便 Agent 先理解页面再行动。
- 操作落在已附加的真实标签页上,让浏览器上下文保持可见、可预期。
- Console 和 Network 捕获会记录 `console.*`、页面异常、日志以及请求/响应,便于诊断真实页面行为。

## CLI

CLI 是首选接口。能执行 shell 的 Agent 用它比手写 `curl` JSON 更快、更少转义:

```bash
browser-relay tabs
browser-relay console --tab ABC123 --limit 50
browser-relay network --tab ABC123 --type response --status 500
browser-relay snapshot --tab ABC123 --max-length 20000
browser-relay click 'button[type=submit]' --tab ABC123
browser-relay type 'hello world' --selector 'input[name=q]' --clear --submit
browser-relay key Control+L
browser-relay scroll down --amount 1000
browser-relay screenshot /tmp/page.png --full-page
browser-relay eval 'document.title'
```

长文本或多行 JavaScript 从 stdin 读取,避免 shell 转义:

```bash
printf 'hello\nworld' | browser-relay type --selector textarea --stdin
browser-relay eval --stdin < script.js
```

所有浏览器命令都支持 `--json`(输出原始 API 响应)和 `--tab <id>`(指定标签页)。用 `--json` 时失败命令会输出结构化错误 JSON 并以非 0 退出。

### 远程控制（Remote Relay）

要从**另一台机器**(CI、远程 agent、不同网络)控制这个浏览器,在扩展 Options 页面打开 **Remote Relay**。浏览器会主动连到公网 Relay 服务(默认是托管的 `relay.linso.ai`)——不开放任何公网端口,也不暴露本地服务。

打开后会生成一个保密的 **Device ID**——请像密码一样保管,在任何地方传给同样的 CLI 命令即可:

```bash
browser-relay tabs --remote-device-id br-xxxx
browser-relay eval "location.href" --remote-device-id br-xxxx

# 存个别名,以后不用重复贴长 id(remote ls / rm 管理):
browser-relay remote add mymac br-xxxx
browser-relay tabs --remote mymac
```

**自建你自己的 Relay 服务** —— 一键把 `hub/` 里的 Worker 部署到你自己的 Cloudflare 账号:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/reliefeai/browser-relay/tree/main/hub)

按钮第一次会让你把 Cloudflare 连上 GitHub(Workers Builds)。想用命令行?`git clone` 后 `cd hub && npx wrangler deploy`。两种方式都会给你一个 `…workers.dev` 地址,填到 Options 页面的 *公网 Relay 服务* 字段即可。

`remote-device-id` 是一个 capability —— Remote Relay 开着时,拿到它的人就能控制这个浏览器。设计见 `docs/remote-control-hub.md`。

### CLI 参考

```bash
browser-relay            # 前台运行 relay server
browser-relay start      # 启动后台服务
browser-relay stop       # 停止后台服务
browser-relay restart    # 重启后台服务
browser-relay fix        # 重启并清理失效会话（标签页连不上时用）
browser-relay update     # 更新全局 npm 包并刷新后台服务
browser-relay status     # 查看服务状态和 HTTP 健康检查
browser-relay logs       # 查看 /tmp/browser-relay.log
browser-relay path       # 输出 Chrome 扩展目录
browser-relay skill      # 输出 Skill 安装命令
browser-relay install    # 注册后台服务
browser-relay uninstall  # 卸载后台服务

browser-relay tabs       # 列出已附加标签页
browser-relay console    # 输出 console 和页面错误记录
browser-relay network    # 输出网络请求、响应和失败事件
browser-relay snapshot   # 输出页面结构化文本
browser-relay click      # 按 CSS selector 点击元素
browser-relay type       # 输入文本
browser-relay key        # 按键或快捷键
browser-relay scroll     # 滚动页面
browser-relay screenshot # 保存 PNG 截图
browser-relay eval       # 在页面内执行 JavaScript
browser-relay download   # 输出元素 src/href
browser-relay download-start # 启动 Chrome 下载
browser-relay downloads      # 列出 Chrome 下载和事件
browser-relay remote     # 管理远程别名（add / ls / rm）
browser-relay api-help   # 查看浏览器操作命令示例
```

## MCP

安装 npm 包后直接用 `browser-relay-mcp`:

```json
{
  "mcpServers": {
    "browser": {
      "command": "browser-relay-mcp",
      "env": {
        "BROWSER_RELAY_URL": "http://127.0.0.1:18795"
      }
    }
  }
}
```

MCP server 提供 `browser_tabs`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_key`、`browser_screenshot` 等高层工具。

## HTTP API

HTTP API 是给代码和自定义工具集成用的稳定接口。交互式 Agent 操作优先用上面的 CLI。

HTTP、CLI `--json` 和 MCP 工具错误都使用结构化错误格式:

```json
{ "ok": false, "code": "invalid_request", "error": "url is required", "message": "url is required", "status": 400, "retryable": false }
```

```bash
curl http://127.0.0.1:18795/api/tabs
curl "http://127.0.0.1:18795/api/snapshot?tabId=ABC123"
curl "http://127.0.0.1:18795/api/console?tabId=ABC123&limit=50"
curl "http://127.0.0.1:18795/api/network?tabId=ABC123&type=response&status=500"

curl -X POST http://127.0.0.1:18795/api/click \
  -H "Content-Type: application/json" \
  -d '{"tabId":"ABC123","selector":"button.submit"}'
```

| Endpoint | Method | 说明 |
| --- | --- | --- |
| `/` | GET/HEAD | 健康检查 |
| `/api/debug` | GET | 服务状态和诊断信息 |
| `/api/tabs` | GET | 列出已附加标签页 |
| `/api/console` | GET | 读取 console 和页面错误记录 |
| `/api/console/clear` | POST | 清理 console 记录 |
| `/api/network` | GET | 读取已捕获的 Network 请求、响应和失败事件（敏感 header 已脱敏） |
| `/api/network/clear` | POST | 清理已捕获的网络事件 |
| `/api/navigate` | POST | 导航已附加标签页 |
| `/api/snapshot` | GET | 获取页面文本快照或 HTML |
| `/api/click` | POST | 按 CSS selector 点击元素 |
| `/api/type` | POST | 输入文本 |
| `/api/key` | POST | 按键或键盘快捷键 |
| `/api/scroll` | POST | 滚动页面 |
| `/api/screenshot` | GET/POST | 获取 PNG 截图；full-page 会返回截图策略和尺寸元数据 |
| `/api/eval` | POST | 执行页面内 JavaScript |
| `/api/download` | POST | 获取元素 URL |
| `/api/download/start` | POST | 从 URL 启动真实 Chrome 下载 |
| `/api/downloads` | GET | 列出 Chrome 下载和最近下载事件 |
| `/api/downloads/clear` | POST | 清理已捕获的下载事件 |

真实 Chrome 下载需要扩展的 `downloads` 权限。从旧版本升级后,需在 `chrome://extensions` 里重新加载 unpacked 扩展。

这些接口远程同样可用:带 `--remote-device-id` 的 CLI 会把它们经公网 Relay 服务发到浏览器。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BROWSER_RELAY_URL` | `http://127.0.0.1:18795` | CLI 浏览器命令和 MCP 使用的 relay 地址 |
| `BROWSER_RELAY_HOST` | `127.0.0.1` | HTTP 和 WebSocket 监听地址 |
| `BROWSER_RELAY_PORT` | `18795` | HTTP 和 WebSocket 端口 |
| `BROWSER_RELAY_REMOTE_DEVICE_ID` | — | 未传 `--remote-device-id` 时使用的远程 Device ID(或别名) |
| `BROWSER_RELAY_REMOTE_HOST` | `https://relay.linso.ai` | 远程命令使用的公网 Relay 服务地址 |

Chrome 扩展端口可以在扩展 Options 页面修改。

### 隐藏「已开始调试此浏览器」顶部提示

只要扩展附加了 debugger,Chrome 就会在页面顶部强制显示一条
`"Browser Relay" 已开始调试此浏览器` 的提示条。任何扩展 API 都无法去掉它 ——
这是 Chrome 内置的防滥用安全提示。

两种处理方式:

- **自动(默认):** 扩展会在标签页闲置 10 分钟后 soft-detach,提示条在你不用时
  自动消失,下一次命令再自动 re-attach。无需配置。
- **彻底去掉:** 用 `--silent-debugger-extension-api` 参数启动 Chrome,它会抑制
  debugger 扩展 API 的这条提示。必须先完全退出 Chrome(`open --args` 只在冷启动时
  才会传入参数):

  ```bash
  # macOS
  osascript -e 'quit app "Google Chrome"'
  open -a "Google Chrome" --args --silent-debugger-extension-api
  ```

  想长期生效,就始终这样启动 Chrome(比如做个 shell 别名或 `.command` 启动器)——
  直接点 Dock 图标不会带上这个参数。

  代价:这会削弱一层安全防护 —— 之后**任何**拥有 `debugger` 权限的扩展都能静默
  附加而不再提示。个人自用、清楚它关掉了什么的前提下可以接受。

## 本地开发

```bash
npm install
npm start
npm run mcp
npm test
```

开发时在 `chrome://extensions` 中选择仓库里的 `extension/` 目录作为 unpacked extension。

## 安全说明

- Chrome 扩展使用 `debugger` 权限,只安装你信任的版本。
- 默认只监听 `127.0.0.1`,不要把 relay server 暴露到公网。
- Remote Relay 从不开放端口:浏览器主动出站连公网 Relay 服务,它只在内存里保存 Device ID 的哈希。Device ID 请像密码一样保管;Remote Relay 开着时,拿到它的人就能控制浏览器。
- Browser Relay 会让 Agent 访问你的真实浏览器状态,因此启用的 Agent 应被视为可信本地软件。

## License

MIT
