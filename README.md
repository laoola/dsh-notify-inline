# dsh-notify-inline

DSH Web 客户端的**页面内统一通知插件**：一个铃铛 + 角标 + 通知面板 + 横幅，把「会话需要你（P1）」与「会话跑完了（P2）」聚合到 DSH 窗口内，后台时通过系统通知 + 标签页标题标记触达。

替代 `dsh-notify-me`（后者功能等价但为独立窗口插件；本插件零依赖、纯客户端、随主窗口渲染，不需要额外窗口/热更新链路）。

## 功能

| 事件 | P1（需要你） | P2（完成） |
|---|---|---|
| 种类 | `approval`（权限审批）> `plan-review`（方案确认）> `question`（提问） | 回复完成 |
| 页面在前台、事件会话在当前标签 | 只亮铃铛角标 + 摇摆动画（不打断当前会话内已有的审批卡片） | 同左 |
| 页面在前台、事件来自后台会话 | 顶部横幅（12s，含裁决按钮）+ 轻音 | 先过**真完成确认窗**（idle 持续 `doneConfirmMs` ≥ 默认 10s 才算完成），再按会话攒批：静默 `doneBatchMs`（默认 5s）无新事件后弹一条聚合横幅（「会话 X · 回复完成 / N 条新动态」）+ 轻音 |
| 页面在后台（最小化/切走） | Windows 系统通知（点击回窗+跳会话）+ 标签标题 `🔔 需要你 · …` | 确认窗+攒批后系统通知 + `✅ 会话 X · 回复完成 · …` |
| 永久 | 全部事件进通知面板（回前台后未处理项仍可点） | 同左 |

裁决（同意/拒绝）直接在横幅/面板上完成，走与页内审批卡完全相同的 `interaction.answer('allowed-once' | 'rejected')` 链路；**同意按钮需长按 800ms**（进度动画）防误触；检测到高危命令（`rm -rf`、`git push --force`、`Remove-Item -Recurse -Force`、`danger-full-access` 等）时**不提供**一键同意，只保留「去处理」。

## 主题三态（v1.1）

面板 ⚙ 设置里可选 **跟随宿主 / 浅色 / 深色**（默认跟随宿主）：

- **跟随宿主（auto）**：`MutationObserver` 监听 `<html data-sm-theme>`，宿主切主题即时跟随，无需刷新。
- 落地为 `<html data-dshni-theme="light|dark">`，铃铛/角标/面板/横幅/浮动按钮全套颜色走 CSS 变量，无深色硬编码残留。
- 宿主未声明主题时兜底深色（GitHub Dark 系，V1 原观感）。

## P2 真完成判定（v1.2）

根治多步 agent 任务「轮间 idle 就报完成」导致的连弹（用户实测单会话 40~60 条）：

- P2 三源检测（`completionUnread` 上升 / 会话 face `running` 下降沿 / 列表行 `completed` 上升沿）不再直接报完成，先登记**待确认**：会话保持 idle 持续 ≥ `doneConfirmMs`（设置抽屉可调 **3~60 秒**，默认 **10000ms**）才判定真完成并触发 P2。
- **窗口内回到 running**（新一轮开始）/ 出现等待输入 / 会话重跑 / 用户打开该会话（unread 回落）→ **取消**，不触发。
- 窗口内同一会话继续产出新证据 → **重置计时**（取最新证据），直到真正静默过闸。
- 过闸后的 P2 仍走 `doneBatchMs` 攒批（见下节），两道闸叠加双保险。
- **P1 通道完全不受影响**（审批/方案/提问即时弹，零去抖）；当前会话完成只亮角标的规则不变。
- 越界值夹回边界；控制台 `__dshNotifyInline.setConfig({ doneConfirmMs: 3000 })` 同样生效。

## P2 攒批防连弹（v1.1）

单会话连跑产生大量 P2 完成事件时不再逐条连弹：

- 同会话 P2 事件入队攒批，**角标立即亮**（未处理数实时）；
- 静默 `doneBatchMs`（设置抽屉可调 **1~30 秒**，默认 **5000ms**）内无新事件才 flush，弹一条聚合通知（文案「会话 X · 回复完成」+「N 条新动态 · 最新：…」）；新事件会**重置计时**；
- 前台走聚合横幅、后台走系统通知，都走 flush 通道；P1 审批类**不攒批**立即弹；
- 设为 1~30 以外的值会被夹回边界；控制台 `__dshNotifyInline.setConfig({ doneBatchMs: 10000 })` 同样生效。

## 会话级单次提示（v1.3）

同一会话的 P2「回复完成」**只弹一次**，未处理前不再重复弹（用户实测同会话连续 3 回合各弹一条，两道时间闸拦不住跨回合弹窗）：

