/* 控制器：状态 + 单一事件委托 + 定时器 + 启动。
   界面层（views.js）只产 HTML，所有交互都从这里走。
   只用一个 document 级 click 委托——逐个节点重绑 onclick 会因漏绑表现为"点了没反应"。 */
import { makeRepo } from './db.js';
import * as V from './views.js';
import { makeAlarm, playChime } from './alarm.js';
import { downloadBackup, readBackupFile, diffSummary, backupAlert } from './backup.js';
import { makeGestures } from './gestures.js';
import { todayKey, dadd, dparse, dkey, expandRange, prevDay } from './domain.js';

const S = {
  layer: 'kiosk', base: 'kiosk', page: 0, sel: todayKey(), anchor: todayKey().slice(0, 7),
  tab: 'cal', vmode: 'month', hidden: new Set(), theme: 'wood',
  rot: 20, cdRot: 5, idleBack: 60, idle: 0, cdIdx: 0, dayBack: 180, dayHold: 0,
  cur: null, askMode: null, form: null, memForm: null, fold: false, sound: true,
  banner: null, backup: { level: 'ok', text: '' }, persist: false, usage: 0, quota: 0, swReady: false,
  nightDim: '22:30 – 07:00', booting: true, undo: null
};
let repo, alarm, snap;

const $ = id => document.getElementById(id);
const els = {};
const el = id => (els[id] = els[id] || $(id));
/* 提示条支持一个「撤销」按钮：拖动改日期与滑动删除都是会改变数据的手势，
   没有反悔路径的手势等于把误触变成数据损失。带按钮时停留久一点。 */
function toast(msg, action) {
  const t = el('toast'); if (!t) return;
  S.undo = action && typeof action.run === 'function' ? action : null;
  t.innerHTML = `<span class="tt-t">${V.esc(msg)}</span>`
    + (S.undo ? `<button class="tt-u" data-undo>${V.esc(S.undo.label || '撤销')}</button>` : '');
  t.classList.add('on');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => { t.classList.remove('on'); S.undo = null; }, S.undo ? 6000 : 2600);
}

/* ---------- 渲染 ---------- */
function refresh() { snap = V.snapshot(repo); S.backup = backupAlert(repo); }
function render() {
  refresh();
  el('host').innerHTML = V.hostHTML(snap, S);
  el('sheet').innerHTML = S.base === 'sheet' ? V.sheetHTML(snap, S) : '';
  el('sheet').classList.toggle('on', S.base === 'sheet');
  const ask = V.askHTML(snap, S);
  el('mDetail').innerHTML = ask || (S.cur ? V.detailHTML(snap, S) : '');
  el('mDetail').classList.toggle('on', !!ask || (!!S.cur && S.layer === 'detail'));
  el('dr').innerHTML = S.form ? V.editorHTML(snap, S) : '';
  el('dr').classList.toggle('on', !!S.form);
  el('mMem').innerHTML = S.memForm ? V.memberHTML(snap, S) : '';
  el('mMem').classList.toggle('on', !!S.memForm);
  el('rb').innerHTML = V.bannerHTML(snap, S);
  el('rb').classList.toggle('on', !!S.banner);
}
function setTheme(id) {
  if (!V.THEMES.some(t => t.id === id)) return;
  S.theme = id;
  document.documentElement.setAttribute('data-theme', id);
  repo.setMeta('theme', id);
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = { ink: '#0e1116', night: '#000205', paper: '#f4f5f7', wood: '#f3ece1' }[id];
  render();
}
function back() { S.layer = S.base === 'sheet' ? 'sheet' : 'kiosk'; S.cur = null; S.askMode = null; }

/* ---------- 表单状态：所有字段走 S.form，重渲染不丢输入 ---------- */
const FMAP = { 'f-t': 'title', 'f-d': 'date', 'f-tm': 'time', 'f-nt': 'note', 'f-until': 'until', 'm-n': 'name', 'm-i': 'initial' };
/* 输入框按 id 前缀归属：m-* 属于成员表单，f-* 属于日程表单。
   早先写成 `S.form || S.memForm`，编辑成员时输入的名字会被塞进日程表单。 */
