# Browser Relay

Browser Relay 是一个本地 Chrome 控制桥，让 AI Agent 可以通过 HTTP API 或 MCP 操作你已经登录的浏览器。它运行在本机，不依赖云端服务，也不绑定特定 Agent。

## 来源说明

本项目源代码整理自 [chengyixu/openclaw-browser-relay](https://github.com/chengyixu/openclaw-browser-relay)，并参考了 [blakesabatinelli/openclaw-chrome-relay](https://github.com/blakesabatinelli/openclaw-chrome-relay) 的架构和自动附加标签页逻辑。

当前版本移除了 OpenClaw 专属的网关握手、token 鉴权和平台绑定，改成一个通用的本地 Browser Relay，方便 Claude、Claude Code、Cursor、Windsurf 或其他自定义 Agent 使用。

## 能做什么

- 读取页面文本快照，并标注链接、按钮、输入框等交互元素
- 点击页面元素、输入文本、提交表单、滚动页面
- 截图、获取元素链接、执行页面内 JavaScript
- 复用你本机 Chrome 的登录状态、Cookie、localStorage 和扩展
- 同时提供 HTTP API 和 MCP stdio server

## 工作方式

```text
AI Agent
  |
  | HTTP API / MCP
  v
Browser Relay Server (Node.js, 只监听本机)
  |
  | WebSocket
  v
Browser Relay Chrome Extension
  |
  | chrome.debugger / CDP
  v
你的 Chrome 标签页
```

默认只绑定 `127.0.0.1`，只有本机进程可以访问。

## 快速开始

使用分三步。

### 1. 安装 Browser Relay

```bash
npm install -g @linsoai/browser-relay
browser-relay status
```

macOS 和 Linux 上，全局安装后会自动注册用户级后台服务，登录后自动启动。若状态显示服务未启动，可以手动执行：

```bash
browser-relay start
```

### 2. 安装 Chrome 扩展

先获取扩展目录：

```bash
browser-relay path
```

然后在 Chrome 中打开：

```text
chrome://extensions
```

打开右上角的开发者模式，点击 `Load unpacked`，选择 `browser-relay path` 输出的 `extension` 目录。

升级 npm 包后，Chrome 不会自动刷新已加载的 unpacked extension。重新执行 `npm install -g @linsoai/browser-relay@latest` 后，记得在 `chrome://extensions` 里点击 Browser Relay 卡片上的刷新按钮。

### 3. 安装 Agent Skill

```bash
browser-relay skill
```

命令会输出一条 `npx skills ...` 安装命令。按提示执行它，把 Browser Relay Skill 安装到对应的 Agent 里。

如果你想直接执行输出的安装命令，也可以：

```bash
$(browser-relay skill)
```

完成后，就可以让 Agent 操作你自己的浏览器了。

## CLI 命令

```bash
browser-relay            # 前台运行 relay server
browser-relay start      # 启动后台服务
browser-relay stop       # 停止后台服务
browser-relay restart    # 重启后台服务
browser-relay status     # 查看服务状态和 HTTP 健康检查
browser-relay logs       # 查看 /tmp/browser-relay.log
browser-relay path       # 输出 Chrome 扩展目录
browser-relay skill      # 输出 Skill 安装命令
browser-relay install    # 重新注册后台服务
browser-relay uninstall  # 卸载后台服务
```

macOS 的 launchd 文件位于：

```text
~/Library/LaunchAgents/org.browser-relay.service.plist
```

Linux 的 systemd user service 位于：

```text
~/.config/systemd/user/browser-relay.service
```

日志默认写入：

```text
/tmp/browser-relay.log
/tmp/browser-relay.error.log
```

## MCP 配置示例

安装 npm 包后，可以直接使用 `browser-relay-mcp`：

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
# 列出已附加标签页
curl http://127.0.0.1:18795/api/tabs

# 获取页面文本快照
curl "http://127.0.0.1:18795/api/snapshot?tabId=ABC123"

# 点击元素
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
| `/api/navigate` | POST | 打开或切换页面 URL |
| `/api/snapshot` | GET | 获取页面文本快照或 HTML |
| `/api/click` | POST | 按 CSS selector 点击元素 |
| `/api/type` | POST | 输入文本 |
| `/api/scroll` | POST | 滚动页面 |
| `/api/screenshot` | GET/POST | 获取 PNG 截图 |
| `/api/eval` | POST | 执行页面内 JavaScript |
| `/api/download` | POST | 获取元素 URL |

## 配置

Relay Server 支持以下环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BROWSER_RELAY_HOST` | `127.0.0.1` | HTTP 和 WebSocket 监听地址 |
| `BROWSER_RELAY_PORT` | `18795` | HTTP 和 WebSocket 端口 |

Chrome 扩展的端口可以在扩展 Options 页面里修改，默认也是 `18795`。

## 本地开发

```bash
npm install
npm start
npm run mcp
```

开发时在 Chrome 的 `chrome://extensions` 中选择仓库里的 `extension/` 目录作为 unpacked extension。

同步扩展版本号：

```bash
npm run sync-version
```

检查 npm 打包内容：

```bash
npm run pack:dry-run
```

## 自动发布到 npm

仓库包含 GitHub Actions workflow：`.github/workflows/publish.yml`。

推送到 `main` 分支时，workflow 会：

1. 安装依赖
2. 同步扩展版本号
3. 执行 `npm pack --dry-run`
4. 检查当前版本是否已经发布到 npm
5. 若该版本尚未发布，则执行 `npm publish --access public --provenance`

需要在 GitHub 仓库的 `Settings -> Secrets and variables -> Actions` 中配置：

```text
NPM_TOKEN
```

发布新版本前，先更新 `package.json` 里的 version，例如：

```bash
npm version patch
git push --follow-tags
```

## 安全说明

- Chrome 扩展使用 `debugger` 权限，只安装你信任的版本
- 默认只监听 `127.0.0.1`，不要把 relay server 暴露到公网
- 如果修改为非本机监听地址，请自行增加鉴权和网络隔离

## License

MIT