- **语义**：设置抽屉开关「**会话单次提示（未处理前不重复弹）**」，默认**开**（`perSessionNotify`，存 `localStorage['dshNotifyInline.config']`）。开启时，会话的 P2 真正「弹给用户」一次（前台聚合横幅+提示音，或后台系统通知）后即被标记；此后该会话的后续 P2 **只入队 + 角标 +1 + 标题标记**，面板计数照常累加，横幅/系统通知/提示音一律不再出。**只弹一次指「弹出通知」本身**，攒批聚合通知里一次带出多条新动态不受影响。
- **解除（恢复弹窗资格）仅两条路径**：① 点「查看」/系统通知**跳转成功**进入该会话；② **currentSession 切到该会话**（用户主动查看）。解除后再完成的 P2 会照常弹。
- **与双闸的关系**：与 `doneConfirmMs`（真完成确认窗）+ `doneBatchMs`（攒批静默窗）**三道闸串联**——先确认是真完成，再攒批聚合，最后会话级只弹一次。`doneBatchMs` 设为 0（P2 不攒批直弹）时同样受本开关约束（共用同一状态）。关闭本开关即恢复此前行为（每个聚合批次都弹）。
- **P1 通道完全不受影响**：审批/方案/提问照旧每次即弹，从不检查会话级状态。

## 已处理即消失与会话聚合（v1.4）

**A. 已处理即消失**（不再保留灰标签历史）：

- 条目转「已处理」的瞬间即从面板列表**直接移除**（v1.1 的灰色「已处理」标签随之移除）：四条 resolve 路径统一收口 `pruneResolved()`——P1 裁决（同意/拒绝）、跳转成功（点「查看」/「去处理」/横幅/系统通知）、宿主 interaction 消费同步（打开对应会话自动消 P1）、手动「全部已读」。
- **面板头「已处理 N 条」累计**（v1.7 已移除：该计数只增不减、无决策价值，本地键启动时清理；见「计数口径精简（v1.7）」节）。
- **持久化口径变化**：已处理条目不再写入 `dshNotifyInline.items`（盘上只存未处理条目）；旧版本盘里残留的 resolved 条目在启动恢复时直接丢弃、不报错。
- 跳转失败的条目**不转已处理、不删除**，红字提示保留（重试成功才移除）。

**B. P2 面板聚合**（纯展示层，条目数组结构不变）：

- v1.4 按会话（sessionId）聚合；**v1.6 改按「会话标题 + 分钟桶」融合**（见下节），同一分钟内同名条目合并成一条。
- 融合行渲染成**单条消息**：标题后只跟 kind 标签，**不显示条数**（无「· N 条新动态」、无「N 个会话」）；有摘要时副标题「最新：…」；时间取组内最新时间。
- 点该行**「查看」**＝跳组内最新条目的会话：跳转成功 → 整组条目（可能跨多个 sid，如子代理继承父标题）resolve 移除、角标按组数减 1、面板收起；跳转失败 → 整组保留并显示红字。
- **P1 不聚合**，仍逐条展示（裁决按钮逐条操作）；标题、横幅、系统通知、单次提示逻辑均不变。

## 同标题同分钟融合（v1.6）

针对「同一时间同一对话的多条完成动态把面板刷成 200 行」的实测反馈（子代理会话继承父会话标题，旧 sessionId 聚合键被拆成多行）：

- **融合键** = 会话标题 `sessionLabel`（缺失时按当前会话/ sid /「会话」兜底）+ **分钟桶** `floor(at / 60000)`。
- **跨分钟不融合**：同标题但落在不同分钟桶的条目仍分行，保留时间先后。
- **角标与面板头改为组数口径**：角标数字 = 未处理组数（P1 逐条计 + P2 融合组每组计 1，>99 显示 `99+`）；面板头「N 个待处理」同口径；P1 的「N 条待裁决」仍是条目数（P1 逐条）。
- **零影响面**：items 数组结构、`localStorage` 键（`dshNotifyInline.items` / `.config`）、攒批闸门、系统通知、标题标记、P1 逐条与裁决全部不动，只改渲染层与计数口径。

## 计数口径精简（v1.7）

针对「面板头『已处理 2102 条』一路递增」的反馈：

- **移除「已处理 N 条」累计显示**：该计数是历史累计值（v1.4 引入），只增不减、无法清零，不回答任何决策问题；真正有用的是左侧「N 个待处理」。
- **`resolvedTotal` 计数逻辑整体删除**：不再写入 `localStorage['dshNotifyInline.resolvedTotal']`；旧键在插件启动时清理。
- **面板头现状**：只保留「N 个待处理」（组数口径）、P1 的「N 条待裁决」与「全部已读」按钮。
- 零影响面：条目的移除/持久化/角标/裁决逻辑均不变，纯显示层与一个废弃计数器清理。

