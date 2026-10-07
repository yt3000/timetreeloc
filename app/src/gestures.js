/* 手势层：把 Pointer Events 翻译成两个语义动作，只在管理页装配（壁挂端禁手势，见 docs/03 §4.2）
     1 跨日拖动 —— 把日程拖到日历另一格 = 改到那天（重复日程只挪这一次）
     2 左右滑   —— 待办行左滑露出「删除」、右滑露出「完成」；滑动本身不执行任何操作

   三条实现前提，都是踩过坑的：
     · 不用 HTML5 拖放（draggable / dragstart）：iOS Safari 对它的触摸支持等于没有，
       而这台设备的唯一真实交互方式就是触摸。
     · 位移低于阈值一律当点击：否则"点一下看详情"会变成"不小心改了日期"。
     · 手势完成后必须吞掉紧随其后的那一次 click：触摸抬起后浏览器一定补发 click，
       不吞的话拖完日期顺手就弹出详情浮层。 */

const TAP_SLOP = 8;          // 位移 ≤ 8px 视为点击
const OPEN_W = 96;           // 量不到按钮宽度时的兜底；正常由 measure() 读 CSS 实际宽度
const REVEAL = 0.5;          // 滑过一半才保持在打开位
const SWALLOW_MS = 500;      // 吞 click 的有效期：没有 click 跟来时不能让标记一直挂着

