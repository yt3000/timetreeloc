/* 视图层：只做"数据 → HTML 字符串"，不碰存储、不绑事件。
   事件全部由 main.js 的单一委托处理（见 docs/03 §4.2）。
   单机版没有并发，因此没有 409 冲突界面——那是多端方案才需要的东西。 */
import { expandRange, listTodos, openTodos, listCountdowns, todayKey, dadd, dparse, dkey, ddiff, prevDay, SCHEMA_VERSION } from './domain.js';

export const WEEK = '日一二三四五六';
export const KIND = { event: '日程', todo: '待办', countdown: '倒数日' };
export const PAGES = [{ name: '今天' }, { name: '本周' }, { name: '本月' }, { name: '待办' }];
export const TABS = [['cal', '日历'], ['todo', '待办'], ['cd', '倒数日'], ['members', '成员'],
  ['theme', '外观与主题'], ['remind', '提醒与声音'], ['kiosk', '壁挂与夜间盘'], ['backup', '备份'], ['about', '关于']];
export const THEMES = [
  { id: 'wood', name: '暖木', desc: '默认 · 纸质暖色，客厅装饰感' },
  { id: 'ink', name: '墨蓝', desc: '夜间友好，通用' },
  { id: 'night', name: '夜灰', desc: '纯黑底，卧室无光污染' },
  { id: 'paper', name: '纸白', desc: '白天强光、长辈看得清' }];

export const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const col = m => `var(--m-${(m || {}).colorKey || 'slate'})`;
export const ini = m => (m || {}).initial || '?';
export const name = m => (m || {}).name || '未知';

export function recurText(e) {
  const r = e.repeat; if (!r) return '';
  if (r.freq === 'weekdays') return '每个工作日';
  if (r.freq === 'weekly') return '每' + (r.byWeekdays || []).map(w => '周' + WEEK[w]).join('、');
  if (r.freq === 'monthly') return '每月同日';
  if (r.freq === 'yearly') return '每年';
  return r.freq || '';
}
export const remindText = r => r >= 1440 ? (r / 1440) + '天前' : (r === 0 ? '准点' : r + '分前');
/* 口语日期：界面文案一律 10月12日，不写 ISO（docs/03 §5） */
export const md = day => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
export const wkOf = day => '周' + WEEK[dparse(day).getDay()];
export const weekStart = day => dadd(day, -((dparse(day).getDay() + 6) % 7));
export const monthOf = day => day.slice(0, 7);
export const monthEnd = day => dkey(new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0));

/* ---------- 数据快照：一次算好，视图只读 ---------- */
export function snapshot(repo) {
  const events = repo.events(), allM = repo.members();
  const members = allM.filter(m => !m.archived), archived = allM.filter(m => m.archived);
  const byId = Object.fromEntries(repo.members().map(m => [m.id, m]));
  const today = todayKey();
  return {
    events, members, archived, byId, today,
    dayOf: d => expandRange(events, d, d),
    weekOf: d => expandRange(events, weekStart(d), dadd(weekStart(d), 6)),
    monthOf: d => expandRange(events, monthOf(d) + '-01', monthEnd(d)),
    todos: listTodos(events), open: openTodos(events), cds: listCountdowns(events, today),
    settings: repo.settings(), stats: repo.stats()
  };
}

/* ---------- 卡片 ---------- */
function evCard(e, s, opts = {}) {
  const m = s.byId[e.memberId];
  const src = s.events.find(x => x.id === e.id) || e;
  const multi = src.endDate && src.endDate !== src.date;
  const ord = multi ? `${ddiff(src.date, e.date) + 1}/${ddiff(src.date, src.endDate) + 1} 天` : '';
  const sub = [name(m), e.repeat ? '↻ ' + recurText(e) : '', ord ? '第 ' + ord : '', e.note]
    .filter(Boolean).join(' · ');
  const big = e.allDay ? (multi ? '持续' : `${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8))}`) : (e.time || '');
  const small = e.allDay ? (ord || '全天') : (e.endTime ? e.endTime + ' 结束' : '');
  return `<button class="ev ${e.pin ? 'pin' : ''}" data-open="${e.id}">
    <i class="bar" style="background:${col(m)}"></i>
    <div class="tm num">${esc(big)}<small>${esc(small)}</small></div>
    <div class="info"><b>${e.pin ? '📌 ' : ''}${esc(e.title)}</b><span>${esc(sub)}</span></div>
    <div class="who" style="background:${col(m)};color:var(--on-member)">${esc(ini(m))}</div>
    ${opts.pending ? '<span class="pend">待同步</span>' : ''}</button>`;
}
const empty = (big, small) => `<div class="empty"><div><b>${big}</b><span>${small}</span></div></div>`;

