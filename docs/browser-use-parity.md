# Browser Use 优点移植：开发实现与验收

本轮把实测和本地扩展审计中确定的八个方向做成 Browser Relay 自身的实现，没有复制厂商扩展代码。这些改动由 `1.5.0-dev.1` 开发版本推进至 **1.5.0**。下文保留开发阶段的验证记录与当时的发布边界；正式版本的功能和升级方式见[1.5.0 发布说明](releases/v1.5.0.md)。

## 八项落地

| 方向 | 实现 | 主要入口 |
|---|---|---|
| 读全内容 | AX 全文、完整 URL、分页续读、子树读取；旧文本修复 display:contents、表格单元格截断 | `read`、`tab.read()`、`browser_read` |
| 保留归属与层级 | 按父子关系输出 article、main、表格等语义边界，去掉重复容器摘要而非正文 | `extension/observations.js` |
| 操作语义明确 | 可访问名称、状态和所属结构；旧按钮优先 aria-label；保留已有 scope 定位 | `observe`、scoped locators |
| 阅读后直接操作 | 正文、完整链接、refs 同时返回；已读完分页后才推进 diff 基线 | `url`、`ref`、`nextCursor` |
| 统一文本、视觉和操作 | 同一 tab 对象读内容、定位、聚焦、截图；both 模式返回文本及真实图像块 | `tab.observe({mode:'both'})`、`focus` |
| 标签页归属和交接 | 自动认领、冲突拒绝、release/handoff、任务创建来源、弹窗显示和停止会话 | `sessions.js`、`browser_tab`、`browser_session` |
| 生命周期与错误恢复 | 心跳/租约、按传输断连停止、取消贯穿任务和请求、取消先于请求的记录、部分结果与中断动作、脚本异步错误即时返回 | `tasks.js`、SDK/MCP/runtime |
| 提示词和 skill | 按阅读/操作/视觉选择接口，确认分页/加载/验证状态，已知动作批处理，异常按实际结果恢复 | `skills/browser-relay/`、MCP tool descriptions |

## 关键行为

- 新阅读默认聚焦 main；页面无 main 时读取整页。需要菜单、侧栏或其他控件时使用 observe。目标 subtree 支持已观察的 ref、CSS 或 role/name。
- 单页输出预算仍有上限，但不会静默丢弃剩余正文。nextCursor 指向同一份已捕获内容，保留 capturedAt；导航/缓存淘汰后返回 stale_observation。每个 tab 最多缓存三份、每份至多四百万字符，超限时明确要求缩小子树。跨页分割不会拆坏代理对字符。
- AX 链接通过 DOMSnapshot 的 backend node ID 批量关联，保留完整 URL，不为每个链接增加一次浏览器往返。
- 游标页读完才更新 diff 基线；没读到的内容不会被当作已见。较旧分页完成时也不会覆盖更新的基线。
- 新协议握手报告真实 executor 版本、runtimeId、protocol 和 features。旧扩展未握手时新服务立即返回 protocol_mismatch。doctor 会实际调用 capabilities，不再只看本地 manifest 和 daemon。
- 会话心跳间隔 40 秒，租约 120 秒。SDK/MCP/runtime 自动维护；短 CLI 调用以 --session 续用任务，必要时显式 heartbeat。停止/过期/断连的会话不能隐式复活。
- 读写会自动认领，其他会话及匿名旧/CDP 客户端不能操作已认领的 tab。租约用于可信客户端间协调，不是抵抗任意本地软件的安全隔离。
- release/handoff 要求没有未完成工作；保留任务创建标记。stop 取消任务并释放归属，不关闭页面、不撤销已执行动作。弹窗提供用户可见的会话停止入口。
- 导航默认等文档 readyState 离开 loading；不是“所有网络请求结束”，也不保证站点异步数据已到。需要时追加目标 wait。
- 滚动默认保持后台，隐藏标签使用 DOM 滚动，不激活标签或窗口。只有用户明确要求时才调用 focus 或允许视觉动作前置。可选 waitForChange 返回是否观察到文本变化；后台可能延迟渲染，不能因此自行切前台。viewportMoved 与 contentChanged 分开，文本变化不是新记录数量，仍需按链接/业务 ID 去重。
- 失败任务保留 results、completedActions 和 interruptedAction。取消会补发本任务尚未释放的按键/鼠标释放事件，不重放按下动作。取消不能保证已发出的动作未产生效果。
- 持久脚本的拒绝型 top-level await 错误即时返回结构化错误并保留绑定；超时重置返回 session/task IDs，便于查询部分进展。MCP notifications/cancelled 可取消普通调用与脚本运行。

