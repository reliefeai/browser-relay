# JavaScript runtime and browser actions

Use MCP `browser_exec({code, sessionId?, timeoutMs?})`. Each named session retains
top-level variables, `await`, and browser handles. Default timeout is 30 seconds,
maximum 120 seconds; a timeout kills that runtime and requests cancellation of
its pending browser tasks. `browser_exec_reset` discards one named session.
This is trusted local execution, not an OS security sandbox or page `eval`.

```js
var tabs = await browser.tabs();
print(tabs);
// Select the actual returned id for the task's URL/title.
var tab = browser.tab(tabs.find(t => t.url === 'https://example.com/app').id);
print(await tab.snapshot({diff:false}));
```

Keep the same variable bindings in later calls. All snippets must use targets
observed in the actual page; names below only illustrate the interface.

```js
var result = await tab.act([
  {type:'fill', target:{role:'textbox',name:'Search'}, text:'invoice'},
  {type:'select', target:{role:'combobox',name:'Owner'}, value:'alice'},
  {type:'check', target:{role:'checkbox',name:'Active only'}, checked:true},
  {type:'click', target:{role:'button',name:'Search records'}},
  {type:'wait', target:{selector:'[data-ready]'}, state:'visible'}
]);
print(result.observation.snapshot);
```

## SDK

Application code can use `import {createBrowser} from '@linsoai/browser-relay/sdk'`.
`createBrowser()` uses `BROWSER_RELAY_URL` or the remote device/host environment
variables. Inject `request(method,path,body,{signal,timeoutMs}?)` for another transport;
preserve abort handling when implementing a custom transport.

| API | Result / purpose |
| --- | --- |
| `browser.sessionId` / `.claims()` / `.heartbeat()` / `.dispose()` | Session identity, tab owners, lease renewal and explicit stop (tabs remain open) |
| `browser.tabs()` | Current `{id,title,url}` entries |
| `browser.tab(id)` | Handle for an existing discovered tab |
| `browser.open(url)` | New background tab handle |
| `browser.capabilities()` | Negotiated executor capabilities |
| `tab.read({target?,cursor?,maxLength?,diff?})` | Main content, complete links and text; nextCursor continues the captured observation |
| `tab.observe({mode:'snapshot'|'read'|'both',target?,cursor?})` | Full controls or combined text/image; both returns screenshot separately |
| `tab.claim({label?})` / `.release()` / `.handoff(toSessionId)` / `.focus()` | Ownership, explicit transfer and foreground |
| `tab.snapshot({diff?,includeNodes?,maxLength?})` | AX text, URL, title, frames, viewport; default diff=true |
| `tab.screenshot({fullPage?,clip?})` | PNG base64, dimensions, screenshotId, imageToViewport |
| `tab.act(actions,{observe?,async?,timeoutMs?,diff?,signal?,requestTimeoutMs?})` | Task with partial results, final observation and request cancellation |
| `tab.ref(ref)` / `tab.locator(css,{frameId?})` / `tab.getByRole(role,{name,frameId?,exact?})` | Locator handle |
| Locator `.click()` / `.doubleClick()` / `.fill(text)` / `.type(text)` | Action + resulting snapshot |
| Locator `.select(value)` / `.check(bool)` / `.hover()` / `.waitFor({state,timeoutMs})` | Action + resulting snapshot |
| Locator `.read({maxLength?,cursor?})` | Read only the observed locator subtree |
| Locator `.getByRole(role,{name,exact?})` | Descendant semantic locator scoped to this parent |
| `tab.clickAt(x,y,{screenshotId?,allowFocus?})` | Visual click |
| `tab.drag({x,y},{x,y},{screenshotId?,allowFocus?})` | Press, movement path, release |
| `tab.key('Control+A')` / `tab.scroll(deltaY,{x,y})` | Keyboard / wheel |
| `tab.goto(url,{waitUntil?,waitFor?,timeoutMs?})` / `tab.close()` | Navigation to document readiness (or commit), optional target wait / close |
| `tab.eval(expression)` | Page-context JavaScript; no access to SDK objects |
| `browser.tasks.get(id)` / `.wait(id)` / `.cancel(id)` | Inspect / await / cancel a job |

For efficiency, prefer `act` over multiple locator calls when several operations
are already determined. An action group is serialized as a whole at the
extension, so remote links do not carry each low-level CDP command separately.
`observe:'read'` returns main content and `observe:'both'` also returns a screenshot. `observe:'none'` suppresses the final snapshot only when another reliable check
is supplied by the workflow. `observe:'screenshot'` returns visual evidence.

## Action schema

