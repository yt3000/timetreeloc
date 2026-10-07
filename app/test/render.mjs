/* M2 无头流程测试：用 DOM 替身驱动 main.js 的 handler，验证"点下去真的发生了什么"。
   上一轮就是这类测试抓到了"点新增完全没反应"的 bug，重构后必须重新覆盖。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + l + (e ? ' → ' + e : '')); } else { fail++; console.log('  ✗ ' + l + (e ? ' → ' + e : '')); } };

/* ---------- DOM 替身 ---------- */
const store = {}, lis = {};
function mkEl(id) {
  const el = { id, dataset: {}, value: '', _attrs: {}, files: null,
    classList: { s: new Set(), add(c) { this.s.add(c) }, remove(c) { this.s.delete(c) },
      toggle(c) { this.s.has(c) ? this.s.delete(c) : this.s.add(c) }, contains(c) { return this.s.has(c) } },
    hasAttribute(a) { return a in this._attrs }, getAttribute(a) { return this._attrs[a] },
    setAttribute(a, v) { this._attrs[a] = v }, appendChild() {}, remove() {}, click() {}, focus() {},
    closest() { return null } };
  Object.defineProperty(el, 'innerHTML', { get: () => store[id] || '', set: v => { store[id] = v } });
  Object.defineProperty(el, 'textContent', { get: () => store[id + '_text'] || '', set: v => { store[id + '_text'] = v } });
  return el;
}
const els = {};
const getEl = id => (els[id] = els[id] || mkEl(id));
global.document = {
  getElementById: getEl, querySelector: sel => getEl('meta:' + sel), addEventListener: (t, f) => { (lis[t] = lis[t] || []).push(f) },
  createElement: () => mkEl('created'), documentElement: mkEl('root'), body: mkEl('body')
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
  onLine: true, serviceWorker: undefined,
  storage: { async persist() { return true }, async persisted() { return true },
    async estimate() { return { usage: 2048, quota: 5e8 } } } } });
global.window = global;
global.addEventListener = (t, f) => { (lis[t] = lis[t] || []).push(f) };
global.location = { origin: 'https://example.test', pathname: '/timetreeloc/' };
global.confirm = () => true;
global.Blob = class { constructor(p) { this.parts = p } };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

/* ---------- IndexedDB 替身 ---------- */
function fakeIdb() {
  const dbs = {};
  const rq = () => { const r = { result: undefined, onsuccess: null, onerror: null };
    r._done = v => { r.result = v; setTimeout(() => r.onsuccess && r.onsuccess(), 0) }; return r };
  class St { constructor(kp) { this.kp = kp; this.rows = new Map() }
    createIndex() {} getAll() { const r = rq(); r._done([...this.rows.values()]); return r }
    put(v) { const r = rq(); this.rows.set(v[this.kp], JSON.parse(JSON.stringify(v))); r._done(v[this.kp]); return r }
    delete(k) { this.rows.delete(k); const r = rq(); setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r }
    clear() { this.rows.clear() } }
  class DB { constructor() { this.s = {} }
    createObjectStore(n, o) { this.s[n] = new St(o.keyPath); return this.s[n] }
    transaction(n) { const s = this.s[n]; const t = { objectStore: () => s, oncomplete: null, onerror: null };
      setTimeout(() => t.oncomplete && t.oncomplete(), 0); return t }
    close() {} }
  return { open(name, ver) { if (!dbs[name]) dbs[name] = { db: new DB(), v: 0 };
    const e = dbs[name], r = rq();
    if (e.v < ver) { const ev = { oldVersion: e.v }; e.v = ver; r.result = e.db;
      setTimeout(() => { r.onupgradeneeded && r.onupgradeneeded(ev); r.onsuccess && r.onsuccess() }, 0) }
    else r._done(e.db);
    return r } };
}
global.indexedDB = fakeIdb();

const wait = ms => new Promise(r => setTimeout(r, ms));
/* 领域层要在第一节就用：测试里所有"今天 / 3 天后"一律走它的 todayKey 与 dadd。
   绝不能用 toISOString 截出来的日期——那是 UTC，在 UTC+8 的 00:00–08:00 比本地今天早一天，
   测试会挑时间偶发闪红（真发生过：晚上全绿、早上红一条，查起来最费时间）。 */
const D = await import('../src/domain.js');
const readCss = readFileSync(join(HERE, '..', 'styles.css'), 'utf8');
process.on('unhandledRejection', e => { console.log('  ✗ 未捕获异常：' + (e && e.stack || e)); process.exit(1) });