## 使用例子

```bash
browser-relay capabilities
browser-relay tabs
browser-relay read --tab <discovered-id> --session research
browser-relay read --tab <discovered-id> --session research --cursor <returned-cursor>
browser-relay focus --tab <discovered-id> --session research
browser-relay observe --tab <discovered-id> --session research --mode both --output /tmp/page.png
browser-relay handoff --tab <discovered-id> --session research --to reviewer
browser-relay session stop --session reviewer
```

SDK/MCP/CLI 的现代接口共用浏览器 executor。旧 HTTP/CSS 接口保留，但在切换到旧客户端前必须 release；不要在同一认领标签上混用两套客户端。MCP 的 browser_read/browser_observe 与 browser_exec 有各自会话标识，混用前按 browser.sessionId 显式交接。

## 验收

常规检查：`npm test`，105 项通过、7 项环境条件跳过。真实浏览器回归：`npm run test:browser`，28 项通过，零失败。
Skill validator、`git diff --check` 与 npm 打包内容检查通过。
浏览器测试在隔离 profile 加载本工作树扩展，动作和读取通过 Relay SDK 发出；启动测试浏览器的兼容框架不是性能对照对象。

新增覆盖：

- 20 条长正文、长 URL、表格末尾、隐藏内容排除、main 范围、分页后无重复 diff。
- 子树读取、导航使旧游标失效。
- 两个会话竞争、匿名客户端拒绝、交接、续租/过期、停止后不隐式重启。
- 旧扩展协议拒绝、真实运行实例信息、断连时挂起请求立即失败。
- 异步浏览器错误即时返回；取消先于任务抵达时禁止执行。
- MCP 文本/图像组合返回、取消通知与任务 ID 对应。
- 弹窗显示认领者，停止时取消待办操作而保留页面。
- 原有 iframe、shadow DOM、控件事件、任务队列和远程 hub 回归。

### 真实 Omarchy 页面回查

使用 `node scripts/verify-reading.mjs <artifact-directory>` 在隔离 Chrome 中访问此前漏读的 `https://zh.omarchy.org/`，整个过程通过本开发版本 Relay 执行，且握手确认版本为 1.5.0-dev.1。

此次读到正文、安装栏目及完整手册链接。新接口分四页返回 66,862 UTF-8 字节；修复后的旧文本返回 37,409 字节。两种读取都找到了此前缺失的内容。原生旧对照有不同的 URL 显示策略，不能用这两个字节数推导对原生的压缩率或速度倍数。

机器摘要见 [browser-use-parity.json](benchmarks/browser-use-parity.json)，弹窗截图见 [extension-sessions.png](benchmarks/extension-sessions.png)。页面正文和本地执行日志保留在本机验收 artifacts 中，未打包用户 X 推荐流。

## 开发阶段的发布边界与剩余验证

- package、插件元数据使用开发版本；Chrome 的数值 version 为 1.5.0，version_name 为 1.5.0-dev.1。
- publish workflow 仅由 workflow_dispatch 触发，必须明确给定与 package.json 相同的版本及 npm channel；开发版本不能用 latest。发布前运行 Linux/Windows 测试。
- 本机 npm 配置的默认 channel 为 next；开发版发布仍要求显式传入非 latest 的 --tag，prepublishOnly 在同步版本前拒绝缺省或 latest（覆盖 npm 不导出默认标签环境变量的情况）。
- 没有触发该工作流，没有推送或发版。
- 本轮证明的是八项设计已实现且经过上述检查，**没有证明新版在用户登录 Chrome 的完整 X 同题流程中已经追平原生**。那项验收仍需要安装/重载这个开发版本，不能沿用此前旧接口的时间数据。
- 租约状态和分页缓存属于当前扩展进程，重载后失效；调用方应建立新会话并重新观察。

## 独立审查后的修复（2026-09-09）

