# Chrome Web Store submission packet

This document is the source of truth for Browser Relay's Chrome Web Store
listing, privacy declarations, reviewer instructions, and release gates. It is
not evidence that an item has been uploaded or submitted.

## Release status

- Store upload: **not started**
- Store review: **not started**
- Public listing: **not available**
- Extension version: `1.4.1`
- Compatible daemon version: `@linsoai/browser-relay@1.4.1` (public on npm)
- Candidate ZIP: `browser-relay-extension-1.4.1.zip`
- Candidate ZIP SHA-256:
  `d6204a75a95fbc42871a90b457b60e554e921898b48b23257120e3916e5e2d89`

The safe release order is:

1. deploy a Hub that accepts both legacy query-token devices and the new
   first-frame authentication;
2. publish and verify the backward-compatible daemon/CLI package;
3. publish the independently versioned Chrome Web Store extension;
4. remove legacy Hub authentication only after the adoption window has ended.

Steps 1 and 2 are already satisfied by the backward-compatible production Hub
and public npm 1.4.1 release. Re-run the exact-build smoke before upload; any
change under `extension/` invalidates the candidate ZIP and checksum above.

## Listing

### Name

`Browser Relay`

### Summary

```text
Let AI agents share your everyday Chrome locally or across multiple machines.
```

This is 77 characters and stays below Chrome's 132-character limit.

### Single purpose

```text
Browser Relay connects a user's existing Chrome tabs to an AI agent only after the user explicitly enables Local Relay or Remote Relay, so the agent can inspect and operate that browser locally or from another machine.
```

### Detailed description

```text
Browser Relay lets an AI agent work in the Chrome browser you already use—including your current tabs and signed-in sessions—instead of launching a separate empty browser profile.

Built for agent workflows:

• Use the Browser Relay Skill + CLI from Codex, Claude Code, or another compatible agent.
• Keep working in the same browser while the agent uses background tabs without repeatedly pulling them to the foreground.
• Connect browsers on multiple machines when the useful login, SSO session, VPN, or internal network access lives elsewhere.
• Review exactly what Local Relay and Remote Relay can access before either mode is enabled.
• Turn either control path off at any time. Remote Relay uses a separate password-like Device ID and can also use a self-hosted Hub.

Browser Relay is open source under the MIT License. It is a high-trust developer tool, not a security sandbox: only connect agents and machines you trust.
```

Do not add Playwright, browser-use, MCP, or HTTP keywords to the Store title or
summary. The differentiators are the existing browser, Skill + CLI, and
multi-machine control.

## Permission justifications

| Permission | Reviewer justification |
| --- | --- |
| `debugger` | Required for the single purpose: inspect and operate existing Chrome tabs through the Chrome DevTools Protocol after the user affirmatively enables Local Relay or Remote Relay, including snapshots, clicks, typing, navigation, screenshots, console/network diagnostics, and explicit page evaluation. |
| `tabs` | Lists and identifies the tabs the user or agent can select, and supports user-requested tab creation, activation, navigation, and closing. URL and title are part of the prominently disclosed browser-control feature. |
| `storage` | Stores Local/Remote consent records, relay settings, UI language, optional-permission cleanup state, and the Remote Device ID capability in the user's Chrome profile. It is not used for analytics or advertising. |
| `alarms` | Keeps an explicitly enabled Local/Remote connection healthy and performs the configured idle-detach check while the MV3 service worker is active. |
| `http://127.0.0.1/*`, `http://localhost/*`, HTTPS loopback | Connects to the Browser Relay daemon on the same computer. Local Relay is off until the user confirms the in-product disclosure. |
| `https://relay.linso.ai/*` | Connects to the default Hosted Remote Hub only after the separate Remote Relay disclosure and confirmation. |
| `https://*/*` optional host access | Allows a user to choose a self-hosted HTTPS Hub. Chrome is asked for only that exact origin during the Remote Relay confirmation flow; abandoned or revoked grants are durably tracked and cleaned up. |
| `downloads` optional | Requested only when the user turns on download control in Options. It lets an authorized agent start a download and read Chrome download metadata for the requested workflow. |

## Remote-code declaration

