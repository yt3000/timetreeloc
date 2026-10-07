/* 手势行为测试（node app/test/gesture.mjs）
   没有真机时，这是唯一的证据：真的派发 pointerdown / pointermove / pointerup / click，
   真的走到 repo 写库，再回读断言。上一轮就是同类测试抓到"点新增完全没反应"。
   覆盖：跨日拖动（单条 / 多日 / 重复）、拖完吞点击、撤销、待办左滑删除与右滑完成、
        竖向不抢滚动、轻点仍算点击、壁挂与浮层下手势必须失效、看板日提示条与自动返回。 */
import { makeDom, fakeIdb } from './dom.mjs';

const D = makeDom();
const doc = D.document;
/* 派发计数：测试自己也要防"一条断言蒙过去"，pointer 事件次数不够就直接判失败 */
let fired = 0;
const rawFire = D.fire.bind(D);
D.fire = (t, e) => { if (/^pointer/.test(t)) fired++; return rawFire(t, e); };
global.document = doc;
global.window = global;
/* Node 24 起 globalThis.navigator 是只读 getter，必须 defineProperty 才能换掉 */
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
  onLine: true, serviceWorker: undefined,
  storage: { async persist() { return true; }, async persisted() { return true; },
    async estimate() { return { usage: 4096, quota: 1e8 }; } } } });
global.addEventListener = (t, f) => { (D.lis[t] = D.lis[t] || []).push({ f, capture: false }); };
global.indexedDB = fakeIdb();
global.location = { origin: 'https://example.test', pathname: '/timetreeloc/' };
global.confirm = () => true;
global.Blob = class { constructor(p) { this.parts = p; } };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

