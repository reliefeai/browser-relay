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
  <a href="README.zh-CN.md">中文</a>
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