/* ---------- 壁挂四页 ---------- */
function pageToday(s, S) {
  const list = s.dayOf(S.sel).filter(e => !S.hidden.has(e.memberId)).slice(0, 6);
  const day = S.sel === s.today ? '今天' : `${md(S.sel)} ${wkOf(S.sel)} ·`;
  return list.length ? list.map(e => evCard(e, s)).join('')
    : empty(`${day} 没有安排`, '点「管理 ⚙」记一件事');
}
function pageWeek(s, S) {
  const start = weekStart(S.sel);
  let heads = '', cols = '';
  for (let i = 0; i < 7; i++) {
    const k = dadd(start, i), d = dparse(k), isToday = k === s.today, isSel = k === S.sel;
    heads += `<div class="${isToday ? 't' : ''} ${isSel && !isToday ? 's' : ''}">周${WEEK[d.getDay()]}<b class="num">${d.getDate()}</b></div>`;
    const list = s.dayOf(k).filter(e => !S.hidden.has(e.memberId));
    cols += `<button class="wkcol ${isToday ? 't' : ''} ${isSel ? 'sel' : ''}" data-jumpday="${k}">
      ${list.slice(0, 4).map(e => `<span class="wchip" style="background:${col(s.byId[e.memberId])}" data-open="${e.id}">
        <i class="num">${e.allDay ? '全天' : e.time}</i>${esc(e.title)}</span>`).join('')
        || '<span class="none">—</span>'}
      ${list.length > 4 ? `<span class="none">+${list.length - 4}</span>` : ''}</button>`;
  }
  return `<div class="wkwrap"><div class="wkhead">${heads}</div><div class="wkcols">${cols}</div></div>`;
}
function pageMonth(s, S) {
  const first = dparse(monthOf(S.sel) + '-01');
  const start = weekStart(monthOf(S.sel) + '-01');
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const k = dadd(start, i), d = dparse(k), out = d.getMonth() !== first.getMonth();
    const list = s.dayOf(k).filter(e => !S.hidden.has(e.memberId));
    cells += `<div class="mcell ${out ? 'out' : ''} ${k === s.today ? 'tdy' : ''} ${k === S.sel ? 'sel' : ''}" data-jumpday="${k}">
      <div class="n num">${d.getDate()}${list.length > 2 ? `<i class="mb">+${list.length - 2}</i>` : ''}</div>
      ${list.slice(0, 2).map(e => `<div class="r" data-open="${e.id}">
        <u style="background:${col(s.byId[e.memberId])}"></u><span>${esc(e.title)}</span></div>`).join('')}</div>`;
  }
  return `<div class="wk">${[1, 2, 3, 4, 5, 6, 0].map(w => `<div>周${WEEK[w]}</div>`).join('')}</div>
    <div class="mwall">${cells}</div>`;
}
function pageTodo(s, S) {
  const list = s.open.filter(e => !S.hidden.has(e.memberId)).slice(0, 6);
  const rest = s.open.length - list.length;
  if (!list.length) return empty('全部完成了', '要加新的，去「管理 ⚙」→ 待办');
  return `<div class="tpage">${list.map(e => {
    const m = s.byId[e.memberId];
    return `<div class="tcard2" data-todo="${e.id}"><i class="ck2">✓</i>
      <div style="flex:1;min-width:0"><div class="ti2">${esc(e.title)}</div>
        ${e.note ? `<div class="no2">${esc(e.note)}</div>` : ''}</div>
      <div class="who" style="background:${col(m)};color:var(--on-member)">${esc(ini(m))}</div></div>`;
  }).join('')}${rest > 0 ? `<div class="thint">还有 ${rest} 条未完成 · 全部在管理页「待办」里</div>` : ''}</div>`;
}

/* ---------- 右栏：倒数日 + 明天 + 本周还剩 + 管理入口 ---------- */
function sideHTML(s, S) {
  const c = s.cds[S.cdIdx % Math.max(s.cds.length, 1)];
  const tmr = dadd(s.today, 1), td = dparse(tmr);
  const tom = s.dayOf(tmr).filter(e => !S.hidden.has(e.memberId)).slice(0, 3);
  const wkEnd = dadd(weekStart(s.today), 6);
  const wk = expandRange(s.events, dadd(s.today, 1), wkEnd).filter(e => !S.hidden.has(e.memberId)).length;
  const daysLeft = ddiff(s.today, wkEnd);
  return `
    <div class="box"><h3>倒数日<em>每 ${S.cdRot} 秒轮换</em></h3>
      ${c ? `<div class="cd ${c.daysLeft <= 7 ? 'near' : ''} ${c.daysLeft === 0 ? 'today' : ''}" data-cdnext>
        <div class="lbl">${esc(c.title)}</div>
        <div class="big"><b class="num">${c.daysLeft === 0 ? '今天' : Math.abs(c.daysLeft)}</b>
          <s>${c.daysLeft === 0 ? '' : (c.daysLeft < 0 ? '天前' : '天后')}</s></div>
        <div class="who">${c.target.slice(5).replace('-', '/')} · ${name(s.byId[c.memberId])}${c.repeat ? ' · 每年' : ''} · 共 ${s.cds.length} 个</div>
      </div>` : '<div class="li st"><i></i><div>还没有倒数日</div></div>'}</div>
    <div class="box"><h3>明天 · ${td.getMonth() + 1}月${td.getDate()}日 周${WEEK[td.getDay()]}</h3>
      ${tom.length ? tom.map(e => `<div class="li"><i class="num">${e.allDay ? '全天' : e.time}</i><div>${esc(e.title)}</div></div>`).join('')
        : '<div class="li st"><i></i><div>没有安排</div></div>'}</div>
    <div class="box"><h3>本周还剩</h3>
      <div class="count num">${wk} 项</div>
      <div class="sub">到本周日（${wkEnd.slice(5).replace('-', '/')}，还有 ${daysLeft} 天）</div></div>
    <button class="managebtn" data-sheet>管理 ⚙</button>`;
}

