<p align="center">
  <img src="extension/icons/icon128.png" width="96" height="96" alt="Browser Relay logo">
</p>

<h1 align="center">Browser Relay</h1>

<p align="center">
  让 AI Agent 和你共用同一个 Chrome 浏览器。
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="#快速开始">快速开始</a>
  ·
  <a href="#agent-友好">Agent 友好</a>
  ·
  <a href="#http-api-示例">HTTP API</a>
</p>

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

## OpenClaw 替代方案与真实 Chrome 会话

如果你在找 OpenClaw Browser Relay alternative，Browser Relay 的定位是本地优先的 AI agent browser automation：让 Agent 使用你的真实 Chrome 会话，而不是临时浏览器配置。Agent 可以复用你日常使用的已登录标签页、Cookie、扩展和登录状态，也不要求用户打开远程 Chrome debugging port。

这适合 AI agent real Chrome session 场景：SaaS 后台、管理面板、内网工具、在线文档，以及那些因为没有登录态而让 headless browser 或全新自动化配置失效的页面。

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

升级是全自动的：执行 `npm install -g @linsoai/browser-relay@latest` 后，后台服务自动重启，扩展会在下次重连 relay 时（约 30 秒内）自动重载。可以用 `browser-relay status` 确认，它会同时显示 CLI 和 daemon 的版本。

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

## Agent 友好

Browser Relay 不是只给底层自动化脚本使用的，它也专门面向 Agent 工作流做了设计：

- 自带 Skill，告诉 Agent 什么时候使用 Browser Relay，以及如何安全交互。
- MCP server 提供 `browser_tabs`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_screenshot` 等高层工具。
- HTTP API 足够简单，自定义 Agent 或脚本也可以直接调用。
- 页面快照会标注链接、按钮、输入框等交互元素，方便 Agent 先理解页面再行动。
- 操作会落在已附加的真实标签页上，让用户的浏览器上下文保持可见、可预期。

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

## 浏览器 CLI

如果 Agent 能执行 shell 命令，优先用 CLI，通常比手写 `curl` JSON 更快，也少很多转义：

```bash
browser-relay tabs
browser-relay snapshot --tab ABC123 --max-length 20000
browser-relay click 'button[type=submit]' --tab ABC123
browser-relay type 'hello world' --selector 'input[name=q]' --clear --submit
browser-relay scroll down --amount 1000
browser-relay screenshot /tmp/page.png --full-page
browser-relay eval 'document.title'
```

长文本或多行 JavaScript 可以从 stdin 读取，避免 shell 转义：

```bash
printf 'hello\nworld' | browser-relay type --selector textarea --stdin
browser-relay eval --stdin < script.js
```

所有浏览器操作命令都支持 `--json` 输出原始 API 响应，也支持 `--tab <id>` 指定标签页。

Agent 使用规则：浏览器交互默认使用 CLI。只有在编写代码、测试、集成
Browser Relay，或者当前环境没有 CLI 时，才直接使用 HTTP API。

## HTTP API 示例

HTTP API 是给代码和自定义工具集成用的稳定接口。交互式 Agent 操作优先使用上面的 CLI。

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
browser-relay fix        # 重启并清理失效会话（标签页连不上时用）
browser-relay status     # 查看服务状态和 HTTP 健康检查
browser-relay logs       # 查看 /tmp/browser-relay.log
browser-relay path       # 输出 Chrome 扩展目录
browser-relay skill      # 输出 Skill 安装命令
browser-relay install    # 注册后台服务
browser-relay uninstall  # 卸载后台服务

browser-relay tabs       # 列出已附加标签页
browser-relay snapshot   # 输出页面结构化文本
browser-relay click      # 按 CSS selector 点击元素
browser-relay type       # 输入文本
browser-relay screenshot # 保存 PNG 截图
browser-relay eval       # 在页面内执行 JavaScript
browser-relay api-help   # 查看浏览器操作命令示例
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BROWSER_RELAY_URL` | `http://127.0.0.1:18795` | CLI 浏览器操作命令和 MCP 使用的 relay 地址 |
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
