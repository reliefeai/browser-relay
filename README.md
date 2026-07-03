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
  <a href="#cli">CLI</a>
  ·
  <a href="#remote-control-remote-relay">Remote</a>
  ·
  <a href="#http-api">HTTP API</a>
  ·
  <a href="README.zh-CN.md">中文</a>
</p>

Browser Relay connects your real, logged-in Chrome to AI agents — over a plain CLI, MCP, or HTTP. Agents work inside the tabs you already have open, **locally or from another machine**, instead of a throwaway automation profile or a headless browser. No cloud browser, no separate automation window, no surprise tabs.

## Real Chrome, not a throwaway profile

Most browser automation spins up a fresh, empty browser profile. That is fine for testing, but useless for agents that need your **authenticated** web apps — SaaS dashboards, admin panels, internal tools, documents, private sessions — where a headless browser or a fresh profile simply is not logged in.

Browser Relay is that missing layer:

- **Your actual Chrome session** — cookies, localStorage, extensions, and login state, shared as-is.
- **No pop-up automation browser** — it never spawns a separate window or opens tabs behind your back; navigation reuses an attached tab.
- **Local or remote** — drive the browser from this machine, or from anywhere through a public relay service (self-hostable on Cloudflare in one click), with no public port exposed.
- **Agent-first** — a bundled Skill, an MCP server, and a simple HTTP API; works with Claude, Claude Code, Cursor, Windsurf, custom agents, and scripts.
- **Local-first boundary** — the relay binds to `127.0.0.1` by default.

## Provenance

