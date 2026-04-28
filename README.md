<p align="center">
  <img src="extension/icons/icon128.png" width="96" height="96" alt="Browser Relay logo">
</p>

<h1 align="center">Browser Relay</h1>

<p align="center">
  Let AI agents use the same Chrome browser you use every day.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@linsoai/browser-relay"><img src="https://img.shields.io/npm/v/@linsoai/browser-relay.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@linsoai/browser-relay"><img src="https://img.shields.io/npm/dm/@linsoai/browser-relay.svg" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/MCP-ready-blue" alt="MCP ready">
  <img src="https://img.shields.io/badge/local--first-127.0.0.1-111827" alt="Local first">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a>
  ·
  <a href="#agent-friendly-by-default">Agent Friendly</a>
  ·
  <a href="#http-api">HTTP API</a>
  ·
  <a href="#中文说明">中文说明</a>
</p>

Browser Relay is a local browser-control bridge for AI agents. It connects your existing Chrome session to agents through HTTP API or MCP, so they can read pages, click buttons, type into forms, scroll, take screenshots, and evaluate JavaScript in the same browser where you are already logged in.

No cloud browser. No throwaway automation profile. No surprise browser windows or new tabs. Browser Relay works with the Chrome tabs you already have open, and normal navigation reuses an attached tab instead of launching a separate browser.

## Why Browser Relay

Most browser automation tools create a fresh browser profile. That is great for testing, but awkward for agents that need to work with your real web apps, authenticated dashboards, SaaS tools, admin panels, documents, or private sessions.

Browser Relay is built for that missing layer:

- **Same browser as the user**: agents share your real Chrome session, including cookies, localStorage, extensions, and login state.
- **No pop-up automation browser**: it does not spawn a separate Chrome window or create temporary tabs behind your back.
- **Agent-first interface**: use the included Skill, MCP server, or plain HTTP API.
- **Local-first security boundary**: the relay binds to `127.0.0.1` by default.
- **Universal integration**: works with Claude, Claude Code, Cursor, Windsurf, custom agents, scripts, and tools that can call HTTP or MCP.

## Provenance

