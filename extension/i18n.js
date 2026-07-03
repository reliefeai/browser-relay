// Lightweight UI i18n with a manual override. Default follows the browser
// language; the options page lets the user force English or 中文 (stored as
// `uiLang`). Classic script (not a module): exposes window.I18N.
;(function () {
  const MESSAGES = {
    en: {
      controlConsole: 'Control Console',
      tagline: 'Bridge Chrome to<br>agents · local &amp; remote',
      localRelay: 'Local Relay',
      localDesc: 'Bridges your Chrome tabs to the local Browser Relay daemon on <code>127.0.0.1</code> for direct, on-device control. Remote Relay below runs on its own and does not need this.',
      relayPort: 'Relay port',
      idleDetach: 'Idle auto-detach <span class="note">(sec · 0 = never)</span>',
      saveTest: 'Save & Test Connection',
      remoteRelay: 'Remote Relay',
      remoteDesc: 'Control <strong>this</strong> browser from anywhere through a public relay — no open ports, no exposed server. Mints a secret Device ID that works until you switch off. Prefer your own hub? <a class="lnk" href="https://deploy.workers.cloudflare.com/?url=https://github.com/reliefeai/browser-relay/tree/main/hub" target="_blank" rel="noopener">Deploy to Cloudflare →</a>',
      remoteHub: 'Public relay',
      deviceId: 'Device ID <span class="note">— secret · treat it like a password</span>',
      copy: 'Copy',
      copyCommand: 'Copy-paste command',
      regenerate: 'Regenerate Device ID',
      regenWarn: 'This invalidates the current Device ID immediately — anything using the old one must switch to the new ID.',
      regenConfirm: 'Regenerate',
      cancel: 'Cancel',
      quickStart: 'Quick start',
      step1: 'Install the CLI — <code>npm i -g @linsoai/browser-relay</code>',
      step2: 'Check it — <code>browser-relay status</code> (auto-starts on login)',
      step3: 'Save the Local Relay settings above',
      step4: 'Flip Remote Relay on, copy the command, run it from anywhere',
      language: 'Language',
      langAuto: 'Auto',
      stateOn: 'On',
      stateOff: 'Off',
      statusConnectedLocal: 'Connected to relay server. Extension will auto-attach tabs.',
      statusRelayStatus: 'Relay server responded with an error status. Check if the server is running.',
      statusRelayUnreachable: 'Cannot connect to the local relay. Is the server running?',
      statusConnectingHub: 'Connecting the extension to the relay…',
      statusRemoteConnected: 'Remote Relay is on and connected to the relay.',
      statusRemoteNoHub: "Device ID generated, but the relay isn't connected yet: ",
      statusRemoteNoReach: "Device ID generated, but the extension didn't reach the relay: ",
      statusRemoteOff: 'Remote Relay is off. Flip it on to generate a new Device ID.',
      statusRemoteConnectedShort: 'Remote Relay is on and connected.',
      statusRemoteDisconnected: 'Remote Relay is on but disconnected: ',
      statusRemoteBgOffline: 'Remote Relay is on, but the extension background is not responding yet.',
      copied: 'Copied',
      popupConnected: 'Connected',
      popupReattach: 'Re-attach tabs',
      popupConnecting: 'Connecting…',
      popupRetry: 'Retry',
      popupNotConnected: 'Not connected',
      popupReconnect: 'Reconnect',
      popupOptions: 'Options',
      popupDocs: 'Docs',
      popupTabsAttached: 'attached',
      popupNoRelay: 'No relay server on ',
      popupTrying: 'Trying ',
      popupLoading: 'Loading…',
      popupInstallTitle: 'Relay server not running — install and check it:',
      popupInstallHint: 'Already installed? Check with <code style="display:inline; padding:1px 5px; cursor:text; font-size:11px">browser-relay status</code>',
    },
    zh_CN: {
      controlConsole: '控制台',
      tagline: '把 Chrome 接到<br>agent · 本地与远程',
      localRelay: '本地中继',
      localDesc: '把你的 Chrome 标签桥接到本机 <code>127.0.0.1</code> 上的 Browser Relay 守护进程,用于本机直连控制。下面的 Remote Relay 独立运行,不需要它。',
      relayPort: '中继端口',
      idleDetach: '空闲自动断开 <span class="note">(秒 · 0 = 从不)</span>',
      saveTest: '保存并测试连接',
      remoteRelay: '远程中继',
      remoteDesc: '从任何地方通过公网 Relay 服务控制<strong>这个</strong>浏览器 —— 不开放端口、不暴露本地服务。会生成一个保密的 Device ID,关闭前一直有效。想用自己的 Relay 服务?<a class="lnk" href="https://deploy.workers.cloudflare.com/?url=https://github.com/reliefeai/browser-relay/tree/main/hub" target="_blank" rel="noopener">部署到 Cloudflare →</a>',
      remoteHub: '公网 Relay 服务',
      deviceId: 'Device ID <span class="note">— 保密 · 请像密码一样保管</span>',
      copy: '复制',
      copyCommand: '可直接粘贴的命令',
      regenerate: '重新生成 Device ID',
      regenWarn: '这会立即作废当前 Device ID —— 仍在用旧 ID 的一切都必须换成新的。',
      regenConfirm: '重新生成',
      cancel: '取消',
      quickStart: '快速开始',
      step1: '安装 CLI —— <code>npm i -g @linsoai/browser-relay</code>',
      step2: '检查 —— <code>browser-relay status</code>(登录时自动启动)',
      step3: '保存上面的本地中继设置',
      step4: '打开 Remote Relay,复制命令,在任何地方运行',
      language: '语言',
      langAuto: '自动',
      stateOn: '开',
      stateOff: '关',
      statusConnectedLocal: '已连接到中继服务器,插件会自动接管标签。',
      statusRelayStatus: '中继服务器返回了错误状态,检查它是否在运行。',
      statusRelayUnreachable: '连不上本地中继,服务器在运行吗?',
      statusConnectingHub: '正在把插件连接到公网 Relay 服务…',
      statusRemoteConnected: 'Remote Relay 已开启并连上公网 Relay 服务。',
      statusRemoteNoHub: '已生成 Device ID,但公网 Relay 服务还没连上:',
      statusRemoteNoReach: '已生成 Device ID,但插件没连上公网 Relay 服务:',
      statusRemoteOff: 'Remote Relay 已关闭。打开它可生成新的 Device ID。',
      statusRemoteConnectedShort: 'Remote Relay 已开启并连接。',
      statusRemoteDisconnected: 'Remote Relay 已开启但未连接:',
      statusRemoteBgOffline: 'Remote Relay 已开启,但插件后台还没响应。',
      copied: '已复制',
      popupConnected: '已连接',
      popupReattach: '重新接管标签',
      popupConnecting: '连接中…',
      popupRetry: '重试',
      popupNotConnected: '未连接',
      popupReconnect: '重连',
      popupOptions: '选项',
      popupDocs: '文档',
      popupTabsAttached: '个标签已接入',
      popupNoRelay: '没有中继服务器:',
      popupTrying: '正在连接 ',
      popupLoading: '加载中…',
      popupInstallTitle: '中继服务器未运行 —— 安装并检查:',
      popupInstallHint: '已安装?用 <code style="display:inline; padding:1px 5px; cursor:text; font-size:11px">browser-relay status</code> 检查',
    },
  }

  let lang = 'en'

  function resolve(override) {
    if (override === 'en' || override === 'zh_CN') return override
    const ui = String((chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || 'en').toLowerCase()
    return ui.startsWith('zh') ? 'zh_CN' : 'en'
  }

  function t(key) {
    const dict = MESSAGES[lang] || MESSAGES.en
    return dict[key] != null ? dict[key] : (MESSAGES.en[key] != null ? MESSAGES.en[key] : key)
  }

  function apply(root) {
    root = root || document
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n) })
    root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml) })
    root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh) })
  }

  function setLang(override) { lang = resolve(override) }

  window.I18N = { t, apply, setLang, get lang() { return lang } }
})()