function readForm() {
  Object.keys(FMAP).forEach(id => {
    const e = $(id); if (!e || e.value === undefined) return;
    const target = id.startsWith('m-') ? S.memForm : S.form;
    if (target) target[FMAP[id]] = e.value;
  });
  const rp = $('f-rp'); if (rp && S.form) S.form.rp = rp.value;
}
function newForm(kind, date) {
  return { kind, title: '', memberId: (snap.members[0] || {}).id,
    date: date || S.sel, time: '', rp: '', until: '', note: '', reminders: [], allDay: false, pin: false, scope: 'all' };
}
function editForm(e) {
  return { kind: e.kind, editId: e.id, title: e.title, memberId: e.memberId, date: e.date,
    time: e.time || '', rp: e.repeat ? e.repeat.freq : '', until: (e.repeat && e.repeat.until) || '',
    note: e.note || '', reminders: [...(e.reminders || [])], allDay: !!e.allDay, pin: !!e.pin,
    sortOrder: e.sortOrder || 0, scope: 'all' };
}
function buildRepeat(f) {
  if (!f.rp) return null;
  const base = f.rp === 'weekdays' ? { freq: 'weekdays' }
    : f.rp === 'weekly' ? { freq: 'weekly', byWeekdays: [dparse(f.date).getDay()] }
    : { freq: f.rp };
  if (f.until) base.until = f.until;
  return base;
}