const M = await import('../src/main.js');
const T = M.__test;
/* 轮询等启动完成，不用固定 sleep：加了示例数据后启动耗时变长，
   固定延时会时快时慢地给出假失败 */
for (let i = 0; i < 100 && T.S.booting; i++) await wait(10);

const camel = k => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
const el = (name, value) => ({ dataset: { [camel(name)]: value }, classList: { contains: () => false }, target: { value } });
const host = () => store.host || '';
const sheet = () => store.sheet || '';

console.log('1 启动');
ok('自动 boot 完成，没有抛异常', T.S.booting === false && host().length > 500, host().length + ' 字符');
ok('壁挂渲染了顶栏日期与时钟', /class="d num"/.test(host()) && /id="clk"/.test(host()));
ok('渲染了底部换屏提示', /khint/.test(host()) && /自动换屏/.test(host()));
ok('右栏有倒数日 / 明天 / 本周还剩 / 管理入口',
  /倒数日/.test(host()) && /明天/.test(host()) && /本周还剩/.test(host()) && /managebtn/.test(host()));
ok('首次启动有示例数据，不是空屏', /接孩子放学/.test(host()), '示例日程已显示');
ok('初始成员只有「全家」一个', T.snapshot().members.length === 1 && T.snapshot().members[0].name === '全家',
   T.snapshot().members.map(m => m.name).join(','));

console.log('\n2 管理页与新增');
T.H.sheet(el('sheet'));
ok('点「管理 ⚙」进入整屏管理页', /tabd|tabs/.test(sheet()) && /管理/.test(sheet()));
const header = sheet().split('<div class="tabs">')[0];
ok('管理页标题区没有新增按钮（新增在内容区右下）',
  !/data-new/.test(header) && /data-new="event"/.test(sheet()), '标题区只有 ✕ 回到壁挂');
ok('日历 tab 有「＋ 新增日程」', /新增日程/.test(sheet()));

T.H.new(el('new', 'event'));
ok('点新增 → 编辑浮窗出现', /id="f-t"/.test(store.dr || ''), (store.dr || '').length + ' 字符');
getEl('f-t').value = '接小雨放学';
getEl('f-d').value = D.todayKey();
getEl('f-tm').value = '18:30';
T.H.pick(el('pick', 'm-dad'));
await T.H.save();
await wait(30);
ok('保存后日程进入本机并显示在壁挂', /接小雨放学/.test(host()),
  T.snapshot().events.length + ' 条记录');

console.log('\n3 重复日程与结束日期');
T.H.new(el('new', 'event'));
getEl('f-t').value = '钢琴课'; getEl('f-d').value = D.todayKey();
getEl('f-tm').value = '19:00';
getEl('f-rp').value = 'weekly';
await T.H.save(); await wait(30);
const weekly = T.snapshot().events.find(e => e.title === '钢琴课');
ok('每周重复日程已建，repeat 落库', !!weekly && weekly.repeat && weekly.repeat.freq === 'weekly');
T.S.form = null;
T.H.new(el('new', 'event'));
getEl('f-t').value = '限时晨跑'; getEl('f-d').value = D.todayKey();
getEl('f-tm').value = '07:00';
getEl('f-rp').value = 'daily';
getEl('f-until').value = D.dadd(D.todayKey(), 3);
await T.H.save(); await wait(30);
const limited = T.snapshot().events.find(e => e.title === '限时晨跑');
ok('结束日期写入 repeat.until', !!limited && limited.repeat && !!limited.repeat.until,
  limited && limited.repeat ? limited.repeat.until : '-');
const far = D.expandRange(T.snapshot().events, D.dadd(D.todayKey(), 20), D.dadd(D.todayKey(), 30));
ok('展开结果不越过 until（20 天后已无该日程）', !far.some(e => e.id === limited.id));

console.log('\n4 三选一（编辑 / 删除重复日程）');
T.S.cur = { ...weekly }; T.H.edit(el('edit'));
ok('编辑重复日程先弹三选一', /\+\+|仅此事件/.test(store.mDetail || ''), (store.mDetail || '').length + ' 字符');
T.H.ask(el('ask', 'one'));
ok('选「仅此事件」→ 打开预填表单', /id="f-t"/.test(store.dr || '') && T.S.form && T.S.form.scope === 'one');
getEl('f-t').value = '钢琴课（改时间）'; getEl('f-tm').value = '20:00';
await T.H.save(); await wait(30);
const afterOne = T.snapshot().events.find(e => e.id === weekly.id);
ok('单次改动写入 overrides，原系列未被整体改写',
  afterOne.overrides && Object.keys(afterOne.overrides).length === 1 && !afterOne.repeat.until,
  Object.keys(afterOne.overrides || {}).join(','));