This project is based on source code from [chengyixu/openclaw-browser-relay](https://github.com/chengyixu/openclaw-browser-relay), with architecture and auto-attach behavior inspired by [blakesabatinelli/openclaw-chrome-relay](https://github.com/blakesabatinelli/openclaw-chrome-relay).

This distribution removes OpenClaw-specific gateway handshakes, token authentication, and platform bindings, and repackages the relay as a general-purpose local browser bridge for AI agents.

## Architecture

```text
AI Agent
  |
  | HTTP API / MCP
  v
Browser Relay Server (Node.js, localhost)
  |
  | WebSocket
  v
Browser Relay Chrome Extension
  |
  | chrome.debugger / CDP
  v
Your existing Chrome tabs
```

The relay server listens on `127.0.0.1` by default. The Chrome extension attaches to regular Chrome tabs and forwards Chrome DevTools Protocol commands between the local relay and the browser.

## Quick Start

Use Browser Relay in three steps.

### 1. Install

```bash
npm install -g @linsoai/browser-relay
browser-relay status
```

On macOS and Linux, the global install registers a user-level background service through launchd or systemd-user. The service starts on login and restarts on crash.

If the service is not running yet:

```bash
browser-relay start
```

### 2. Load the Chrome extension

Print the extension directory:

```bash
browser-relay path
```

Then open Chrome:

```text
chrome://extensions
```

Enable **Developer mode**, click **Load unpacked**, and select the `extension` directory printed by `browser-relay path`.

When upgrading the npm package, Chrome will not automatically reload unpacked extensions. After `npm install -g @linsoai/browser-relay@latest`, open `chrome://extensions` and click reload on the Browser Relay extension card.

### 3. Install the Agent Skill

Browser Relay ships with an agent-friendly Skill. Print the install command:

```bash
browser-relay skill
```

Then run the printed `npx skills ...` command and choose the agent you want to install it into.

You can also run it directly:

```bash
$(browser-relay skill)
```

After that, your agent can operate your own browser without opening a separate automation browser.

## Agent Friendly by Default

Browser Relay is designed to be comfortable for agents, not just low-level automation scripts.

- The included Skill tells agents when to use Browser Relay and how to interact safely.
- The MCP server exposes high-level tools such as `browser_tabs`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_screenshot`.
- The HTTP API is simple enough for any custom agent or script.
- Page snapshots are annotated with links, buttons, inputs, and other interactive elements so agents can plan before acting.
- Actions target existing attached tabs, keeping the user's browser context visible and predictable.

## MCP

After installing the npm package, use `browser-relay-mcp` directly:

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

## HTTP API

```bash
# List attached tabs
curl http://127.0.0.1:18795/api/tabs

# Take a text snapshot of a page
curl "http://127.0.0.1:18795/api/snapshot?tabId=ABC123"

# Click an element
curl -X POST http://127.0.0.1:18795/api/click \
  -H "Content-Type: application/json" \
  -d '{"tabId":"ABC123","selector":"button.submit"}'
```

| Endpoint | Method | Description |
| --- | --- | --- |
| `/` | GET/HEAD | Health check |
| `/api/debug` | GET | Server diagnostics |
| `/api/tabs` | GET | List attached tabs |
| `/api/navigate` | POST | Navigate an attached tab |
| `/api/snapshot` | GET | Get annotated text or raw HTML |
| `/api/click` | POST | Click an element by CSS selector |
| `/api/type` | POST | Type into an input |
| `/api/scroll` | POST | Scroll the page |
| `/api/screenshot` | GET/POST | Capture a PNG screenshot |
| `/api/eval` | POST | Evaluate JavaScript in the page |
| `/api/download` | POST | Extract an element URL |

## CLI

```bash
browser-relay            # Run the relay server in the foreground
browser-relay start      # Start the background service
browser-relay stop       # Stop the background service
browser-relay restart    # Restart the background service
browser-relay status     # Show service state and HTTP health
browser-relay logs       # Tail /tmp/browser-relay.log
browser-relay path       # Print the Chrome extension directory
browser-relay skill      # Print the Skill install command
browser-relay install    # Register the background service
browser-relay uninstall  # Unregister the background service
```

Service files:

```text
macOS: ~/Library/LaunchAgents/org.browser-relay.service.plist
Linux: ~/.config/systemd/user/browser-relay.service
```

Logs:

```text
/tmp/browser-relay.log
/tmp/browser-relay.error.log
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `BROWSER_RELAY_HOST` | `127.0.0.1` | HTTP and WebSocket bind address |
| `BROWSER_RELAY_PORT` | `18795` | HTTP and WebSocket port |

The Chrome extension port can be changed from the extension Options page.

## Development

```bash
npm install
npm start
npm run mcp
```

Load the local `extension/` directory from `chrome://extensions` in Developer mode.

Useful checks:

```bash
npm run sync-version
npm run pack:dry-run
```

## Security

- The extension uses Chrome's `debugger` permission. Install only versions you trust.
- The relay binds to `127.0.0.1` by default. Do not expose it to the public internet.
- If you change the bind address, add your own authentication and network isolation.
- Browser Relay gives agents access to the same browser state you have, so treat enabled agents as trusted local software.

## License

MIT

---

# 中文说明

Browser Relay 是一个本地 Chrome 控制桥，让 AI Agent 可以和你共用同一个 Chrome 浏览器。Agent 可以通过 HTTP API 或 MCP 读取页面、点击按钮、输入表单、滚动、截图、执行页面内 JavaScript，而且复用你当前浏览器里的登录状态、Cookie、localStorage 和扩展。

它不会启动一个额外的自动化浏览器，不会弹出新的浏览器窗口，也不会默认创建临时 Tab。Browser Relay 面向的是你已经打开的真实 Chrome 标签页，普通导航会复用已附加的标签页。

## 为什么需要它

很多浏览器自动化工具会创建一个全新的浏览器配置，这适合测试，但不适合让 Agent 帮你操作真实工作流：已登录的后台、SaaS、CRM、文档、控制台、内网站点等。

Browser Relay 解决的是这层连接：

- **和用户共用同一个浏览器**：Agent 直接使用你的真实 Chrome 会话。
- **不会弹出自动化浏览器和 Tab**：不创建额外浏览器窗口，不制造新的临时配置。
- **Agent 友好**：自带 Skill，也提供 MCP server 和 HTTP API。
- **本地优先**：默认只监听 `127.0.0.1`。
- **通用接入**：Claude、Claude Code、Cursor、Windsurf、自定义 Agent 和脚本都可以使用。

## 来源说明

本项目源代码整理自 [chengyixu/openclaw-browser-relay](https://github.com/chengyixu/openclaw-browser-relay)，并参考了 [blakesabatinelli/openclaw-chrome-relay](https://github.com/blakesabatinelli/openclaw-chrome-relay) 的架构和自动附加标签页逻辑。

当前版本移除了 OpenClaw 专属的网关握手、token 鉴权和平台绑定，整理为通用的本地 Browser Relay。

## 工作方式

```text
AI Agent
  |
  | HTTP API / MCP
  v
Browser Relay Server (Node.js, localhost)
  |
  | WebSocket
  v
Browser Relay Chrome Extension
  |
  | chrome.debugger / CDP
  v
你已经打开的 Chrome 标签页
```

## 快速开始

使用分三步。

### 1. 安装

```bash
npm install -g @linsoai/browser-relay
browser-relay status
```

macOS 和 Linux 上，全局安装会自动注册用户级后台服务，登录后自动启动。若服务未启动，可以执行：

```bash
browser-relay start
```

### 2. 安装 Chrome 扩展

先获取扩展目录：

```bash
browser-relay path
```

然后打开：

```text
chrome://extensions
```

打开右上角开发者模式，点击 `Load unpacked`，选择 `browser-relay path` 输出的 `extension` 目录。

升级 npm 包后，Chrome 不会自动刷新 unpacked extension。执行 `npm install -g @linsoai/browser-relay@latest` 后，需要在 `chrome://extensions` 里点击 Browser Relay 扩展卡片上的刷新按钮。

### 3. 安装 Agent Skill

Browser Relay 自带 Agent Skill：

```bash
browser-relay skill
```

命令会输出一条 `npx skills ...` 安装命令，按提示安装到对应的 Agent 里。

也可以直接执行：

```bash
$(browser-relay skill)
```

安装完成后，就可以让 Agent 操作你自己的浏览器了。

## MCP 配置

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

## HTTP API 示例

```bash
curl http://127.0.0.1:18795/api/tabs

curl "http://127.0.0.1:18795/api/snapshot?tabId=ABC123"

curl -X POST http://127.0.0.1:18795/api/click \
  -H "Content-Type: application/json" \
  -d '{"tabId":"ABC123","selector":"button.submit"}'
```

常用接口：

| Endpoint | Method | 说明 |
| --- | --- | --- |
| `/` | GET/HEAD | 健康检查 |
| `/api/debug` | GET | 服务状态和诊断信息 |
| `/api/tabs` | GET | 列出已附加标签页 |
| `/api/navigate` | POST | 导航已附加标签页 |
| `/api/snapshot` | GET | 获取页面文本快照或 HTML |
| `/api/click` | POST | 按 CSS selector 点击元素 |
| `/api/type` | POST | 输入文本 |
| `/api/scroll` | POST | 滚动页面 |
| `/api/screenshot` | GET/POST | 获取 PNG 截图 |
| `/api/eval` | POST | 执行页面内 JavaScript |
| `/api/download` | POST | 获取元素 URL |

## CLI

```bash
browser-relay            # 前台运行 relay server
browser-relay start      # 启动后台服务
browser-relay stop       # 停止后台服务
browser-relay restart    # 重启后台服务
browser-relay status     # 查看服务状态和 HTTP 健康检查
browser-relay logs       # 查看 /tmp/browser-relay.log
browser-relay path       # 输出 Chrome 扩展目录
browser-relay skill      # 输出 Skill 安装命令
browser-relay install    # 注册后台服务
browser-relay uninstall  # 卸载后台服务
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BROWSER_RELAY_HOST` | `127.0.0.1` | HTTP 和 WebSocket 监听地址 |
| `BROWSER_RELAY_PORT` | `18795` | HTTP 和 WebSocket 端口 |

Chrome 扩展端口可以在扩展 Options 页面修改。

## 本地开发

```bash
npm install
npm start
npm run mcp
npm run pack:dry-run
```

开发时在 Chrome 的 `chrome://extensions` 中选择仓库里的 `extension/` 目录作为 unpacked extension。

## 安全说明

- Chrome 扩展使用 `debugger` 权限，只安装你信任的版本。
- 默认只监听 `127.0.0.1`，不要把 relay server 暴露到公网。
- 如果修改为非本机监听地址，请自行增加鉴权和网络隔离。
- Browser Relay 会让 Agent 访问你的真实浏览器状态，因此启用的 Agent 应被视为可信本地软件。

## License

MIT