/* ---------- 交互表：一个 data-* 对应一个函数 ---------- */
const H = {
  sheet: () => { S.base = 'sheet'; S.layer = 'sheet'; S.tab = 'cal'; render(); },
  exit: () => { S.base = 'kiosk'; S.layer = 'kiosk'; S.form = null; S.memForm = null; render(); },
  close: () => { back(); render(); },
  cancel: () => { S.form = null; S.memForm = null; S.askMode = null; render(); },
  tab: e => { S.tab = e.dataset.tab; render(); },
  vm: e => { S.vmode = e.dataset.vm; render(); },
  day: e => { S.sel = e.dataset.day; S.anchor = S.sel.slice(0, 7); S.dayHold = 0; render(); },
  jumpday: e => { S.sel = e.dataset.jumpday; S.anchor = S.sel.slice(0, 7); S.page = 0; S.dayHold = 0; render(); },
  today: () => { S.sel = todayKey(); S.anchor = S.sel.slice(0, 7); S.dayHold = 0; S.idle = 0; render(); },
  mo: e => { const d = dparse(S.anchor + '-01'); d.setMonth(d.getMonth() + Number(e.dataset.mo));
    S.anchor = dkey(d).slice(0, 7); S.sel = S.anchor + '-01';
    if (S.anchor === todayKey().slice(0, 7)) S.sel = todayKey(); render(); },
  f: e => { const id = e.dataset.f;
    S.hidden = new Set(S.hidden.has(id) ? [...S.hidden].filter(x => x !== id) : [...S.hidden, id]); render(); },
  cdnext: () => { const n = snap.cds.length; if (n) S.cdIdx = (S.cdIdx + 1) % n; render(); },
  'set-theme': e => { setTheme(e.dataset.setTheme); toast('主题已切换为「' + V.THEMES.find(t => t.id === e.dataset.setTheme).name + '」'); },
  'sw-sound': () => { S.sound = !S.sound; repo.setMeta('sound', S.sound ? '1' : '0'); render(); },
  chime: async () => { const ok = await playChime(); toast(ok ? '若听不到：检查 iPad 侧边静音开关与音量' : '此浏览器不支持网页音频'); },
  'banner-close': () => { S.banner = null; render(); },

  /* ---- 打开与编辑 ---- */
  open: e => { const ev = snap.events.find(x => x.id === e.dataset.open); if (!ev) return;
    S.cur = { ...ev }; S.layer = 'detail'; render(); },
  edit: () => { const e = S.cur; if (!e) return;
    if (e.repeat) { S.askMode = 'edit'; render(); return; }
    S.form = editForm(e); S.cur = null; render(); focusTitle(); },
  copy: async () => { const e = S.cur; if (!e) return;
    await repo.putEvent({ ...e, id: null, seriesId: null, date: todayKey(), version: 0,
      repeat: null, exdates: [], overrides: [], doneAt: null });
    S.cur = null; render(); toast('已复制到今天'); },
  del: () => { const e = S.cur || (S.form && snap.events.find(x => x.id === S.form.editId));
    if (!e) return;
    if (e.repeat) { S.askMode = 'del'; S.cur = { ...e }; S.form = null; render(); return; }
    return doDel(e.id, 'all', e.date); },
  ask: async e => {
    const scope = e.dataset.ask, ev = S.cur, mode = S.askMode;
    if (!ev) { S.askMode = null; render(); return; }
    if (mode === 'del') return doDel(ev.id, scope, ev.date);
    S.askMode = null;
    S.form = { ...editForm(ev), scope, date: scope === 'all' ? ev.date : ev.date };
    render(); focusTitle();
  },
  /* ---- 编辑浮窗内部 ---- */
  kind: e => { readForm(); S.form.kind = e.dataset.kind; if (S.form.kind !== 'event') { S.form.rp = ''; S.form.until = ''; } render(); },
  pick: e => { readForm(); S.form.memberId = e.dataset.pick; render(); },
  rm: e => { readForm(); const v = Number(e.dataset.rm);
    S.form.reminders = S.form.reminders.includes(v) ? S.form.reminders.filter(x => x !== v) : [...S.form.reminders, v]; render(); },
  sw: e => { readForm(); const k = e.dataset.sw; S.form[k] = !S.form[k]; render(); },
  fold: () => { readForm(); S.fold = !S.fold; render(); setTimeout(focusTitle, 40); },
  new: e => { S.form = newForm(e.dataset.new || 'event'); render(); focusTitle(); },
  save: async () => {
    readForm(); const f = S.form; if (!f) return;
    if (!String(f.title).trim()) { toast('标题不能为空'); return; }
    if (!f.memberId) { toast('请选择成员'); return; }
    const repeat = f.kind === 'event' ? buildRepeat(f) : (f.kind === 'countdown' && f.rp === 'yearly' ? { freq: 'yearly' } : null);
    const patch = { kind: f.kind, title: String(f.title).trim(), memberId: f.memberId, date: f.date,
      time: f.kind === 'event' && !f.allDay ? (f.time || null) : null,
      allDay: f.kind !== 'event' || !f.time, repeat,
      reminders: [...(f.reminders || [])].sort((a, b) => a - b), note: f.note || '', pin: !!f.pin };
    try {
      if (!f.editId) {
        await repo.putEvent({ ...patch, sortOrder: f.kind === 'todo' ? snap.todos.length + 1 : 0 });
      } else if (!f.scope || f.scope === 'all' || !(snap.events.find(x => x.id === f.editId) || {}).repeat) {
        const cur = snap.events.find(x => x.id === f.editId);
        await repo.putEvent({ ...cur, ...patch, version: cur.version });
      } else {
        await repo.applyScope(f.editId, f.scope, f.date, patch);
      }
      S.form = null; S.fold = false; render(); toast('已保存到本机');
    } catch (err) { toast('保存失败：' + err.message); }
  },

  /* ---- 待办打勾 ---- */
  todo: async e => { const ev = snap.events.find(x => x.id === e.dataset.todo); if (!ev) return;
    await repo.setTodoDone(ev.id, !ev.doneAt);
    if (S.cur && S.cur.id === ev.id) S.cur = null;
    render(); toast(ev.doneAt ? '已撤销完成' : '已完成：' + ev.title); },

  /* ---- 手势带来的三个动作：撤销、滑动删除、滑动完成 ---- */
  undo: async () => { const a = S.undo; S.undo = null;
    const t = el('toast'); if (t) { t.classList.remove('on'); t.innerHTML = ''; }
    if (!a) return;
    try { await a.run(); toast('已撤销'); } catch (err) { toast('撤销失败：' + err.message); } },
  swdel: async e => { const id = e.dataset.swdel; const ev = snap.events.find(x => x.id === id);
    if (!ev) return;
    await repo.deleteEvent(id); gestures.closeAll(); render();
    toast(`已删除待办「${ev.title}」`, { label: '撤销', run: async () => { await repo.undelete(id); render(); } }); },
  swdone: async e => { const id = e.dataset.swdone; const ev = snap.events.find(x => x.id === id);
    if (!ev) return;
    const was = !!ev.doneAt;
    await repo.setTodoDone(id, !was); gestures.closeAll(); render();
    toast(was ? '已撤销完成：' + ev.title : '已完成：' + ev.title,
      { label: '撤销', run: async () => { await repo.setTodoDone(id, was); render(); } }); },
  dayback: async () => { const opts = [60, 180, 600];
    S.dayBack = opts[(opts.indexOf(S.dayBack) + 1) % opts.length];
    await repo.setMeta('dayBackSec', S.dayBack); render();
    toast(`点开的某天停留 ${Math.round(S.dayBack / 60)} 分钟`); },

  /* ---- 成员 ---- */
  'mem-new': () => { S.memForm = { name: '', initial: '', colorKey: firstFreeColor(), family: false }; render(); },
  'mem-edit': e => { const m = snap.byId[e.dataset.memEdit]; if (!m) return;
    S.memForm = { editId: m.id, name: m.name, initial: m.initial, colorKey: m.colorKey, family: m.kind === 'family' }; render(); },
  'mem-arch': async e => { const m = snap.byId[e.dataset.memArch]; if (!m || m.kind === 'family') return;
    await repo.putMember({ ...m, archived: true }); render(); toast('已归档 ' + m.name + '，历史日程仍保留归属'); },
  'mem-unarch': async e => { const m = (snap.archived || []).find(x => x.id === e.dataset.memUnarch) || snap.byId[e.dataset.memUnarch];
    if (!m) return; await repo.putMember({ ...m, archived: false }); render(); toast('已恢复 ' + m.name); },
  pal: e => { if (e.classList.contains('used')) return; S.memForm.colorKey = e.dataset.pal; render(); },
  'mem-family': () => { S.memForm.family = !S.memForm.family; render(); },
  msave: async () => { readForm(); const f = S.memForm;
    if (!String(f.name).trim()) { toast('名字不能为空'); return; }
    try {
      await repo.putMember({ id: f.editId, name: String(f.name).trim(), initial: f.initial,
        colorKey: f.colorKey, kind: f.family ? 'family' : 'person' });
      S.memForm = null; render(); toast(f.editId ? '成员已更新' : '已新增成员');
    } catch (err) { toast('保存失败：' + err.message); } },

  /* ---- 备份与存储 ---- */
  async export() { try { const r = await downloadBackup(repo); await storageInfo(); render();
      toast(`已导出 ${r.count} 条：${r.file}`); } catch (err) { toast('导出失败：' + err.message); } },
  import: () => { const i = $('imp'); if (i) i.click(); },
  async persist() { S.persist = await repo.persist(); render();
    toast(S.persist ? '持久存储已授予' : '浏览器未授予，空间紧张时仍可能被清理'); },
  async purge() { const n = await repo.purgeTombstones(30); render(); toast(n ? `已清理 ${n} 条墓碑` : '没有可清理的墓碑'); },
  async clear() {
    if (!confirm('这会清空本机全部日程、待办、倒数日与成员，且不可撤销。\n确定前请先「导出 JSON」备份。仍要继续？')) return;
    if (!confirm('再次确认：真的要清空这台设备上的全部数据？')) return;
    await repo.clearAll(); S.base = 'kiosk'; S.layer = 'kiosk'; S.form = null; render(); toast('已清空并恢复默认成员'); },
};
async function doDel(id, scope, day) {
  await repo.applyScope(id, scope, day, {});
  S.askMode = null; S.cur = null; S.form = null; render();
  toast('已按「' + (scope === 'one' ? '仅此事件' : scope === 'future' ? '此事件及以后' : '整个系列') + '」删除');
}
function firstFreeColor() {
  const used = snap.members.map(m => m.colorKey);
  return ['blue', 'green', 'orange', 'pink', 'violet', 'teal', 'red', 'slate'].find(c => !used.includes(c)) || 'blue';
}
function focusTitle() { setTimeout(() => { const i = $('f-t') || $('m-n'); if (i) i.focus(); }, 260); }

