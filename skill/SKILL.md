---
name: browser-relay
description: Control the user's local Chrome browser through Browser Relay. For agent browser interaction, use the `browser-relay` CLI by default; use HTTP API mainly when writing code, tests, or integrations. Use for dynamic/login-protected pages, clicking, typing, screenshots, or evaluating JS in tabs that carry the user's real session. Skip static pages and pure REST APIs.
---

# Browser Relay Skill

Control a real Chrome browser via the Browser Relay CLI, HTTP API, or MCP. The browser runs on the user's machine, carrying their login state, cookies, and extensions.

## When to Use

Use Browser Relay when you need to:

- **Scrape dynamic pages** — JavaScript-rendered content, SPAs, dashboards
- **Interact with login-protected sites** — pages that require the user's session (Twitter, Gmail, Notion, etc.)
- **Perform actions** — click buttons, fill forms, scroll, take screenshots
- **Get structured page text** — annotated DOM snapshot with `[link]`, `[button]`, `[input]` markers
- **Evaluate arbitrary JavaScript** in the page context

**When NOT to use:**
- Simple static pages without login — use WebFetch or Jina Reader (faster, cheaper)
- Pure API calls — use the site's REST API directly

## Prerequisites

1. **Relay Server** running (Node.js, default port `18795`)
2. **Browser Relay Chrome Extension** installed and configured with the relay port
3. At least one Chrome tab open and attached (extension auto-attaches all tabs)

## Connection Info

```
Relay URL:  http://127.0.0.1:18795
WebSocket:  ws://127.0.0.1:18795/extension
```

No authentication needed — the relay only accepts connections from localhost.

## Preferred CLI Workflow

When shell access is available, use the `browser-relay` CLI for browser
interaction. Do not hand-write `curl` for normal agent browsing tasks. The CLI
avoids JSON escaping, keeps commands short, and prints compact output by
default.

Use the HTTP API directly only when you are writing code, tests, scripts, or an
integration against Browser Relay, or when the CLI is unavailable. Use `--json`
only when you need the full API response.

```bash
browser-relay tabs
browser-relay console --tab <tabId> --limit 50
browser-relay snapshot --tab <tabId> --max-length 20000
browser-relay click 'button[type=submit]' --tab <tabId>
browser-relay type 'hello world' --selector 'input[name=q]' --clear --submit --tab <tabId>
browser-relay scroll down --amount 1000 --tab <tabId>
browser-relay screenshot /tmp/page.png --full-page --tab <tabId>
browser-relay eval 'document.title' --tab <tabId>
```

For long text or JavaScript, avoid shell escaping with stdin:

```bash
printf '%s' "$TEXT" | browser-relay type --selector textarea --stdin --tab <tabId>
browser-relay eval --stdin --tab <tabId> < script.js
```

## HTTP API Reference

The HTTP API below is for code, tests, custom tools, and low-level debugging.
For interactive agent work, prefer the CLI workflow above.

### 1. browser_tabs
List all attached browser tabs.
```
GET http://127.0.0.1:18795/api/tabs
```
Returns: `{ ok: true, tabs: [{ id, sessionId, title, url }] }`

### 2. browser_navigate
Navigate a tab to a URL.
```
POST http://127.0.0.1:18795/api/navigate
Header: Content-Type: application/json
Body: { "url": "https://example.com", "tabId?": "optional-target-id" }
```

### 2b. browser_console
Read captured console, page error, and browser log entries.
```
GET http://127.0.0.1:18795/api/console?tabId=<id>&limit=100&level=error&clear=false
POST http://127.0.0.1:18795/api/console/clear
Body: { "tabId?": "...", "level?": "error" }
```
Use this after actions that may trigger frontend errors or warnings.

### 3. browser_snapshot
Get a text representation of the current page (interactive elements annotated).
```
GET http://127.0.0.1:18795/api/snapshot?tabId=<id>&format=text&maxLength=100000
```
Format can be `"text"` (annotated DOM) or `"html"` (raw HTML).

### 4. browser_click
Click an element by CSS selector. Scrolls into view first, uses real mouse events.
```
POST http://127.0.0.1:18795/api/click
Body: { "selector": "button.submit", "tabId?": "...", "doubleClick?": false }
```

### 5. browser_type
Type text into an input field. Optionally clear and submit.
```
POST http://127.0.0.1:18795/api/type
Body: {
  "text": "hello world",
  "selector?": "input[name='q']",
  "clear?": true,
  "submit?": true,
  "tabId?": "..."
}
```

### 6. browser_scroll
Scroll the page.
```
POST http://127.0.0.1:18795/api/scroll
Body: { "direction": "down|up|top|bottom", "amount?": 800, "tabId?": "..." }
```

### 7. browser_screenshot
Capture a PNG screenshot (base64).
```
POST/GET http://127.0.0.1:18795/api/screenshot?tabId=<id>&fullPage=true
```
Returns: `{ ok: true, data: "base64...", format: "png" }`

### 8. browser_eval
Evaluate arbitrary JavaScript in the page. The escape hatch.
```
POST http://127.0.0.1:18795/api/eval
Body: { "expression": "document.querySelector('h1').innerText", "tabId?": "..." }
```

### 9. browser_download
Get the URL of an image/media/link element.
```
POST http://127.0.0.1:18795/api/download
Body: { "selector": "img.profile-pic", "tabId?": "..." }
```

## Agent Decision Workflow

When asked to do something with a web page:

1. **`browser-relay tabs` first** — discover available tabs and their URLs
2. **`browser-relay navigate`** if needed — go to the target page
3. **`browser-relay snapshot`** — understand the page structure
4. **Plan actions** based on snapshot (click what, type where)
5. **Execute** (`browser-relay click`, `browser-relay type`, `browser-relay scroll`) one at a time
6. **`browser-relay console`** if the page behaves unexpectedly or after risky actions
7. **Re-snapshot** after each action to verify state
8. **Screenshot** if visual confirmation is needed

## Example Session

```bash
# 1. List tabs
browser-relay tabs
# ABC123    Google    https://google.com

# 2. Take snapshot to see the page
browser-relay snapshot --tab ABC123
# [input type=text name=q placeholder="Search Google"]
# [button "Google Search"]

# 3. Type into the search box
browser-relay type 'browser relay' --selector 'input[name=q]' --submit --tab ABC123

# 4. New snapshot after navigation
browser-relay snapshot --tab ABC123

# 5. Click a result
browser-relay click 'a[href*="github.com"]' --tab ABC123
```

## MCP Registration (Claude Desktop / Cursor / Windsurf)

Add to your MCP config (`~/.claude/mcp.json` or equivalent):

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

## Error Patterns

| Error | Meaning | Fix |
|-------|---------|-----|
| Extension not connected | Relay server is running but no browser extension connected | Check that Chrome is running with the Browser Relay extension installed |
| No attached tabs | Extension connected but no tab is attached | The extension auto-attaches all regular tabs. Make sure at least one non-chrome:// tab is open |
| Element not found: selector | The CSS selector did not match anything on the page | Try a different selector, or take a snapshot first to inspect the DOM |

## Health Check

```bash
curl http://127.0.0.1:18795/
# → OK

curl http://127.0.0.1:18795/api/debug
# → { "version": "<package-version>", "connected": true/false, "tabCount": N }
```
