/**
 * dsh-notify-inline v1.6 逻辑层自验（node，零依赖，不参与发布：package.json files 不含本文件）
 *
 * 宿主不重启加载不了新 bundle，故用 node 里最小窗口桩加载 client.js（真实 factory 路径），
 * 直接对生产函数做断言：buildP2Groups / unhandledGroupsCount / groupRowHtml / resolveGroupItems
 * + loadPersisted（持久化后聚合一致）。
 *
 * 跑法：node verify-v16.mjs   （退出码 0 = 全绿）
 */
import fs from 'node:fs';
import vm from 'node:vm';

const LOG = [];
let failed = 0;
function ok(name, cond, detail) {
  LOG.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
  if (!cond) failed++;
}

/* ── 最小宿主桩 ───────────────────────────────────────────── */
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
const doc = { title: '', hidden: false };
const win = {
  localStorage, document: doc, focus() {},
  addEventListener() {}, removeEventListener() {}
};
let loaded = null;
win.__ModuleLoader__ = { load: (m) => { loaded = m; } };

globalThis.window = win;
globalThis.document = doc;
globalThis.localStorage = localStorage;

const srcPath = new URL('./client.js', import.meta.url);
const src = fs.readFileSync(srcPath, 'utf8');
vm.runInThisContext(src, { filename: 'client.js' });
ok('bundle 注册到 __ModuleLoader__', !!loaded && loaded.id === 'dsh-notify-inline');

const mod = loaded.factory(() => null); // react 缺席 → 纯逻辑路径
const api = win.__dshNotifyInline;
const I = api._internals;
ok('工厂执行并暴露 debug API', !!api && !!I);
ok('exports.apply / inject 存在', typeof mod.apply === 'function' && Array.isArray(mod.inject));

/* ── 固定时间基准（对齐分钟边界，分钟桶可控） ─────────────── */
const T = 1700000040000; // T % 60000 === 0
ok('基准时间对齐分钟边界', T % 60000 === 0, 'T=' + T);

function mk(o) {
  return {
    id: o.id, pr: o.pr === 1 ? 1 : 2, kind: o.kind || 'done',
    ico: o.pr === 1 ? '🔐' : '✅', tagKey: o.tagKey || 'k-' + o.id,
    title: o.title || '标题', sub: o.sub || '',
    sessionId: o.sessionId || null, sessionLabel: o.sessionLabel || '',
    at: o.at, read: !!o.read, resolved: !!o.resolved,
    jumpFailed: !!o.jumpFailed, key: o.key || null, interaction: o.interaction || null,
    highRisk: !!o.highRisk, mock: true
  };
}
// 每次返回全新对象（resolve 会改引用，避免跨用例污染）
function seed5() {
  return [
    mk({ id: 'a1', pr: 2, sessionId: 'sid-a', sessionLabel: '修 bug', at: T, sub: '旧一点的动态' }),
    mk({ id: 'a2', pr: 2, sessionId: 'sid-b', sessionLabel: '修 bug', at: T + 1000, sub: '中间动态' }),
    mk({ id: 'a3', pr: 2, sessionId: 'sid-c', sessionLabel: '修 bug', at: T + 20000, sub: '最新一条摘要' }), // 同桶
    mk({ id: 'd1', pr: 2, sessionId: 'sid-d', sessionLabel: '修 bug', at: T - 120000, sub: '两分钟前' }),      // 跨分钟
    mk({ id: 'e1', pr: 2, sessionId: 'sid-e', sessionLabel: '别的对话', at: T + 30000, sub: '别的对话动态' })
  ];
}
function byLabel(list, label) { return list.filter((g) => g.label === label); }