/* ---------- 拖动改日期 ----------
   语义按 docs/02 §4.1 的「仅此事件」：重复日程拖一次只挪那一天，
   底层拆成「原日加例外 + 目标日新建独立日程」，因为 overrides 按日期索引、表达不了换日。 */
async function moveDay(id, from, to) {
  const ev = snap.events.find(x => x.id === id);
  const title = (ev || {}).title || '这条日程';
  let info;
  try { info = await repo.moveInstance(id, from, to); } catch (err) { toast('改日期失败：' + err.message); return; }
  if (!info) return;
  render();
  toast(`「${title}」已挪到 ${V.md(to)}${info.kind === 'split' ? '（只这一次）' : ''}`,
    { label: '撤销', run: async () => { await repo.undoMove(info); render(); } });
}
/* allow 按手势种类分别放行：拖日程只在日历 tab 的月/周视图（日视图没有可投放的格子，
   给一个拖不动的手势等于骗人），滑动待办只在待办 tab，
   且任何浮层打开时一律不认手势——浮层底下拖动等于看不见地在改数据。 */
const gestures = makeGestures({
  allow: kind => S.base === 'sheet' && !S.form && !S.memForm && !S.askMode && !S.cur
    && (kind === 'move' ? S.tab === 'cal' && S.vmode !== 'day'
      : kind === 'swipe' ? S.tab === 'todo' : false),
  onMoveDay: (id, from, to) => moveDay(id, from, to)
});