/* ---------- 壁挂宿主 ---------- */
export function hostHTML(s, S) {
  const n = new Date(), P = PAGES[S.page];
  /* 点过周/月视图里的某一天之后，S.sel 就离开今天了。顶栏那个日期是"今天几点"的时钟区，
     不能跟着变——所以必须另起一条提示说明"下面看的是哪天"，并给一个回今天的按钮。 */
  const pinned = S.sel !== s.today;
  const title = pinned && S.page === 0 ? `${md(S.sel)} ${wkOf(S.sel)}` : P.name;
  const hint = [`${s.dayOf(S.sel).length} 项`, '7 天概览',
    `${Number(monthOf(S.sel).slice(5))}月 · 整月概览`, `${s.open.length} 件未完成`][S.page];
  const st = S.backup.level === 'ok' ? '' : S.backup.level === 'warn' ? 'warn' : 'err';
  return `<div class="hd">
      <span class="d num">${n.getMonth() + 1}月${n.getDate()}日</span>
      <span class="w">星期${WEEK[n.getDay()]}</span><span class="sp"></span>
      <span class="status ${st}"><i></i>${esc(S.backup.text)}${S.persist ? ' · 持久存储已授予' : ''}</span>
      <span class="clock num" id="clk">${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}<small>${String(n.getSeconds()).padStart(2, '0')}</small></span>
    </div>
    <div class="bd"><div class="main">
      <h2>${title}<em>· ${hint} · ${S.page + 1}/${PAGES.length} 页</em></h2>
      ${pinned ? `<div class="lookbar"><i class="dot"></i>
        <div class="lb-t"><b>正在看 ${md(S.sel)} ${wkOf(S.sel)} · 不是今天</b>
          <span>本周 / 本月也按这天定位 · ${Math.round(S.dayBack / 60)} 分钟后自动回到今天</span></div>
        <button class="lb-b" data-today>回到今天</button></div>` : ''}
      ${[pageToday, pageWeek, pageMonth, pageTodo][S.page](s, S)}</div>
      <div class="side">${sideHTML(s, S)}</div></div>
    <div class="khint"><span>自动换屏</span><b>${S.page + 1}/${PAGES.length}</b>
      <span class="seq">${PAGES.map(p => p.name).join(' → ')} · 每 ${S.rot} 秒</span>
      <span class="now">当前「${title}」· ${pinned ? '看板日定位中' : '触摸后重新计时'}</span></div>`;
}

/* ---------- 浮层：详情 / 三选一 ---------- */
export function detailHTML(s, S) {
  const e = S.cur; if (!e) return '';
  const m = s.byId[e.memberId], d = dparse(e.date), up = new Date(e.updatedAt || Date.now());
  const p2 = n => String(n).padStart(2, '0');
  return `<div class="panel" style="width:60vmin"><div class="cap" style="background:${col(m)}"></div>
    <div class="pb"><h5>${e.kind !== 'event' ? `<span class="bdg">${KIND[e.kind]}</span> ` : ''}${esc(e.title)}</h5>
      <div class="meta"><span class="chip on" style="color:${col(m)}"><i class="dt" style="background:${col(m)}"></i>${esc(name(m))}</span>
        <span>${e.kind === 'todo' ? '无截止时间' : e.kind === 'countdown' ? `目标 ${d.getMonth() + 1}月${d.getDate()}日`
          : `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]} · ${e.allDay ? '全天' : (e.time + (e.endTime ? '–' + e.endTime : ''))}`}</span>
        ${e.repeat ? `<span class="bdg">↻ ${recurText(e)}</span>` : ''}
        ${(e.reminders || []).map(r => `<span class="bdg">🔔 ${remindText(r)}</span>`).join('')}
        ${e.pin ? `<span class="bdg r">📌 已置顶</span>` : ''}
        ${e.doneAt ? `<span class="bdg">✓ 已完成</span>` : ''}</div>
      ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
      <div class="by">上次由 ${esc(e.updatedBy || '本机')} 修改 · ${p2(up.getMonth() + 1)}-${p2(up.getDate())} ${p2(up.getHours())}:${p2(up.getMinutes())}</div>
      ${e.kind === 'todo' ? `<div class="row"><button class="pri" data-todo="${e.id}">${e.doneAt ? '撤销完成' : '标记完成'}</button><button data-edit>编辑</button></div>` : ''}
      <div class="row"><button ${e.kind === 'todo' ? '' : 'class="pri"'} data-edit>编辑</button>
        <button data-copy>复制到今天</button><button class="dgr" data-del>删除</button></div>
      <div class="row"><button data-close>关闭</button></div></div></div>`;
}
export function askHTML(s, S) {
  if (!S.askMode || !S.cur) return '';
  const editing = S.askMode === 'edit';
  return `<div class="panel" style="width:56vmin"><div class="pb">
    <h4 style="margin:0 0 .6vmin;font-size:var(--t-title)">${editing ? '改哪部分' : '删除哪部分'}？</h4>
    <div class="hint">这条属于「${recurText(S.cur)}」系列（${esc(S.cur.title)}）。<br>
      「此事件及以后」会把原系列截断到 ${S.cur.date} 之前，并从这天起新建一条。
      ${editing ? '选「整个系列」会清掉已有的单次改动与例外。' : ''}</div>
    <div class="row"><button class="pri" data-ask="one">仅此事件</button>
      <button data-ask="future">此事件及以后</button><button data-ask="all">整个系列</button></div>
    <div class="row"><button data-close>返回</button></div></div></div>`;
}

