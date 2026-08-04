# Browser Relay Privacy Policy

Effective date: July 24, 2026

Browser Relay is an open-source tool that lets an AI agent use Chrome tabs in a browser you already use. This policy explains what the Browser Relay Chrome extension and the official relay service process, where that processing happens, and what controls you have.

## Short version

- Local Relay is off until you explicitly allow it. In local mode, browser commands and results travel between the extension and the Browser Relay daemon on your own computer.
- Remote Relay is a separate opt-in. If enabled, browser commands and results pass through the Remote Hub you select. The default Hub is `https://relay.linso.ai`; you may use a self-hosted Hub.
- Browser Relay does not sell browser data, use it for advertising, or use it to train AI models.
- A Device ID is a password-like capability. Anyone who has it can control the connected browser until Remote Relay is turned off or the ID is regenerated.

## Data Browser Relay can process

Depending on the command an agent sends, Browser Relay can process:

- tab identifiers, URLs, titles, open/closed state, and window state;
- page text, HTML/DOM data, accessibility data, selections, and element details;
- screenshots;
- clicks, keyboard input, form input, scrolling, navigation, and tab-management commands;
- console messages and errors;
- network metadata such as request URLs, methods, status codes, timing, and headers;
- download URLs, filenames, status, and history, but only if you separately grant the optional Chrome `downloads` permission; and
- other values an agent explicitly asks the page to evaluate. This can include data available to page JavaScript, such as non-HttpOnly cookies. The extension does not request Chrome's `cookies` permission and does not automatically export a cookie database.

Browser Relay attempts to redact common sensitive network headers, including `Authorization`, `Cookie`, `Proxy-Authorization`, and `Set-Cookie`, before returning captured network metadata. URLs, page content, other headers, console output, and evaluated values may still contain sensitive information.

### Chrome Web Store data-category disclosure

For Chrome Web Store disclosure, Browser Relay conservatively declares all nine Dashboard categories below. Browser Relay can inspect and operate any page in a browser-control session that the user explicitly enables, and explicit page evaluation can return values available to that page's JavaScript. Declaring a category describes this capability; it does not mean that Browser Relay intentionally collects every category in every session. A command normally processes only the data needed for the action the authorized agent requested.

| Dashboard category | How Browser Relay can process it |
| --- | --- |
| Personally identifiable information | Page content, forms, console output, network metadata, screenshots, or evaluated values can contain names, email or physical addresses, identifiers, and other information that identifies a person. |
| Health information | A user-enabled tab can display or accept health, medical, fitness, or treatment information. |
| Financial and payment information | A user-enabled tab can contain payment-card, bank, transaction, invoice, or other financial information. |
| Authentication information | Signed-in pages, form interaction, console/network metadata, and explicit evaluation can expose credentials, authentication state, session tokens, or non-HttpOnly cookies. Browser Relay does not request Chrome's `cookies` permission or automatically export a cookie database. The Remote Device ID is also a password-like authentication capability stored only while Remote Relay is enabled. |
| Personal communications | A user-enabled tab can contain email, chat, direct messages, comments, drafts, or other communications. |
| Location | Page content or forms can contain a physical location, and explicit page evaluation can return location data available to the page context. Browser Relay does not request a separate Chrome location permission and does not independently track location. |
| Web history | Tab URLs and titles, navigation state, and requested network URLs/metadata are part of the disclosed tab-control capability. |
| User activity | Commands and results can include clicks, typed text, selections, scrolling, navigation, tab state, console activity, and optional download interactions. |
| Website content | Snapshot, screenshot, console, network, and evaluation commands can process page text, HTML/DOM, accessibility data, images visible in screenshots, metadata, and other website content. |

## Local Relay

When Local Relay is enabled, the extension connects to the Browser Relay daemon at `127.0.0.1` on your computer. Commands and results are processed locally and are not intentionally sent to a Browser Relay-operated server. An AI client connected to that local daemon may receive the data listed above and may act through your existing signed-in browser session.

Local settings and your consent record are stored in `chrome.storage.local`. Active tab-session mappings are stored in `chrome.storage.session` and in memory. Local and Remote Relay share the same Chrome debugger attachment when both modes are enabled. Turning Local Relay off closes the local connection and cancels its reconnect attempts. Controlled tabs are detached and active session mappings are cleared when Remote Relay is also off; if Remote Relay remains enabled, its separately authorized control path keeps the shared attachment.

## Remote Relay

Remote Relay is off by default and requires a separate disclosure and confirmation each time you enable it. When enabled:

1. the extension creates a secret Device ID;
2. the extension connects to the Remote Hub you selected; and
3. commands from a remote Browser Relay client and the resulting browser data transit that Hub.

The default Hub's application code routes messages in memory and does not intentionally write browser command payloads or results to durable application storage. Infrastructure providers may process transient request, connection, security, and operational metadata under their own policies. If you choose a self-hosted Hub, that Hub's operator controls its infrastructure, logging, retention, and access practices.

The extension stores the selected Hub, the Device ID capability, and the remote-consent record in `chrome.storage.local` while Remote Relay is enabled. Turning Remote Relay off closes the connection, stops reconnect attempts, and deletes the stored Device ID capability. It also asks Chrome to remove any optional permission granted for a custom Hub and verifies that the permission is gone. If Chrome reports that cleanup failed, the settings page shows the pending permission and provides a retry action. Shared debugger attachments are detached only when Local Relay is also off.