export function makeGestures({
  onMoveDay = () => {}, allow = () => true,
  doc = globalThis.document, openWidth = OPEN_W
} = {}) {
  let act = null;                 // 当前手势（同一时刻只允许一个）
  let swallowAt = 0;              // 手势之后要忽略的 click 截止时间

  const pick = (t, sel) => (t && t.closest ? t.closest(sel) : null);
  const cls = (el, c) => !!(el && el.classList && el.classList.contains(c));
  const rowOf = el => (el && el.parentNode && cls(el.parentNode, 'swipe')) ? el.parentNode : null;

  function closeRow(w) {
    if (!w) return;
    w.classList.remove('open-l'); w.classList.remove('open-r');
    const body = w.querySelector ? w.querySelector('[data-swipe]') : null;
    if (body) { body.classList.remove('swiping'); body.style.transform = ''; }
  }
  function closeAllRows() {
    if (!doc.querySelectorAll) return;
    [...doc.querySelectorAll('.swipe.open-l,.swipe.open-r')].forEach(closeRow);
  }

  /* ---------- 按下：判定落在哪种可手势元素上 ---------- */
  function down(ev) {
    /* 新的一次按下意味着上一手势的 click 已经过去了：
       不清掉的话，"左滑露出删除"后紧接着那一下快点会被自己吞掉 */
    swallowAt = 0;
    if ((ev.button || 0) !== 0) return;                                  // 只认主键与单指
    if (pick(ev.target, '[data-swdel]') || pick(ev.target, '[data-swdone]')) return;   // 露出的按钮交给 click
    const sw = pick(ev.target, '[data-swipe]');
    const dr = sw ? null : pick(ev.target, '[data-drag]');
    const kind = sw ? 'swipe' : (dr ? 'move' : null);
    if (!kind || !allow(kind)) return;
    if (sw) {
      const w = rowOf(sw);
      /* 点在已经张开的行上：这一指只负责收起，不开新一轮滑动 */
      if (w && (cls(w, 'open-l') || cls(w, 'open-r'))) {
        closeRow(w); swallowAt = Date.now() + SWALLOW_MS; return;
      }
      act = { kind: 'swipe', el: sw, wrap: w, id: sw.dataset.swipe,
        x0: ev.clientX, y0: ev.clientY, dx: 0, moved: false };
      return;
    }
    const r = dr.getBoundingClientRect ? dr.getBoundingClientRect() : { left: 0, top: 0, width: 0 };
    act = { kind: 'move', el: dr, id: dr.dataset.drag, from: dr.dataset.dragday,
      x0: ev.clientX, y0: ev.clientY, gx: ev.clientX - r.left, gy: ev.clientY - r.top,
      w: r.width || 0, moved: false, over: null, overEl: null, ghost: null };
  }

  /* ---------- 进入拖动：造浮影 / 关掉行体过渡 ---------- */
  function start() {
    act.moved = true;
    closeAllRows();                                       // 同时只保留一处展开，避免与浮影打架
    if (act.kind !== 'move') { measure(act); act.el.classList.add('swiping'); return; }
    const g = doc.createElement('div');
    g.className = 'dragghost';
    g.textContent = act.el.textContent || '';
    if (doc.body && doc.body.appendChild) doc.body.appendChild(g);
    act.ghost = g;
    act.el.classList.add('drag-src');
  }
  /* 露出宽度以 CSS 实际量出来的为准：整套界面用 vmin 自适应，
     在 JS 里写死像素会在大屏上露一半按钮、小屏上一划就过头 */
  function measure(a) {
    const one = sel => {
      const e = a.wrap && a.wrap.querySelector ? a.wrap.querySelector(sel) : null;
      const w = e && e.getBoundingClientRect ? e.getBoundingClientRect().width : 0;
      return Math.max(48, Math.min(280, w || openWidth));
    };
    a.maxL = one('.swacts.r');   // 左滑露出右侧那组按钮
    a.maxR = one('.swacts.l');
  }
  function place(x, y) {
    const g = act.ghost; if (!g) return;
    g.style.left = Math.round(x - act.gx) + 'px';
    g.style.top = Math.round(y - act.gy) + 'px';
    if (act.w) g.style.width = Math.round(act.w) + 'px';
  }
  function markOver(x, y) {
    if (act.overEl) { act.overEl.classList.remove('dropover'); act.overEl = null; }
    act.over = null;
    if (!doc.elementFromPoint) return;
    const cell = pick(doc.elementFromPoint(x, y), '[data-day]');
    if (!cell || cell.dataset.day === act.from) return;   // 拖回原格不算目标
    act.over = cell.dataset.day; act.overEl = cell;
    cell.classList.add('dropover');
  }

  function move(ev) {
    if (!act) return;
    const dx = ev.clientX - act.x0, dy = ev.clientY - act.y0;
    if (!act.moved) {
      if (Math.abs(dx) < TAP_SLOP && Math.abs(dy) < TAP_SLOP) return;
      if (act.kind === 'swipe' && Math.abs(dx) < Math.abs(dy)) { act = null; return; }  // 竖向意图 = 滚动
      start();
    }
    if (ev.preventDefault) ev.preventDefault();
    if (act.kind === 'move') { place(ev.clientX, ev.clientY); markOver(ev.clientX, ev.clientY); return; }
    act.dx = Math.max(-act.maxL, Math.min(act.maxR, dx));
    act.el.style.transform = 'translateX(' + Math.round(act.dx) + 'px)';
  }

  /* ---------- 抬手 / 取消：commit=false 时只复位不执行 ---------- */
  function finish(ev, commit) {
    if (!act) return;
    const a = act; act = null;
    if (!a.moved) return;                                  // 未过阈值：当普通点击放行
    swallowAt = Date.now() + SWALLOW_MS;
    if (a.kind === 'move') {
      if (a.ghost && a.ghost.remove) a.ghost.remove();
      a.el.classList.remove('drag-src');
      if (a.overEl) a.overEl.classList.remove('dropover');
      if (commit && a.over) Promise.resolve(onMoveDay(a.id, a.from, a.over)).catch(() => {});
      return;
    }
    a.el.classList.remove('swiping');
    const to = !commit ? 0
      : (a.dx <= -a.maxL * REVEAL ? -a.maxL : (a.dx >= a.maxR * REVEAL ? a.maxR : 0));
    if (a.wrap && a.wrap.classList) {
      a.wrap.classList.toggle('open-l', to < 0);
      a.wrap.classList.toggle('open-r', to > 0);
    }
    a.el.style.transform = to ? 'translateX(' + to + 'px)' : '';
  }

  doc.addEventListener('pointerdown', down);
  doc.addEventListener('pointermove', move);
  doc.addEventListener('pointerup', ev => finish(ev, true));
  doc.addEventListener('pointercancel', ev => finish(ev, false));
  /* 滚动会让触摸被系统接管，此时必须复位，否则浮影会留在屏幕上 */
  doc.addEventListener('scroll', closeAllRows, true);
  /* 只吞一次、且只在手势后 500ms 内吞；捕获阶段拦下，不影响 main.js 的唯一派发委托 */
  doc.addEventListener('click', ev => {
    if (!swallowAt) return;
    const stale = Date.now() > swallowAt;
    swallowAt = 0;
    if (stale) return;
    ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault();
  }, true);

  return {
    /* 供无头测试与界面层使用：busy 为真时不能重建 DOM，否则浮影指向的节点已游离 */
    busy: () => !!act,
    state: () => act,
    closeAll: closeAllRows
  };
}