T.S.cur = { ...weekly }; T.H.del(el('del'));
ok('删除重复日程也先弹三选一', /仅此事件/.test(store.mDetail || ''));
T.H.ask(el('ask', 'one')); await wait(30);
const afterDel = T.snapshot().events.find(e => e.id === weekly.id);
ok('「仅此事件删除」落到 exdates', (afterDel.exdates || []).length === 1, (afterDel.exdates || []).join(','));

console.log('\n5 待办与倒数日');
T.H.new(el('new', 'todo'));
getEl('f-t').value = '交物业费';
await T.H.save(); await wait(30);
const todo = T.snapshot().events.find(e => e.title === '交物业费');
ok('待办可创建', !!todo && todo.kind === 'todo');
ok('待办不出现在日历展开里', !D.expandRange(T.snapshot().events, D.todayKey(), D.todayKey()).some(e => e.id === todo.id));
T.S.page = 3; T.render();
ok('壁挂「待办」页显示它并可打勾', /交物业费/.test(host()) && /data-todo=/.test(host()));
await T.H.todo(el('todo', todo.id)); await wait(30);
ok('打勾后从未完成清单消失', !T.snapshot().open.some(e => e.id === todo.id));
T.H.new(el('new', 'countdown'));
getEl('f-t').value = '奶奶生日'; getEl('f-d').value = D.dadd(D.todayKey(), 12);
T.S.form.rp = 'yearly';
await T.H.save(); await wait(30);
const cd = T.snapshot().cds.find(c => c.title === '奶奶生日');
ok('倒数日创建并算出剩余天数', !!cd && cd.daysLeft === 12, cd ? cd.daysLeft + ' 天后' : '-');
T.S.page = 0; T.S.base = 'kiosk'; T.S.layer = 'kiosk'; T.render();
ok('倒数日出现在壁挂右栏', /奶奶生日/.test(host()));

console.log('\n6 成员');
T.H['mem-new'](el('mem-new'));
ok('成员浮窗出现且带 8 色板', /id="m-n"/.test(store.mMem || '') && (store.mMem || '').split('data-pal=').length - 1 === 8);
getEl('m-n').value = '爷爷'; T.H.pal(el('pal', 'teal'));
await T.H.msave(); await wait(30);
const grand = T.snapshot().members.find(m => m.name === '爷爷');
ok('新增成员成功、首字自动取名字第一个字', !!grand && grand.initial === '爷' && grand.colorKey === 'teal');
await T.H['mem-arch'](el('mem-arch', grand.id)); await wait(30);
ok('归档后不在在列成员里', !T.snapshot().members.some(m => m.id === grand.id));

console.log('\n6b 本轮修复项');
T.S.form = null; T.S.memForm = null; T.S.base = 'sheet'; T.S.layer = 'sheet';
T.S.tab = 'cal'; T.render();
const calTab = store.sheet || '';
ok('日历 tab 右侧面板在 DOM 里（选中日列表 + 新增按钮）',
  /class="paneList"/.test(calTab) && /data-new="event"/.test(calTab));
ok('calwrap 有明确最小高度（防 1fr 塌陷把面板挤出可视区）',
  /\.calwrap\{[^}]*min-height:\d+vh/.test(readCss),
  (readCss.match(/\.calwrap\{[^}]*\}/) || [''])[0].slice(0, 46));
const mbSize = +(readCss.match(/\.managebtn\{[^}]*font-size:([\d.]+)vmin/) || [0, 99])[1];
ok('管理入口字号已调小（≤2.4vmin）且保留边框', mbSize <= 2.4 && /\.managebtn\{[^}]*border:1px/.test(readCss), mbSize + 'vmin');

T.H.new(el('new', 'event'));
const evForm = store.dr || '';
ok('日程浮窗含「重复」与「结束日期」',
  /<label>重复<\/label>/.test(evForm) && /更多：重复 · 结束日期/.test(evForm));
T.S.form = null; T.H.new(el('new', 'todo'));
const todoForm = store.dr || '';
ok('待办浮窗不含日程专属字段（重复/结束日期/时间）',
  !/<label>重复<\/label>/.test(todoForm) && !/id="f-until"/.test(todoForm)
  && !/id="f-tm"/.test(todoForm) && /更多：提醒 · 备注/.test(todoForm), '按类型分支渲染');