/* ---------- 编辑浮窗（居中，不再是从底部顶出的抽屉） ---------- */
export function editorHTML(s, S) {
  const f = S.form; if (!f) return '';
  const e = f.editId ? s.events.find(x => x.id === f.editId) : null;
  const showTime = f.kind === 'event';
  return `<div class="panel" style="width:88vmin;max-height:88vh"><div class="ph">
      <h4>${e ? '编辑' + KIND[f.kind] : '新增' + KIND[f.kind]}</h4>
      <button class="x" data-cancel>取消</button></div>
    <div class="pb">
      <div class="f"><label>类型</label><span class="seg">${['event', 'todo', 'countdown'].map(v =>
        `<button class="${f.kind === v ? 'on' : ''}" data-kind="${v}">${KIND[v]}</button>`).join('')}</span>
        <span class="tip">${f.kind === 'event' ? '进日历，可设时间' : f.kind === 'todo' ? '不进日历，未打勾就一直显示' : '不进日历，在右栏倒数'}</span></div>
      <div class="f"><label>标题</label><input type="text" id="f-t" maxlength="40"
        placeholder="${f.kind === 'countdown' ? '例：奶奶生日' : f.kind === 'todo' ? '例：交物业费' : '例：接孩子放学'}" value="${esc(f.title)}"></div>
      <div class="f"><label>成员</label>${s.members.map(m => `<span class="chip ${f.memberId === m.id ? 'on' : 'off'}"
        data-pick="${m.id}" style="color:${f.memberId === m.id ? col(m) : ''}"><i class="dt" style="background:${col(m)}"></i>${esc(m.name)}</span>`).join('')}</div>
      <div class="f"><label>${f.kind === 'countdown' ? '目标日' : f.kind === 'todo' ? '记于' : '日期'}</label>
        <input type="date" class="num" id="f-d" value="${f.date}">
        ${showTime ? `<label class="inline">时间</label><input type="time" class="num" id="f-tm" value="${f.time}">` : ''}</div>
      ${showTime ? `<div class="f"><label></label>
        <span class="tgl"><i class="sw ${f.allDay ? 'on' : ''}" data-sw="allDay"></i> 全天</span>
        <span class="tgl"><i class="sw ${f.pin ? 'on' : ''}" data-sw="pin"></i> 📌 置顶到壁挂屏</span></div>` : ''}
      <div class="fold" data-fold>${S.fold ? '▾' : '▸'} ${f.kind === 'event' ? '更多：重复 · 结束日期 · 提醒 · 备注'
        : f.kind === 'countdown' ? '更多：每年重复 · 提醒 · 备注' : '更多：提醒 · 备注'}</div>
      <div class="adv ${S.fold ? 'on' : ''}">
        ${f.kind === 'event' ? `<div class="f"><label>重复</label><select id="f-rp">
          <option value="">不重复</option>
          <option value="weekdays" ${f.rp === 'weekdays' ? 'selected' : ''}>每个工作日</option>
          <option value="weekly" ${f.rp === 'weekly' ? 'selected' : ''}>每周</option>
          <option value="monthly" ${f.rp === 'monthly' ? 'selected' : ''}>每月同日</option>
          <option value="yearly" ${f.rp === 'yearly' ? 'selected' : ''}>每年</option></select>
          <span class="tip">「工作日」不含法定节假日调休</span></div>
        ${f.rp ? `<div class="f"><label>结束日期</label><input type="date" class="num" id="f-until" value="${f.until}">
          <span class="tip">${f.until ? '到这天为止（含当天），之后不再出现' : '留空 = 一直循环'}</span></div>`
          : `<div class="f"><label>结束日期</label><span class="tip">选了「重复」才用得上</span></div>`}` : ''}
        ${f.kind === 'countdown' ? `<div class="f"><label>每年重复</label><select id="f-rp">
          <option value="">不重复（过完转"已过"）</option>
          <option value="yearly" ${f.rp === 'yearly' ? 'selected' : ''}>每年（生日、纪念日）</option></select></div>` : ''}
        <div class="f"><label>提醒</label>${[0, 15, 60, 1440].map(r => `<span class="chip ${(f.reminders || []).includes(r) ? 'on' : 'off'}"
          data-rm="${r}"><i class="dt" style="background:var(--c-warn)"></i>${remindText(r)}</span>`).join('')}</div>
        <div class="f"><label>备注</label><input type="text" id="f-nt" maxlength="500" value="${esc(f.note)}" placeholder="地址、要带的东西…"></div>
      </div>
      <div class="row"><button class="cancel" data-cancel>取消</button>
        <button class="pri" data-save>保存</button>${e ? '<button class="dgr" data-del>删除</button>' : ''}</div>
    </div></div>`;
}

