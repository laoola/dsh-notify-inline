/**
 * dsh-notify-inline — browser half (client plugin bundle, plain JS 零构建)。
 *
 * 机制依据（DSH 0.2.0-rc.2 实机 + 参考源码，2026-10-17）：
 * - 加载：window.__ModuleLoader__.load({ id: 包名, factory(require) })，React 取自模块表。
 *   参照 dsh-notify-me/lib/client.js:200 与本仓库 dsh-instruction-tracker/client.js:31。
 * - 挂载：ctx.slots.inject("conversation.session.header.utilities", fn) + fn 内
 *   ctx.slots.register({name, id, order}, Component)。
 *   参照 dsh-token-monitor/lib/client.js:5993-6013（其 order:-99 钉最左）。
 *   本插件 order:-100 —— 框架按 order 升序稳定排序（dsh-client-ui-renderer 的
 *   sort((a,b)=>a.order-b.order)），-100 < -99 = 稳定排 token-monitor 徽标左侧，
 *   不改 token-monitor 任何源码。
 * - 会话状态双读法（宿主多版本兼容，验收项 #2）：
 *     * DSH 0.1.2-alpha.2 .. 0.1.5-rc.3：uiSession.pendingInteractions，
 *       Map<sessionId, interaction>，值即 interaction 对象（kind/key/answer…）；
 *     * DSH 0.1.6-alpha.2+（含 0.2.0-rc.2，本机）：uiSession.sessionStatus，
 *       Map<sessionId, {running, pendingInteraction, completionUnread}>，
 *       旧 store 已删，只有新 store。
 *   运行时按「能力探测」选 store：sessionStatus 存在优先（=0.1.6+ 一代），
 *   否则 pendingInteractions（=0.1.2~0.1.5 一代）。两代都不在 → 通道静默。
 *   依据：dsh-notify-me/lib/client.js:1329-1342（interactionStore/pendingOf）。
 *   ⚠ uiSession 不进 exports.inject：cordis inject 是硬门，服务缺失则条目永不激活、
 *   boot audit 失败；老宿主无 uiSession。故 lazy lookupService()（ctx.get →
 *   ctx.reflect.get → 属性读），同 dsh-notify-me/lib/client.js:1312-1324。
 * - 当前会话判定（验收项 #3，与 notify-me client.js:918 同口径）：
 *   listStore.getSnapshot() 的 `current` 字符串（<=0.1.5-rc.3）优先，
 *   否则遍历 byId 取 retainedBy.mainView > 0 的行（0.1.6+，官方 DocumentTitle /
 *   ui-workspace / ui-session isMain() 同款）。
 * - 跳转双保险（验收项 #10）：
 *   * 路径 A（宿主 action，spike 实机验证 2026-10-17，dsh 0.2.0-rc.2）：
 *     sessions.open 在 0.2.0-rc.2 的 sessions 服务上【不存在】（svc.open === undefined），
 *     uiWorkspace.openSession(id) 【存在可用】—— 与 notify-me 注释一致
 *     （dsh-notify-me/lib/client.js:416-433：0.1.6+ 走 uiWorkspace.openSession）。
 *     两者都试，先 sessions.open（兼容 0.1.2~0.1.5）再 uiWorkspace.openSession。
 *   * 路径 B（DOM 兜底，A 全部不可用时）：会话列表行定位 —— 实机 DOM 勘察结论
 *     （0.2.0-rc.2）：侧栏行元素带 `data-session-id` 属性者未发现，实际可用锚点是
 *     行内 [data-testid 或 class] 均不稳定，最终以「列表容器内遍历行元素、按
 *     byId[sid] 标题文本匹配」命中后 element.click()。选择器候选数组见 domJump()。
 *   * 点系统通知 = window.focus()（web 壳调窗）+ 上述切会话（notify-me 的
 *     raiseWindow/focusSession 同款，:401-435）。
 * - 系统通知仅 document.hidden 时发出（验收项 #6）；权限在首次用户手势时请求
 *   （notify-me :721-731 同款，Chromium 手势外 requestPermission 被忽略）。
 * - WebAudio 首次手势解锁后才发声（验收项 #5）。
 * - 标题标记：宿主拥有 document.title（跟踪会话/工作区名），每次写入前重读
 *   base 并剥离自身历史前缀（notify-me cleanBase/applyTitle 同款，:733-778）。
 *   页面可见时不写标记（前台通道自足），hidden 时按未读优先级 🔔 > ✅。
 * - P2 完成三源合并（notify-me 同款，:1153-1167/:1441-1459）：
 *   face running true→false（当前会话）、列表行 completed 边（老宿主）、
 *   sessionStatus.completionUnread（0.1.6+ 主通道）；doneFiredAt 去重窗防双报。
 * - 裁决动词：interaction.answer('allowed-once' | 'rejected') —— 与页内审批卡
 *   同款（notify-me :596-604）。pendingInteraction 可能是完整 interaction 对象
 *   （0.2.0-rc.2 实测）或 kind 字符串（列表行 sum.pendingInteraction），分形态处理。
 * - window.__dshNotifyInline = { config, items(), debug(), test() } 供实机自测。
 */