T.S.form = null; T.H.new(el('new', 'countdown'));
const cdForm = store.dr || '';
ok('倒数日浮窗有「每年重复」但无时间/结束日期',
  /每年重复<\/label>/.test(cdForm) && !/id="f-tm"/.test(cdForm) && !/<label>结束日期<\/label>/.test(cdForm));
T.S.form = null;

/* 归档成员必须可见可恢复：此前 snapshot 没有 archived，归档等于人间蒸发 */
T.S.memForm = { name: '', initial: '', colorKey: 'violet', family: false };
getEl('m-n').value = '测试归档';          // 走真实输入路径，不直接改状态
await T.H.msave(); await wait(30);
const tmp = T.snapshot().members.find(m => m.name === '测试归档');
ok('新增成员成功（首字自动取）', !!tmp && tmp.initial === '测', tmp ? tmp.initial : '-');
await T.H['mem-arch'](el('mem-arch', tmp.id)); await wait(30);
ok('snapshot 提供 archived 列表', Array.isArray(T.snapshot().archived) && T.snapshot().archived.some(m => m.id === tmp.id));
T.S.tab = 'members'; T.render();
ok('成员 tab 显示「已归档」与恢复按钮',
  /已归档/.test(store.sheet || '') && /data-mem-unarch/.test(store.sheet || ''));
await T.H['mem-unarch'](el('mem-unarch', tmp.id)); await wait(30);
ok('恢复后成员回到在列', T.snapshot().members.some(m => m.id === tmp.id));

/* 编辑成员时输入必须写回成员表单，不能污染日程表单 */
T.S.form = { kind: 'event', title: '', memberId: 'm-family', date: D.todayKey(),
  time: '', rp: '', until: '', note: '', reminders: [], allDay: false, pin: false, scope: 'all' };
T.S.memForm = { editId: tmp.id, name: '测试归档', initial: '测', colorKey: 'violet', family: false };
/* 走真实路径：触发 main.js 注册的 input 监听，让 readForm 自己判断归属 */
T.S.form.title = '';
getEl('m-n').value = '爷爷';
(lis.input[0])({ target: getEl('m-n') });
ok('成员输入写回成员表单、不污染日程表单（走真实 input 监听）',
  T.S.memForm.name === '爷爷' && T.S.form.title !== '爷爷',
  'memForm.name=' + T.S.memForm.name + ' / form.title=' + JSON.stringify(T.S.form.title));
T.S.form = null; T.S.memForm = null;
await T.H['mem-arch'](el('mem-arch', tmp.id)); await wait(30);

console.log('\n7 主题与持久化');
T.setTheme('ink');
ok('切主题落到根元素属性', global.document.documentElement.getAttribute('data-theme') === 'ink');
ok('主题值已写入 meta（重启后保持）', (await T.repo().readMetaByPrefix('theme')).some(r => r.v === 'ink'));
T.setTheme('wood');

console.log('\n8 备份与存储状态');
const alert = T.S.backup;
ok('未备份时有提示文案', typeof alert.text === 'string' && alert.text.length > 0, alert.text);
await T.repo().setMeta('lastBackupAt', new Date().toISOString());
T.refresh(); T.render();
ok('刚备份过提示转正常', T.S.backup.level === 'ok', T.S.backup.text);
const est = await T.repo().estimate();
ok('能读到配额信息（用于告警）', typeof est.usage === 'number' && typeof est.quota === 'number',
  `${(est.usage / 1024).toFixed(0)}KB / ${(est.quota / 1048576).toFixed(0)}MB`);

console.log('\n9 提醒调度幂等');
const { makeAlarm } = await import('../src/alarm.js');
let fired = [];
const alarm = makeAlarm({ repo: T.repo(), onFire: l => { fired = fired.concat(l) }, tickMs: 999999 });
const target = T.snapshot().events.find(e => e.title === '接小雨放学');
const n0 = new Date(); n0.setMinutes(n0.getMinutes() - 1);          // 一分钟前到点：应触发
const hhmm = `${String(n0.getHours()).padStart(2, '0')}:${String(n0.getMinutes()).padStart(2, '0')}`;
await T.repo().patchEvent(target.id, { reminders: [0], date: D.todayKey(), time: hhmm });
await alarm.scan();
const first = fired.length;
await alarm.scan();
ok('到点提醒触发一次', first === 1, first + ' 次');
ok('重复扫描不重发（幂等键生效）', fired.length === first, fired.length + ' 次');
/* 过期分支：把时间改成 2 小时前、清掉幂等键后重扫，应只标灰不发声。
   断言只看目标事件——用全局计数会被别的日程到点提醒污染，测试之间不隔离。 */