/* ---------- 成员浮窗 ---------- */
export function memberHTML(s, S) {
  const f = S.memForm; if (!f) return '';
  const editing = !!f.editId;
  return `<div class="panel" style="width:66vmin"><div class="ph">
      <h4>${editing ? '编辑成员' : '新增成员'}</h4><button class="x" data-cancel>取消</button></div>
    <div class="pb">
      <div class="f"><label>名字</label><input type="text" id="m-n" maxlength="8" value="${esc(f.name)}" placeholder="例：爷爷"></div>
      <div class="f"><label>首字</label><input type="text" id="m-i" maxlength="2" value="${esc(f.initial)}"
        placeholder="留空取名字第一个字" style="flex:0 0 22vmin">
        <span class="tip">徽章是"色块 + 首字"双编码，不能只靠颜色认人</span></div>
      <div class="f"><label>颜色</label><div class="palrow">${['blue', 'green', 'orange', 'pink', 'violet', 'teal', 'red', 'slate'].map(c => {
        const used = s.members.some(m => m.colorKey === c && m.id !== f.editId);
        return `<button class="pal ${f.colorKey === c ? 'on' : ''} ${used ? 'used' : ''}" data-pal="${c}"
          style="background:var(--m-${c})" title="${c}${used ? ' 已占用' : ''}"></button>`;
      }).join('')}</div></div>
      <div class="f"><label></label><span class="tgl"><i class="sw ${f.family ? 'on' : ''}" data-mem-family></i> 作为「全家」公共日历（不属于任何个人）</span></div>
      <div class="hint">色板固定 8 色、禁止自由取色；已被占用的色不可选，保证一人一色。归档不是删除——历史日程仍要能显示归属。</div>
      <div class="row"><button class="cancel" data-cancel>取消</button><button class="pri" data-msave>保存成员</button></div>
    </div></div>`;
}

/* ---------- 提醒横幅 ---------- */
export function bannerHTML(s, S) {
  const b = S.banner; if (!b) return '';
  const m = s.byId[b.memberId];
  return `<i class="bl"></i><div><b>该${esc(b.title)}了</b>
    <span>${b.allDay ? '今天' : b.time} · ${esc(name(m))}${b.note ? ' · ' + esc(b.note) : ''}</span></div>
    <button data-banner-close>知道了</button>`;
}