## 视觉层重构（v1.5）

按已批准原型 `prototypes/dsh-notify-inline-visual-v15.html` 实施的**纯样式层重构**：逻辑、路由、持久化、事件检测零变化，不引入任何库，全部颜色/阴影经宿主 DSW 设计令牌引用。

- **令牌三层**：`--dsw-static-*`（77 个原子色）→ `--dsw-alias-*`（亮色 107 个挂 `:root`、暗色 101 个挂 `[data-dshni-theme="dark"]`）→ `--dshni-*` 语义映射层（组件样式只消费映射层）。主题色零硬编码。
- **双主题信号**：跟随逻辑扩展为 `body[data-ds-dark-theme]`（宿主新版信号）优先、`html[data-sm-theme]` 兜底，双 observe 任一变化即重解析；抽屉三态（跟随/浅/深）机制不变。
- **组件规格对齐原型**：铃铛 28×28 r8 透明底、角标 ring+150ms pop、面板 400px r12 缩放淡入 200ms（origin top right）、行 r12 无分隔线 hover 150ms、优先级竖条常驻（P1 红/P2 绿）、主按钮 28px 黑白款（button-primary-fill）、P2 聚合行 36px 单行、抽屉 checkbox accent 色。
- **横幅**：宿主 toast 令牌深底白字（双主题一致）、右下角 20px、240ms 右滑入；主按钮 contrast-fill+label-primary-foreground（双主题可读）；ghost 按钮固定白 15% 边。
- **动效与可访问性**：面板/横幅/角标/行 hover 四项动效；`@media (prefers-reduced-motion: reduce)` 关闭全部入场与强调动画；交互件 `focus-visible` 2px outline（business-primary 色）。

## 「已处理」规则（v1.1）

- 角标 = **未处理组数**（v1.6 改：P1 未裁决逐条计 + P2 融合组每组计 1），不再是「未读数」，也不是条目数。
- **打开面板只展开，数字不动**（「打开即全已读」已移除）。
- 条目转「已处理」仅两条路径：**P1 裁决**（同意/拒绝）或**跳转成功**（点「去处理」/「查看」/横幅「查看」/系统通知点击，宿主 action 与 DOM 兜底任一命中）。
- **跳转失败**（两条路径都没命中）：条目保持未处理、角标不动，面板该条目下显示红字「跳转失败，请手动前往该会话处理」。
- 面板头部保留手动**「全部已读」**按钮兜底：显式点击才把全部条目转已处理。
- 已处理条目**即从面板移除**（v1.4 改：不再保留灰色「已处理」标签历史，见「已处理即消失与会话聚合（v1.4）」节）。
- **跳转后恢复侧栏分组折叠态**（v1.1 #20）：宿主 `openSession` 会自动展开目标会话所在工作区分组且持久，插件在跳转前快照各分组折叠态、跳转成功 ~700ms 后把被误展开的组重新折叠（含目标组），避免「铃铛复制了对话」的误读。该逻辑全程 try/catch，不影响跳转主流程，也不触碰「展开其余 N 个会话」按钮。

## 条目持久化（v1.2）

通知条目不再随刷新/重启丢失（此前用户实测 61 条历史清零）：

- 全量字段（pr/kind/title/sub/会话/时间/已处理/跳转失败等）落 `localStorage`，key `dshNotifyInline.items`（与 `dshNotifyInline.config` 并存不冲突）。
- **启动恢复**：插件初始化读回条目并按未处理口径重算角标（v1.4 改：盘上只存未处理条目，旧盘已处理条目恢复时直接丢弃；v1.7 起旧版 `dshNotifyInline.resolvedTotal` 计数键启动时清理）。
- **恢复 ≠ 新事件**：恢复路径只填列表 + 重算角标，横幅/系统通知/提示音**零重放**。
- **200 条上限**沿用挤最老；**写入 500ms 防抖**批量落盘；localStorage 满/异常自动降级纯内存，不报错；无历史（首次安装/旧版升级）= 空启动。
- mock 测试条目不持久化（自测不污染真实历史）；面板「清空」立即落盘清空。
- 注意：恢复的 P1 条目不带 live `interaction` 对象，无法页内裁决，走「去处理」跳转路径。

## 宿主兼容

| 宿主代际 | 交互源 | 完成源 |
|---|---|---|
| 0.1.2-alpha.2 ~ 0.1.5-rc.3 | `uiSession.pendingInteractions`（Map<sid, interaction>） | 会话 face `running` 下降沿 + 列表行 `completed` 上升沿 |
| 0.1.6-alpha.2+（含 0.2.0-rc.2） | `uiSession.sessionStatus`（Map<sid, {running, pendingInteraction, completionUnread}>） | `completionUnread` 上升沿 + face 下降沿 |