Select **Yes**. The Dashboard asks whether the extension executes remote code,
and Browser Relay accepts user-authorized `Runtime.evaluate` expressions through
Chrome's documented `debugger` API. Chrome's Manifest V3 policy explicitly lists
the Debugger API as a permitted remote-execution API when used for its documented
purpose. This declaration is about that narrow debugger path; it does not mean
that the extension loads remote scripts into an extension context.

Use this explanation:

```text
All JavaScript executed in the extension service worker, Options page, and popup is included in the submitted ZIP. The extension does not fetch or execute remotely hosted JavaScript or WebAssembly in its own extension context. As part of its disclosed browser-control purpose, an authorized agent may send Chrome DevTools Protocol commands—including Runtime.evaluate expressions—to a page in the user's explicitly enabled browser-control session through Chrome's debugger API. Browser Relay declares this behavior for review even though the execution path is the Chrome debugger API, not a remotely loaded extension script.
```

Official references:

- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/#declare_remote_code
- https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code#chrome.debugger

## Data-use declarations

Select **all nine data categories** in the Dashboard. Browser Relay can inspect
and operate any page in a user-enabled browser-control session, and explicit
page evaluation can return values available to that page's JavaScript. The
declaration therefore covers the extension's full capability, even though a
given command or session normally processes only a subset of these categories.

| Dashboard category | Select | Capability-based explanation |
| --- | --- | --- |
| Personally identifiable information | Yes | Page content, forms, console output, network metadata, screenshots, or evaluated values can contain names, email or physical addresses, identifiers, and other information that identifies a person. |
| Health information | Yes | A user-enabled tab can display or accept health, medical, fitness, or treatment information, which page inspection, screenshots, form interaction, or explicit evaluation can process. |
| Financial and payment information | Yes | A user-enabled tab can contain payment-card, bank, transaction, invoice, or other financial information in page content, forms, screenshots, network metadata, or evaluated values. |
| Authentication information | Yes | Signed-in pages, form interaction, console/network metadata, and explicit evaluation can expose credentials, authentication state, session tokens, or non-HttpOnly cookies. The extension does not request Chrome's `cookies` permission or automatically export a cookie database. The Remote Device ID is also a password-like authentication capability stored only while Remote Relay is enabled. |
| Personal communications | Yes | Page content, screenshots, form interaction, and explicit evaluation can process email, chat, direct messages, comments, drafts, or other user communications in a user-enabled tab. |
| Location | Yes | Page content or forms can contain a physical location, and explicit page evaluation can return location data available to the page context. Browser Relay does not request a separate Chrome location permission and does not independently track location. |
| Web history | Yes | The core tab-control purpose processes tab URLs and titles, navigation state, and requested network URLs/metadata. |
| User activity | Yes | Browser-control commands and results can include clicks, typed text, selections, scrolling, navigation, tab state, console activity, and optional download interactions. |
| Website content | Yes | Snapshot, screenshot, console, network, and evaluation commands can process page text, HTML/DOM, accessibility data, images visible in screenshots, metadata, and other content supplied by a website. |

The selected categories do not mean Browser Relay intentionally collects every
category in every session. Data is processed only through a Local Relay or
Remote Relay control path that the user explicitly enables, for the commands an
authorized agent sends.

Certify Limited Use only after confirming that the public `PRIVACY.md`, Store
description, Dashboard answers, and extension UI all remain consistent. The
certifications are supportable because Browser Relay:

- uses or transfers browser data only to provide the disclosed browser-control
  purpose through the local AI client/daemon or remote client/Hub selected by
  the user;
- does not sell browser data, share it with data brokers, or use it for targeted
  advertising;
- does not use or transfer browser data to determine creditworthiness or for
  lending decisions;
- does not use browser data to train AI models; and
- does not allow human access except for the policy-permitted cases stated in
  `PRIVACY.md`.

## Reviewer test instructions

Test the exact uploaded ZIP before copying this section into the Dashboard.