Each action has `type`. A target is `{ref}`, `{selector,frameId?}`, or
`{role,name?,exact?,frameId?,scope?}`. Matching must be unique. Defaults are exact names.
`scope` is another observed target identifying an ancestor in the same document;
nesting is bounded. A snapshot's `within` points to its named container ref;
`includeNodes` also supplies `parentRef`. For example:

```js
await tab.getByRole('group',{name:'South'})
  .getByRole('button',{name:'Save'}).click({timeoutMs:1500});
// Equivalent batch target:
// {role:'button',name:'Save',scope:{role:'group',name:'South'}}
```

Complete links are returned as `url`. Text snapshots retain semantic hierarchy. `truncated:true` supplies nextCursor; continue it with the same tab/session. Cursors are bounded cached observations and expire on navigation or eviction; `stale_observation` requires a new read. Large individual text nodes may span pages.

Cross-origin iframe and shadow DOM refs are resolved by Chrome's AX/CDP APIs.
Unavailable frames are listed in snapshot `warnings`, never silently guessed.
Main-content reading includes frames embedded inside that main in document order.
Without a top-level main it reads the whole document, even if a child frame has its own main.

- `click`, `double_click`, `hover`: `target`, or numeric `x,y`; optional `button`
  (`left`, `middle`, `right`), `screenshotId`, `allowFocus`.
- `move`: numeric `x,y`, optional screenshotId/allowFocus.
- `drag`: starting `x,y`, `to:{x,y}` or `path:[{x,y},...]`; optional screenshotId.
- `fill`, `type`: `text`, optional `target`; fill requires a target. `clear:true`
  selects existing text. `submit:true` presses Enter after typing.
- `select`: `target`, `value` string or array of option values. Disabled options
  and disabled optgroups are rejected without changing the selection.
- `check`: `target`, boolean `checked`; native inputs and ARIA checkbox/radio/switch.
  Already-correct state is a no-op. Foreground changes dispatch mouse input and
  verify checked state; background DOM fallback reports `strategy:'dom'` and
  does not imply a trusted mouse event. A radio cannot be directly unchecked.
- `key`: `key`, e.g. `Enter`, `Escape`, `Control+A`, `Meta+A`, `Shift+Tab`.
- `scroll`: `target` or numeric `x,y`, plus `deltaX` and/or `deltaY` in pixels. Background scrolling uses DOM scrolling without activating the tab, including when an older caller supplies `allowFocus:true`. Coordinate scrolling selects the scrollable container under the point; for an iframe, use an explicit target with frameId. Results identify strategy:'dom' or 'wheel'. `waitForChange:true` waits up to timeoutMs (default 1500) and reports contentChanged. Hidden pages may defer rendering; no observed change is not permission to focus. This compares rendered text, not unique record identities. viewportMoved reports page scroll movement, not nested element scroll movement.
- `focus`: Bring the current tab/window to the foreground only when the user explicitly requests it. The same requirement applies to `allowFocus:true` on visual actions.
- `wait`: `target`, state `attached|visible|hidden|detached|enabled`, timeoutMs 1–20000.
- `navigate`: HTTP(S) `url`, or `about:blank`. Default waitUntil:'interactive' waits for document readiness; waitUntil:'commit' only starts navigation. Neither guarantees site-specific async data is loaded. Add a wait action for the actual result.

Target actions accept optional `timeoutMs` (1–20000) for readiness checks:
appearance, visibility, enabled state, occlusion, and pointer target stability.
Without it, readiness errors fail immediately. This is distinct from the task
timeout below. Waiting is cancellable; ambiguous targets, invalid selectors, and
stale refs are not silently retargeted. Once input has been dispatched, it is
never replayed. Parent iframe hit-testing checks the actual action point.
Locator `select(value, options)`, `check(checked, options)`, and `hover(options)`
accept the same action options.

A group contains 1–100 operations. Default task timeout is 20 seconds; maximum
120 seconds. Use async tasks when execution may exceed the local relay's
30-second command transport timeout. Task IDs and runtime bindings are separate
from tab IDs. Task history is bounded and does not survive extension restart.

```js
var job = await tab.act([{type:'wait',target:{selector:'.report-ready'},timeoutMs:20000}], {async:true});
print(job.id);
// Work on an independent tab, then:
print(await browser.tasks.wait(job.id));
```

## Session ownership and stopping

SDK browsers use a unique sessionId by default; createBrowser({sessionId:'research'})
uses an explicit identity. Modern reading/actions automatically claim the tab.
Heartbeat interval is 40 seconds and the lease expires after 120 seconds without
renewal. browser.dispose() stops pending jobs and releases claims; it preserves tabs.
A stopped, disconnected or expired identity cannot restart implicitly.