/* ---------- 委托：click / input / change ---------- */
const keys = () => Object.keys(H).sort((a, b) => b.length - a.length);
document.addEventListener('click', ev => {
  const t = ev.target;
  if (!t || !t.closest) return;
  const hit = t.closest(keys().map(k => `[data-${k}]`).join(','));
  if (!hit) {
    /* 点遮罩空白：只收起详情/三选一这类只读浮层。
       编辑浮窗不吃这个——正在打字时点空白关掉会吞掉输入 */
    const mask = t.closest && t.closest('.mask.on');
    if (mask && !t.closest('.panel')) { S.askMode = null; S.cur = null; render(); }
    return;
  }
  const key = keys().find(k => hit.hasAttribute('data-' + k));
  if (!key) return;
  ev.stopPropagation(); S.idle = 0;
  Promise.resolve(H[key](hit, ev)).catch(e => toast('操作失败：' + e.message));
});
document.addEventListener('input', ev => { if (FMAP[ev.target.id]) readForm(); });
document.addEventListener('change', async ev => {
  const id = ev.target.id;
  if (id === 'f-rp') { readForm(); render(); return; }
  if (id === 'f-until') { readForm(); render(); return; }
  if (id === 'imp' && ev.target.files && ev.target.files[0]) {
    try {
      const payload = await readBackupFile(ev.target.files[0]);
      const d = diffSummary(repo, payload);
      if (!confirm(`将合并：事件 新增 ${d.events.add} / 更新 ${d.events.upd} / 跳过 ${d.events.skip}，`
        + `成员 新增 ${d.members.add} / 更新 ${d.members.upd} / 跳过 ${d.members.skip}。\n不会删除本机任何记录。继续？`)) return;
      const r = await repo.merge(payload);
      render(); toast(`导入完成：新增 ${r.events + r.members} 条`);
    } catch (e) { toast('导入失败：' + e.message); }
    ev.target.value = '';
    return;
  }
  if (id === 'rng-rot') { S.rot = Number(ev.target.value); await repo.setMeta('kioskRotSec', S.rot); render(); }
  if (id === 'rng-cd') { S.cdRot = Number(ev.target.value); await repo.setMeta('cdRotSec', S.cdRot); startCdTimer(); render(); }
});
document.addEventListener('pointerdown', () => { S.idle = 0; });
addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' && S.layer === 'kiosk' && !S.form) { S.page = (S.page + 1) % V.PAGES.length; render(); }
  if (e.key === 'ArrowLeft' && S.layer === 'kiosk' && !S.form) { S.page = (V.PAGES.length + S.page - 1) % V.PAGES.length; render(); }
  if (e.key === 'Escape') {
    /* Esc 只收起最上层浮层；退出管理页必须点「✕ 回到壁挂」 */
    if (S.form || S.memForm || S.askMode || S.cur) { S.form = null; S.memForm = null; S.askMode = null; back(); render(); }
  }
  if (e.key.toLowerCase() === 'r' && S.layer === 'kiosk') previewBanner();
});