(function (root) {
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-notify-inline',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      var React = null;
      try { React = require('react') || null; } catch (e) { React = null; }
      var h = React ? React.createElement : null;

      /* ══════════════════════════ 配置 ══════════════════════════ */
      var LS_CONFIG = 'dshNotifyInline.config';
      var DEFAULTS = {
        enabled: true,      // 总开关：false = 全通道静默
        banner: true,       // 前台横幅
        sound: true,        // WebAudio 轻音
        volume: 0.12,       // 0..1
        titleMark: true,    // 标签标题标记（后台）
        sysNotify: true,    // Windows 系统通知（后台）
        autoFocus: true,    // 点通知/去处理时调窗+切会话
        highRiskGuard: true,// 高危审批不给一键同意（验收项 #7）
        longPressMs: 800,   // 「同意」长按时长（防误触，验收项 #7）
        bannerMax: 3,       // 横幅同时最多条数
        bannerQuietMs: 10000,// 同类横幅静默窗
        doneBatchMs: 5000,  // P2 攒批静默窗（可配 1~30s；返修 #18：同会话连发聚合弹一条，P1 不攒批）
        doneConfirmMs: 10000, // P2 真完成确认窗（v1.2 #22：idle 持续 ≥ 此值才判定完成，可配 3~60s）
        perSessionNotify: true, // 会话级单次提示（v1.3 #23：同会话 P2 弹过一次未处理前不再弹横幅/系统通知，跳转成功或 current 切到该会话才解除；P1 不受影响）
        theme: 'auto'       // 主题三态：auto=跟随宿主 data-sm-theme / light / dark（返修 #14）
      };
      var config = (function () {
        var c = Object.assign({}, DEFAULTS);
        try {
          var raw = root.localStorage && root.localStorage.getItem(LS_CONFIG);
          if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') Object.assign(c, o); }
        } catch (e) {}
        return c;
      })();
      function saveConfig() {
        try { root.localStorage && root.localStorage.setItem(LS_CONFIG, JSON.stringify(config)); } catch (e) {}
      }

      /* ══════════════════════════ 主题（返修 #14：三态+自动跟随；v1.5：宿主双信号） ══════════════════════════ */
      // 三态：auto=宿主双信号自动跟随（body[data-ds-dark-theme] 优先，fallback <html data-sm-theme>）；
      // light/dark=强制。落地为 <html data-dshni-theme="light|dark">，全套 CSS 变量按它切换（见 injectStyles）。
      function resolveTheme() {
        if (config.theme === 'light' || config.theme === 'dark') return config.theme;
        try {
          var d = document.body ? document.body.getAttribute('data-ds-dark-theme') : null; // v1.5：宿主新版暗色信号
          if (d !== null && d !== undefined) return d === 'false' ? 'light' : 'dark';
        } catch (e) {}
        try {
          var t = document.documentElement.getAttribute('data-sm-theme');
          if (t === 'light' || t === 'dark') return t;
        } catch (e) {}
        return 'dark'; // 宿主未声明时兜底深色
      }
      var themeObserver = null;
      function applyTheme() {
        try { document.documentElement.setAttribute('data-dshni-theme', resolveTheme()); } catch (e) {}
      }
      function bindThemeObserver() {
        if (themeObserver) return;
        try { themeObserver = new MutationObserver(function () { applyTheme(); }); } catch (e) { return; }
        try { themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sm-theme'] }); } catch (e) {}
        try { if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }); } catch (e) {} // v1.5：双信号
        applyTheme(); // 绑定时立即对齐一次
      }

      /* ══════════════════════════ 数据 store ══════════════════════════ */
      // items：通知历史（面板全部数据源）。回前台后未处理项全部在面板 ——
      // 所有事件无论走哪条通道都无条件入 items（验收项 #4 的「不丢」一半）。
      var items = [];               // {id, pr, kind, ico, tagKey, title, sub, sessionId, sessionLabel, at, read, resolved, jumpFailed, key, interaction, highRisk, mock}
      // 返修 #19：独立 unread 计数废弃 —— 角标 = unhandledCount()（未 resolved 条目数）
      var subscribers = new Set();
      function emit() { subscribers.forEach(function (fn) { try { fn(); } catch (e) {} }); }
      function subscribe(fn) { subscribers.add(fn); return function () { subscribers.delete(fn); }; }

      /* ══════════════════════════ 条目持久化（v1.2 #21） ══════════════════════════ */
      // items 全量字段落 localStorage（key 与 dshNotifyInline.config 并存不冲突）；刷新/重开恢复。
      // 恢复 ≠ 新事件：恢复路径只填 items 数组重算角标，横幅/系统通知/攒批零触发。
      // mock 测试条目不持久化（不污染真实历史）。写满/异常 try-catch 降级纯内存。
      var LS_ITEMS = 'dshNotifyInline.items';
      var LS_RESOLVED_TOTAL_LEGACY = 'dshNotifyInline.resolvedTotal'; // v1.7：v1.4~v1.6 已废弃的「已处理 N 条」累计键，启动时清理
      var ITEMS_MAX = 200; // 与 pushItem 挤最老同口径
      var persistTimer = null;
      function slimItem(n) { // 可序列化子集：剥 interaction（live 对象，恢复后无意义）与 mock
        return {
          id: n.id, pr: n.pr, kind: n.kind, ico: n.ico, tagKey: n.tagKey || '',
          title: n.title || '', sub: n.sub || '', sessionId: n.sessionId || null,
          sessionLabel: n.sessionLabel || '', at: n.at, read: !!n.read,
          resolved: !!n.resolved, jumpFailed: !!n.jumpFailed,
          key: n.key || null, highRisk: !!n.highRisk
        };
      }
      function persistNow() {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        try {
          var slim = [];
          for (var i = 0; i < items.length && slim.length < ITEMS_MAX; i++) {
            if (!items[i].mock) slim.push(slimItem(items[i]));
          }
          if (root.localStorage) root.localStorage.setItem(LS_ITEMS, JSON.stringify(slim));
        } catch (e) {} // localStorage 满/禁用 → 降级纯内存，不报错
      }
      function schedulePersist() { // 500ms 防抖：批量落盘，避免每条事件一次写
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(persistNow, 500);
      }
      function loadPersisted() {
        try {
          var raw = root.localStorage && root.localStorage.getItem(LS_ITEMS);
          if (!raw) return [];
          var arr = JSON.parse(raw);
          if (!Array.isArray(arr)) return [];
          return arr.slice(0, ITEMS_MAX).map(function (n) {
            if (!n || typeof n !== 'object') return null;
            if (n.resolved) return null; // v1.4 #26：旧盘已处理条目恢复时直接丢弃（新口径已处理不入盘），不报错
            return {
              id: n.id || uid(), pr: n.pr === 1 ? 1 : 2, kind: n.kind || 'done', ico: n.ico || '✅',
              tagKey: n.tagKey || '', title: n.title || '', sub: n.sub || '',
              sessionId: n.sessionId || null, sessionLabel: n.sessionLabel || '',
              at: Number(n.at) || Date.now(), read: !!n.read, resolved: !!n.resolved,
              jumpFailed: !!n.jumpFailed, key: n.key || null,
              interaction: null, // 恢复条目不带 live interaction（P1 恢复后走「去处理」跳转路径）
              highRisk: !!n.highRisk, mock: false, restored: true
            };
          }).filter(Boolean);
        } catch (e) { return []; } // 无历史/损坏 JSON = 空启动
      }

      /* ══════════════════════════ 已处理即消失（v1.4 #24） ══════════════════════════ */
      // resolved 条目从 items 数组直接移除（灰标签历史不再保留）。移除后防抖落盘——盘上自然不含
      // 已处理条目。跳转失败条目不 resolve 不删（红字提示保留）。所有 resolve 路径收口于此：
      // decide（P1 裁决）/ jumpSessionId（跳转成功）/ resolveItemByKey（interaction 消费同步）/
      // markAllResolved（手动全部已读兜底）。
      // v1.7：v1.4 #26 的 resolvedTotal「已处理 N 条」累计计数已移除（只增不减无信息价值），
      // 本地键启动时清理，面板头不再展示。
      function pruneResolved() { // 返回本次移除条数（0 = 无变化）
        var kept = [], removed = 0;
        for (var i = 0; i < items.length; i++) {
          if (items[i].resolved) removed++; else kept.push(items[i]);
        }
        if (removed) {
          items = kept;
          schedulePersist(); // 已处理条目不再入盘（#26 持久化口径）
        }
        return removed;
      }

      var attentionKeysFired = Object.create(null); // P1 key 去重（不重的一半）
      var doneFiredAt = Object.create(null);        // P2 会话级去重窗
      var DONE_DEDUPE_MS = 1500;

      function uid() { return 'dshni-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

      function kindRank(kind) { return kind === 'approval' ? 3 : kind === 'plan-review' ? 2 : kind === 'question' ? 1 : 0; }

      var KIND_META = {
        'approval':    { ico: '🔐', label: '权限审批',   pr: 1 },
        'plan-review': { ico: '📐', label: '方案待确认', pr: 1 },
        'question':    { ico: '❓', label: '向你提问',   pr: 1 },
        'done':        { ico: '✅', label: '回复完成',   pr: 2 }
      };

      // 高危权限判定（验收项 #7：高危权限不给一键同意）。
      // 审批 payload 里命中以下任一形态即视为高危：破坏性命令 / 全量放权标记。
      var HIGH_RISK_RE = new RegExp(
        '(danger-full-access' +
        '|rm\\s+(-[a-z]*r[a-z]*f|--force|~|/\\s)' +
        '|git\\s+push\\s+\\S*--force' +
        '|del\\s+/[qs]' +
        '|Remove-Item\\s+\\S*-Recurs\\w*\\s+\\S*-Forc\\w*' +
        '|format\\s+[a-zA-Z]:' +
        '|shutdown|reboot\\s+now' +
        '|reg\\s+delete|bcdedit|diskpart|mkfs|dd\\s+if=' +
        '|drop\\s+(table|database))', 'i');
      function isHighRisk(interaction) {
        if (!config.highRiskGuard) return false;
        try {
          var it = interaction && typeof interaction === 'object' ? interaction : null;
          var pay = it && it.payload ? it.payload : null;
          var parts = [];
          if (it) ['toolName', 'reason', 'command', 'text', 'summary', 'title'].forEach(function (k) {
            if (typeof it[k] === 'string') parts.push(it[k]);
          });
          if (pay && typeof pay === 'object') Object.keys(pay).forEach(function (k) {
            var v = pay[k];
            if (typeof v === 'string') parts.push(v);
            else if (v && typeof v === 'object' && typeof v.text === 'string') parts.push(v.text);
          });
          return HIGH_RISK_RE.test(parts.join(' \n '));
        } catch (e) { return false; }
      }

      // interaction 摘要文案（notify-me textFromPayload 同思路，:1056-1094）
      function textFromInteraction(it) {
        try {
          if (typeof it === 'string') return '';
          if (!it || typeof it !== 'object') return '';
          function clip(s) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > 160 ? s.slice(0, 160) + '…' : s; }
          var keys = ['text', 'question', 'prompt', 'title', 'summary', 'description', 'message', 'operation', 'toolName', 'reason', 'name', 'tool'];
          for (var i = 0; i < keys.length; i++) {
            var v = it[keys[i]];
            if (typeof v === 'string' && clip(v)) {
              if (keys[i] === 'toolName' && typeof it.reason === 'string' && clip(it.reason)) return clip(v) + ' · ' + clip(it.reason);
              return clip(v);
            }
          }
          var pay = it.payload;
          if (pay && typeof pay === 'object') {
            for (var j = 0; j < keys.length; j++) {
              var w = pay[keys[j]];
              if (typeof w === 'string' && clip(w)) return clip(w);
            }
          }
          var qs = it.questions || (pay && pay.questions);
          if (Array.isArray(qs) && qs.length) {
            var q = qs[0];
            if (typeof q === 'string') return clip(q);
            if (q && typeof q === 'object') {
              var qk = ['question', 'title', 'text', 'detail'];
              for (var m = 0; m < qk.length; m++) if (typeof q[qk[m]] === 'string' && clip(q[qk[m]])) return clip(q[qk[m]]);
            }
          }
        } catch (e) {}
        return '';
      }

      /* ══════════════════════════ 宿主服务访问 ══════════════════════════ */
      var rootCtx = null;
      var listStore = null;
      var sessionsSvc = null;

      // uiSession / uiWorkspace 一律 lazy：不进 exports.inject（硬门问题，见头注）
      function lookupService(name) {
        var svc = null;
        try { if (rootCtx && typeof rootCtx.get === 'function') svc = rootCtx.get(name) || null; } catch (e) { svc = null; }
        if (svc) return svc;
        try { if (rootCtx && rootCtx.reflect && typeof rootCtx.reflect.get === 'function') svc = rootCtx.reflect.get(name) || null; } catch (e) { svc = null; }
        if (svc) return svc;
        try { if (rootCtx && name in rootCtx) svc = rootCtx[name] || null; } catch (e) { svc = null; }
        return svc;
      }
      function isStore(s) { return !!s && typeof s.getSnapshot === 'function' && typeof s.subscribe === 'function'; }

      // ── 验收项 #2：双读法 + 版本探测 ──
      // 0.1.6+ 的 sessionStatus 行：{running, pendingInteraction, completionUnread}
      // 0.1.2~0.1.5 的 pendingInteractions 行：interaction 对象本身
      function interactionStore(svc) {
        if (svc && isStore(svc.sessionStatus)) return { store: svc.sessionStatus, source: 'sessionStatus' };      // 0.1.6+（含 0.2.0-rc.2）
        if (svc && isStore(svc.pendingInteractions)) return { store: svc.pendingInteractions, source: 'pendingInteractions' }; // 0.1.2..0.1.5-rc.3
        return null;
      }
      function pendingOf(value, source) {
        if (!value) return null;
        if (source === 'sessionStatus') return value.pendingInteraction || null; // 对象（可裁决）或 kind 字符串
        return value;                                                            // legacy：值即 interaction
      }
      // 版本/代际探测：能力探测为主，能读到宿主版本号则一并记录（debug 用）
      var hostGen = { source: null, version: null };
      function probeGeneration() {
        hostGen.source = null;
        var svc = lookupService('uiSession');
        var found = interactionStore(svc);
        if (found) hostGen.source = found.source === 'sessionStatus' ? '0.1.6+ (sessionStatus)' : '0.1.2..0.1.5 (pendingInteractions)';
        else hostGen.source = 'pre-0.1.2 / unavailable (通道静默)';
        try {
          var boot = root.__DSH_BOOT__ || {};
          hostGen.version = boot.version || (boot.manifest && boot.manifest.version) ||
            (boot.entries && boot.entries[0] && boot.entries[0].rev ? 'rev:' + boot.entries[0].rev : null) || null;
        } catch (e) {}
        return hostGen;
      }

      // ── 验收项 #3：当前会话判定（notify-me client.js:918 同口径）──
      function currentSessionId() {
        try {
          if (!listStore) return null;
          var st = listStore.getSnapshot();
          if (!st) return null;
          if (typeof st.current === 'string' && st.current) return st.current;   // <= 0.1.5-rc.3
          var byId = st.byId || {};
          for (var id in byId) {
            var row = byId[id];
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id; // 0.1.6+
          }
        } catch (e) {}
        return null;
      }
      function labelForSessionId(sid) {
        try {
          if (!listStore || !sid) return sid || '';
          var st = listStore.getSnapshot();
          var sum = st && st.byId && st.byId[sid];
          if (sum) return sum.displayTitle || sum.title || sid;
        } catch (e) {}
        return sid;
      }
      function sessionLabelOf(sum, sid) {
        if (sum && (sum.displayTitle || sum.title)) return sum.displayTitle || sum.title;
        return sid;
      }

      /* ══════════════════════════ WebAudio ══════════════════════════ */
      var audioCtx = null;
      function unlockAudio() {
        try {
          if (!audioCtx) {
            var AC = root.AudioContext || root.webkitAudioContext;
            if (!AC) return;
            audioCtx = new AC();
          }
          if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
        } catch (e) {}
      }
      function tone(freq, startIn, durMs) {
        if (!audioCtx || audioCtx.state !== 'running') return;
        try {
          var t0 = audioCtx.currentTime + startIn;
          var osc = audioCtx.createOscillator();
          var gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          var vol = Math.max(0, Math.min(1, Number(config.volume)));
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
          osc.connect(gain).connect(audioCtx.destination);
          osc.start(t0);
          osc.stop(t0 + durMs / 1000 + 0.05);
        } catch (e) {}
      }
      function playSound(pr) {
        if (!config.sound) return;
        unlockAudio();
        if (pr === 1) { tone(880, 0, 140); tone(1174, 0.16, 200); }  // P1 上行双音
        else { tone(660, 0, 180); }                                   // P2 单音
      }
      var permAsked = false;
      function requestPermission() {
        if (!('Notification' in root) || permAsked) return;
        permAsked = true;
        try {
          if (root.Notification.permission === 'default') {
            var p = root.Notification.requestPermission();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }
        } catch (e) {}
      }
      function onFirstGesture() {
        unlockAudio();
        requestPermission();
        root.removeEventListener('pointerdown', onFirstGesture, true);
        root.removeEventListener('keydown', onFirstGesture, true);
      }

      /* ══════════════════════════ 标题标记（后台） ══════════════════════════ */
      // 宿主拥有 document.title：每次写入前重读 base 并剥自身前缀（notify-me :733-778 同款）
      var MARK_ATTENTION = '🔔 需要你 · ';
      var MARK_DONE = '✅ 回复完成 · ';
      var hostBase = null;
      var writtenTitle = null;
      function cleanBase(t) {
        var prefixes = [MARK_ATTENTION, MARK_DONE];
        var stripped = true;
        while (stripped) {
          stripped = false;
          for (var i = 0; i < prefixes.length; i++) {
            if (t.indexOf(prefixes[i]) === 0) { t = t.slice(prefixes[i].length); stripped = true; }
          }
        }
        return t;
      }
      // 返修 #19：「已处理」只看 resolved（P1 裁决 / 跳转成功），read 仅面板视觉态
      function hasUnhandled(pr) {
        for (var i = 0; i < items.length; i++) {
          var n = items[i];
          if (!n.resolved && n.pr === pr) return true;
        }
        return false;
      }
      function unhandledCount() { // 未处理条目数（P1 未裁决 + P2 未查看）；v1.6 起不再用于角标/面板头
        var c = 0;
        for (var i = 0; i < items.length; i++) if (!items[i].resolved) c++;
        return c;
      }
      /* ══════════════ v1.6：P2 融合（同标题 + 同一分钟 → 一条） ══════════════
         融合键 = 会话标题 sessionLabel + 分钟桶 floor(at / 60000)。子代理会话继承父会话标题，
         旧口径按 sessionId 聚合会被拆成多行；改按标题融合后同分钟同名条目合成一条，跨分钟仍分行。
         纯渲染层：items 数组结构、localStorage 键、resolve 语义全部不动。 */
      var GROUP_BUCKET_MS = 60000;
      function p2LabelOf(n) { // 标题兜底口径与 P1/P2 行展示保持一致
        var sid = n.sessionId || '';
        return n.sessionLabel || (sid === currentSessionId() ? '当前会话' : sid || '会话');
      }
      function p2GroupKey(n) { // 融合键：标题 + 分钟桶（仅内存用，不下发 DOM）
        return p2LabelOf(n) + '\u0000' + Math.floor((Number(n.at) || 0) / GROUP_BUCKET_MS);
      }
      function buildP2Groups(list) { // list = 未处理 P2 条目；返回按组内最新时间倒序的组数组
        var map = Object.create(null), out = [];
        for (var i = 0; i < list.length; i++) {
          var n = list[i];
          var k = p2GroupKey(n);
          var g = map[k];
          if (!g) { g = { label: p2LabelOf(n), list: [], jumpFailed: false }; map[k] = g; out.push(g); }
          g.list.push(n);
          if (n.jumpFailed) g.jumpFailed = true;
        }
        for (var j = 0; j < out.length; j++) {
          var grp = out[j];
          // 组内时间倒序：首条=最新（「查看」跳它、时间显示它、meta 用它的 sub）
          grp.list.sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); });
          var latest = grp.list[0];
          grp.latest = latest;
          grp.jumpSid = (latest && latest.sessionId) || '';
          if (!grp.jumpSid) { // 最新条目无 sid 时退到组内首个有 sid 的条目
            for (var s = 0; s < grp.list.length; s++) {
              if (grp.list[s].sessionId) { grp.jumpSid = grp.list[s].sessionId; break; }
            }
          }
        }
        out.sort(function (a, b) {
          return ((Number(b.latest && b.latest.at)) || 0) - ((Number(a.latest && a.latest.at)) || 0);
        });
        return out;
      }
      function unhandledGroupsCount() { // v1.6：角标/面板头 = 未处理组数（P1 逐条计 + P2 融合组每组计 1）
        var p1 = 0, p2 = [];
        for (var i = 0; i < items.length; i++) {
          var n = items[i];
          if (n.resolved) continue;
          if (n.pr === 1) p1++; else p2.push(n);
        }
        return p1 + buildP2Groups(p2).length;
      }
      function applyTitle() {
        try {
          var current = String(document.title || '');
          if (current !== writtenTitle) hostBase = cleanBase(current);
          var prefix = '';
          if (config.enabled && config.titleMark && document.hidden) { // 仅后台标（前台通道自足）
            if (hasUnhandled(1)) prefix = MARK_ATTENTION;
            else if (hasUnhandled(2)) prefix = MARK_DONE;
          }
          var next = prefix + hostBase;
          writtenTitle = next;
          if (current !== next) document.title = next;
        } catch (e) {}
      }

      /* ══════════════════════════ 系统通知（仅隐藏时） ══════════════════════════ */
      function canSysNotify() {
        if (!config.sysNotify) return false;
        try { return 'Notification' in root && root.Notification.permission === 'granted'; } catch (e) { return false; }
      }
      function showSysNotify(item) {
        if (!document.hidden) return;                 // 验收项 #6：仅页面隐藏时发出
        if (!canSysNotify()) return;
        try {
          var n = new root.Notification(item.title, {
            body: (item.sessionLabel ? '「' + item.sessionLabel + '」 ' : '') + (item.sub || ''),
            tag: item.tagKey,                         // 同类合并由 OS 处理
            renotify: true,
            silent: true,                             // 声音由 WebAudio 通道负责，避免双响
            icon: (location.origin || '') + '/favicon.svg'
          });
          n.onclick = function () {
            try { root.focus(); } catch (e) {}
            if (config.autoFocus !== false) jumpSessionId(item.sessionId); // 返修 #19：跳转成功才转已处理
            n.close();
          };
          setTimeout(function () { try { n.close(); } catch (e) {} }, 15000);
        } catch (e) {}
      }

      /* ══════════════════════════ 跳转（双保险） ══════════════════════════ */
      // 路径 A：宿主 action（spike 结论见头注「跳转双保险」）
      function hostJump(sessionId) {
        try {
          if (!sessionId) return true;
          var st = listStore && listStore.getSnapshot();
          if (st && st.byId && !st.byId[sessionId] && currentSessionId() !== sessionId) return false; // 行已不在列表
          var s = sessionsSvc || lookupService('sessions');
          if (s && typeof s.open === 'function') { s.open(sessionId); return true; }                  // 0.1.2..0.1.5-rc.3
          var ws = lookupService('uiWorkspace');
          if (ws && typeof ws.openSession === 'function') { ws.openSession(sessionId); return true; } // 0.1.6+（实机 0.2.0-rc.2 验证可用）
          return false;
        } catch (e) { return false; }
      }
      // 路径 B：DOM 兜底 —— 会话列表行定位后 element.click()。
      // 实机勘察（0.2.0-rc.2）：行元素无稳定 data-session-id 锚，按
      // 「候选容器内行元素 × 列表行标题文本」匹配（labelForSessionId 的标题）。
      function domJump(sessionId) {
        try {
          var title = labelForSessionId(sessionId);
          if (!title) return false;
          // 候选标题：store 标签 + 条目携带的 sessionLabel（会话完成后被挤出列表时 store 已查不到，靠事件快照兜底）
          var titles = [title];
          for (var t = 0; t < items.length; t++) {
            var lab = items[t] && items[t].sessionLabel;
            if (items[t] && items[t].sessionId === sessionId && lab && titles.indexOf(lab) === -1) titles.push(lab);
          }
          var containers = [
            document.querySelector('aside'), document.querySelector('nav'),
            document.querySelector('[class*="session-list"]'), document.querySelector('[class*="sidebar"]')
          ].filter(Boolean);
          for (var c = 0; c < containers.length; c++) {
            var rows = containers[c].querySelectorAll('div[role="button"],li,a,[class*="item" i],[class*="row" i]'); // "i" 标志：实机行类 YDXeBa_sessionRow 大写 R，区分大小写时永不命中（0.2.0-rc.2 实测坑）
            for (var r = 0; r < rows.length; r++) {
              var txt = (rows[r].textContent || '').trim();
              if (!txt) continue;
              for (var k = 0; k < titles.length; k++) {
                if (titles[k] && txt.indexOf(titles[k]) !== -1) { rows[r].click(); return true; }
              }
            }
          }
          return false;
        } catch (e) { return false; }
      }
      // 返修 #17/#19：统一跳转入口（V1 focusSession 改造）。root.focus → hostJump → domJump 兜底；
      // 成功 = 该会话全部未处理条目转已处理（resolved+read，角标随之减）；失败 = 不 resolve、
      // 条目标 jumpFailed（面板红字提示）、角标不动。返回是否成功。
      // 返修 #20：宿主 openSession 副作用 = 自动展开目标会话所在工作区分组且持久（refresh 不复原），
      // 用户误读为「铃铛复制了对话」。跳转前快照各分组折叠态，跳转成功 ~700ms 后把
      // 「跳转前折叠、跳转后被展开」的组重新折叠（含目标组：会话切换不依赖列表展开）。
      // 判定：组内可见 [class*="sessionRow"] 即展开；折叠动作 = 组头 [role="treeitem"] click（真机验证有效）。
      // 不碰 bhn1Oq_sessionOverflowButton；任何失败不影响跳转主流程。
      function groupExpanded(g) {
        try { return g.querySelectorAll('[class*="sessionRow" i]').length > 0; } catch (e) { return true; }
      }
      function snapshotGroupCollapse() {
        var snap = [];
        try {
          var groups = document.querySelectorAll('[class*="groupSection" i]');
          for (var i = 0; i < groups.length; i++) snap.push({ el: groups[i], expanded: groupExpanded(groups[i]) });
        } catch (e) {}
        return snap;
      }
      function restoreGroupCollapse(snap) {
        try {
          if (!snap || !snap.length) return;
          setTimeout(function () {
            try {
              var before = [], after = [];
              for (var i = 0; i < snap.length; i++) {
                var s = snap[i];
                var g = s.el;
                if (!g || !g.isConnected) continue;
                before.push(s.expanded);
                var expandedNow = groupExpanded(g);
                after.push(expandedNow);
                if (!s.expanded && expandedNow) {
                  var hdr = g.querySelector('[role="treeitem"]');
                  if (hdr) hdr.click(); // 组头点击 = 折叠（组内其他元素无效）
                }
              }
              try { console.info('[dsh-notify-inline] #20 分组折叠复原：跳转前', JSON.stringify(before), '→ 跳转后', JSON.stringify(after)); } catch (e) {}
            } catch (e) {}
          }, 700);
        } catch (e) {}
      }
      function jumpSessionId(sessionId) {
        try { root.focus(); } catch (e) {}
        if (!sessionId) return true;
        var snap = snapshotGroupCollapse(); // #20：跳转前快照折叠态
        var ok = hostJump(sessionId);
        if (!ok) ok = domJump(sessionId);
        if (!ok) {
          try { console.warn('[dsh-notify-inline] 跳转失败：宿主 action 与 DOM 兜底均未命中', sessionId); } catch (e) {}
          var touched = false;
          for (var i = 0; i < items.length; i++) {
            var n = items[i];
            if (n.sessionId === sessionId && !n.resolved && !n.jumpFailed) { n.jumpFailed = true; touched = true; }
          }
          if (touched) emit();
          return false;
        }
        restoreGroupCollapse(snap); // #20：跳转成功后复原折叠态（不阻断主流程）
        releaseSessionNotified(sessionId); // v1.3 #23：跳转成功 = 用户去了该会话，解除单次提示（恢复弹窗资格）
        var hit = false;
        for (var j = 0; j < items.length; j++) {
          var m = items[j];
          if (m.sessionId === sessionId && !m.resolved) { m.resolved = true; m.read = true; m.jumpFailed = false; hit = true; }
        }
        if (hit) { pruneResolved(); applyTitle(); emit(); } // v1.4 #24：跳转成功该会话条目全删（防抖落盘）
        return true;
      }

      /* ══════════════════════════ 横幅（前台） ══════════════════════════ */
      var bannerZone = null;
      var bannerByKey = new Map();   // tagKey -> {el, timer}（同类合并）
      var quietUntil = Object.create(null); // tagKey -> ts（10s 静默窗）
      function ensureBannerZone() {
        if (bannerZone && bannerZone.isConnected) return bannerZone;
        bannerZone = document.createElement('div');
        bannerZone.className = 'dshni-banner-zone';
        bannerZone.setAttribute('data-dshni-banner-zone', '1');
        document.body.appendChild(bannerZone);
        return bannerZone;
      }
      function dismissBannerEl(entry) {
        if (!entry || entry.closing) return;
        entry.closing = true;
        clearTimeout(entry.timer);
        entry.el.classList.add('dshni-banner-out');
        setTimeout(function () { try { entry.el.remove(); } catch (e) {} }, 260);
        for (var k in quietUntil) {} // noop（保留结构清晰）
      }
      function pruneBanners() { // 最多 bannerMax 条，超出挤掉最老
        var arr = Array.from(bannerByKey.values());
        while (arr.length > config.bannerMax) {
          var oldest = arr.shift();
          bannerByKey.delete(oldest.tagKey);
          dismissBannerEl(oldest);
        }
      }
      function bannerActionsHtml(item) {
        if (item.pr !== 1) {
          return '<div class="dshni-b-actions"><button class="dshni-btn" data-act="go">查看</button></div>';
        }
        var approve = item.highRisk
          ? '' // 高危权限不给一键同意（验收项 #7）
          : '<button class="dshni-btn primary" data-act="approve"' +
            ' data-longpress="' + Number(config.longPressMs) + '">同意（长按）</button>';
        return '<div class="dshni-b-actions">' +
          approve +
          '<button class="dshni-btn danger" data-act="reject">拒绝</button>' +
          '<button class="dshni-btn" data-act="go">去处理</button></div>';
      }
      function showBanner(item) {
        if (!config.banner) return; // 返修 #17：横幅同时服务 P1 与 P2 攒批聚合（#18 flush 产物）
        var now = Date.now();
        if (quietUntil[item.tagKey] && now - quietUntil[item.tagKey] < config.bannerQuietMs) return; // 10s 静默窗
        quietUntil[item.tagKey] = now;
        var zone = ensureBannerZone();
        var existing = bannerByKey.get(item.tagKey);
        if (existing) { // 同类合并：刷新文案与计时，不新增
          dismissBannerEl(existing);
        }
        var el = document.createElement('div');
        el.className = 'dshni-banner dshni-pr' + item.pr;
        el.innerHTML =
          '<div class="dshni-b-ico">' + item.ico + '</div>' +
          '<div class="dshni-b-body">' +
            '<div class="dshni-b-title">' + esc(item.title) + '</div>' +
            '<div class="dshni-b-sub">' + esc(item.sessionLabel ? '「' + item.sessionLabel + '」 ' : '') + esc(item.sub || '') + '</div>' +
            (item.highRisk ? '<div class="dshni-b-risk">⚠ 检测到高危操作，请到会话内人工裁决</div>' : '') +
            bannerActionsHtml(item) +
          '</div>' +
          '<button class="dshni-b-close" data-act="close">✕</button>';
        el.addEventListener('click', function (ev) {
          var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
          if (!btn) return;
          ev.stopPropagation();
          var act = btn.getAttribute('data-act');
          if (act === 'close') { bannerByKey.delete(item.tagKey); dismissBannerEl(entry); }
          else if (act === 'go') { bannerByKey.delete(item.tagKey); dismissBannerEl(entry); jumpSessionId(item.sessionId); } // 返修 #19：跳转成功才转已处理
          else if (act === 'reject') { decide(item, 'rejected'); bannerByKey.delete(item.tagKey); dismissBannerEl(entry); }
          else if (act === 'approve') { /* 长按逻辑由 longPressBind 处理 */ }
        });
        // 横幅上的「同意」同样长按防误触
        var apBtn = el.querySelector('[data-act="approve"]');
        if (apBtn) longPressBind(apBtn, function () {
          decide(item, 'allowed-once');
          bannerByKey.delete(item.tagKey);
          dismissBannerEl(entry);
        });
        zone.appendChild(el);
        var entry = { el: el, tagKey: item.tagKey, timer: null, closing: false };
        bannerByKey.set(item.tagKey, entry);
        entry.timer = setTimeout(function () { bannerByKey.delete(item.tagKey); dismissBannerEl(entry); }, item.pr === 1 ? 12000 : 6000);
        pruneBanners();
      }
      function dismissAllBanners() {
        bannerByKey.forEach(function (entry) { dismissBannerEl(entry); });
        bannerByKey.clear();
      }
      function longPressBind(btn, onConfirm) {
        var timer = null, done = false;
        function start(ev) {
          if (timer) return;
          done = false;
          btn.classList.add('dshni-pressing');
          var ms = Number(btn.getAttribute('data-longpress')) || Number(config.longPressMs) || 800;
          timer = setTimeout(function () {
            done = true;
            btn.classList.remove('dshni-pressing');
            timer = null;
            onConfirm();
          }, ms);
        }
        function cancel() {
          if (timer) { clearTimeout(timer); timer = null; }
          btn.classList.remove('dshni-pressing');
        }
        btn.addEventListener('pointerdown', start);
        btn.addEventListener('pointerup', cancel);
        btn.addEventListener('pointerleave', cancel);
        btn.addEventListener('pointercancel', cancel);
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!done) {
            ev.preventDefault();
            try { btn.title = '防误触：长按 ' + config.longPressMs + 'ms 确认'; } catch (e) {}
          }
        });
      }

      /* ══════════════════════════ 会话级单次提示（v1.3 #23） ══════════════════════════ */
      // 用户设计意图「一次对话只提示一条」：同会话 P2 真正「弹给用户」一次后（横幅+声音 /
      // 系统通知），未处理前该会话的后续 P2 只入队 + 角标 +1 + 标题标记，不再弹。
      // 标记时机 = routeFlush 的 visible 非当前分支（showBanner+playSound(2)）与 hidden
      // 分支（showSysNotify）；visible+当前会话分支（只亮角标）不标记。
      // 解除（恢复弹窗资格）仅两路径：jumpSessionId 跳转成功 / currentSession 切到该 sid。
      // P1 通道完全不检查此状态；perSessionNotify=false 恢复旧行为（每次完成都弹）。
      var sessionNotified = new Map(); // sid -> true
      function perSessionOn() { return config.perSessionNotify !== false; }
      function p2Suppressed(sid) {
        return perSessionOn() && !!sid && sessionNotified.get(sid) === true;
      }
      function markSessionNotified(sid) {
        if (sid) sessionNotified.set(sid, true);
      }
      function releaseSessionNotified(sid) {
        if (sid && sessionNotified.delete(sid)) {
          try { console.info('[dsh-notify-inline] #23 会话单次提示解除（恢复弹窗资格）：', sid); } catch (e) {}
        }
      }

      /* ══════════════════════════ P2 攒批（返修 #18） ══════════════════════════ */
      // 同会话 P2 完成事件入队攒批（角标立即亮）：新事件重置计时；静默 doneBatchMs
      // （可配 1~30s，默认 5s）无新事件才 flush 弹一条聚合。P1 不攒批立即弹。
      var doneBatch = new Map(); // sessionId -> { list: [], timer }
      function clampBatchMs() {
        var ms = Number(config.doneBatchMs);
        if (!isFinite(ms)) ms = DEFAULTS.doneBatchMs;
        return Math.min(30000, Math.max(1000, ms));
      }
      function batchDone(item) {
        var sid = item.sessionId || '_';
        var entry = doneBatch.get(sid);
        if (!entry) { entry = { list: [], timer: null }; doneBatch.set(sid, entry); }
        entry.list.push(item);
        if (entry.timer) clearTimeout(entry.timer); // 新事件重置计时
        entry.timer = setTimeout(function () { flushDoneBatch(sid); }, clampBatchMs());
      }
      function flushDoneBatch(sid) {
        var entry = doneBatch.get(sid);
        if (!entry) return;
        doneBatch.delete(sid);
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        if (!entry.list.length) return;
        var first = entry.list[0];
        var n = entry.list.length;
        var latest = entry.list[n - 1];
        var label = first.sessionLabel || labelForSessionId(sid === '_' ? null : sid) || '会话';
        routeFlush({
          pr: 2, kind: 'done', ico: '✅',
          tagKey: first.tagKey || ('done:' + sid),
          sessionId: sid === '_' ? null : sid,
          sessionLabel: first.sessionLabel || '',
          title: label + ' · 回复完成',
          sub: n > 1 ? (n + ' 条新动态 · 最新：' + (latest.sub || '')) : (first.sub || '')
        });
      }
      // 攒批 flush 的统一出栈通道（横幅 + 系统通知都走这里，#17）。
      // v1.3 #23：会话已弹过未处理（sessionNotified）→ 抑制横幅/系统通知/声音，
      // 只保留入队+角标+标题标记；真正弹出的那一刻才标记该会话。
      function routeFlush(d) {
        if (document.hidden) {
          if (!p2Suppressed(d.sessionId)) {
            showSysNotify(d);
            markSessionNotified(d.sessionId); // #23：系统通知发出即标记（弹给用户）
          }
          applyTitle(); // 抑制分支也走标题标记（未处理 ✅/🔔 前缀照常）
        } else {
          var isCurrent = d.sessionId && d.sessionId === currentSessionId();
          if (!isCurrent) {
            if (!p2Suppressed(d.sessionId)) {
              showBanner(d);
              playSound(2);
              markSessionNotified(d.sessionId); // #23：横幅+声音弹出即标记（弹给用户）
            }
          } // visible+当前会话分支只亮角标 → 不标记（#23）
          ringBell();
          applyTitle();
        }
      }
      function clearDoneBatches() {
        doneBatch.forEach(function (entry) { if (entry.timer) clearTimeout(entry.timer); });
        doneBatch.clear();
      }

      /* ══════════════════════════ P2 真完成确认闸（v1.2 #22） ══════════════════════════ */
      // 三源（completionUnread / face 下降沿 / list completed 边）不再直接 reportDone，先登记
      // 待确认：idle 持续 ≥ doneConfirmMs（默认 10s，可配 3~60s）才判定完成触发 P2；窗口内
      // 回 running / 出现 pending / 重跑 / 用户打开会话（completionUnread 回落）即取消。
      // P1 通道不经过此闸（evalUiStatus→pushItem 直达，零去抖）。过闸后仍走 doneBatchMs
      // 攒批（#18 双保险）。同 sid 多源登记共享一个 entry，重复登记=重置计时，不重复报。
      var doneConfirm = new Map(); // sid -> { timer, snippet, face }
      function clampConfirmMs() {
        var ms = Number(config.doneConfirmMs);
        if (!isFinite(ms)) ms = DEFAULTS.doneConfirmMs;
        return Math.min(60000, Math.max(3000, ms));
      }
      function cancelDoneConfirm(sid) {
        var entry = doneConfirm.get(sid);
        if (entry) { if (entry.timer) clearTimeout(entry.timer); doneConfirm.delete(sid); }
      }
      function cancelAllDoneConfirms() {
        doneConfirm.forEach(function (entry) { if (entry.timer) clearTimeout(entry.timer); });
        doneConfirm.clear();
      }
      function requestDoneConfirm(sid, snippet, opts) {
        opts = opts || {};
        var prev = doneConfirm.get(sid);
        if (prev && prev.timer) clearTimeout(prev.timer); // 重启计时（新证据刷新窗口）
        var entry = {
          snippet: snippet || (prev && prev.snippet) || '',
          face: !!opts.face || !!(prev && prev.face),
          timer: setTimeout(function () {
            doneConfirm.delete(sid);
            reportDone(sid, entry.snippet, { face: entry.face }); // 过闸：仍走 #18 攒批
          }, clampConfirmMs())
        };
        doneConfirm.set(sid, entry);
      }

      /* ══════════════════════════ 事件入队与路由 ══════════════════════════ */
      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
      }
      // pushItem：所有事件无条件入 items（不丢），再路由（验收项 #4；P2 攒批 #18）
      function pushItem(o) {
        var item = {
          id: uid(), pr: o.pr, kind: o.kind, ico: o.ico, tagKey: o.tagKey,
          title: o.title, sub: o.sub || '', sessionId: o.sessionId || null,
          sessionLabel: o.sessionLabel || '', at: Date.now(),
          read: false, resolved: false, // 返修 #19：P1 待裁决 / P2 待查看，裁决或跳转成功才转已处理
          key: o.key || null, interaction: o.interaction || null,
          highRisk: !!o.highRisk, mock: !!o.mock
        };
        items.unshift(item);
        if (items.length > 200) items.length = 200; // 历史上限，防泄漏
        schedulePersist(); // v1.2 #21：防抖落盘（恢复条目已含在 items 口径内）
        if (o.pr === 2 && Number(config.doneBatchMs) > 0) {
          batchDone(item);  // 攒批：角标立即亮（emit），静默到期 flush 聚合（#18）
          applyTitle();
        } else {
          route(item);      // P1 立即弹（不攒批）；doneBatchMs=0 关闭攒批时 P2 走原路由
        }
        emit();
        return item;
      }
      // 双通道路由核心：hidden → 系统通知+标题标记；visible → P1 非当前会话横幅+重音。
      // P2 前台不再单独直弹/发声（返修 #18：统一由攒批 flush 的 routeFlush 出栈）。
      // v1.3 #23：doneBatchMs=0 时 P2 直走本函数，hidden 的系统通知同样受会话级
      // 单次提示抑制（与 routeFlush 共用同一状态，规则一致）；P1 分支零改动。
      function route(item) {
        if (!config.enabled) return;
        var hidden = document.hidden;
        if (hidden) {
          var p2Blocked = item.pr === 2 && p2Suppressed(item.sessionId); // #23：仅 P2 检查
          if (!p2Blocked) {
            showSysNotify(item);    // 系统通知仅 hidden 时发（showSysNotify 内再判一次）
            if (item.pr === 2) markSessionNotified(item.sessionId); // #23：P2 弹出即标记
          }
          applyTitle();             // hidden 时标题标记 🔔/✅（抑制分支照常）
        } else {
          var isCurrent = item.sessionId && item.sessionId === currentSessionId();
          if (item.pr === 1 && !isCurrent) {
            showBanner(item);       // 前台 + 非当前会话 → 横幅（含裁决按钮）——P1 不查 #23
            playSound(1);
          }
          // 当前会话事件：只亮角标 + 铃铛摇摆（免得盖住你正看的审批卡片），不弹横幅
          ringBell();
          // 前台不写标题标记
          applyTitle();
        }
      }
      // 返修 #19：移除 markRead/markAllRead（「打开面板即全已读」废弃）——已处理仅两条
      // 路径：P1 裁决（decide）/ 跳转成功（jumpSessionId）。read 只作面板视觉态。
      function markAllResolved() { // 面板手动「全部已读」兜底：显式点击才全部 resolve
        items.forEach(function (n) {
          if (!n.resolved) { n.resolved = true; n.jumpFailed = false; }
          n.read = true;
        });
        pruneResolved(); // v1.4 #24：全部已读=全部移除
        dismissAllBanners();
        clearDoneBatches();
        applyTitle(); emit();
      }
      function clearAll() {
        items = [];
        dismissAllBanners();
        clearDoneBatches();
        cancelAllDoneConfirms(); // v1.2 #22：清待确认计时器
        attentionKeysFired = Object.create(null);
        persistNow(); // v1.2 #21：清空立即落盘（不走防抖，防旧数据残留）
        applyTitle(); emit();
      }
      // 页内裁决（验收项 #7）：P1 裁决走 interaction.answer；无 interaction（纯 kind 字符串/mock）只能去处理
      function decide(item, outcome) {
        if (item.resolved) return;
        var it = item.interaction;
        var ok = false;
        if (it && typeof it === 'object' && typeof it.answer === 'function' && item.key && it.key === item.key) {
          try { var p = it.answer(outcome); if (p && typeof p.catch === 'function') p.catch(function () {}); ok = true; } catch (e) {}
        } else if (it && typeof it === 'object' && typeof it.answer === 'function') {
          try { var p2 = it.answer(outcome); if (p2 && typeof p2.catch === 'function') p2.catch(function () {}); ok = true; } catch (e) {}
        }
        if (ok || item.mock) {
          item.resolved = true;
          item.read = true;
          item.jumpFailed = false; // 返修 #19：裁决即已处理，清跳转失败标记
          pruneResolved(); // v1.4 #24：裁决即从面板消失（内部防抖落盘）
          applyTitle(); emit();
          try { console.log('[dsh-notify-inline] 裁决', outcome, item.key, ok ? '(interaction.answer)' : '(mock)'); } catch (e) {}
        }
      }

      /* ══════════════════════════ P1 watcher（uiSession 双读法） ══════════════════════════ */
      var uiSub = null, uiStore = null, uiSource = null;
      var uiBaseline = Object.create(null); // sid -> { key }
      function bindUiSession() {
        var svc = lookupService('uiSession');
        var found = interactionStore(svc);
        if (!found) return;
        var store = found.store;
        if (uiSub && uiStore === store) return;
        if (uiSub) { try { uiSub(); } catch (e) {} uiSub = null; }
        uiStore = store;
        uiSource = found.source;
        uiSub = store.subscribe(function () { try { evalUiStatus(); } catch (e) {} });
        hostGen.source = uiSource === 'sessionStatus' ? '0.1.6+ (sessionStatus)' : '0.1.2..0.1.5 (pendingInteractions)';
        evalUiStatus(); // 种子扫描：插件装载前已存在的等待也报一次
      }
      function detachUiSession() {
        if (uiSub) { try { uiSub(); } catch (e) {} uiSub = null; }
        uiStore = null; uiSource = null;
      }
      function evalUiStatus() {
        var found = interactionStore(lookupService('uiSession'));
        if (!found || typeof found.store.getSnapshot !== 'function') return;
        var snap = found.store.getSnapshot();
        if (!snap || typeof snap.forEach !== 'function') return;
        if (found.source === 'sessionStatus') syncDoneFromStatus(snap); // 0.1.6+ 完成主通道
        var seen = Object.create(null);
        snap.forEach(function (value, sid) {
          var it = pendingOf(value, found.source);
          if (!it) return;                      // 无等待：不计 seen（让 teardown 释放标记）
          seen[sid] = true;
          var kind = typeof it === 'string' ? it : (it.kind || 'approval');
          if (!KIND_META[kind]) kind = 'approval';
          var key = (typeof it === 'object' && it.key) ? it.key : (kind + ':' + sid);
          var prev = uiBaseline[sid];
          if (prev && prev.key === key) return; // 已入队的等待：不重报
          uiBaseline[sid] = { key: key };
          if (attentionKeysFired[key]) return;  // 已报过：不重（换 key 的新等待会走到这之上）
          attentionKeysFired[key] = true;
          var meta = KIND_META[kind];
          var detail = textFromInteraction(it);
          pushItem({
            pr: meta.pr, kind: kind, ico: meta.ico,
            tagKey: kind + ':' + sid,
            title: meta.label + '等待处理',
            sub: detail,
            sessionId: sid, sessionLabel: labelForSessionId(sid),
            key: key, interaction: typeof it === 'object' ? it : null,
            highRisk: kind === 'approval' && isHighRisk(it)
          });
        });
        for (var sid2 in uiBaseline) {          // teardown：等待消失（已答/已取消/会话没了）
          if (seen[sid2]) continue;
          resolveItemByKey(uiBaseline[sid2].key);
          delete uiBaseline[sid2];
        }
      }
      function resolveItemByKey(key) {
        for (var i = 0; i < items.length; i++) {
          var n = items[i];
          if (n.pr === 1 && n.key === key && !n.resolved) n.resolved = true; // 标记后统一走 pruneResolved 删除
        }
        if (pruneResolved()) emit(); // v1.4 #24：interaction 消费同步=已处理即消失
      }

      /* ══════════════════════════ P2 完成检测（三源合并） ══════════════════════════ */
      // 源 1（0.1.6+ 主通道）：sessionStatus.completionUnread（后台会话完成未读；
      // host 在会话被打开/重跑/消失时清除）。当前会话 host 不置位 → 天然只走 face edge。
      var uiDoneBaseline = Object.create(null);
      function syncDoneFromStatus(snap) {
        try {
          snap.forEach(function (value, sid) {
            if (!value || !value.completionUnread) { cancelDoneConfirm(sid); return; } // v1.2 #22：清零=用户已处理，取消待确认
            if (value.pendingInteraction) { cancelDoneConfirm(sid); return; }          // 停在等输入是 wait 不是完成（#22 取消）
            if (currentSessionId() === sid) return;            // 在屏会话不算 unread
            var cur = currentSessionId();
            markDoneUnreadLocal(sid);
            var prevDone = uiDoneBaseline[sid];
            if (typeof prevDone === 'number' && value.completionUnread <= prevDone) {
              if (value.completionUnread < prevDone) {
                uiDoneBaseline[sid] = value.completionUnread; // 宿主清零/回落 → 重置基线，下次上涨照报
                cancelDoneConfirm(sid); // v1.2 #22：unread 回落（用户打开处理）→ 取消待确认
              }
              return;                                            // 无新增完成
            }
            uiDoneBaseline[sid] = value.completionUnread;        // 数字基线：跟踪 completionUnread 增长（宿主清零后可再报）
            requestDoneConfirm(sid, ''); // v1.2 #22：登记待确认（持续 idle 过闸才报；继续上涨会重置计时）
          });
        } catch (e) {}
      }
      function markDoneUnreadLocal(sid) { /* 占位：V1 完成未读标记由标题通道派生（hasUnread(2)） */ }
      // 源 2（当前会话 face edge）：binding(sid).session 的 running true→false 且无 pending
      var faceSub = null, faceId = null;
      var prevFace = null; // { running }
      function bindCurrentFace() {
        if (!listStore || !rootCtx || !rootCtx.sessions) return;
        try {
          var cur = currentSessionId();
          if (!cur) { detachFace(); return; }
          if (cur === faceId && faceSub) return;
          detachFace();
          var b = rootCtx.sessions.binding(cur);
          if (!b || !b.session || typeof b.session.subscribe !== 'function') return; // binding 未就绪，重试定时器再来
          faceId = cur;
          prevFace = null;
          faceSub = b.session.subscribe(function () {
            try { evalFace(cur, b.session.getSnapshot()); } catch (e) {}
          });
          try { evalFace(cur, b.session.getSnapshot()); } catch (e) {}
        } catch (e) {}
      }
      function detachFace() {
        if (faceSub) { try { faceSub(); } catch (e) {} faceSub = null; }
        faceId = null; prevFace = null;
      }
      function evalFace(sid, snap) {
        if (sid !== faceId || !snap) return;
        var runningNow = !!snap.running;
        var hasPending = !!snap.pending && snap.pending.length > 0;
        if (runningNow || hasPending) cancelDoneConfirm(sid); // v1.2 #22：回 running/等输入 → 取消待确认
        if (prevFace && prevFace.running && !runningNow && !hasPending) {
          // 当前会话 idle → 登记确认（v1.2 #22：持续 ≥ doneConfirmMs 才 reportDone；验收项 #8 只亮角标规则不变）
          requestDoneConfirm(sid, snippetOfSnap(snap), { face: true });
        }
        prevFace = { running: runningNow };
      }
      function snippetOfSnap(snap) {
        try {
          var nodes = snap.nodes || [];
          for (var i = nodes.length - 1; i >= 0; i--) {
            var nd = nodes[i];
            if (nd && nd.kind === 'assistant' && nd.blocks) {
              for (var b = nd.blocks.length - 1; b >= 0; b--) {
                if (nd.blocks[b] && nd.blocks[b].kind === 'text' && nd.blocks[b].text) {
                  var t = nd.blocks[b].text.replace(/\s+/g, ' ').trim();
                  if (t) return t.length > 80 ? t.slice(0, 80) + '…' : t;
                }
              }
            }
          }
        } catch (e) {}
        return '';
      }
      // 源 3（列表行 completed 边，老宿主；0.1.6+ 由 completionUnread 主导，此处去重兜底）
      var prevCompleted = Object.create(null);
      function evalListRows() {
        if (!listStore) return;
        try {
          var st = listStore.getSnapshot();
          var byId = (st && st.byId) || {};
          var cur = currentSessionId();
          for (var sid in byId) {
            if (sid === cur) continue;
            var sum = byId[sid];
            if (!sum) continue;
            var completed = !!sum.completed;
            var was = prevCompleted[sid];
            if (completed && was === false && statusDoneSource() !== true) {
              requestDoneConfirm(sid, ''); // v1.2 #22：登记待确认（过闸才报）
            } else if (!completed && was === true) {
              cancelDoneConfirm(sid); // v1.2 #22：重跑（completed 回落）→ 取消
            }
            prevCompleted[sid] = completed;
          }
        } catch (e) {}
      }
      function statusDoneSource() { return !!(uiSub && uiSource === 'sessionStatus'); }
      function reportDone(sid, snippet, opts) {
        opts = opts || {};
        var now = Date.now();
        if (doneFiredAt[sid] && now - doneFiredAt[sid] < DONE_DEDUPE_MS) return; // 去重窗：edge 与 completionUnread 双视图合一
        doneFiredAt[sid] = now;
        var meta = KIND_META.done;
        var isCurrent = sid === currentSessionId() || opts.face === true;
        pushItem({
          pr: 2, kind: 'done', ico: meta.ico,
          tagKey: 'done:' + sid,
          title: isCurrent ? '回复完成' : '后台会话完成',
          sub: snippet || '',
          sessionId: sid, sessionLabel: labelForSessionId(sid),
          key: 'done:' + sid + ':' + now
        });
      }

      /* ══════════════════════════ 可见性切换 ══════════════════════════ */
      function onVisibility() {
        if (!document.hidden) {
          // 回前台：标题标记清除（applyTitle 里 hidden 才写）；未处理项全部在面板（items 常驻）
          applyTitle();
          emit(); // 角标/面板刷新
        } else {
          applyTitle(); // 切后台：若有未读立即标标题
        }
      }

      /* ══════════════════════════ UI（纯 DOM，原型同款） ══════════════════════════ */
      var bellWrap = null, bellBtn = null, badgeEl = null, panelEl = null;
      var panelOpen = false;
      var fallbackBtn = null;
      function injectStyles() {
        if (document.querySelector('style[data-dshni-css]')) return;
        var st = document.createElement('style');
        st.setAttribute('data-dshni-css', '1');
        st.textContent = [
          // ── v1.5：宿主令牌实采（原型 dsh-notify-inline-visual-v15.html，2026-10-19 实采）。
          // 第一层 --dsw-static-* 原子色（77，不随主题）；第二层 --dsw-alias-* 语义令牌亮/暗两套
          // （亮挂默认+:root，暗挂 [data-dshni-theme="dark"]，与宿主 body/body[data-ds-dark-theme] 同构）；
          // 第三层 --dshni-* 组件语义映射全部引用 alias——组件样式零硬编码主题色（#27）。
          // 切换：<html data-dshni-theme="light|dark">（resolveTheme 维护，信号=body[data-ds-dark-theme] 优先）。
          ':root{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#7aaaff;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-500-a08:#22c55e14;--dsw-static-green-500-a12:#22c55e1f;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f9fafb;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-400-a12:#f25a5a1f;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-600-a08:#ec131314;--dsw-static-red-900:#570c0c}',
          ':root{--dsw-alias-settings-card-fill:var(--dsw-alias-bg-layer-2);--dsw-alias-settings-card-stroke:var(--dsw-alias-border-l4);--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-document-preview:var(--dsw-static-neutral-bluish-100);--dsw-alias-bg-document-selection:color-mix(in srgb,var(--dsw-static-blue-500) 40%,transparent);--dsw-alias-label-document-preview:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-mask-1:#0000003d;--dsw-alias-bg-mask-2:#0000001f;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#ffffffb3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-150);--dsw-alias-bg-skeleton:#0000000a;--dsw-alias-border-inverted2:#0000;--dsw-alias-border-inverted:#0000;--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2-darkmode-thin:#0000001a;--dsw-alias-border-l2:#0000001a;--dsw-alias-border-l3:#0000001f;--dsw-alias-border-l4:#00000029;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-primary-new-colorprimary-new-color:#4176e6;--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-1000);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-75);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-500);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-150);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-500);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-400);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#2631481a;--dsw-alias-interactive-bg-hover-accent:#26314824;--dsw-alias-interactive-bg-hover-danger:#ec13130d;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-75);--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-deep-diving:color-mix(in srgb,var(--dsw-static-deepseek-500) 70%,var(--dsw-static-blue-950));--dsw-alias-label-deep-diving-shimmer:color-mix(in srgb,var(--dsw-static-deepseek-500) 30%,var(--dsw-static-blue-950));--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-200);--dsw-alias-label-primary-bluish:var(--dsw-static-blue-900);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-shimmer:color-mix(in srgb,var(--dsw-static-neutral-1000) 30%,transparent);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);--dsw-alias-menu-icon:var(--dsw-static-neutral-bluish-800);--dsw-alias-link:var(--dsw-static-deepseek-500);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-100);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-00);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-75);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-50);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-60);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-75);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-300);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-300);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-500);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-100);--dsw-alias-code-diff-added:var(--dsw-static-green-500-a08);--dsw-alias-code-diff-deleted:var(--dsw-static-red-600-a08);--dsw-alias-file-diff-added-bg:#e6f4e7;--dsw-alias-file-diff-added-gutter:#edf7ed;--dsw-alias-file-diff-added-marker:#01a241;--dsw-alias-file-diff-deleted-bg:#fce6e2;--dsw-alias-file-diff-deleted-gutter:#fdece9;--dsw-alias-file-diff-deleted-marker:#ba2723;--dsw-alias-state-error-primary:var(--dsw-static-red-600);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-idle-primary:var(--dsw-static-neutral-300);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-100);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-100);--dsw-alias-switch-thumb:var(--dsw-static-neutral-bluish-00);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-800);--dsw-alias-toast-label:var(--dsw-static-neutral-bluish-00);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-850);--dsw-alias-tooltip-key-bg:color-mix(in srgb,var(--dsw-alias-tooltip-bg),white 18%);--dsw-alias-turn-trigger-bg:var(--dsw-alias-markdown-code-block);--dsw-alias-turn-trigger-bg-hover:var(--dsw-alias-interactive-bg-hover);--dsw-alias-menu-group-header-fill:#f8f9faf0;--dsw-alias-onboarding-accent:#3964fe;--dsw-alias-onboarding-card-fill:color-mix(in srgb,var(--dsw-static-neutral-bluish-00) 80%,transparent);--dsw-alias-onboarding-secondary-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-onboarding-checkbox-border:color-mix(in srgb,var(--dsw-static-neutral-bluish-1000) 20%,transparent)}',
          '[data-dshni-theme="dark"]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-document-preview:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-document-selection:color-mix(in srgb,var(--dsw-static-blue-500) 40%,transparent);--dsw-alias-label-document-preview:var(--dsw-static-neutral-bluish-300);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-850);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-mask-1:#00000080;--dsw-alias-bg-mask-2:#0003;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#272730b3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-850);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-skeleton:#ffffff14;--dsw-alias-border-inverted2:#ffffff14;--dsw-alias-border-inverted:#ffffff0f;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2-darkmode-thin:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-border-l4:#fff3;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-primary-new-colorprimary-new-color:var(--dsw-static-deepseek-450);--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-850);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-800);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-600);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-400);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-500);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#ffffff24;--dsw-alias-interactive-bg-hover-accent:#ffffff3d;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-800);--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-deep-diving:color-mix(in srgb,var(--dsw-static-deepseek-450) 55%,var(--dsw-static-neutral-bluish-400));--dsw-alias-label-deep-diving-shimmer:color-mix(in srgb,var(--dsw-static-blue-300) 65%,var(--dsw-static-deepseek-400));--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-shimmer:color-mix(in srgb,var(--dsw-static-neutral-00) 45%,transparent);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-menu-icon:var(--dsw-alias-label-primary-dimmed);--dsw-alias-link:var(--dsw-static-deepseek-400);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-800);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-850);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-700);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-550);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-400);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-code-diff-added:var(--dsw-static-green-500-a12);--dsw-alias-code-diff-deleted:var(--dsw-static-red-400-a12);--dsw-alias-file-diff-added-bg:#1f3124;--dsw-alias-file-diff-added-gutter:#132016;--dsw-alias-file-diff-added-marker:#41c977;--dsw-alias-file-diff-deleted-bg:#3c1f1b;--dsw-alias-file-diff-deleted-gutter:#28130e;--dsw-alias-file-diff-deleted-marker:#fa423e;--dsw-alias-state-error-primary:var(--dsw-static-red-400);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-idle-primary:var(--dsw-static-neutral-600);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-900);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-900);--dsw-alias-switch-thumb:var(--dsw-static-neutral-bluish-400);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-toast-label:var(--dsw-static-neutral-bluish-00);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-tooltip-key-bg:color-mix(in srgb,var(--dsw-alias-tooltip-bg),white 18%);--dsw-alias-turn-trigger-bg:var(--dsw-alias-interactive-bg-hover);--dsw-alias-turn-trigger-bg-hover:var(--dsw-alias-interactive-bg-active);--dsw-alias-menu-group-header-fill:#303136f0}',
          ':root{--dshni-bg2:var(--dsw-alias-bg-layer-2);--dshni-bg3:var(--dsw-alias-bg-layer-3);--dshni-border:var(--dsw-alias-border-l2);--dshni-border2:var(--dsw-alias-border-l1);--dshni-text:var(--dsw-alias-label-primary);--dshni-text2:var(--dsw-alias-label-secondary);--dshni-text3:var(--dsw-alias-label-tertiary);--dshni-accent:var(--dsw-alias-link);--dshni-accentbg:var(--dsw-alias-interactive-bg-hover);--dshni-hover:var(--dsw-alias-interactive-bg-hover);--dshni-active:var(--dsw-alias-interactive-bg-active);--dshni-unreadbg:var(--dsw-alias-interactive-bg-hover);--dshni-p1:var(--dsw-alias-state-error-primary);--dshni-p1bg:var(--dsw-alias-interactive-bg-hover-danger);--dshni-p1border:var(--dsw-alias-state-error-secondary);--dshni-p2:var(--dsw-alias-state-success-primary);--dshni-p2bg:var(--dsw-alias-code-diff-added);--dshni-p2border:var(--dsw-alias-state-success-secondary);--dshni-badge:var(--dsw-alias-state-error-primary);--dshni-sess:var(--dsw-alias-label-primary);--dshni-btn-primary:var(--dsw-alias-button-primary-fill);--dshni-btn-primary-h:var(--dsw-alias-button-primary-hover);--dshni-btn-primary-fg:var(--dsw-alias-label-primary-foreground);--dshni-btn-danger:var(--dsw-alias-state-error-primary);--dshni-btn-danger-h:var(--dsw-alias-state-error-secondary);--dshni-pressfill:color-mix(in srgb,var(--dsw-alias-label-primary-foreground) 25%,transparent);--dshni-focus:var(--dsw-alias-state-business-primary);--dshni-toast:var(--dsw-alias-toast-bg);--dshni-toastfg:var(--dsw-alias-toast-label);--dshni-scrollbar:var(--dsw-alias-scrollbar-bg-l1);--dshni-scrollbar-h:var(--dsw-alias-scrollbar-hover-l1);--dshni-shadow:0 12px 40px rgba(0,0,0,.15),0 2px 8px rgba(0,0,0,.06);--dshni-shadow2:0 12px 40px rgba(0,0,0,.3)}',
          '.dshni-bell-wrap{position:relative;display:flex}',
          // v1.5：宿主 icon 按钮规格 28×28/r8/透明底，hover/active 走 interactive 令牌
          '.dshni-bell{width:28px;height:28px;box-sizing:border-box;border-radius:8px;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;transition:background .15s ease-out;font:inherit;padding:0;color:var(--dshni-text)}',
          '.dshni-bell:hover{background:var(--dshni-hover)}',
          '.dshni-bell:active{background:var(--dshni-active)}',
          '.dshni-bell:focus-visible{outline:2px solid var(--dshni-focus);outline-offset:2px}',
          '.dshni-bell svg{width:16px;height:16px;display:block;fill:var(--dshni-text2);transition:fill .15s ease-out}',
          '.dshni-bell:hover svg{fill:var(--dshni-text)}',
          '.dshni-bell.dshni-ringing{animation:dshni-ring .5s ease}',
          '@keyframes dshni-ring{0%,100%{transform:rotate(0)}20%{transform:rotate(12deg)}40%{transform:rotate(-10deg)}60%{transform:rotate(8deg)}80%{transform:rotate(-6deg)}}',
          '.dshni-badge{position:absolute;top:-5px;right:-6px;min-width:16px;height:16px;border-radius:8px;background:var(--dshni-badge);color:#fff;font-size:10px;font-weight:600;line-height:16px;text-align:center;display:flex;align-items:center;justify-content:center;padding:0 4px;box-shadow:0 0 0 2px var(--dsw-alias-bg-base);opacity:0;transform:scale(.5);transition:opacity .2s ease-out,transform .2s ease-out;pointer-events:none;z-index:2}',
          '.dshni-badge.dshni-show{opacity:1;transform:scale(1)}',
          '.dshni-badge.dshni-pulse{animation:dshni-pulse .6s ease}',
          '.dshni-badge.dshni-pop{animation:dshni-pop .15s ease-out}',
          '@keyframes dshni-pulse{0%{transform:scale(1)}50%{transform:scale(1.35)}100%{transform:scale(1)}}',
          '@keyframes dshni-pop{0%{transform:scale(.4)}70%{transform:scale(1.15)}100%{transform:scale(1)}}',
          '.dshni-panel{position:fixed;width:400px;max-width:94vw;max-height:520px;background:var(--dshni-bg2);border:1px solid var(--dshni-border2);border-radius:12px;box-shadow:var(--dshni-shadow);z-index:2147483000;display:none;overflow:hidden;flex-direction:column;color:var(--dshni-text);font-size:14px;font-family:"Segoe UI","Microsoft YaHei",sans-serif}',
          '.dshni-panel.dshni-open{display:flex}',
          '.dshni-panel.dshni-enter{animation:dshni-panel-in .2s cubic-bezier(0,0,.2,1);transform-origin:top right}',
          '@keyframes dshni-panel-in{from{opacity:0;transform:scale(.96) translateY(-4px)}to{opacity:1;transform:none}}',
          '.dshni-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px 10px}',
          '.dshni-panel-head h3{font-size:14px;font-weight:600;margin:0}',
          '.dshni-panel-head .dshni-cnt{font-size:12px;color:var(--dshni-text3)}',
          '.dshni-panel-head .dshni-pending{font-size:12px;color:var(--dshni-p1)}',
          '.dshni-panel-head button{height:24px;margin-left:auto;background:none;border:none;border-radius:6px;color:var(--dshni-text3);font-size:12px;cursor:pointer;padding:0 8px;white-space:nowrap;display:flex;align-items:center;justify-content:center;transition:background .15s ease-out,color .15s ease-out}',
          '.dshni-panel-head button:hover{background:var(--dshni-hover);color:var(--dshni-text)}',
          '.dshni-panel-head button:focus-visible{outline:2px solid var(--dshni-focus);outline-offset:2px}',
          '.dshni-panel-list{overflow-y:auto;flex:1;padding:8px}',
          '.dshni-panel-list::-webkit-scrollbar{width:8px}',
          '.dshni-panel-list::-webkit-scrollbar-thumb{background:var(--dshni-scrollbar);border-radius:4px}',
          '.dshni-panel-list::-webkit-scrollbar-thumb:hover{background:var(--dshni-scrollbar-h)}',
          '.dshni-item{display:flex;gap:10px;padding:10px 12px;border-radius:12px;cursor:pointer;position:relative;transition:background .15s ease-out;margin-bottom:2px}',
          '.dshni-item:hover{background:var(--dshni-hover)}',
          '.dshni-item.dshni-unread{background:var(--dshni-unreadbg)}',
          // v1.5：prio 竖条常驻（原型 6px 圆角条简化为 4px 左缘条），P1 红 / P2 绿
          '.dshni-item::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:4px;border-radius:2px;background:transparent}',
          '.dshni-item.dshni-pr1::before{background:var(--dshni-p1)}',
          '.dshni-item.dshni-pr2::before{background:var(--dshni-p2)}',
          '.dshni-ico{width:32px;height:32px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;font-size:15px}',
          '.dshni-pr1 .dshni-ico{background:var(--dshni-p1bg);color:var(--dshni-p1)}',
          '.dshni-pr2 .dshni-ico{background:var(--dshni-p2bg);color:var(--dshni-p2)}',
          '.dshni-body{flex:1;min-width:0}',
          '.dshni-title{font-size:14px;font-weight:500;display:flex;align-items:center;gap:6px}',
          '.dshni-tag{font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600}',
          // v1.4 #24：.dshni-tag-done 灰标签样式已随功能移除（已处理条目直接消失，无历史保留）
          '.dshni-pr1 .dshni-tag{background:var(--dshni-p1bg);color:var(--dshni-p1)}',
          '.dshni-pr2 .dshni-tag{background:var(--dshni-p2bg);color:var(--dshni-p2)}',
          '.dshni-meta{font-size:12px;color:var(--dshni-text2);margin-top:3px;display:flex;gap:8px;align-items:center}',
          '.dshni-sess{color:var(--dshni-sess);font-weight:500}',
          // 返修 #19：跳转失败提示（条目保持未处理）
          '.dshni-jumpfail{font-size:11px;color:var(--dshni-btn-danger);margin-top:3px}',
          '.dshni-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}',
          '.dshni-btn{height:28px;padding:0 12px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid var(--dshni-border);background:transparent;color:var(--dshni-text2);position:relative;overflow:hidden;user-select:none;-webkit-user-select:none;transition:background .15s ease-out,color .15s ease-out,border-color .15s ease-out}',
          '.dshni-btn:hover{background:var(--dshni-hover);color:var(--dshni-text)}',
          '.dshni-btn:focus-visible{outline:2px solid var(--dshni-focus);outline-offset:2px}',
          // v1.5：主按钮=宿主 brand 黑白款（button-primary-fill+label-primary-foreground）
          '.dshni-btn.primary{background:var(--dshni-btn-primary);border-color:transparent;color:var(--dshni-btn-primary-fg)}',
          '.dshni-btn.primary:hover{background:var(--dshni-btn-primary-h)}',
          '.dshni-btn.primary:active{transform:scale(.97)}',
          '.dshni-btn.danger{background:var(--dshni-btn-danger);border-color:transparent;color:#fff}',
          '.dshni-btn.danger:hover{background:var(--dshni-btn-danger-h)}',
          '.dshni-btn.dshni-resolved{opacity:.55;pointer-events:none}',
          // 长按进度：pressing 时伪元素 800ms 线性铺满（v1.5：fill=label-primary-foreground 25%，原型同款）
          '.dshni-btn.dshni-pressing::after{content:"";position:absolute;left:0;top:0;bottom:0;background:var(--dshni-pressfill);animation:dshni-fill linear forwards;animation-duration:inherit}',
          '@keyframes dshni-fill{from{width:0}to{width:100%}}',
          // v1.5 #25 规格对齐：P2 聚合行=原型 ni-agg 36px 单行（✓ + 会话 · N 条新动态 + 查看），不展开明细；
          // 跳转失败组加 .dshni-group-fail 展开红字（v1.4 #24 需求保留）
          '.dshni-group{height:36px;padding:0 12px;align-items:center;gap:10px}',
          '.dshni-group::before{display:none}',
          '.dshni-group .dshni-ico{width:auto;height:auto;background:none;font-size:14px}',
          '.dshni-group .dshni-body{display:flex;align-items:center;gap:8px}',
          '.dshni-group .dshni-title{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}',
          '.dshni-group .dshni-meta,.dshni-group .dshni-jumpfail{display:none}',
          '.dshni-group .dshni-actions{margin:0;flex:none}',
          '.dshni-group .dshni-btn{height:24px;padding:0 8px;border:0;background:none;color:var(--dshni-accent);font-size:13px}',
          '.dshni-group .dshni-btn:hover{background:none;color:var(--dshni-accent);text-decoration:underline}',
          '.dshni-group.dshni-group-fail{height:auto;padding:8px 12px}',
          '.dshni-group.dshni-group-fail .dshni-body{flex-wrap:wrap}',
          '.dshni-group.dshni-group-fail .dshni-meta{display:flex}',
          '.dshni-group.dshni-group-fail .dshni-jumpfail{display:block;width:100%}',
          '.dshni-time{font-size:12px;color:var(--dshni-text3);flex:none}',
          '.dshni-empty{text-align:center;padding:28px 0;color:var(--dshni-text3);font-size:13px}',
          '.dshni-foot{padding:8px 14px;border-top:1px solid var(--dshni-border2);font-size:12px;color:var(--dshni-text3);display:flex;justify-content:space-between;gap:8px}',
          '.dshni-foot .dshni-settings-toggle{cursor:pointer;color:var(--dshni-accent)}',
          '.dshni-drawer{display:none;padding:10px 14px;border-top:1px solid var(--dshni-border2);font-size:12px}',
          '.dshni-drawer.dshni-open{display:block}',
          '.dshni-drawer label{display:flex;align-items:center;gap:6px;margin:4px 0;color:var(--dshni-text2);cursor:pointer}',
          '.dshni-drawer input[type="checkbox"]{accent-color:var(--dshni-focus)}',
          // 返修 #14：主题三态 select + 返修 #18：攒批秒数 number
          '.dshni-drawer select,.dshni-drawer input[type="number"]{background:var(--dshni-bg3);color:var(--dshni-text);border:1px solid var(--dshni-border);border-radius:8px;padding:2px 6px;font-size:12px}',
          '.dshni-drawer input[type="number"]{width:46px}',
          '.dshni-drawer .dshni-drawer-row{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}',
          '.dshni-drawer .dshni-test{font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--dshni-border);background:transparent;color:var(--dshni-text2);cursor:pointer;transition:background .15s ease-out}',
          '.dshni-drawer .dshni-test:hover{background:var(--dshni-hover)}',
          '.dshni-drawer .dshni-test.p1{border-color:var(--dshni-p1border);color:var(--dshni-p1)}',
          '.dshni-drawer .dshni-test.p2{border-color:var(--dshni-p2border);color:var(--dshni-p2)}',
          // v1.5：横幅=宿主 toast 令牌（深底白字双主题一致）、右下 20px、240ms 右滑入（原型 ni-banner）
          '.dshni-banner-zone{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;width:360px;max-width:92vw}',
          '.dshni-banner{display:flex;gap:12px;align-items:flex-start;background:var(--dshni-toast);color:var(--dshni-toastfg);border:0;border-radius:12px;padding:14px 16px;box-shadow:var(--dshni-shadow2);animation:dshni-banner-in .24s cubic-bezier(0,0,.2,1);font-family:"Segoe UI","Microsoft YaHei",sans-serif}',
          '.dshni-banner.dshni-pr2 .dshni-b-ico{color:var(--dsw-alias-state-success-secondary)}',
          '.dshni-banner.dshni-banner-out{animation:dshni-banner-out .25s ease forwards}',
          '@keyframes dshni-banner-in{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}',
          '@keyframes dshni-banner-out{to{opacity:0;transform:translateX(16px)}}',
          '.dshni-b-ico{font-size:14px;margin-top:2px}',
          '.dshni-b-body{flex:1}',
          '.dshni-b-title{font-size:14px;font-weight:600}',
          '.dshni-b-sub{font-size:13px;opacity:.82;margin-top:6px;line-height:1.5;word-break:break-all}',
          '.dshni-b-risk{font-size:12px;color:var(--dshni-p1);margin-top:4px}',
          '.dshni-b-actions{display:flex;gap:8px;margin-top:10px;justify-content:flex-end}',
          '.dshni-b-close{background:none;border:none;color:var(--dshni-toastfg);opacity:.7;cursor:pointer;font-size:15px;padding:2px}',
          '.dshni-b-close:hover{opacity:1}',
          // 横幅内按钮：普通钮=固定白 15% 边 ghost（toast 深底），主按钮=contrast-fill+label-primary-foreground
          //（双主题可读，#28 硬性要求）；danger 保持红底白字。
          '.dshni-banner .dshni-btn{border:1px solid rgba(255,255,255,.15);background:transparent;color:var(--dshni-toastfg);opacity:.85}',
          '.dshni-banner .dshni-btn:hover{opacity:1;background:var(--dshni-active);color:var(--dshni-toastfg)}',
          '.dshni-banner .dshni-btn.primary{background:var(--dsw-alias-button-contrast-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);opacity:1}',
          '.dshni-banner .dshni-btn.primary:hover{background:var(--dsw-alias-button-contrast-fill);opacity:.88}',
          '.dshni-banner .dshni-btn.danger{background:var(--dshni-btn-danger);border-color:transparent;color:#fff;opacity:1}',
          '.dshni-banner .dshni-btn.danger:hover{background:var(--dshni-btn-danger-h)}',
          '.dshni-fallback-btn{position:fixed;right:18px;bottom:18px;width:46px;height:46px;border-radius:50%;background:var(--dshni-bg3);border:1px solid var(--dshni-border);box-shadow:var(--dshni-shadow2);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2147483000;font:inherit;padding:0;color:var(--dshni-text)}',
          '.dshni-fallback-btn svg{width:20px;height:20px;fill:var(--dshni-text2)}',
          // v1.5 #29：prefers-reduced-motion 降级——关闭入场/强调动画，不关 hover 过渡
          '@media (prefers-reduced-motion:reduce){.dshni-panel.dshni-enter,.dshni-banner,.dshni-badge.dshni-pulse,.dshni-badge.dshni-pop,.dshni-bell.dshni-ringing{animation:none!important}}'
        ].join('\n');
        document.head.appendChild(st);
      }
      function hhmm(ts) {
        var d = new Date(ts);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
      function ringBell() {
        if (!bellBtn) return;
        bellBtn.classList.remove('dshni-ringing');
        void bellBtn.offsetWidth;
        bellBtn.classList.add('dshni-ringing');
        if (badgeEl) {
          badgeEl.classList.remove('dshni-pulse'); void badgeEl.offsetWidth; badgeEl.classList.add('dshni-pulse');
        }
      }
      function renderBadge() {
        if (!badgeEl) return;
        var c = unhandledGroupsCount(); // v1.6：角标 = 未处理组数（P1 逐条 + P2 融合组各计 1）
        var prev = badgeEl.textContent;
        badgeEl.textContent = c > 99 ? '99+' : String(c);
        badgeEl.classList.toggle('dshni-show', c > 0);
        if (c > 0 && prev !== badgeEl.textContent) { // v1.5 #29：数字变化 pop 150ms
          badgeEl.classList.remove('dshni-pop'); void badgeEl.offsetWidth; badgeEl.classList.add('dshni-pop');
        }
      }
      function itemActionsHtml(n) {
        var html = '';
        if (n.pr === 1 && !n.resolved) {
          if (!n.highRisk && n.interaction) {
            html += '<button class="dshni-btn primary" data-act="approve" data-longpress="' + Number(config.longPressMs) + '">同意（长按）</button>';
          }
          if (n.interaction) {
            html += '<button class="dshni-btn danger" data-act="reject">拒绝</button>';
          }
          if (n.highRisk) html += '<span class="dshni-b-risk" style="margin:0 4px;align-self:center">⚠ 高危：请到会话内人工裁决</span>';
        }
        // v1.4 #24：已处理条目已从面板移除（pruneResolved），灰标签历史分支随之消亡
        html += '<button class="dshni-btn" data-act="go">' + (n.pr === 1 ? '去处理' : '查看') + '</button>';
        return '<div class="dshni-actions">' + html + '</div>';
      }
      // v1.6：融合组行 HTML（纯函数：渲染与逻辑层自测共用）
      // 单条消息口径——标题后只跟 kind 标签，不显示条数（无「· N 条新动态」、无「N 个会话」）；
      // meta 显示组内最新条目的 sub；时间显示组内最新时间；data-gids 供「查看」成功后整组 resolve。
      function groupRowHtml(g) {
        var latest = g.latest; // 组内时间倒序首条 = 最新
        var gids = g.list.map(function (n) { return n.id; }).join(',');
        return '<div class="dshni-item dshni-pr2 dshni-group' + (g.jumpFailed ? ' dshni-group-fail' : '') + '" data-sid="' + esc(g.jumpSid || '_') + '" data-gids="' + esc(gids) + '">' +
          '<div class="dshni-ico">✅</div>' +
          '<div class="dshni-body">' +
            '<div class="dshni-title">' + esc(g.label) + '<span class="dshni-tag">' + esc(KIND_META.done ? KIND_META.done.label : '回复完成') + '</span></div>' +
            (latest && latest.sub ? '<div class="dshni-meta"><span style="word-break:break-all">最新：' + esc(latest.sub) + '</span></div>' : '') +
            (g.jumpFailed ? '<div class="dshni-jumpfail">⚠ 跳转失败，请手动前往该会话处理</div>' : '') +
            '<div class="dshni-actions"><button class="dshni-btn" data-act="gogroup">查看</button></div>' +
          '</div>' +
          '<div class="dshni-time">' + hhmm(latest ? latest.at : Date.now()) + '</div>' +
        '</div>';
      }
      // v1.6：整组转已处理（组内可能跨多个 sid）→ 统一走 pruneResolved（防抖落盘）
      function resolveGroupItems(groupItems) {
        var touched = false;
        for (var i = 0; i < groupItems.length; i++) {
          var n = groupItems[i];
          if (!n || n.resolved) continue;
          n.resolved = true; n.read = true; n.jumpFailed = false;
          touched = true;
        }
        if (!touched) return 0;
        var removed = pruneResolved();
        applyTitle(); emit();
        return removed;
      }
      function renderPanel() {
        if (!panelEl) return;
        var headCnt = panelEl.querySelector('.dshni-cnt');
        var headPending = panelEl.querySelector('.dshni-pending');
        var list = panelEl.querySelector('.dshni-panel-list');
        if (!list) return;
        var c = unhandledGroupsCount(); // v1.6：头部 = 未处理组数
        if (headCnt) headCnt.textContent = c > 0 ? c + ' 个待处理' : '';
        var p1 = 0;
        for (var pi = 0; pi < items.length; pi++) if (items[pi].pr === 1 && !items[pi].resolved) p1++;
        if (headPending) headPending.textContent = p1 > 0 ? p1 + ' 条待裁决' : '';
        if (!items.length) {
          list.innerHTML = '<div class="dshni-empty"><div style="font-size:32px;margin-bottom:8px;opacity:.5">🔕</div>暂无通知<br>对话需要你或跑完时，这里会亮</div>';
          return;
        }
        // 面板排序：P1 置顶标记（approval>plan-review>question），同级时间倒序
        var sorted = items.slice().sort(function (a, b) {
          if (a.pr !== b.pr) return a.pr - b.pr;
          var ka = a.pr === 1 ? kindRank(a.kind) : 0;
          var kb = b.pr === 1 ? kindRank(b.kind) : 0;
          if (ka !== kb) return kb - ka;
          return b.at - a.at;
        });
        // v1.6：P1 逐条展示；未处理 P2 按「会话标题 + 分钟桶」融合为一行（纯渲染层，items 数组结构不动）
        var p1Rows = [];
        var p2List = [];
        var groups = []; // {label,list,jumpFailed,latest,jumpSid}（buildP2Groups 产出）
        for (var gi = 0; gi < sorted.length; gi++) {
          if (sorted[gi].pr === 1) p1Rows.push(sorted[gi]); else p2List.push(sorted[gi]);
        }
        groups = buildP2Groups(p2List);
        list.innerHTML =
          p1Rows.map(function (n) {
            return '<div class="dshni-item dshni-pr' + n.pr + (n.read ? '' : ' dshni-unread') + '" data-id="' + n.id + '">' +
              '<div class="dshni-ico">' + n.ico + '</div>' +
              '<div class="dshni-body">' +
                '<div class="dshni-title">' + esc(n.title) + '<span class="dshni-tag">' + esc(KIND_META[n.kind] ? KIND_META[n.kind].label : n.kind) + '</span></div>' +
                '<div class="dshni-meta"><span class="dshni-sess">💬 ' + esc(n.sessionLabel || (n.sessionId === currentSessionId() ? '当前会话' : n.sessionId || '')) + '</span>' +
                (n.sub ? '<span style="word-break:break-all">' + esc(n.sub) + '</span>' : '') + '</div>' +
                (n.jumpFailed && !n.resolved ? '<div class="dshni-jumpfail">⚠ 跳转失败，请手动前往该会话处理</div>' : '') +
                itemActionsHtml(n) +
              '</div>' +
              '<div class="dshni-time">' + hhmm(n.at) + '</div>' +
            '</div>';
          }).join('') +
          groups.map(groupRowHtml).join('');
        // 绑定动作（事件委托在 mountPanel 时挂一次）
      }
      function mountPanelEvents() {
        if (!panelEl) return;
        var list = panelEl.querySelector('.dshni-panel-list');
        list.addEventListener('click', function (ev) {
          var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
          var itemEl = ev.target && ev.target.closest ? ev.target.closest('.dshni-item') : null;
          if (!itemEl) return;
          // v1.6：融合组「查看」= 跳组内最新条目的 sid；跳转成功 → 整组 resolve 删除（组内可能跨多个
          // sid，如子代理会话继承父标题），失败 → 整组保留红字。分支须在 data-id 条目查找前——组行无 id。
          if (btn && btn.getAttribute('data-act') === 'gogroup') {
            var gsid = itemEl.getAttribute('data-sid');
            var gids = String(itemEl.getAttribute('data-gids') || '').split(',');
            var groupItems = [];
            for (var gi2 = 0; gi2 < gids.length; gi2++) { // 跳转前先取组内条目引用（jumpSessionId 会先删同 sid 条目）
              if (!gids[gi2]) continue;
              for (var gj = 0; gj < items.length; gj++) if (items[gj].id === gids[gi2]) { groupItems.push(items[gj]); break; }
            }
            var jumped = false;
            if (gsid && gsid !== '_') jumped = jumpSessionId(gsid);
            if (jumped) {
              resolveGroupItems(groupItems); // 整组消：组内跨 sid 的剩余条目一并 resolve + pruneResolved
              closePanel();
            }
            renderPanel(); renderBadge(); applyTitle();
            return;
          }
          var item = null;
          for (var i = 0; i < items.length; i++) if (items[i].id === itemEl.getAttribute('data-id')) { item = items[i]; break; }
          if (!item) return;
          if (btn) {
            ev.stopPropagation();
            var act = btn.getAttribute('data-act');
            // 返修 #19：go=统一跳转；成功才收面板；失败保持未处理+面板红字提示
            if (act === 'go') { if (jumpSessionId(item.sessionId)) closePanel(); renderPanel(); renderBadge(); return; }
            if (act === 'reject') { decide(item, 'rejected'); renderPanel(); renderBadge(); return; }
            if (act === 'approve') { /* 长按在 bindLongPress 处理 */ return; }
          }
          // 点条目其他区域 = 跳转（返修 #19：跳转成功才收面板，失败保持未处理）
          if (jumpSessionId(item.sessionId)) closePanel();
          renderPanel(); renderBadge();
        });
        // 长按「同意」绑定（每次 render 后重建按钮，改为委托 pointerdown）
        list.addEventListener('pointerdown', function (ev) {
          var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act="approve"]') : null;
          if (!btn) return;
          var itemEl = btn.closest('.dshni-item');
          if (!itemEl) return;
          var item = null;
          for (var i = 0; i < items.length; i++) if (items[i].id === itemEl.getAttribute('data-id')) { item = items[i]; break; }
          if (!item || item.resolved) return;
          longPressBind(btn, function () {
            decide(item, 'allowed-once');
            renderPanel(); renderBadge();
          });
          // longPressBind 重复绑定 pointerdown 会叠加：首绑后替换为 noop 标记
          btn.setAttribute('data-lp-bound', '1');
        }, true);
        // 面板头：全部已读 / 设置抽屉
        var markAll = panelEl.querySelector('[data-act="markall"]');
        if (markAll) markAll.addEventListener('click', function (ev) { ev.stopPropagation(); markAllResolved(); renderPanel(); renderBadge(); });
        var settingsToggle = panelEl.querySelector('.dshni-settings-toggle');
        if (settingsToggle) settingsToggle.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var drawer = panelEl.querySelector('.dshni-drawer');
          if (drawer) drawer.classList.toggle('dshni-open');
        });
      }
      function openPanel(force) {
        panelOpen = force === true ? true : !panelOpen;
        if (panelEl) {
          panelEl.classList.toggle('dshni-open', panelOpen);
          if (panelOpen) {
            // v1.5 #29：入场动画 200ms 缩放淡入（transform-origin top right；reduced-motion 下 CSS 关闭）
            panelEl.classList.remove('dshni-enter'); void panelEl.offsetWidth; panelEl.classList.add('dshni-enter');
            // 定位：铃铛 rect 下方；铃铛不在（降级模式）则右下角
            var rect = bellBtn && bellBtn.isConnected ? bellBtn.getBoundingClientRect() : null;
            if (rect) {
              var left = Math.min(Math.max(8, rect.right - panelEl.offsetWidth), window.innerWidth - panelEl.offsetWidth - 8);
              panelEl.style.left = Math.max(8, left) + 'px';
              panelEl.style.top = (rect.bottom + 8) + 'px';
            } else {
              panelEl.style.left = (window.innerWidth - 420) + 'px';
              panelEl.style.top = (window.innerHeight - 540) + 'px';
            }
            // 返修 #19：打开面板只展开（数字不动）——「打开即全已读」移除
            renderBadge(); renderPanel(); applyTitle();
          }
        }
      }
      function closePanel() { panelOpen = false; if (panelEl) panelEl.classList.remove('dshni-open'); }
      function renderDrawer() {
        var drawer = panelEl.querySelector('.dshni-drawer');
        if (!drawer) return;
        drawer.innerHTML =
          '<label><input type="checkbox" data-cfg="enabled"' + (config.enabled ? ' checked' : '') + '> 总开关</label>' +
          '<label><input type="checkbox" data-cfg="banner"' + (config.banner ? ' checked' : '') + '> 前台横幅</label>' +
          '<label><input type="checkbox" data-cfg="sound"' + (config.sound ? ' checked' : '') + '> 提示音</label>' +
          '<label><input type="checkbox" data-cfg="titleMark"' + (config.titleMark ? ' checked' : '') + '> 标签标题标记（后台）</label>' +
          '<label><input type="checkbox" data-cfg="sysNotify"' + (config.sysNotify ? ' checked' : '') + '> Windows 系统通知（后台）</label>' +
          '<label><input type="checkbox" data-cfg-chk="perSessionNotify"' + (config.perSessionNotify !== false ? ' checked' : '') + '> 会话单次提示（未处理前不重复弹）</label>' +
          '<label><input type="checkbox" data-cfg="highRiskGuard"' + (config.highRiskGuard !== false ? ' checked' : '') + '> 高危审批禁一键同意</label>' +
          // 返修 #14：主题三态（跟随宿主/浅/深）；#18：攒批静默秒数（1~30s）
          '<label style="margin-left:8px">主题 <select data-cfg-sel="theme">' +
            '<option value="auto"' + (config.theme === 'auto' || !config.theme ? ' selected' : '') + '>跟随宿主</option>' +
            '<option value="light"' + (config.theme === 'light' ? ' selected' : '') + '>浅色</option>' +
            '<option value="dark"' + (config.theme === 'dark' ? ' selected' : '') + '>深色</option>' +
          '</select></label>' +
          '<label style="margin-left:8px">完成攒批静默 <input type="number" min="1" max="30" step="1" data-cfg-num="doneBatchMs" value="' + Math.round(Number(config.doneBatchMs) / 1000) + '"> 秒（1~30）</label>' +
          '<label style="margin-left:8px">完成确认窗口 <input type="number" min="3" max="60" step="1" data-cfg-num="doneConfirmMs" value="' + Math.round(Number(config.doneConfirmMs || DEFAULTS.doneConfirmMs) / 1000) + '"> 秒（3~60）</label>' +
          '<label style="margin-left:8px">音量 <input type="range" min="0" max="100" data-cfg="volume" value="' + Math.round(config.volume * 100) + '"></label>' +
          '<div class="dshni-drawer-row">' +
            '<span style="color:var(--dshni-text2)">测试（实机自测用）：</span>' +
            '<button class="dshni-test p1" data-test="approval">🔐 审批·本会话</button>' +
            '<button class="dshni-test p1" data-test="approval-bg">🔐 审批·后台会话</button>' +
            '<button class="dshni-test p1" data-test="plan">📐 方案</button>' +
            '<button class="dshni-test p1" data-test="question">❓ 提问</button>' +
            '<button class="dshni-test p2" data-test="done-here">✅ 完成·本会话</button>' +
            '<button class="dshni-test p2" data-test="done-bg">✅ 完成·后台会话</button>' +
            '<button class="dshni-test p1" data-test="sys">🖥 模拟后台通道</button>' +
            '<button class="dshni-test" data-test="clear">🗑 清空</button>' +
          '</div>';
        drawer.querySelectorAll('input[data-cfg]').forEach(function (input) {
          input.addEventListener('change', function () {
            var k = input.getAttribute('data-cfg');
            if (k === 'volume') { config.volume = Number(input.value) / 100; }
            else { config[k] = input.checked; }
            saveConfig(); applyTitle();
          });
        });
        // v1.3 #23：会话单次提示开关（data-cfg-chk，与 data-cfg 复选框同款式；关闭=恢复每次都弹）
        drawer.querySelectorAll('input[data-cfg-chk]').forEach(function (input) {
          input.addEventListener('change', function () {
            var k = input.getAttribute('data-cfg-chk');
            config[k] = input.checked;
            saveConfig(); applyTitle();
            try { console.log('[dsh-notify-inline] #23 perSessionNotify =', config[k]); } catch (e) {}
          });
        });
        // 返修 #14：主题三态 select（立即 applyTheme）
        drawer.querySelectorAll('select[data-cfg-sel]').forEach(function (sel) {
          sel.addEventListener('change', function () {
            var k = sel.getAttribute('data-cfg-sel');
            config[k] = sel.value;
            saveConfig();
            applyTheme();
            renderDrawer(); // 回填选中态
          });
        });
        // 返修 #18 + v1.2 #22：秒数控件（doneBatchMs 1~30s；doneConfirmMs 3~60s，越界回夹）
        drawer.querySelectorAll('input[data-cfg-num]').forEach(function (num) {
          num.addEventListener('change', function () {
            var k = num.getAttribute('data-cfg-num');
            var lo = k === 'doneConfirmMs' ? 3 : 1;
            var hi = k === 'doneConfirmMs' ? 60 : 30;
            var v = Math.round(Number(num.value));
            if (!isFinite(v)) v = Math.round(DEFAULTS[k] / 1000);
            v = Math.min(hi, Math.max(lo, v));
            num.value = String(v);
            config[k] = v * 1000;
            saveConfig();
          });
        });
        drawer.querySelectorAll('[data-test]').forEach(function (btn) {
          btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            runTest(btn.getAttribute('data-test'));
          });
        });
      }
      // 实机自测注入（验收项 #13 的 UI 侧工具；window.__dshNotifyInline.test 同源）
      function runTest(kind) {
        var cur = currentSessionId();
        if (kind === 'clear') { clearAll(); renderPanel(); renderBadge(); return; }
        if (kind === 'approval') return testP1('approval', cur || 'mock-here', '本会话', 'pnpm test --filter runner（mock）');
        if (kind === 'approval-bg') return testP1('approval', 'mock-bg-session', '修 bug（后台 mock）', 'pwsh -Command Remove-Item 常规命令（mock）');
        if (kind === 'plan') return testP1('plan-review', cur || 'mock-here', '本会话', 'runner 重构方案已就绪，等你批准（mock）');
        if (kind === 'question') return testP1('question', cur || 'mock-here', '本会话', '分支命名用 camelCase 还是 kebab-case？（mock）');
        if (kind === 'done-here') return testDone(cur || 'mock-here', '本会话', true);
        if (kind === 'done-bg') return testDone('mock-bg-done', '写文档（后台 mock）', false);
        if (kind === 'sys') { // 模拟「事件发生时页面在后台」的系统通知形态（无视 hidden 判定，便于验收）
          var item = { title: '🔐 权限审批等待处理', sub: '「修 bug」会话请求执行命令，点击回到该会话处理（mock）', sessionId: 'mock-bg-session', sessionLabel: '修 bug（后台 mock）', tagKey: 'approval:mock-bg-session' };
          try {
            if ('Notification' in root && root.Notification.permission === 'granted') {
              var n = new root.Notification(item.title, { body: '「' + item.sessionLabel + '」 ' + item.sub, tag: item.tagKey, silent: true, icon: (location.origin || '') + '/favicon.svg' });
              n.onclick = function () { try { root.focus(); } catch (e) {} if (config.autoFocus !== false) jumpSessionId(item.sessionId); n.close(); };
              setTimeout(function () { try { n.close(); } catch (e) {} }, 15000);
            } else {
              try { console.warn('[dsh-notify-inline] 系统通知权限未授予（首次手势时才会请求）'); } catch (e) {}
            }
          } catch (e) {}
          return;
        }
      }
      function testP1(kind, sid, label, detail) {
        var meta = KIND_META[kind];
        var answered = null;
        var mockInteraction = { kind: kind, key: 'mock:' + kind + ':' + Date.now(), answer: function (outcome) { answered = outcome; try { console.log('[dsh-notify-inline] mock answer →', outcome); } catch (e) {} return Promise.resolve(); } };
        var item = pushItem({
          pr: 1, kind: kind, ico: meta.ico, tagKey: kind + ':' + sid,
          title: meta.label + '等待处理', sub: detail,
          sessionId: sid, sessionLabel: label,
          key: mockInteraction.key, interaction: mockInteraction, mock: true
        });
        return item;
      }
      function testDone(sid, label, isHere) {
        var meta = KIND_META.done;
        return pushItem({
          pr: 2, kind: 'done', ico: meta.ico, tagKey: 'done:' + sid,
          title: isHere ? '回复完成' : '后台会话完成', sub: '（mock）',
          sessionId: sid, sessionLabel: label, key: 'mock:done:' + Date.now(),
          mock: true // v1.2 #21：mock 条目不持久化（不污染真实历史）
        });
      }
      function buildBellDOM() {
        bellWrap = document.createElement('div');
        bellWrap.className = 'dshni-bell-wrap';
        bellWrap.setAttribute('data-dshni-bell', '1');
        // 返修 #16：原生 <button>（a11y 树稳定可读名称 + 键盘可达）；aria-label 供读屏，title 保留悬停提示
        bellBtn = document.createElement('button');
        bellBtn.type = 'button';
        bellBtn.className = 'dshni-bell';
        bellBtn.setAttribute('aria-label', '页面内通知');
        bellBtn.title = '页面内通知（dsh-notify-inline）';
        bellBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 16a2 2 0 0 0 1.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 0 0 8 16ZM3 5a5 5 0 0 1 10 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.519 1.519 0 0 1 13.482 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947Z"/></svg>';
        badgeEl = document.createElement('div');
        badgeEl.className = 'dshni-badge';
        badgeEl.textContent = '0';
        bellBtn.appendChild(badgeEl);
        bellBtn.addEventListener('click', function (ev) { ev.stopPropagation(); openPanel(); });
        bellWrap.appendChild(bellBtn);
        ensurePanelDOM();
        return bellWrap;
      }
      // 面板独立建（挂 body fixed，不依赖铃铛）：降级按钮路径也要能开面板
      function ensurePanelDOM() {
        if (panelEl && !panelEl.isConnected) panelEl = null; // 外部清 DOM（HMR/React 重挂）后自动重建
        if (panelEl) return;
        panelEl = document.createElement('div');
        panelEl.className = 'dshni-panel';
        panelEl.setAttribute('data-dshni-panel', '1');
        panelEl.innerHTML =
          '<div class="dshni-panel-head"><h3>通知</h3><span class="dshni-cnt"></span><span class="dshni-pending"></span>' +
          '<button data-act="markall">全部已读</button></div>' +
          '<div class="dshni-panel-list"></div>' +
          '<div class="dshni-drawer"></div>' +
          '<div class="dshni-foot"><span>🔔 P1 需要你操作 · ✅ P2 执行完成</span><span class="dshni-settings-toggle">⚙ 设置/测试</span></div>';
        panelEl.addEventListener('click', function (ev) {
          ev.stopPropagation();
        });
        document.body.appendChild(panelEl);
        mountPanelEvents();
        renderDrawer();
        renderPanel(); renderBadge();
      }
      function mountFallbackButton() {
        // 降级浮动按钮（验收项 #9）：铃铛未出现时兜底
        if (fallbackBtn && !fallbackBtn.isConnected) fallbackBtn = null; // 外部清 DOM 后自动重建
        if (fallbackBtn) return;
        ensurePanelDOM(); // 降级模式下铃铛/面板可能都没建过，先补面板再挂按钮
        // 返修 #16：原生 <button>（a11y 树稳定可读名称 + 键盘可达）
        fallbackBtn = document.createElement('button');
        fallbackBtn.type = 'button';
        fallbackBtn.className = 'dshni-fallback-btn';
        fallbackBtn.setAttribute('aria-label', '页面内通知（浮动降级）');
        fallbackBtn.title = '页面内通知（dsh-notify-inline，浮动降级）';
        fallbackBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 16a2 2 0 0 0 1.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 0 0 8 16ZM3 5a5 5 0 0 1 10 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.519 1.519 0 0 1 13.482 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947Z"/></svg>';
        fallbackBtn.addEventListener('click', function () { openPanel(); });
        document.body.appendChild(fallbackBtn);
        try { console.warn('[dsh-notify-inline] 会话头部挂载未就绪，已降级浮动按钮'); } catch (e) {}
      }
      // 点面板外关闭
      function onDocClick(ev) {
        if (!panelOpen) return;
        var t = ev.target;
        if (panelEl && panelEl.contains(t)) return;
        if (bellBtn && bellBtn.contains(t)) return;
        if (fallbackBtn && fallbackBtn.contains(t)) return;
        closePanel();
      }

      /* ══════════════════════════ React 挂载钩子（slots 组件壳） ══════════════════════════ */
      // 真实 UI 全在纯 DOM（buildBellDOM），此组件只负责把 DOM 插进框架槽位节点。
      // display:contents 让壳节点不影响 header flex 布局；order:-100 已保证排在
      // token-monitor（-99）左侧 —— 位置由框架排序保证，不动它任何源码。
      function BellMount() {
        var ref = React.useRef(null);
        React.useEffect(function () {
          if (!ref.current) return;
          injectStyles();
          var ui = buildBellDOM();
          ref.current.appendChild(ui);
          renderBadge();
          // 降级轮询已挪至 apply 主 effect（不依赖 React 生命周期：
          // 框架注册 slot 但从不渲染组件时 effect 不跑，此处轮询起不来）
          return function () {
            try { ui.remove(); } catch (e) {}
            try { if (panelEl) { panelEl.remove(); panelEl = null; } } catch (e) {}
          };
        }, []);
        return h('div', { ref: ref, style: { display: 'contents' } });
      }

      /* ══════════════════════════ apply ══════════════════════════ */
      function apply(ctx) {
        rootCtx = ctx;
        try { sessionsSvc = ctx.sessions || null; } catch (e) { sessionsSvc = null; }

        // 铃铛挂载：conversation.session.header.utilities 槽，order -100（token-monitor -99 左侧）
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.slots.inject('conversation.session.header.utilities', function () {
              return ctx.slots.register({
                name: 'conversation.session.header.utilities',
                id: 'notify-inline',
                // order 升序稳定排序：-100 < -99(token-monitor) < -10(open-in-app) < 0(session-log-export)
                // → 铃铛稳定钉在 token-monitor 徽标左侧（参照 token-monitor client.js:5997-6005）
                order: -100
              }, BellMount);
            });
          }
        } catch (e) {
          try { console.error('[dsh-notify-inline] slots 注入失败，将走浮动按钮降级', e); } catch (e2) {}
        }

        ctx.effect(function () {
          var disposed = false;
          var unsubs = [];
          var retryTimer = null;
          try {
            // v1.2 #21：恢复持久化条目（恢复 ≠ 新事件：只填 items + 重算角标，横幅/系统通知/攒批零触发）
            try {
              try { root.localStorage && root.localStorage.removeItem(LS_RESOLVED_TOTAL_LEGACY); } catch (eLegacy) {} // v1.7：清理已废弃的「已处理 N 条」累计键
              var restoredItems = loadPersisted();
              if (restoredItems.length) {
                items = restoredItems.concat(items);
                try { console.log('[dsh-notify-inline] 持久化恢复 ' + restoredItems.length + ' 条（未处理 ' + unhandledCount() + '）'); } catch (e) {}
                renderBadge();
                applyTitle();
              }
            } catch (eRest) {}
            var sessions = ctx.sessions;
            if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') {
              try { console.log('[dsh-notify-inline] sessions 服务不可用 — watcher 空转'); } catch (e) {}
            } else {
              listStore = sessions.list;
              unsubs.push(sessions.list.subscribe(onListChanged));
            }
            // 首次手势：解锁 WebAudio + 请求通知权限
            root.addEventListener('pointerdown', onFirstGesture, true);
            root.addEventListener('keydown', onFirstGesture, true);
            unsubs.push(function () {
              root.removeEventListener('pointerdown', onFirstGesture, true);
              root.removeEventListener('keydown', onFirstGesture, true);
            });
            // 可见性：回前台清标题标记/刷面板，切后台立即标标题
            document.addEventListener('visibilitychange', onVisibility);
            unsubs.push(function () { try { document.removeEventListener('visibilitychange', onVisibility); } catch (e) {} });
            document.addEventListener('click', onDocClick, true);
            unsubs.push(function () { try { document.removeEventListener('click', onDocClick, true); } catch (e) {} });
            // store 订阅：数据一变即刷角标/面板（修复：原先 renderBadge 只在开面板/裁决路径被调，
            // pushItem→emit() 后无人订阅 → 新事件角标不亮，直到手动开面板）
            unsubs.push(subscribe(function () {
              renderBadge();
              if (panelOpen) renderPanel();
            }));
            // 交互源先绑（它拥有标题标记与裁决）；face/list 随后
            bindUiSession();
            bindThemeObserver(); // 返修 #14：主题自动跟随 <html data-sm-theme>
            onListChanged();
            // 降级判定：铃铛 6s 内未进文档（框架未渲染 slot / 容器丢失）→ 挂浮动按钮。
            // 独立于 React 生命周期，slot 组件渲染与否都能兜底。
            // 6s 宽限后转入周期巡检：视图切换导致铃铛卸载时自动补挂降级按钮（铃铛回来则撤按钮）。
            var fbChecks = 0;
            var fbWatch = null;
            function startFbWatch() {
              if (fbWatch) return;
              fbWatch = setInterval(function () {
                if (disposed) { clearInterval(fbWatch); fbWatch = null; return; }
                var bellThere = bellBtn && bellBtn.isConnected;
                if (bellThere) {
                  if (fallbackBtn && fallbackBtn.isConnected) { try { fallbackBtn.remove(); } catch (e) {} fallbackBtn = null; }
                } else {
                  try { mountFallbackButton(); } catch (e) {}
                }
              }, 3000);
            }
            var fbTimer = setInterval(function () {
              if (disposed) { clearInterval(fbTimer); return; }
              fbChecks++;
              var mine = document.querySelector('[data-dshni-bell]');
              if (fbChecks < 12) {
                if (mine && mine.isConnected) { clearInterval(fbTimer); startFbWatch(); }
                return;
              }
              clearInterval(fbTimer);
              try { mountFallbackButton(); } catch (e) {}
              startFbWatch();
            }, 500);
            unsubs.push(function () { if (fbTimer) clearInterval(fbTimer); if (fbWatch) clearInterval(fbWatch); });
            // 服务晚到重试（boot race）
            retryTimer = setInterval(function () {
              if (disposed) return;
              try { bindCurrentFace(); } catch (e) {}
              try { bindUiSession(); } catch (e) {}
            }, 1500);
            unsubs.push(function () { if (retryTimer) clearInterval(retryTimer); });
            unsubs.push(function () { applyTitle._restore && applyTitle._restore(); });
            probeGeneration();
            try { console.log('[dsh-notify-inline] active — window.__dshNotifyInline 可调试/自测 (gen=' + hostGen.source + ')'); } catch (e) {}
          } catch (e) {
            try { console.error('[dsh-notify-inline] init failed', e); } catch (e2) {}
          }
          return function () {
            // 卸载清理（验收项 #11）：恢复标题、拆 DOM、退订全部
            disposed = true;
            for (var i = 0; i < unsubs.length; i++) { try { unsubs[i](); } catch (e) {} }
            detachFace();
            detachUiSession();
            dismissAllBanners();
            clearDoneBatches(); // 返修 #18：清攒批计时器，防卸载后 flush
            cancelAllDoneConfirms(); // v1.2 #22：清完成确认计时器
            try { if (themeObserver) { themeObserver.disconnect(); themeObserver = null; } } catch (e) {} // 返修 #14
            try { document.documentElement.removeAttribute('data-dshni-theme'); } catch (e) {}
            try { if (panelEl) { panelEl.remove(); panelEl = null; } } catch (e) {}
            try { if (bellWrap) { bellWrap.remove(); bellWrap = null; } } catch (e) {}
            try { if (fallbackBtn) { fallbackBtn.remove(); fallbackBtn = null; } } catch (e) {}
            try { if (bannerZone) { bannerZone.remove(); bannerZone = null; } } catch (e) {} // 横幅容器随卸载拆除（防多轮装载残留累积）
            try {
              if (writtenTitle != null) {
                var bare = cleanBase(String(document.title || ''));
                if (bare !== document.title) document.title = bare;
                writtenTitle = null; hostBase = null;
              }
            } catch (e) {}
          };
        }, 'dsh-notify-inline: watchers');
      }

      var prevCurrentSid = null; // v1.3 #23：跟踪 current 切换（切到某会话即解除其单次提示）
      function onListChanged() {
        if (!listStore) return;
        try {
          var cur = currentSessionId();
          if (cur && cur !== prevCurrentSid) {
            prevCurrentSid = cur;
            releaseSessionNotified(cur); // v1.3 #23：current 切到该 sid = 用户主动查看，解除单次提示
          }
          bindCurrentFace();
          bindUiSession();
          evalUiStatus();
          evalListRows();
        } catch (e) {}
      }

      exports.inject = ['sessions', 'slots'];
      exports.apply = apply;

      /* ══════════════════════════ 调试 / 自测 API ══════════════════════════ */
      try {
        root.__dshNotifyInline = {
          get config() { return config; },
          setConfig: function (patch) {
            Object.assign(config, patch || {});
            // 返修 #14/#18：越界回夹（doneBatchMs 1~30s；theme 归一并立即生效）
            var bm = Number(config.doneBatchMs);
            if (!isFinite(bm)) bm = DEFAULTS.doneBatchMs;
            config.doneBatchMs = Math.min(30000, Math.max(1000, bm));
            var cm = Number(config.doneConfirmMs); // v1.2 #22：3~60s 越界回夹
            if (!isFinite(cm)) cm = DEFAULTS.doneConfirmMs;
            config.doneConfirmMs = Math.min(60000, Math.max(3000, cm));
            if (config.theme !== 'auto' && config.theme !== 'light' && config.theme !== 'dark') config.theme = 'auto';
            config.perSessionNotify = config.perSessionNotify !== false; // v1.3 #23：布尔归一（undefined/0/null 均归 false 之外 → true 仅当显式非 false）
            try { applyTheme(); } catch (e) {}
            saveConfig(); applyTitle();
          },
          items: function () { return items.slice(); },
          unread: function () { return unhandledCount(); }, // 返修 #19：未处理条目数
          // v1.6：未处理组数（角标/面板头同口径；P1 逐条 + P2 融合组每组计 1）
          groups: function () { return unhandledGroupsCount(); },
          // v1.6：逻辑层自测注入（node/console 直接塞 items，跳过路由与渲染）
          _seedItems: function (list) { items = Array.isArray(list) ? list.slice() : []; return items.length; },
          _items: function () { return items; },
          pending: function () {
            var c = 0;
            for (var i = 0; i < items.length; i++) if (items[i].pr === 1 && !items[i].resolved) c++;
            return c;
          },
          generation: function () { return probeGeneration(); },
          currentSession: function () { return currentSessionId(); },
          // 跳转 spike（验收项 #10）：实机验证宿主 action 可用性
          spike: function () {
            var s = lookupService('sessions');
            var ws = lookupService('uiWorkspace');
            var ui = lookupService('uiSession');
            return {
              hostGen: probeGeneration(),
              sessionsService: !!s,
              sessionsOpen: !!(s && typeof s.open === 'function'),
              uiWorkspace: !!ws,
              uiWorkspaceOpenSession: !!(ws && typeof ws.openSession === 'function'),
              uiSessionVisible: !!ui,
              sessionStatusStore: !!(ui && isStore(ui.sessionStatus)),
              pendingInteractionsStore: !!(ui && isStore(ui.pendingInteractions)),
              notificationPermission: ('Notification' in root) ? root.Notification.permission : 'unsupported',
              bellMounted: !!(document.querySelector('[data-dshni-bell]') && document.querySelector('[data-dshni-bell]').isConnected)
            };
          },
          focus: function (sid) { jumpSessionId(sid || currentSessionId()); }, // 返修 #19
          test: runTest,
          _internals: { pushItem: pushItem, interactionStore: interactionStore, pendingOf: pendingOf, currentSessionId: currentSessionId, isHighRisk: isHighRisk, HIGH_RISK_RE: HIGH_RISK_RE, cleanBase: cleanBase, applyTitle: applyTitle, decide: decide, hostJump: hostJump, domJump: domJump, jumpSessionId: jumpSessionId, unhandledCount: unhandledCount, unhandledGroupsCount: unhandledGroupsCount, buildP2Groups: buildP2Groups, p2GroupKey: p2GroupKey, groupRowHtml: groupRowHtml, resolveGroupItems: resolveGroupItems, flushDoneBatch: flushDoneBatch, applyTheme: applyTheme, injectStyles: injectStyles, buildBellDOM: buildBellDOM, route: route, requestDoneConfirm: requestDoneConfirm, cancelDoneConfirm: cancelDoneConfirm, cancelAllDoneConfirms: cancelAllDoneConfirms, schedulePersist: schedulePersist, persistNow: persistNow, loadPersisted: loadPersisted, syncDoneFromStatus: syncDoneFromStatus, evalFace: evalFace, evalListRows: evalListRows, sessionNotified: sessionNotified, p2Suppressed: p2Suppressed, markSessionNotified: markSessionNotified, releaseSessionNotified: releaseSessionNotified, pruneResolved: pruneResolved, reportDone: reportDone }
        };
      } catch (e) {}

      return module.exports;
    }
  });
})(typeof window !== 'undefined' ? window : this);