Astra 对原开发提交的独立审查发现三项 P1 和七项 P2。原有全绿测试未覆盖这些边界，不能据此认定八项能力已经验收完成。本节记录工作树中的修复，不表示发布或 X 效率对照已经完成。

| 审查问题 | 修复及回归证据 |
| --- | --- |
| HTTP 取消/超时后后续点击仍执行 | 本地服务监听响应连接中止；SDK/CLI/MCP 共用传输实现。Node/Worker hub 自身的 HTTP abort 和 RPC 超时也发送取消，不依赖 SDK。预分配任务 ID 并保留进展；browser-review、transport、hub-rpc、remote-hub 与 worker-hub 覆盖各入口 |
| main 内 iframe 静默漏读 | AX frame root 接到实际 DOM frame owner；同源、跨源 iframe 按宿主位置进入子树。无法接入时显式 warning；browser-review 覆盖内外 main 的范围 |
| runtime inspect 隐藏截断 | 移除字符串、数组和对象深度的隐式裁剪；总输出预算溢出时提供独立 runtimeOutput 游标和 readOutput 续读，回归覆盖长正文、数组、深层值及日志占满预算后的恢复 |
| 正文顺序错乱 | 按 AX childIds 深度优先遍历后过滤；四步内容顺序回归固定为 1→2→3→4 |
| article 独立标签丢失 | 仅省略经文本相等验证的重复摘要；Alice/Bob 独立 article 名称保留 |
| 主 frame CSS 子树 stale_ref | 子树定位统一使用当前主 frame 标识；仅为选定根保留 AX 忽略的 div/p，主文档、普通容器及跨源 frame CSS 读取通过 |
| MCP 取消误报连接故障 | 普通调用及 runtime 中断使用 request_cancelled、retryable=false，保留可用任务信息 |
| remote focus 丢失连接来源 | 递归 action 请求透传 transport；sessions 回归验证远程断连停止远程归属并保留本地归属 |
| 已认领 tab 阻断其他 tab 的 CDP 握手 | Browser.getVersion 读取扩展上下文的浏览器元数据；browser-review 验证连接及操作已释放 tab，同时仍拒绝操作已认领 tab |
| 本地 npm publish 可能将开发版设成 latest | publishConfig 默认 next，发布前要求开发版显式非 latest 标签；distribution 通过真实 npm lifecycle 验证 next 通过、缺省/latest 拒绝，未执行发布 |

本轮全量检查：`npm test` 124 通过、8 项环境条件跳过；`npm run test:browser` 36 通过、零失败。新增回归为 `tests/browser-review.test.mjs`、`tests/transport.test.mjs` 以及 runtime/MCP/session/distribution 的补充断言。独立 Astra 最终复验已将十项问题全部标为通过，独立运行的测试结果亦为 124/36。复验额外覆盖 99,800 字符、85k 日志叠加正文、18 万字符跨页及 emoji，续读结果与完整 HTTP 内容逐字符一致；真实 Node hub 的 30 秒超时后原始 HTTP 与 SDK 均停止后续点击。CLI 单次 exec 排空 185,406 字符后无失效游标或残留归属。证据归档于本机 `~/.codex/artifacts/browser-relay-review-fixes-2026-09-09/`。

取消是停止后续 Relay 动作，不会撤回页面已经启动的网络请求或定时器。传输无法送达取消时明确报告未知结果，并保留任务标识；不得自动重放。Runtime 总输出预算与浏览器分页不同；超预算后先按 runtimeOutput.readWith 续读缓存，取回被裁剪的正文和浏览器游标，再继续浏览器分页。超出续读缓存上限则明确报错，应保留结果变量后分段打印，不能通过 diff 补回先前没打印的内容。

Worker 改动按 [Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/) 显式传递 AbortSignal 并启用 enable_request_signal。Wrangler 本地 dry-run 打包与类型生成通过，没有上传或部署。Cloudflare 线上 DO 的真实客户端断连传播仍未验证；本地 Worker 路由/信号回归通过。Linux/Windows 实机、实际发布和登录 X 的原生效率对照也不在本轮验证结果内。

上述独立复验完成时，修复仍保留为未提交改动，尚未推送、发版、部署或替换全局安装。随后用户明确批准正式发布 1.5.0，发布状态以 GitHub Release 与 npm registry 为准。