/* ---------- 定时器：时钟 / 轮播 / 倒数日 / 自动回落 ---------- */
function tickClock() {
  const n = new Date(), c = $('clk');
  if (c) c.innerHTML = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}<small>${String(n.getSeconds()).padStart(2, '0')}</small>`;
}
/* 一秒一跳。单独抽成函数是为了能在无头测试里直接调用——
   "点了某天要停留、停留完自动回今天"这类行为，用 setInterval 包着就测不到。 */
function oneSecond() {
  tickClock();
  /* 手指还按在拖动/滑动上：这一秒什么都不做，别把手势正引用的 DOM 抽掉 */
  if (gestures.busy()) return;
  const overlay = S.form || S.memForm || S.cur || S.askMode;
  if (S.layer !== 'kiosk' || overlay) {
    S.idle++;
    /* 正在输入时绝不自动关；空表单静止 5 分钟才放弃 */
    if (S.form && S.idle > 300 && !String(S.form.title || '').trim()) { S.form = null; render(); return; }
    if (!S.form && !S.memForm && S.idle >= S.idleBack) { S.base = 'kiosk'; back(); render(); }
    return;
  }
  S.idle++;
  /* 点开了某一天：轮播照转（壁挂上没有任何翻页控件，停了就等于困死在这一页），
     但三页都以这天为基准，且超时自动回到今天——壁挂不能长期停在一个日子 */
  if (S.sel !== todayKey()) {
    S.dayHold++;
    if (S.dayHold >= S.dayBack) {
      S.sel = todayKey(); S.anchor = S.sel.slice(0, 7); S.dayHold = 0; S.idle = 0; render(); return;
    }
  }
  if (S.idle >= S.rot) { S.idle = 0; S.page = (S.page + 1) % V.PAGES.length; render(); return; }
}
setInterval(oneSecond, 1000);
/* 倒数日独立计时：避免与主轮播互相打断 */
let cdTimer = null;
function startCdTimer() {
  clearInterval(cdTimer);
  cdTimer = setInterval(() => {
    if (S.layer !== 'kiosk' || S.form || S.memForm || gestures.busy() || !snap || snap.cds.length < 2) return;
    S.cdIdx = (S.cdIdx + 1) % snap.cds.length; render();
  }, Math.max(3, S.cdRot) * 1000);
}

function previewBanner() {
  const e = alarm ? alarm.preview() : null;
  if (!e) { toast('今天没有可演示的提醒'); return; }
  S.banner = e; render(); if (S.sound) playChime();
  clearTimeout(previewBanner.h);
  previewBanner.h = setTimeout(() => { S.banner = null; render(); }, 60000);
}

/* ---------- 启动 ---------- */
async function storageInfo() {
  const e = await repo.estimate();
  S.usage = e.usage; S.quota = e.quota;
  try { S.persist = await navigator.storage?.persisted?.() || false; } catch { S.persist = false; }
}
export async function boot() {
  repo = await makeRepo();
  const r = await repo.init();
  S.theme = r.settings.theme || 'wood';
  S.rot = r.settings.kioskRotSec || 20;
  S.cdRot = Number(r.settings.cdRotSec || 5);
  S.dayBack = Number(r.settings.dayBackSec || 180);
  S.nightDim = r.settings.nightDim || '22:30 – 07:00';
  S.sound = r.settings.sound !== '0';
  document.documentElement.setAttribute('data-theme', S.theme);
  await storageInfo();
  refresh();
  alarm = makeAlarm({ repo, soundOn: () => S.sound,
    onFire: list => { S.banner = list[0]; render(); if (S.sound) playChime();
      setTimeout(() => { S.banner = null; render(); }, 60000); },
    onMissed: () => render() });
  alarm.start();
  startCdTimer();
  S.booting = false;
  render();
  return { repo, S, snap };
}

/* 供无头测试直接驱动 handler 与状态（静态测试已保证 data-* 与 H 键一一对应） */
export const __test = { H, S, render, refresh, setTheme, snapshot: () => snap, repo: () => repo, boot,
  gestures, toast, oneSecond };

/* 浏览器入口：index.html 里 import('./src/main.js').then(m => m.boot()) */
if (typeof window !== 'undefined' && document.getElementById('host')) {
  boot().catch(err => {
    const h = document.getElementById('host');
    if (h) h.innerHTML = `<div class="empty"><div><b>启动失败</b><span>${String(err.message || err)}</span></div></div>`;
    console.error(err);
  });
  /* 注意：`'serviceWorker' in navigator` 对值为 undefined 的属性也返回 true，
     隐私模式或部分浏览器里 navigator.serviceWorker 本身就是 undefined */
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    navigator.serviceWorker.register('./sw.js').then(() => { S.swReady = true; }).catch(() => {});
  }
}