/* ---------- 整屏管理页 ---------- */
export function sheetHTML(s, S) {
  const fn = { cal: tabCal, todo: tabTodo, cd: tabCd, members: tabMembers, theme: tabTheme,
    remind: tabRemind, kiosk: tabKiosk, backup: tabBackup, about: tabAbout }[S.tab];
  return `<div class="ph"><h4>管理</h4><button class="x" data-exit>✕ 回到壁挂</button></div>
    <div class="tabs">${TABS.map(t => `<button data-tab="${t[0]}" class="${S.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}</div>
    <div class="pb">${fn(s, S)}</div>`;
}
function dayList(s, S, list) {
  return list.map(e => {
    const m = s.byId[e.memberId];
    return `<button class="sitem" data-open="${e.id}"><i class="b2" style="background:${col(m)}"></i>
      <span class="t2 num">${e.allDay ? '全天' : e.time}</span>
      <span><span class="ti">${esc(e.title)}</span><br>
      <span class="sub2">${esc(name(m))}${e.repeat ? ' · ↻' : ''}${e.pin ? ' · 📌' : ''}</span></span></button>`;
  }).join('') || '<div class="none2">这天没有安排</div>';
}
function tabCal(s, S) {
  const first = dparse(monthOf(S.sel) + '-01'), start = weekStart(monthOf(S.sel) + '-01');
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const k = dadd(start, i), d = dparse(k), out = d.getMonth() !== first.getMonth();
    const list = s.dayOf(k).filter(e => !S.hidden.has(e.memberId));
    cells += `<button class="cell ${out ? 'out' : ''} ${k === s.today ? 'today' : ''} ${k === S.sel ? 'sel' : ''}" data-day="${k}">
      <span class="dn num">${d.getDate()}${list.length > 2 ? `<i class="mb">+${list.length - 2}</i>` : ''}</span>
      ${list.slice(0, 2).map(e => `<span class="cev" style="background:${col(s.byId[e.memberId])}" data-open="${e.id}"
        data-drag="${e.id}" data-dragday="${e.date}">${esc(e.title)}</span>`).join('')}</button>`;
  }
  const sel = s.dayOf(S.sel).filter(e => !S.hidden.has(e.memberId));
  const view = S.vmode === 'week' ? tabWeek(s, S) : S.vmode === 'day' ? tabDay(s, S)
    : `<div class="wk">${[1, 2, 3, 4, 5, 6, 0].map(w => `<div>周${WEEK[w]}</div>`).join('')}</div><div class="mgrid">${cells}</div>`;
  return `<div class="f" style="margin:0 0 1vmin">
      <span class="seg">${['month', 'week', 'day'].map(v => `<button data-vm="${v}" class="${S.vmode === v ? 'on' : ''}">${{ month: '月', week: '周', day: '日' }[v]}</button>`).join('')}</span>
      <button class="mini" data-mo="-1">‹</button><button class="mini" data-mo="1">›</button>
      <b class="mt">${first.getFullYear()}年${first.getMonth() + 1}月${S.sel !== s.today ? ` · 选中 ${md(S.sel)}` : ''}</b>
      ${s.members.map(m => `<span class="chip ${S.hidden.has(m.id) ? 'off' : 'on'}" data-f="${m.id}"
        style="color:${S.hidden.has(m.id) ? '' : col(m)}"><i class="dt" style="background:${col(m)}"></i>${esc(m.name)}</span>`).join('')}
      <button class="mini ${S.sel === s.today ? '' : 'pri'}" data-today style="margin-left:auto">${S.sel === s.today ? '今天' : '回到今天'}</button></div>
    <div class="calwrap"><div class="panev">${view}</div>
      <div class="paneList"><h3>${S.sel === s.today ? '今天' : `${md(S.sel)} ${wkOf(S.sel)}`} · ${sel.length} 项</h3>
        ${dayList(s, S, sel)}
        <button class="mini pri addbtn" data-new="event">＋ 新增日程</button></div></div>
    <div class="hint">把格子里的日程<b>拖到另一格</b> = 改到那天，重复日程只挪这一次。
      <b>轻点不算拖</b>：按住不动再抬手仍是打开详情。格子只放得下前两条，剩下的在右侧列表里点开改日期。</div>`;
}
function tabWeek(s, S) {
  const start = weekStart(S.sel);
  let cols = '';
  for (let i = 0; i < 7; i++) {
    const k = dadd(start, i), d = dparse(k), list = s.dayOf(k).filter(e => !S.hidden.has(e.memberId));
    cols += `<button class="cell ${k === s.today ? 'today' : ''} ${k === S.sel ? 'sel' : ''}" data-day="${k}">
      <span class="dn num">周${WEEK[d.getDay()]} ${d.getDate()}</span>
      ${list.slice(0, 5).map(e => `<span class="cev" style="background:${col(s.byId[e.memberId])}" data-open="${e.id}"
        data-drag="${e.id}" data-dragday="${e.date}">${e.allDay ? '' : e.time} ${esc(e.title)}</span>`).join('')
        || '<span class="none3">—</span>'}
      ${list.length > 5 ? `<span class="none3">+${list.length - 5}</span>` : ''}</button>`;
  }
  return `<div class="mgrid weekgrid">${cols}</div>`;
}
function tabDay(s, S) {
  const list = s.dayOf(S.sel).filter(e => !S.hidden.has(e.memberId));
  return `<div class="daylist">${list.length ? list.map(e => {
    const m = s.byId[e.memberId];
    return `<button class="ev" data-open="${e.id}"><i class="bar" style="background:${col(m)}"></i>
      <div class="tm num">${e.allDay ? '全天' : e.time}<small>${e.endTime ? e.endTime + ' 结束' : ''}</small></div>
      <div class="info"><b>${esc(e.title)}</b><span>${esc(name(m))}${e.repeat ? ' · ↻ ' + recurText(e) : ''}${e.note ? ' · ' + esc(e.note) : ''}</span></div>
      <div class="who" style="background:${col(m)};color:var(--on-member)">${esc(ini(m))}</div></button>`;
  }).join('') : '<div class="none2">这天没有安排，用右下方「＋ 新增日程」记一件事</div>'}</div>`;
}
function tabTodo(s, S) {
  const open = s.todos.filter(e => !e.doneAt), done = s.todos.filter(e => e.doneAt);
  /* 滑动只负责"露出按钮"，执行必须再点一下：一条左滑就删掉待办，误触成本太高 */
  const row = (e, handle) => `<div class="swipe"><div class="swacts l">
        <button class="swb ok" data-swdone="${e.id}">${e.doneAt ? '撤销完成' : '完成'}</button></div>
      <div class="swacts r"><button class="swb dgr" data-swdel="${e.id}">删除</button></div>
      <div class="r swbody${e.doneAt ? ' dim' : ''}" data-swipe="${e.id}">
        ${handle}<span class="k">${e.doneAt ? '<s>' + esc(e.title) + '</s>' : esc(e.title)}${e.note ? `<span class="sub2"> · ${esc(e.note)}</span>` : ''}</span>
        <span class="v">${esc(name(s.byId[e.memberId]))}${e.doneAt ? ' · ' + esc(String(e.doneAt).slice(5, 10)) + ' 完成' : ''}</span>
        <button class="mini" data-open="${e.id}">编辑</button></div></div>`;
  const ck = e => `<i class="ck${e.doneAt ? ' on' : ''}" data-todo="${e.id}">✓</i>`;
  return `<button class="mini pri addbtn" data-new="todo">＋ 新增待办</button>
    <div class="sec"><h6>未完成 · ${open.length} 件（未打勾就一直显示，永不过期）</h6>
      ${open.map(e => row(e, ck(e))).join('')
        || '<div class="r"><span class="k none2">全部完成</span></div>'}</div>
    ${done.length ? `<div class="sec"><h6>最近完成 · ${done.length}（14 天内可撤销）</h6>
      ${done.slice(0, 12).map(e => row(e, ck(e))).join('')}</div>` : ''}
    <div class="hint">待办行<b>左滑</b>露出「删除」、<b>右滑</b>露出「完成」——滑动本身不执行任何操作，必须再点一下按钮；
      删掉后提示条上有 6 秒「撤销」。<br>
      壁挂「待办」页每页显示前 6 条，其余在这里看全。一块全家共看的屏不该变成某个人的无限清单。</div>`;
}
function tabCd(s, S) {
  return `<button class="mini pri addbtn" data-new="countdown">＋ 新增倒数日</button>
    <div class="sec"><h6>倒数日 · ${s.cds.length} 个（不进日历，在壁挂右栏与「待办」旁的轮播里显示）</h6>
      ${s.cds.map(c => `<div class="r"><i class="avatar" style="background:${col(s.byId[c.memberId])};color:var(--on-member)">${esc(ini(s.byId[c.memberId]))}</i>
        <span class="k">${esc(c.title)}${c.repeat ? ' <span class="bdg">每年</span>' : ''}</span>
        <span class="v num">${c.target.slice(5).replace('-', '/')} · ${c.daysLeft === 0 ? '就是今天' : c.daysLeft + ' 天后'}</span>
        <button class="mini" data-open="${c.id}">编辑</button></div>`).join('')
        || '<div class="r"><span class="k none2">还没有倒数日</span></div>'}</div>
    <div class="hint">带「每年」的目标日过完自动滚到下一年（生日、纪念日）；不带的一年过完转"已过"等人工处理。</div>`;
}
function tabMembers(s, S) {
  const all = s.members.concat(s.archived || []);
  return `<button class="mini pri addbtn" data-mem-new>＋ 新增成员</button>
    <div class="sec"><h6>在列 · ${s.members.length} 人</h6>
      ${s.members.map(m => `<div class="r"><i class="avatar" style="background:${col(m)};color:var(--on-member)">${esc(m.initial)}</i>
        <span class="k">${esc(m.name)}${m.kind === 'family' ? ' <span class="bdg">公共日历</span>' : ''}</span>
        <span class="v">${esc(m.colorKey)} · ${s.dayOf(s.today).filter(e => e.memberId === m.id).length} 项/今天</span>
        <button class="mini" data-mem-edit="${m.id}">编辑</button>
        ${m.kind === 'family' ? '<span class="v">不可归档</span>' : `<button class="mini dgr" data-mem-arch="${m.id}">归档</button>`}</div>`).join('')}</div>
    ${(s.archived || []).length ? `<div class="sec"><h6>已归档 · ${s.archived.length}</h6>
      ${s.archived.map(m => `<div class="r dim"><i class="avatar" style="background:${col(m)};color:var(--on-member)">${esc(m.initial)}</i>
        <span class="k">${esc(m.name)}</span><button class="mini" data-mem-unarch="${m.id}">恢复</button></div>`).join('')}</div>` : ''}
    <div class="hint">色板固定 8 色、禁止自由取色：任意两色去饱和后亮度仍不相邻，红绿色觉异常可辨。归档而非删除——历史日程要仍能显示归属。</div>`;
}
function tabTheme(s, S) {
  return `<div class="tcards">${THEMES.map(t => `<button class="tcard ${S.theme === t.id ? 'on' : ''}" data-set-theme="${t.id}">
      <div class="nm">${t.name}${S.theme === t.id ? ' · 当前' : ''}</div><div class="ds">${t.desc}</div>
      <div class="swatches">${['--c-bg', '--c-panel', '--c-accent', '--c-ok'].map(v => `<u style="background:var(${v})"></u>`).join('')}</div>
    </button>`).join('')}</div>
    <div class="hint">主题存在本机。切换只改根元素的 <code>data-theme</code>，不重排、不刷新；
      组件内不出现写死颜色，全部引用令牌。</div>`;
}
function tabRemind(s, S) {
  const todays = s.dayOf(s.today).filter(e => (e.reminders || []).length);
  return `<div class="sec"><h6>提醒</h6>
      <div class="r"><span class="k">在本机发声</span><span class="v">壁挂端就是提醒主机</span>
        <i class="sw ${S.sound ? 'on' : ''}" data-sw-sound></i></div>
      <div class="r"><span class="k">提示音</span><span class="v">需 iPad 侧边静音开关处于「响铃」</span>
        <button class="mini pri" data-chime>▶ 试听</button></div>
      <div class="r"><span class="k">错过的提醒</span><span class="v">超 30 分钟不再发声，只标灰</span></div></div>
    <div class="hint">iOS 限制：网页不能弹系统通知；Web Push 需经 Apple 通道、离线不可达；
      锁屏或退出应用后定时器冻结；静音开关会掐掉网页音频。
      所以<b>提醒可靠 = 这块屏亮着且停在本应用</b>——配合同步方案才能全屋提醒。</div>
    <div class="sec"><h6>今天将响 · ${todays.length}</h6>
      ${todays.map(e => `<div class="r"><span class="k">${esc(e.title)}</span>
        <span class="v num">${e.time || '全天'}</span><span class="v">${e.reminders.map(remindText).join(' / ')}</span></div>`).join('')
        || '<div class="r"><span class="k none2">今天没有设提醒的日程</span></div>'}</div>`;
}
function tabKiosk(s, S) {
  return `<div class="sec"><h6>壁挂</h6>
      <div class="r"><span class="k">轮播页</span><span class="v">${PAGES.map(p => p.name).join(' / ')}</span></div>
      <div class="r"><span class="k">轮播间隔</span><input type="range" class="range" id="rng-rot" min="10" max="60" step="5"
        value="${S.rot}"><span class="v num">${S.rot} 秒</span></div>
      <div class="r"><span class="k">倒数日轮换</span><input type="range" class="range" id="rng-cd" min="3" max="15" step="1"
        value="${S.cdRot}"><span class="v num">${S.cdRot} 秒</span></div>
      <div class="r"><span class="k">点开的某天停留</span><span class="v num">${Math.round(S.dayBack / 60)} 分钟后自动回到今天</span>
        <button class="mini" data-dayback>换停留时长</button></div>
      <div class="r"><span class="k">无操作自动回壁挂</span><span class="v num">${S.idleBack} 秒</span><i class="sw on"></i></div>
      <div class="r"><span class="k">夜间盘（降亮、停轮播、隐控件）</span><span class="v num">${esc(S.nightDim)}</span>
        <button class="mini">修改</button></div>
      <div class="r"><span class="k">常亮检查</span><span class="v">自动锁定=永不 · 引导式访问已开</span>
        <button class="mini pri">两步截图</button></div></div>
    <div class="hint">壁挂端只响应"点卡片""点圆圈打勾""点某天看那天"三种操作，<b>不做任何滑动手势与拖拽</b>——
      挂墙屏上左右滑翻月、长按快删必然误触。入口常驻可见，不依赖 hover（触屏没有 hover）。<br>
      拖动改日期与待办左滑<b>只在管理页生效</b>；进了管理页才有这两个手势，回到壁挂立刻失效。</div>`;
}
function tabBackup(s, S) {
  return `<div class="sec"><h6>数据在这台 iPad 上（唯一副本）</h6>
      <div class="r"><span class="k">本机记录</span><span class="v">日程 ${s.stats.events} · 待办 ${s.stats.todos} · 倒数日 ${s.stats.countdowns} · 成员 ${s.stats.members}</span></div>
      <div class="r"><span class="k">持久存储</span><span class="v">${S.persist ? '已授予' : '未授予（空间紧张时可能被清理）'}</span>
        <button class="mini" data-persist>重新请求</button></div>
      <div class="r"><span class="k">占用 / 配额</span><span class="v num">${(S.usage / 1048576).toFixed(2)} MB / ${(S.quota / 1048576).toFixed(0)} MB</span></div>
      <div class="r"><span class="k">上次备份</span><span class="v">${esc(S.backup.text)}</span>
        <button class="mini pri" data-export>导出 JSON</button></div>
      <div class="r"><span class="k">导入备份</span><span class="v">按更新时间合并，永不静默删除</span>
        <input id="imp" type="file" accept="application/json,.json" style="display:none">
        <button class="mini" data-import>选择文件</button></div></div>
    <div class="hint">数据不出这台设备，丢了就只能靠导出的 JSON 恢复。建议每两周导出一次，放到 iCloud 云盘或家里 NAS。</div>
    <div class="sec dgr"><h6>危险区</h6>
      <div class="r"><span class="k">清空本机全部数据</span><span class="v">需二次确认，且不可撤销</span>
        <button class="mini dgr" data-clear>清空</button></div></div>`;
}
function tabAbout(s, S) {
  return `<div class="sec">
      <div class="r"><span class="k">版本</span><span class="v">timetreeloc v0.11 · 纯浏览器 · schema v${SCHEMA_VERSION}</span></div>
      <div class="r"><span class="k">运行时</span><span class="v">无后端、无构建、无依赖：HTML + ES Modules + IndexedDB</span></div>
      <div class="r"><span class="k">数据</span><span class="v">只存在这台设备的浏览器数据库，不上传任何服务器</span></div>
      <div class="r"><span class="k">离线</span><span class="v">${S.swReady ? '已装 PWA，可完全离线' : '未安装到主屏：需 HTTPS 来源'}</span></div>
      <div class="r"><span class="k">存储健康</span><span class="v">${s.stats.total} 条记录 · 墓碑 ${s.stats.total - s.stats.live} 条</span>
        <button class="mini" data-purge>清理 30 天前的墓碑</button></div></div>`;
}