let pass = 0, fail = 0;
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + l + (e ? ' → ' + e : '')); } else { fail++; console.log('  ✗ ' + l + (e ? ' → ' + e : '')); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
process.on('unhandledRejection', e => { console.log('  ✗ 未捕获异常：' + (e && e.stack || e)); process.exit(1); });

const M = await import('../src/main.js');
const T = M.__test;
for (let i = 0; i < 120 && T.S.booting; i++) await wait(10);
const repo = T.repo();
const Dm = await import('../src/domain.js');
const today = Dm.todayKey();
const day = n => Dm.dadd(today, n);

/* ---------- 造数据 ---------- */
const fam = (await repo.members())[0];
const mk = o => repo.putEvent({ memberId: fam.id, date: today, kind: 'event', reminders: [],
  exdates: [], overrides: {}, ...o });
const single = await mk({ title: '拖我单条', time: '09:00', date: day(2) });
const trip = await mk({ title: '三天出差', date: day(3), endDate: day(5) });
const weekly = await mk({ title: '拖我重复', time: '19:00', date: day(0),
  repeat: { freq: 'weekly', byWeekdays: [new Date().getDay()] } });
const todoA = await mk({ title: '左滑删我', kind: 'todo', sortOrder: 1 });
const todoB = await mk({ title: '右滑完成我', kind: 'todo', sortOrder: 2 });

/* ---------- 工具 ---------- */
async function openTab(tab) {
  T.S.base = 'sheet'; T.S.layer = 'sheet'; T.S.tab = tab; T.S.form = null;
  T.S.memForm = null; T.S.cur = null; T.S.askMode = null; T.S.vmode = 'month';
  T.S.sel = today; T.S.anchor = today.slice(0, 7);
  T.render(); await wait(10);
  D.layout();
}
const q = sel => doc.querySelector(sel);
const qa = sel => doc.querySelectorAll(sel);
const ghosts = () => doc.body.children.filter(c => c.className === 'dragghost').length;
const evOf = id => T.snapshot().events.find(e => e.id === id);
const cells = () => qa('[data-day]').map(e => e.dataset.day);
/* 目标格必须真的在网格里：月末那几天会掉出 42 格，写死日期会让测试在某些日子假失败 */
function pickCell(want, test) {
  const list = cells();
  const exact = list.find(d => d === want && (!test || test(d)));
  return exact || list.filter(test || (() => true)).pop() || list[list.length - 1];
}
const wd = d => Dm.dparse(d).getDay();
const otherWd = d => wd(d) !== wd(today);

/* 一次完整拖动：按住 → 分步移动 → 抬起 → 补发浏览器一定会发的那次 click */
async function dragTo(sel, targetSel) {
  const src = q(sel), dst = q(targetSel);
  if (!src || !dst) return { ok: false, why: `src=${!!src} dst=${!!dst}` };
  const a = D.center(src.getBoundingClientRect()), b = D.center(dst.getBoundingClientRect());
  D.fire('pointerdown', { target: src, clientX: a.x, clientY: a.y });
  for (let i = 1; i <= 6; i++) {
    D.fire('pointermove', { target: src, clientX: a.x + (b.x - a.x) * i / 6, clientY: a.y + (b.y - a.y) * i / 6 });
  }
  const busyMid = T.gestures.busy();
  const over = T.gestures.state();
  D.fire('pointerup', { target: src, clientX: b.x, clientY: b.y });
  const clicked = D.fire('click', { target: src });          // 真实浏览器：抬手后必发 click
  await wait(30);
  return { ok: true, busyMid, target: over && over.over, clicked };
}
/* 一次真实轻点：按下、抬起、click（按下会把上一次的"吞点击"清掉） */
function clickOn(sel) {
  const e = q(sel); if (!e) return false;
  const c = D.center(e.getBoundingClientRect());
  D.fire('pointerdown', { target: e, clientX: c.x, clientY: c.y });
  D.fire('pointerup', { target: e, clientX: c.x, clientY: c.y });
  D.fire('click', { target: e });
  return true;
}

/* ═════════ 1 跨日拖动：单条日程 ═════════ */
console.log('1 跨日拖动改日期（单条）');
await openTab('cal');
const chipSel = `[data-drag="${single.id}"][data-dragday="${day(2)}"]`;
ok('管理页日历里能找到可拖的日程块', !!q(chipSel), 'data-drag + data-dragday 就位');
ok('月网格有 42 个可投放的格子（防止空转）', cells().length === 42, cells().length + ' 格');
const tgt1 = pickCell(day(9));
let r = await dragTo(chipSel, `[data-day="${tgt1}"]`);
ok('拖动过程有 busy 状态、抬手后结束', r.ok && r.busyMid === true && T.gestures.busy() === false);
ok('拖完日期真的改了（写进 repo，不只是界面）', evOf(single.id).date === tgt1,
  evOf(single.id).date + ' ← ' + day(2));
ok('拖动后浮影已移除，不留残影', ghosts() === 0);
ok('拖完补发的 click 被吞掉，没有顺手弹出详情', !T.S.cur && T.S.layer !== 'detail', 'S.cur 仍为空');
ok('提示条出现且带「撤销」按钮', /data-undo/.test(doc.getElementById('toast').innerHTML) && !!T.S.undo);
clickOn('[data-undo]'); await wait(30);
ok('点撤销 → 日期回到原处', evOf(single.id).date === day(2), evOf(single.id).date);

/* ═════════ 2 轻点不算拖：仍然打开详情 ═════════ */
console.log('\n2 阈值：轻点必须仍是点击');
await openTab('cal');
const chip2 = q(chipSel), c2 = D.center(chip2.getBoundingClientRect());
D.fire('pointerdown', { target: chip2, clientX: c2.x, clientY: c2.y });
D.fire('pointermove', { target: chip2, clientX: c2.x + 3, clientY: c2.y + 2 });
D.fire('pointerup', { target: chip2, clientX: c2.x + 3, clientY: c2.y + 2 });
D.fire('click', { target: chip2 });
await wait(20);
ok('位移 3px 不触发拖动（日期没动）', evOf(single.id).date === day(2));
ok('轻点没被"吞点击"误伤 → 照常打开详情', !!T.S.cur && T.S.cur.id === single.id,
  T.S.cur ? T.S.cur.title : '详情没开');
T.S.cur = null; T.S.layer = 'sheet'; T.render();

/* ═════════ 3 多日日程：整条平移，跨度不变 ═════════ */
console.log('\n3 多日日程拖动（跨度必须保持）');
await openTab('cal');
const tgt3 = pickCell(day(11));
r = await dragTo(`[data-drag="${trip.id}"][data-dragday="${day(4)}"]`, `[data-day="${tgt3}"]`);
const tr = evOf(trip.id), delta = Dm.ddiff(day(4), tgt3);
ok(`从中间那天拖到 ${tgt3} → 起始日与结束日一起平移`,
  tr.date === Dm.dadd(day(3), delta) && tr.endDate === Dm.dadd(day(5), delta),
  `${tr.date} → ${tr.endDate}（平移 ${delta} 天）`);
ok('出差仍是 3 天（没有被压成一天）', Dm.ddiff(tr.date, tr.endDate) === 2,
  Dm.ddiff(tr.date, tr.endDate) + 1 + ' 天');
clickOn('[data-undo]'); await wait(30);
const tr2 = evOf(trip.id);
ok('撤销多日平移后回到原区间', tr2.date === day(3) && tr2.endDate === day(5), `${tr2.date} → ${tr2.endDate}`);

/* ═════════ 4 重复日程：只挪这一次 ═════════ */
console.log('\n4 重复日程拖动 = 只挪这一次');
await openTab('cal');
ok('拖动前今天有这一条', Dm.expandRange(T.snapshot().events, today, today).some(e => e.id === weekly.id));
/* 目标必须落在别的星期几，否则父系列那天本来也会出现，断言就说不清是谁 */
const tgt4 = pickCell(null, otherWd);
r = await dragTo(`[data-drag="${weekly.id}"][data-dragday="${today}"]`, `[data-day="${tgt4}"]`);
const wk = evOf(weekly.id);
ok(`今天加了例外（exdates 含 ${today}）`, (wk.exdates || []).includes(today), (wk.exdates || []).join(','));
ok('展开结果里今天这条没了', !Dm.expandRange(T.snapshot().events, today, today).some(e => e.id === weekly.id));
const onTarget = Dm.expandRange(T.snapshot().events, tgt4, tgt4).filter(e => e.title === '拖我重复');
ok(`目标日 ${tgt4} 出现且只有一条独立的挪过来日程`,
  onTarget.length === 1 && onTarget[0].repeat === null, onTarget.length + ' 条');
ok('系列其余部分仍照旧（下一个同星期几还在）',
  Dm.expandRange(T.snapshot().events, day(7), day(7)).some(e => e.id === weekly.id));
ok('系列本身没被整体改写（repeat 规则完好）', !!wk.repeat && wk.repeat.freq === 'weekly' && !wk.repeat.until);
const child = T.snapshot().events.find(e => e.title === '拖我重复' && e.id !== weekly.id);
clickOn('[data-undo]'); await wait(40);
const wk2 = evOf(weekly.id), child2 = evOf(child.id);
ok('撤销：例外取消 + 挪出去那条转墓碑（不静默硬删）',
  !(wk2.exdates || []).includes(today) && !!child2.deletedAt,
  'exdates=' + (wk2.exdates || []).length + ' / 墓碑=' + !!child2.deletedAt);
ok('撤销后今天的实例又回来了',
  Dm.expandRange(T.snapshot().events, today, today).some(e => e.id === weekly.id));

/* ═════════ 5 待办左滑删除 ═════════ */
console.log('\n5 待办左滑：露出按钮 → 点它才删');
await openTab('todo');
const row = q(`[data-swipe="${todoA.id}"]`), wrap = row.parentNode;
ok('待办行有滑动结构（.swipe / .swacts / data-swipe）',
  !!row && wrap.classList.contains('swipe') && !!wrap.querySelector('.swacts.r'), '三层结构齐');
const rc = D.center(row.getBoundingClientRect());
D.fire('pointerdown', { target: row, clientX: rc.x, clientY: rc.y });
for (let i = 1; i <= 6; i++) D.fire('pointermove', { target: row, clientX: rc.x - i * 20, clientY: rc.y });
D.fire('pointerup', { target: row, clientX: rc.x - 120, clientY: rc.y });
await wait(20);
ok('左滑后行停在打开位（位移落到样式上，露宽由 CSS 量出）',
  /translateX\(-96px\)/.test(row.style.transform || ''), row.style.transform);
ok('打开态用 open-l 标记，样式才描得出红边', wrap.classList.contains('open-l'));
ok('滑动本身不删任何东西（这是硬要求）', !evOf(todoA.id).deletedAt);
ok('露出的删除按钮就在同一行里', !!q(`.swipe [data-swdel="${todoA.id}"]`));
clickOn(`[data-swdel="${todoA.id}"]`); await wait(30);
ok('点露出的「删除」才写墓碑', !!evOf(todoA.id).deletedAt);
ok('删除提示条带撤销', /data-undo/.test(doc.getElementById('toast').innerHTML));
clickOn('[data-undo]'); await wait(30);
ok('撤销删除 → 待办原样回来', !evOf(todoA.id).deletedAt);

/* ═════════ 6 待办右滑完成 + 竖向让位滚动 ═════════ */
console.log('\n6 右滑完成 / 竖向不抢滚动');
const rowB = q(`[data-swipe="${todoB.id}"]`), wrapB = rowB.parentNode, cb = D.center(rowB.getBoundingClientRect());
D.fire('pointerdown', { target: rowB, clientX: cb.x, clientY: cb.y });
for (let i = 1; i <= 5; i++) D.fire('pointermove', { target: rowB, clientX: cb.x + i * 24, clientY: cb.y });
D.fire('pointerup', { target: rowB, clientX: cb.x + 120, clientY: cb.y });
await wait(20);
ok('右滑停在打开位 open-r', wrapB.classList.contains('open-r') && /translateX\(96px\)/.test(rowB.style.transform),
  rowB.style.transform);
clickOn(`[data-swdone="${todoB.id}"]`); await wait(30);
ok('点「完成」才打勾', !!evOf(todoB.id).doneAt);
clickOn('[data-undo]'); await wait(30);
ok('撤销完成又可逆', !evOf(todoB.id).doneAt);
const rowC = q(`[data-swipe="${todoB.id}"]`), cc = D.center(rowC.getBoundingClientRect());
D.fire('pointerdown', { target: rowC, clientX: cc.x, clientY: cc.y });
D.fire('pointermove', { target: rowC, clientX: cc.x + 3, clientY: cc.y + 140 });
D.fire('pointerup', { target: rowC, clientX: cc.x + 3, clientY: cc.y + 140 });
await wait(20);
ok('竖向拖动不被当成横向滑（行没张开、也没位移）',
  !rowC.parentNode.className.includes('open-') && !rowC.style.transform, JSON.stringify(rowC.style.transform));
ok('半程即松手 → 弹回原位不保持打开', (() => {
  const e = q(`[data-swipe="${todoA.id}"]`), c = D.center(e.getBoundingClientRect());
  D.fire('pointerdown', { target: e, clientX: c.x, clientY: c.y });
  D.fire('pointermove', { target: e, clientX: c.x - 20, clientY: c.y });
  D.fire('pointerup', { target: e, clientX: c.x - 20, clientY: c.y });
  return e.parentNode.className.includes('open-') === false && e.style.transform === '';
})(), '未过半 → 归位');

/* ═════════ 7 手势边界 ═════════ */
console.log('\n7 手势边界（防误触的底线）');
T.S.base = 'kiosk'; T.S.layer = 'kiosk'; T.S.tab = 'cal'; T.S.sel = today; T.render(); await wait(10);
const hostHtml = doc.getElementById('host').innerHTML;
ok('壁挂 HTML 里根本不存在拖拽/滑动把手', !/data-drag/.test(hostHtml) && !/data-swipe/.test(hostHtml),
  '壁挂只认点击');
await openTab('cal');
T.S.form = { kind: 'event', title: '', memberId: fam.id, date: today, time: '', rp: '', until: '',
  note: '', reminders: [], allDay: false, pin: false, scope: 'all' };
T.render(); await wait(10); D.layout();
const chip3 = q(chipSel);
const tgt7 = pickCell(null);
const cell7 = q(`[data-day="${tgt7}"]`);
if (chip3 && cell7) {
  const a = D.center(chip3.getBoundingClientRect()), b = D.center(cell7.getBoundingClientRect());
  D.fire('pointerdown', { target: chip3, clientX: a.x, clientY: a.y });
  for (let i = 1; i <= 6; i++) D.fire('pointermove', { target: chip3, clientX: a.x + (b.x - a.x) * i / 6, clientY: a.y + (b.y - a.y) * i / 6 });
  D.fire('pointerup', { target: chip3, clientX: b.x, clientY: b.y });
  await wait(30);
  ok('浮层打开时手势不生效（看不见地在改数据最危险）',
    evOf(single.id).date === day(2) && ghosts() === 0, evOf(single.id).date);
  T.S.form = null;
} else ok('浮层打开时手势不生效（找不到测试元素，需复查）', false, `${!!chip3}/${!!cell7}`);
T.S.form = null; T.render();

await openTab('cal');
const v0 = evOf(single.id).version;
r = await dragTo(chipSel, `[data-day="${day(2)}"]`);
ok('拖回原格 = 什么都不做（version 不涨）', evOf(single.id).version === v0 && evOf(single.id).date === day(2),
  'v' + v0 + ' → v' + evOf(single.id).version);
await openTab('todo');
ok('待办 tab 里只有滑动元素、没有拖拽把手', !!q('[data-swipe]') && !q('[data-drag]'));
await openTab('cal');
ok('日历 tab 里只有拖拽把手、没有滑动元素', !!q('[data-drag]') && !q('[data-swipe]'));

/* 周视图是另一套模板，把手必须同样挂上 */
await openTab('cal');
T.S.sel = day(2); T.render(); await wait(10); D.layout();
T.S.vmode = 'week'; T.render(); await wait(10); D.layout();
const wcells = cells();
ok('周视图渲染出 7 个可投放格子', wcells.length === 7, wcells.length + ' 格');
const wtgt = wcells.find(d => d !== day(2));
r = await dragTo(`[data-drag="${single.id}"][data-dragday="${day(2)}"]`, `[data-day="${wtgt}"]`);
ok('周视图里也能拖（两套模板都挂了把手）', r.ok && evOf(single.id).date === wtgt, wtgt || '没找到目标格');
clickOn('[data-undo]'); await wait(30);
ok('周视图拖动一样可撤销', evOf(single.id).date === day(2), evOf(single.id).date);
T.S.vmode = 'day'; T.render(); await wait(10); D.layout();
ok('日视图既不给把手也不给格子（不做拖不动的假 affordance）', !q('[data-drag]') && !q('[data-day]'));
T.S.vmode = 'month'; T.S.sel = today;

/* ═════════ 8 点了别的日子：提示条 / 回到今天 / 自动返回 ═════════ */
console.log('\n8 壁挂看板日提示条');
T.S.base = 'kiosk'; T.S.layer = 'kiosk'; T.S.page = 2; T.S.sel = today; T.render(); await wait(10);
const wallCells = qa('[data-jumpday]');
const target8 = day(6);
const cell8 = wallCells.find(e => e.dataset.jumpday === target8) || wallCells[3];
const d8 = cell8.dataset.jumpday;
D.fire('pointerdown', { target: cell8, clientX: 10, clientY: 10 });
D.fire('click', { target: cell8 }); await wait(20);
ok('壁挂月格点一下 → 选中那天并翻到第 1 页', T.S.sel === d8 && T.S.page === 0, 'sel=' + T.S.sel);
let wall = doc.getElementById('host').innerHTML;
ok('出现「正在看 X月X日 · 不是今天」提示条', /正在看 /.test(wall) && /不是今天/.test(wall),
  (wall.match(/正在看[^<]*/) || [''])[0]);
ok('提示条上有「回到今天」按钮', /data-today/.test(wall));
ok('大标题不再写「今天」，改成那一天的日期', /<h2>\d+月\d+日 周/.test(wall),
  (wall.match(/<h2>[^<]*/) || [''])[0]);
ok('格子里给看板日描了独立记号（与"今天"的强调色分开）', (() => {
  T.S.page = 2; T.render();
  return /class="mcell[^"]*sel/.test(doc.getElementById('host').innerHTML);
})(), '月格 .mcell.sel');
ok('看板日状态下轮播仍继续（壁挂没有翻页控件，一停就出不去）', (() => {
  const p0 = T.S.page; let changed = false;
  for (let i = 0; i < T.S.rot + 2; i++) { T.oneSecond(); if (T.S.page !== p0) changed = true; }
  return changed && T.S.sel === d8;
})(), '页码在走、定位仍是 ' + d8);
for (let i = 0; i < T.S.dayBack + 2; i++) T.oneSecond();
T.S.page = 0; T.render();
wall = doc.getElementById('host').innerHTML;
ok('超过停留时长自动回到今天，提示条消失', T.S.sel === today && !/正在看 /.test(wall), 'sel=' + T.S.sel);
ok('回到今天后大标题恢复成「今天」', /<h2>今天/.test(wall), (wall.match(/<h2>[^<]*/) || [''])[0]);
ok('手动点「回到今天」立即生效（不必等超时）', (() => {
  T.H.jumpday({ dataset: { jumpday: day(3) } });
  const btn = qa('[data-today]')[0];
  D.fire('click', { target: btn });
  return T.S.sel === today && T.S.dayHold === 0;
})(), '点按钮 → sel=' + T.S.sel);
ok('管理页同样有「回到今天」且文案随状态变', (() => {
  T.S.base = 'sheet'; T.S.tab = 'cal'; T.S.sel = day(3); T.render();
  const on = doc.getElementById('sheet').innerHTML;
  T.S.sel = today; T.render();
  const off = doc.getElementById('sheet').innerHTML;
  return /回到今天/.test(on) && !/回到今天/.test(off) && /选中/.test(on);
})(), '选中非今天时按钮写「回到今天」');

/* ═════════ 9 本文件没空转 ═════════ */
console.log('\n9 自检');
ok('真的派发过 pointer 事件（监听器都注册了）',
  (D.lis.pointerdown || []).length >= 2 && (D.lis.pointermove || []).length >= 1,
  (D.lis.pointerdown || []).length + ' 个 pointerdown 监听');
ok('click 监听 = 1 个捕获（吞点击）+ 1 个冒泡（唯一派发委托）',
  (D.lis.click || []).filter(l => l.capture).length === 1 && (D.lis.click || []).filter(l => !l.capture).length === 1,
  (D.lis.click || []).length + ' 个 click 监听');
ok('派发过 12 次以上 pointerdown（不是一两条蒙过去）', fired >= 12, fired + ' 次');
ok('解析界面 HTML 时没有标签不配对', D.warnings.length === 0, D.warnings.slice(0, 3).join(' / ') || '零告警');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