const past = new Date(); past.setHours(past.getHours() - 2);
await T.repo().patchEvent(target.id, { time: `${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}` });
await T.repo().setMeta('fired:' + D.todayKey(), '[]');
let missed = 0, fired2 = [];
const a2 = makeAlarm({ repo: T.repo(), onFire: l => { fired2 = fired2.concat(l) }, onMissed: l => { missed += l.length } });
await a2.scan();
ok('超过 30 分钟的过期提醒不补发声，只计入 missed',
  !fired2.some(x => x.id === target.id) && missed >= 1,
  `该事件未发声，missed=${missed}`);

console.log('\n10 四页轮播都渲染');
for (let i = 0; i < 4; i++) { T.S.page = i; T.render();
  ok(`  第 ${i + 1} 页「${['今天', '本周', '本月', '待办'][i]}」有内容`, (host() || '').length > 800, (host()).length + ' 字符'); }
T.S.page = 0; T.render();

console.log('\n11 九个管理 tab + 四页壁挂：标签配对与产物卫生');
const V = await import('../src/views.js');
const VOIDTAG = ['input', 'br', 'img', 'hr'];
const balance = html => {
  const tags = new Set([...html.matchAll(/<([a-zA-Z][\w-]*)/g)].map(m => m[1]));
  const bad = [];
  for (const t of tags) {
    if (VOIDTAG.includes(t)) continue;
    const o = (html.match(new RegExp('<' + t + '(?=[\\s>])', 'g')) || []).length;
    const c = (html.match(new RegExp('</' + t + '>', 'g')) || []).length;
    if (o !== c) bad.push(`${t} ${o}/${c}`);
  }
  return bad;
};
const dirty = html => ['undefined', 'NaN', 'Invalid Date', '[object Object]', '${'].filter(w => html.includes(w));
T.S.base = 'sheet'; T.S.layer = 'sheet';
for (const t of V.TABS) {
  T.S.tab = t[0]; T.render();
  const html = store.sheet || '';
  ok(`  管理 tab「${t[1]}」有内容且标签配对`, html.length > 60 && balance(html).length === 0,
    balance(html).join(' ') || html.length + ' 字符');
  ok(`  管理 tab「${t[1]}」产物无脏值`, dirty(html).length === 0, dirty(html).join(','));
}
T.S.base = 'kiosk'; T.S.layer = 'kiosk'; T.S.tab = 'cal';
for (let i = 0; i < V.PAGES.length; i++) {
  T.S.page = i; T.render();
  const html = host();
  ok(`  壁挂第 ${i + 1} 页「${V.PAGES[i].name}」标签配对`, balance(html).length === 0,
    balance(html).join(' ') || html.length + ' 字符');
}
T.S.page = 0; T.S.sel = D.dadd(D.todayKey(), 3); T.render();
ok('看板日提示条出现且自身配对', /lookbar/.test(host()) && balance(host()).length === 0);
ok('提示条上写的是那一天而不是今天', /正在看 \d+月\d+日 周/.test(host()) && /回到今天/.test(host()));
T.S.sel = D.dadd(D.todayKey(), 45); T.render();
ok('看板日的空态文案跟着改口（不写"今天没有安排"）',
  /\d+月\d+日 周. · 没有安排/.test(host()) && !/今天没有安排/.test(host()),
  (host().match(/<b>\d+月[^<]*没有安排/) || [''])[0]);
T.S.sel = D.todayKey(); T.render();
ok('回到今天后提示条消失', !/lookbar/.test(host()));
T.S.page = 0; T.render();

/* 待办 tab 的滑动结构：三层齐了手势才有落点 */
T.S.base = 'sheet'; T.S.layer = 'sheet'; T.S.tab = 'todo'; T.render();
ok('待办 tab 渲染出滑动三层结构（.swipe / .swacts / data-swipe）',
  /class="swipe"/.test(store.sheet) && /data-swipe=/.test(store.sheet)
  && /data-swdel=/.test(store.sheet) && /data-swdone=/.test(store.sheet));
T.S.tab = 'cal'; T.render();
ok('日历 tab 的日程块带拖拽把手', /data-drag=/.test(sheet()) && /data-dragday=/.test(sheet()));
T.S.base = 'kiosk'; T.S.layer = 'kiosk'; T.S.tab = 'cal'; T.render();
ok('壁挂产物里没有任何手势把手', !/data-drag|data-swipe/.test(host()), '壁挂只认点击');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