```text
Browser Relay is a developer tool. It does not require a Browser Relay account,
but Local Relay requires its open-source daemon on the same computer.

Prerequisite
1. Install Node.js 18 or newer.
2. In a terminal run:
   npm install -g @linsoai/browser-relay@1.4.1
3. Run:
   browser-relay status
   Expected: HTTP responding at http://127.0.0.1:18795/.

Local Relay
1. Install the submitted extension. Its Options page opens automatically with
   the Local Relay disclosure already expanded.
2. Confirm that Local Relay is Off and no tab is attached before consent.
3. Read the disclosure, tick the acknowledgement, and click
   “Allow & connect”.
4. Chrome 142 or newer may ask for loopback/local-network access. Allow it so
   the extension can reach the daemon on this computer.
5. Open https://example.com/ in a normal tab.
6. In the terminal run:
   browser-relay tabs
   browser-relay snapshot --max-length 2000
   Expected: the example.com tab is listed and its visible page text is
   returned. No account or private test data is required.
7. Turn Local Relay Off. Run browser-relay tabs again and confirm the extension
   is disconnected. The page itself remains open.

Remote Relay
1. In Options, turn Remote Relay On.
2. Read the separate Remote Relay disclosure, tick its acknowledgement, and
   click “Enable Remote Relay”.
3. Treat the generated Device ID as a temporary password-like capability. Do
   not paste it into review notes, chat, screenshots, or browser pages.
4. In a private terminal, save it locally and then use only the saved name:
   browser-relay remote add store-review <the generated Device ID>
   browser-relay tabs --remote store-review
   Expected: the current browser's tabs are listed through the Hosted Hub.
5. Turn Remote Relay Off. Re-run the command and confirm the device is offline.
   The stored Device ID is deleted. A custom Hub permission, if used, is also
   revoked and verified.
6. Remove the local reviewer entry:
   browser-relay remote rm store-review

Optional downloads permission
1. With Local Relay enabled, turn “Chrome downloads (optional)” On.
2. Confirm Chrome displays a separate permission request.
3. Turn it Off and confirm the optional permission is removed. No download is
   required for the core review path.

No-daemon behavior
If the daemon is stopped, the extension remains Off or reports that the local
daemon is unreachable. It must not claim to be connected and it must not attach
tabs without the user's successful enable action.

Source: https://github.com/reliefeai/browser-relay
Privacy policy: https://github.com/reliefeai/browser-relay/blob/main/PRIVACY.md
Submitted ZIP SHA-256: d6204a75a95fbc42871a90b457b60e554e921898b48b23257120e3916e5e2d89
```

## Exact-build checklist

- [x] The hosted Hub accepted both the current first-frame device auth and one
  isolated legacy query-token RPC on 2026-07-31. The temporary capability was
  destroyed immediately after the compatibility check.
- [x] npm 1.4.1 is public and the installed daemon reports that version.
- [x] Manifest version is greater than every prior Store upload; it does not
  need to equal the npm version.
- [x] `npm test`, production audit, npm dry-run, and Hub dry-run are green.
- [x] `npm run pack:extension` has been run twice and both ZIPs are identical.
- [x] The recorded SHA-256 matches the current candidate ZIP.
- [x] The current exact ZIP has passed isolated Chrome for Testing smoke for
  first-install Local disclosure, no connection or tab attachment before
  consent, cancel, Local enable, 12-character tab routing, and browser-restart
  auto-reconnect. Remote Relay remained Off throughout.
- [x] The exact ZIP passed isolated Chrome for Testing smoke on 2026-07-31 for
  Remote enable/disable with real CLI round trips, Local/Remote independence,
  optional downloads grant/use/revoke, failed custom-host replacement cleanup,
  browser restart recovery, and daemon-unavailable rollback. Any ZIP change
  still requires this evidence to be regenerated.
- [ ] Chrome's native Local Network Access Allow, Deny, and revoke flows have
  been completed manually in branded current Chrome.
- [x] The 1280x800 screenshot was captured from the exact ZIP and contains no
  Device ID, private URL, account name, company data, or browser notification.
- [ ] The public privacy-policy URL resolves without authentication.
- [ ] Store listing, Dashboard privacy answers, and in-product disclosures use
  the same data-flow description.
- [ ] Developer account, fee, upload, visibility, and submission have separate
  written owner approval.