/* ══ 验收① + ④：同标题同分钟融合 1 行；跨分钟 1 行；不同标题 1 行 ══ */
api._seedItems(seed5());
ok('① items 注入 5 条', api._items().length === 5);
let groups = I.buildP2Groups(api._items());
ok('① 聚合组数 = 3（同标题同分钟融合 / 跨分钟 / 不同标题）', groups.length === 3, 'got ' + groups.length);
const fused = byLabel(groups, '修 bug').find((g) => g.list.length === 3);
ok('① 同标题同分钟 3 条融合成 1 组', !!fused);
ok('① 组内时间倒序，首条=最新 sid-c', !!fused && fused.latest.id === 'a3' && fused.list.map((n) => n.id).join(',') === 'a3,a2,a1');
ok('① 组内 3 条分属不同 sid（子代理同名场景）', !!fused && new Set(fused.list.map((n) => n.sessionId)).size === 3);
const crossMin = byLabel(groups, '修 bug').find((g) => g.list.length === 1);
ok('① 跨分钟同标题单独成组', !!crossMin && crossMin.list[0].id === 'd1');
ok('① 不同标题单独成组', byLabel(groups, '别的对话').length === 1);
ok('④ 跨分钟键不同（分钟桶参与融合键）', I.p2GroupKey(seed5()[0]) !== I.p2GroupKey(seed5()[3]));
ok('④ 同分钟键相同（同名不同 sid 也同键）', I.p2GroupKey(seed5()[0]) === I.p2GroupKey(seed5()[2]));

/* ══ 验收②：角标 = 组数（P1 逐条 + P2 每组计 1） ══ */
ok('② 未处理组数 = 3（不是条目数 5）', I.unhandledGroupsCount() === 3, 'groups=' + I.unhandledGroupsCount());
ok('② 条目数仍为 5（旧口径对照）', I.unhandledCount() === 5);
ok('② 公开 API groups() 与角标同口径', api.groups() === 3);
ok('② renderBadge 使用 unhandledGroupsCount()', /function renderBadge\(\)[\s\S]{0,400}?unhandledGroupsCount\(\)/.test(src));

/* ══ 验收③：面板头「N 个待处理」 ══ */
ok('③ 面板头文案为「个待处理」', src.includes("c + ' 个待处理'"));
ok('③ 旧文案「条未处理」已清除', !src.includes("' 条未处理'"));
ok('③ 面板头计数走组数口径', /var c = unhandledGroupsCount\(\); \/\/ v1\.6：头部 = 未处理组数/.test(src));