Remote Hub connections require HTTPS or WSS, except for development connections to `localhost` or `127.0.0.1`.

## Chrome permissions

Browser Relay uses:

- `debugger` to attach to tabs and issue Chrome DevTools Protocol commands;
- `tabs` to list and manage browser tabs;
- `storage` to retain settings, consent records, and active session state;
- `alarms` to keep explicitly enabled connections healthy; and
- host access to the local daemon and the default Remote Hub.

The `downloads` permission is optional and is requested only from the settings page when you enable download commands. A custom HTTPS Remote Hub receives an exact optional host permission only after you confirm Remote Relay for that host.

## Sharing, sale, advertising, and AI training

Browser Relay does not sell browser data, share it with data brokers, use it for targeted advertising, or use it to train AI models. Data is disclosed only as needed to provide the control path you explicitly enable: to your local AI client and daemon in Local Relay, or to the remote client and Hub you select in Remote Relay.

Browser Relay does not use or transfer browser data for purposes unrelated to its disclosed browser-control purpose, or to determine creditworthiness or for lending decisions.

Browser Relay's use of information received from Google APIs, including Chrome APIs, adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

Browser Relay operators do not intentionally read browser command payloads or results transiting the default Hub. Human access to user data is limited to cases permitted by the Chrome Web Store User Data Policy: when a user explicitly asks for support and consents to sharing specific data, when access is necessary to investigate abuse or a security incident, when required by law, or when data has been aggregated and anonymized for lawful internal operations. Never send Device IDs, passwords, private URLs, screenshots, or page content through a public support issue.

## Retention and deletion

The Browser Relay extension does not maintain a cloud account or a server-side browsing history. Local extension settings remain until you change them, clear extension data, or uninstall the extension. In-memory buffers and session mappings are bounded or cleared when the relevant control mode is disabled or the extension session ends. Infrastructure logs, if any, follow the infrastructure provider's retention and security policies.

You can revoke access at any time by turning off Local Relay, turning off Remote Relay, revoking optional permissions in settings, clearing the extension's data, or uninstalling the extension.

## Children

Browser Relay is a developer tool and is not directed to children under 13.

## Changes

If a change materially expands the data Browser Relay processes or where it sends that data, the extension will require renewed consent and this policy will be updated before the new behavior is enabled.

## Contact

For privacy questions, open an issue in the [Browser Relay GitHub repository](https://github.com/reliefeai/browser-relay/issues). Do not include secrets, Device IDs, private URLs, screenshots, or other sensitive browser data in a public issue.

---

# Browser Relay 隐私政策（中文摘要）

生效日期：2026 年 7 月 24 日

Browser Relay 是一个开源工具，让 AI Agent 使用你正在使用的 Chrome 标签页。本地控制和远程控制默认均不应在未确认时启动：

- Local Relay 仅在你明确允许后连接本机 `127.0.0.1` 守护进程。本地模式中的浏览器命令与结果不会被有意发送到 Browser Relay 运营的服务器。
- Remote Relay 需要单独阅读数据披露并确认。开启后，命令和结果会经过你选择的远程 Hub；默认 Hub 是 `https://relay.linso.ai`，也可以使用自托管 Hub。
- 根据 Agent 执行的命令，数据可能包括标签页 URL/标题、页面文本与 DOM/无障碍数据、截图、点击与输入、控制台信息、网络元数据，以及页面 JavaScript 可访问的值。扩展不申请 Chrome `cookies` 权限，也不会自动导出 Cookie 数据库，但显式页面求值可能读取非 HttpOnly Cookie。
- Chrome Web Store 数据披露按能力保守勾选九类：个人身份信息、健康信息、金融与支付信息、认证信息、个人通信、位置、浏览历史、用户活动和网站内容。Browser Relay 能处理用户明确授权标签页中的这些数据，并不表示每次会话都会收集全部类别；位置仅指页面显示、表单输入或页面上下文可访问的位置数据，扩展不申请独立的 Chrome 定位权限，也不会自行跟踪位置。
- Chrome 下载能力使用单独的可选权限；自定义远程 Hub 使用按目标域名单独授予的可选 Host 权限。
- Browser Relay 不出售浏览器数据，不用于广告、信用评估或借贷决策，也不用于训练 AI 模型；数据仅用于用户明确启用的浏览器控制目的。
- Device ID 类似密码。持有者在 Remote Relay 关闭或 ID 重新生成前，可以控制已连接的浏览器。

Local Relay 与 Remote Relay 同时开启时会复用同一份 Chrome debugger 会话。关闭其中一个模式只撤销该模式；只有两者都关闭后才会分离受控标签并清理活动会话。关闭 Remote Relay 还会删除本地保存的 Device ID,并要求 Chrome 撤销、随后验证自托管 Hub 的可选 Host 权限；若撤销失败,Options 页面会明确显示待清理状态并允许重试。隐私问题请通过 [GitHub Issues](https://github.com/reliefeai/browser-relay/issues) 联系；公开 issue 中不要附带 Device ID、私密 URL、截图或其他敏感数据。