运行时能力探测（`isStore` 判定），同代内不依赖具体版本号。跳转：优先 `sessions.open()`（老宿主）/ `uiWorkspace.openSession()`（0.1.6+，0.2.0-rc.2 实机验证可用），全不可用时 DOM 兜底（侧栏行标题匹配点击）。`window.__dshNotifyInline.spike()` 打印当前宿主探测结果。

## 调试 / 自测

控制台对象 `window.__dshNotifyInline`：

```js
__dshNotifyInline.spike()       // 宿主能力探测（版本代际/跳转/通知权限/铃铛挂载）
__dshNotifyInline.items()       // 当前通知列表（含 read/resolved/jumpFailed 状态）
__dshNotifyInline.unread()      // 未处理条目数（P1 未裁决 + P2 未查看，v1.1 语义）
__dshNotifyInline.groups()      // 未处理组数（v1.6：角标/面板头同口径）
__dshNotifyInline._seedItems([...])  // v1.6：逻辑层自测直接注入 items（跳过路由与渲染）
__dshNotifyInline.test('approval-bg')  // 注入测试事件（mock interaction 可完整验证长按裁决链路）
__dshNotifyInline.focus('sid')  // 触发跳转链路（host → dom 兜底）
__dshNotifyInline.setConfig({ banner: false, volume: 0.3 })
```

`test()` 可用 kind：`approval` / `approval-bg` / `plan` / `question` / `done-here` / `done-bg` / `sys`（直接发系统通知，无视 hidden 判定，便于验收）/ `clear`。面板右下 ⚙ 也有同款按钮。

设置持久化在 `localStorage['dshNotifyInline.config']`。

## 安装

### 从 GitHub 安装（推荐）

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"dsh-notify-inline": "github:laoola/dsh-notify-inline"`，跑 `pnpm install`。
2. 同文件 `dsh.profile.bundles` 追加 `"dsh-notify-inline"`。
3. 刷新页面（client bundle 走静态 combo，页面刷新即生效）；改代码/升级版本后 Ctrl+F5 强刷即可。

### 本地开发（link 方式）

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"dsh-notify-inline": "link:D:/GitCode/dshplugin/dsh-notify-inline"`，跑 `pnpm install`（同步 lock + 建 node_modules Junction）。
2. 同文件 `dsh.profile.bundles` 追加 `"dsh-notify-inline"`。
3. 重启 dsh web 或刷新页面。

宿主半边（`index.js`）是 no-op（`inject: []` + `apply`），仅满足 cordis 装配契约（缺 `inject` 导出会在激活时报 `cannot get property … without inject`，见 dsh-instruction-tracker 踩坑记录）。

## 卸载 / 回退

纯客户端插件，卸载即回退，不留残余：

1. `~/.dsh/profiles/web/package.json`：从 `dependencies` 删除 `"dsh-notify-inline"` 行、从 `dsh.profile.bundles` 删除 `"dsh-notify-inline"` 行。
2. `pnpm install`（移除 node_modules Junction 并同步 lock）。
3. 刷新页面。插件的 `ctx.effect` disposer 会：恢复被标记的 `document.title`、移除铃铛/面板/横幅/浮动按钮 DOM、退订全部 store —— 宿主无报错，token-monitor 不受影响（本插件从不写它的文件，仅排序上排其左侧）。

未装 Node 端（`index.js` 为 no-op），无宿主侧状态需要清理。

铃铛挂载点：`conversation.session.header.utilities` 槽，`order: -100`（token-monitor 用 -99，官方组件 ≥ -10）→ 铃铛稳定出现在 token-monitor 徽标左侧，**不改 token-monitor 任何源码**。槽位不可用时自动降级为右下角浮动按钮。

## 已知边界

- 系统通知权限在首次用户手势（点击/按键）时请求（Chromium 限制，手势外 `requestPermission()` 被忽略）；未授权时后台触达只剩标题标记。
- WebAudio 提示音同样需首次手势解锁。
- 横幅最多同时 3 条（超出挤掉最老），同类事件 10s 静默窗内合并不重弹。
- 面板历史上限 200 条，超出丢弃最老。
- 条目已持久化（v1.2，见「条目持久化」节）；mock 测试条目不落盘。**多标签页同时打开宿主时，各标签页实例写同一个 `localStorage` key 会互相覆盖**（后写者胜，可能吞掉另一标签页刚入队的条目）——单标签页/常规使用不受影响。
- 会话标题来自 `listStore` 摘要（`displayTitle`/`title`）；列表里已删的会话只剩 id。