`tab.handoff(receiver)` requires the current owner and no pending work; it preserves
whether the tab was task-created. `release()` also requires pending work to finish.
`close()` refuses busy tabs. Hand off or release before changing to a legacy/CDP
client; those calls cannot operate on a claimed tab. Leases coordinate trusted
clients; they are not a security boundary against other local software.

CLI `--session` names survive separate invocations until expiry/stop. MCP has a
per-process default and optional named sessions. Runtime sessions retain browser
objects; use browser.sessionId when coordinating an explicit handoff.

GET /api/tasks/:id takes sessionId in the query; cancellation takes it in the JSON
body. Failed jobs return completed results plus interruptedAction when an input
may have partly run. Cancellation does not undo already dispatched input. Runtime
errors retain structured details and return without waiting for the execution timeout.

The built-in transport combines the abort signal with its request timeout. Aborting
or timing out an in-flight browser task sends a separate cancellation request. The
error includes taskId/sessionId and, when cancellation reaches the executor, task
progress. request_cancelled and task request timeouts are not retryable. A failed
cancellation delivery is reported as cancellationError; query the task before any
recovery. This cannot undo already dispatched input or a page's own timers/requests.
MCP notifications/cancelled reports request_cancelled for ordinary and runtime calls.

Runtime object output preserves full strings, arrays and nested values. Its total
output budget is separate from an observation's pagination budget: runtimeOutput
reports any clipped output with nextCursor and readWith. In the same persistent
session, execute `readOutput("<returned cursor>")` to read that cached output,
including any clipped browser-page cursor. This does not read the browser again
or change its diff baseline. Continue until runtimeOutput is absent, then follow
any browser nextCursor from the recovered observation. The runtime caches three
outputs of up to four million characters each; eviction/reset returns stale_output,
and exceeding the cache returns output_cache_limit. Preserve very large results
in variables and print selected parts. One-shot CLI exec drains runtime output
pages before closing; MCP/browser_exec and CLI repl retain their session.

## Images and coordinates

```js
var shot = await tab.screenshot();
display(shot);
// After inspecting the image, use its actual coordinates:
await tab.clickAt(420,180,{screenshotId:shot.screenshotId});
```

Image coordinates map to CSS viewport coordinates as
`x * scaleX + offsetX`, `y * scaleY + offsetY`. The executor validates viewport,
scroll position and URL before applying a screenshot-based coordinate. Screenshot
identity cannot detect every DOM animation; capture again if the UI changed.
`clip` is a document-CSS rectangle `{x,y,width,height}`. Full-page images can be
larger than the visible viewport; scroll to offscreen elements first.

## CLI / MCP / HTTP

CLI `exec --file workflow.js --json` returns mixed text/image content. Use
`--output screenshot.png` for a script that emits one image to a file. CLI `repl`
reads one JSON object per line (`{"code":"...","sessionId":"work"}`) and emits
one JSON result per line. Separate `exec` processes do not share JS variables.

Modern HTTP endpoints (also forwarded by the remote hub):

| Method | Path | Input |
| --- | --- | --- |
| GET | `/api/capabilities` | — |
| POST | `/api/observe` or `/api/read` | tabId, mode, diff, sessionId, maxLength, includeNodes, target, cursor |
| GET/POST | `/api/sessions` | List claims / sessionId + action: heartbeat or stop |
| POST | `/api/tabs/claim`, `/release`, `/handoff`, `/focus` | tabId, sessionId; handoff also toSessionId |
| POST | `/api/evaluate` | Managed and serialized page JS: tabId, sessionId, expression |
| POST | `/api/actions` | tabId, actions, observe, async, timeoutMs, sessionId |
| GET | `/api/tasks/:id` | sessionId query |
| POST | `/api/tasks/:id/cancel` | sessionId |
| POST | `/api/tabs/create` | url |
| POST | `/api/tabs/close` | tabId |

MCP exposes browser_read, browser_observe, browser_actions, browser_tab, browser_session, browser_task, browser_exec and
browser_exec_reset, plus the original tools. Screenshot results are image blocks.
Both NDJSON MCP stdio and legacy Content-Length framing are accepted.
There is deliberately no HTTP endpoint for executing local OS JavaScript.

## Playwright interoperability

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:18795');
const context = browser.contexts()[0];
// Discover/select a page from context.pages(); reuse the user's default context.
```

Release any tab claimed by a managed session before handing it to this compatibility client.

The local `/cdp` bridge gives each client virtual sessions and preserves the
extension attachment when clients disconnect. Browser profiles, creating
incognito contexts and window resizing are outside this bridge's contract.
Native Chrome downloads retain the user's configured download behavior.
This CDP endpoint is local-only; remote workflows use SDK/HTTP actions.