Based on [chengyixu/openclaw-browser-relay](https://github.com/chengyixu/openclaw-browser-relay), with auto-attach behavior inspired by [blakesabatinelli/openclaw-chrome-relay](https://github.com/blakesabatinelli/openclaw-chrome-relay). Repackaged as a general-purpose local browser bridge for AI agents, without the OpenClaw-specific gateway, token auth, or platform bindings.

## Architecture

```text
Local
  AI Agent ──CLI / MCP / HTTP──▶ Relay server (Node, 127.0.0.1)
                                        │ WebSocket
                                        ▼
                                 Chrome extension ──chrome.debugger / CDP──▶ your Chrome tabs

Remote (Remote Relay)
  AI Agent ──HTTPS──▶ public relay (relay.linso.ai) ◀──WSS── Chrome extension ──▶ your Chrome tabs
```

**Local mode** is the default: the agent talks to a relay server on `127.0.0.1`, which forwards Chrome DevTools Protocol commands to the extension.

**Remote mode** exposes nothing. When you turn on Remote Relay, the extension connects *out* to a public relay service; a remote CLI reaches that same service, which routes each command down to your browser over the existing connection — no open ports, no local server on the network. Use the default hosted relay, or run your own on Cloudflare in one click (see below).

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

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension` directory printed by `browser-relay path`.

Upgrade with `browser-relay update`. It installs `@linsoai/browser-relay@latest` globally, refreshes the background service, and prints a status check; the extension reloads itself the next time it reconnects (within ~30 seconds).

### 3. Install the Agent Skill

Browser Relay ships with an agent-friendly Skill. Print the install command:

```bash
browser-relay skill
```

Then run the printed `npx skills ...` command and choose the agent to install it into, or run it directly with `$(browser-relay skill)`. After that, your agent can operate your own browser without opening a separate automation browser.

## Agent Friendly by Default

Browser Relay is designed to be comfortable for agents, not just low-level automation scripts.

- The included Skill tells agents when to use Browser Relay and how to interact safely.
- Page snapshots are annotated with links, buttons, inputs, and other interactive elements so agents can plan before acting.
- Actions target existing attached tabs, keeping the user's browser context visible and predictable.
- Console and network capture record `console.*`, page exceptions, log entries, and request/response activity for debugging real-page behavior.

## CLI

The CLI is the primary interface. For agents that can run shell commands, it is faster and less error-prone than hand-writing `curl` JSON:

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

For long text or JavaScript, avoid shell escaping by reading from stdin:

```bash
printf 'hello\nworld' | browser-relay type --selector textarea --stdin
browser-relay eval --stdin < script.js
```

All browser commands accept `--json` for the raw API response and `--tab <id>` to target a specific tab. When `--json` is used, a failed command prints the structured error payload and exits non-zero.

### Remote control (Remote Relay)

To drive this browser from **another machine** — a CI box, a remote agent, a different network — turn on **Remote Relay** in the extension's Options page. The browser connects out to a public relay service (the hosted `relay.linso.ai` by default); nothing listens on a public port and no local server is exposed.

Turning it on mints a secret **Device ID** — treat it like a password. Pass it to the same CLI commands from anywhere:

```bash
browser-relay tabs --remote-device-id br-xxxx
browser-relay eval "location.href" --remote-device-id br-xxxx

# Save an alias once so you don't retype the id (remote ls / rm to manage):
browser-relay remote add mymac br-xxxx
browser-relay tabs --remote mymac
```

**Run your own relay** instead of the hosted one — it's a small Cloudflare Worker in `hub/`:

```bash
git clone https://github.com/reliefeai/browser-relay
cd browser-relay/hub && npx wrangler deploy
```

Then set the Options page's *Public relay* field to the printed `…workers.dev` URL. (A one-click **Deploy to Cloudflare** button is in `hub/README.md`, but it needs Cloudflare's GitHub integration; `wrangler deploy` always works.)

The `remote-device-id` is a capability — anyone with it can control this browser while Remote Relay is on. Design notes: `docs/remote-control-hub.md`.

### CLI reference

```bash
browser-relay            # Run the relay server in the foreground
browser-relay start      # Start the background service
browser-relay stop       # Stop the background service
browser-relay restart    # Restart the background service
browser-relay fix        # Restart and clear stale session state (when tabs won't connect)
browser-relay update     # Update the global package and refresh the service
browser-relay status     # Show service state and HTTP health
browser-relay logs       # Tail /tmp/browser-relay.log
browser-relay path       # Print the Chrome extension directory
browser-relay skill      # Print the Skill install command
browser-relay install    # Register the background service
browser-relay uninstall  # Unregister the background service

browser-relay tabs       # List attached browser tabs
browser-relay console    # Print captured console/page errors
browser-relay network    # Print captured network requests/responses/failures
browser-relay snapshot   # Print annotated page text
browser-relay click      # Click an element by CSS selector
browser-relay type       # Type text into the page
browser-relay key        # Press a key or shortcut
browser-relay scroll     # Scroll the page
browser-relay screenshot # Save a PNG screenshot
browser-relay eval       # Evaluate JavaScript in the page
browser-relay download   # Print src/href for an element
browser-relay download-start # Start a Chrome download
browser-relay downloads      # List Chrome downloads and events
browser-relay remote     # Manage remote aliases (add / ls / rm)
browser-relay api-help   # Show browser command examples
```

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

The MCP server exposes high-level tools such as `browser_tabs`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_key`, and `browser_screenshot`.

## HTTP API

The HTTP API is the stable integration surface for code and custom tools. For interactive agent work, prefer the CLI above.

Errors use a structured shape across HTTP, CLI `--json`, and MCP tool errors:

```json
{ "ok": false, "code": "invalid_request", "error": "url is required", "message": "url is required", "status": 400, "retryable": false }
```

```bash
# List attached tabs
curl http://127.0.0.1:18795/api/tabs

# Take a text snapshot of a page
curl "http://127.0.0.1:18795/api/snapshot?tabId=ABC123"

# Read captured console/page errors
curl "http://127.0.0.1:18795/api/console?tabId=ABC123&limit=50"

# Read captured network activity (sensitive headers are redacted)
curl "http://127.0.0.1:18795/api/network?tabId=ABC123&type=response&status=500"

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
| `/api/console` | GET | Read captured console/page error entries |
| `/api/console/clear` | POST | Clear captured console entries |
| `/api/network` | GET | Read captured Network.* request/response/failure entries |
| `/api/network/clear` | POST | Clear captured network entries |
| `/api/navigate` | POST | Navigate an attached tab |
| `/api/snapshot` | GET | Get annotated text or raw HTML |
| `/api/click` | POST | Click an element by CSS selector |
| `/api/type` | POST | Type into an input |
| `/api/key` | POST | Press a key or keyboard shortcut |
| `/api/scroll` | POST | Scroll the page |
| `/api/screenshot` | GET/POST | Capture a PNG screenshot; full-page mode returns capture strategy/size metadata |
| `/api/eval` | POST | Evaluate JavaScript in the page |
| `/api/download` | POST | Extract an element URL |
| `/api/download/start` | POST | Start a real Chrome download from a URL |
| `/api/downloads` | GET | List Chrome downloads and recent download events |
| `/api/downloads/clear` | POST | Clear captured download events |

Real Chrome downloads require the extension's `downloads` permission. After upgrading from an older Browser Relay version, reload the unpacked extension in `chrome://extensions`.

The same endpoints are reachable remotely: a CLI running with `--remote-device-id` sends them through the public relay to the browser.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `BROWSER_RELAY_URL` | `http://127.0.0.1:18795` | Relay base URL used by CLI browser commands and MCP |
| `BROWSER_RELAY_HOST` | `127.0.0.1` | HTTP and WebSocket bind address |
| `BROWSER_RELAY_PORT` | `18795` | HTTP and WebSocket port |
| `BROWSER_RELAY_REMOTE_DEVICE_ID` | — | Remote Device ID (or alias) used when no `--remote-device-id` flag is passed |
| `BROWSER_RELAY_REMOTE_HOST` | `https://relay.linso.ai` | Public relay URL for remote commands |

The Chrome extension port can be changed from the extension Options page.

Service files:

```text
macOS: ~/Library/LaunchAgents/org.browser-relay.service.plist
Linux: ~/.config/systemd/user/browser-relay.service
```

Logs: `/tmp/browser-relay.log`, `/tmp/browser-relay.error.log`

## Development

```bash
npm install
npm start
npm run mcp
npm test
```

Load the local `extension/` directory from `chrome://extensions` in Developer mode.

## Security

- The extension uses Chrome's `debugger` permission. Install only versions you trust.
- The relay binds to `127.0.0.1` by default. Do not expose it to the public internet.
- Remote Relay never opens a port: the browser connects out to the public relay, which only holds a hash of your Device ID secret in memory. Treat the Device ID like a password; anyone with it can control the browser while Remote Relay is on.
- Browser Relay gives agents access to the same browser state you have, so treat enabled agents as trusted local software.

## License

MIT