/* ══ 验收①：融合行渲染成单条（无条数） ══ */
const html = I.groupRowHtml(fused);
ok('① 融合行无「N 条新动态」', !html.includes('条新动态'));
ok('① 融合行无「N 个会话」', !html.includes('个会话'));
ok('① 融合行标题后只有 kind 标签', /<div class="dshni-title">修 bug<span class="dshni-tag">/.test(html));
ok('① 融合行 meta 显示最新 sub', html.includes('最新：最新一条摘要'));
ok('① 融合行带组内全部条目 id（data-gids）', /data-gids="a3,a2,a1"/.test(html), html.match(/data-gids="[^"]*"/)?.[0]);
ok('① 融合行 data-sid = 组内最新 sid', /data-sid="sid-c"/.test(html));
ok('① 融合行时间 = 组内最新时间', new RegExp('>' + String(new Date(T + 20000).getHours()).padStart(2, '0') + ':').test(html));

/* ══ 验收④：跨分钟不融合保留时间先后 ══ */
ok('④ 时间顺序：融合组最新 > 跨分钟组', fused.latest.at > crossMin.latest.at);
ok('④ 组间按组内最新时间倒序', groups[0].latest.at >= groups[1].latest.at && groups[1].latest.at >= groups[2].latest.at);

/* ══ 验收⑤：融合行「查看」跳最新 sid，成功后整组 resolve 删除 ══ */
api._seedItems(seed5()); // 全新数据（避免上一段断言引用污染）
const rtBefore = I.resolvedTotal();
const gBefore = I.unhandledGroupsCount();
const target = byLabel(I.buildP2Groups(api._items()), '修 bug').find((g) => g.list.length === 3);
ok('⑤ 「查看」目标 sid = 组内最新 sid-c', target.jumpSid === 'sid-c');
const removed = I.resolveGroupItems(target.list);
ok('⑤ 整组落盘移除 3 条', removed === 3, 'removed=' + removed);
ok('⑤ 面板条目 5 → 2', api._items().length === 2, 'now=' + api._items().length);
ok('⑤ 角标组数 3 → 2（该组从角标消失）', I.unhandledGroupsCount() === gBefore - 1, 'now=' + I.unhandledGroupsCount());
ok('⑤ resolvedTotal 累计 +3', I.resolvedTotal() === rtBefore + 3);
ok('⑤ 组内条目不在 items 中了', !api._items().some((n) => n.id === 'a1' || n.id === 'a2' || n.id === 'a3'));
// 跳转失败态：组保留 + 红字（resolveGroupItems 只在该组跳转成功后调用）
const failGroup = I.buildP2Groups([mk({ id: 'f1', pr: 2, sessionId: 'sid-f', sessionLabel: '失败对话', at: T, jumpFailed: true })])[0];
ok('⑤ 跳转失败组带 fail 样式', I.groupRowHtml(failGroup).includes('dshni-group-fail'));
ok('⑤ 跳转失败组显示红字', I.groupRowHtml(failGroup).includes('跳转失败'));
ok('⑤ 跳转失败组未 resolve 仍计入角标', failGroup.list[0].resolved === false);

/* ══ 验收⑥：P1 逐条展示零改动 ══ */
api._seedItems(seed5().concat([
  mk({ id: 'p1', pr: 1, kind: 'approval', sessionId: 'sid-p', sessionLabel: '审批会话', interaction: {}, at: T + 40000 }),
  mk({ id: 'q1', pr: 1, kind: 'question', sessionId: 'sid-q', sessionLabel: '提问会话', interaction: {}, at: T + 41000 })
]));
const grpWithP1 = I.buildP2Groups(api._items().filter((n) => n.pr !== 1));
ok('⑥ P1 不进 P2 融合组', grpWithP1.length === 3 && grpWithP1.every((g) => g.list.every((n) => n.pr === 2)));
ok('⑥ 角标 = P1 2 条 + P2 3 组 = 5', I.unhandledGroupsCount() === 5, 'got ' + I.unhandledGroupsCount());
ok('⑥ 条目数 = 7（P1 仍逐条）', I.unhandledCount() === 7);
ok('⑥ P1 长按同意按钮模板未动', src.includes('data-act="approve" data-longpress='));
ok('⑥ P1 拒绝按钮模板未动', src.includes('data-act="reject">拒绝</button>'));
ok('⑥ P1 逐条渲染模板未动', src.includes("'<div class=\"dshni-item dshni-pr' + n.pr + (n.read ? '' : ' dshni-unread')"));
ok('⑥ decide / 长按绑定函数仍在', typeof I.decide === 'function' && /function longPressBind/.test(src));
ok('⑥ 高危拦截逻辑未动', /dshni-b-risk/.test(src) && /isHighRisk\(interaction\)/.test(src));

/* ══ 验收⑦：刷新后聚合一致（持久化键与数据不变，仅渲染层变） ══ */
const live = api._items();
store.set('dshNotifyInline.items', JSON.stringify(live.map((n) => ({
  id: n.id, pr: n.pr, kind: n.kind, ico: n.ico, tagKey: n.tagKey, title: n.title, sub: n.sub,
  sessionId: n.sessionId, sessionLabel: n.sessionLabel, at: n.at, read: n.read, resolved: n.resolved,
  jumpFailed: n.jumpFailed, key: n.key, highRisk: n.highRisk
}))));
const restored = I.loadPersisted();
ok('⑦ 持久化恢复条数一致', restored.length === live.length, restored.length + ' vs ' + live.length);
ok('⑦ 恢复后 at 保留', restored.every((n) => live.some((m) => m.id === n.id && m.at === n.at)));
ok('⑦ 恢复后组数一致（刷新后聚合不变）', I.buildP2Groups(restored).length === I.buildP2Groups(live).length);
ok('⑦ 持久化键未改（dshNotifyInline.items/.config/.resolvedTotal）',
  src.includes("'dshNotifyInline.items'") && src.includes("'dshNotifyInline.config'") && src.includes("'dshNotifyInline.resolvedTotal'"));
ok('⑦ 融合键只读 sessionLabel/at，不新增 items 字段',
  /function p2GroupKey\(n\) \{/.test(src) && !/groupKey:|groupBucket:/.test(src));

/* ── 报告 ─────────────────────────────────────────────── */
console.log(LOG.join('\n'));
console.log('\n' + (failed === 0 ? 'ALL PASS (' + LOG.length + ' checks)' : 'FAILED ' + failed + ' / ' + LOG.length));
process.exit(failed === 0 ? 0 : 1);
