/* 领域层：纯函数，不碰 DOM、不碰 IndexedDB。
   这样它能在 Node 里直接跑测试（app/test/local.mjs），也是整个应用最值得测的部分。
   语义依据 docs/02 §3.3 / §4 / §5。 */

/* ---------- 日期：一律本地墙钟字符串，不碰 UTC 与时区 ---------- */
export const pad = n => String(n).padStart(2, '0');
export const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dparse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const dadd = (s, n) => { const d = dparse(s); d.setDate(d.getDate() + n); return dkey(d); };
export const ddiff = (a, b) => Math.round((dparse(b) - dparse(a)) / 864e5);
export const prevDay = s => dadd(s, -1);
export const todayKey = (d = new Date()) => dkey(d);

export const KIND = { event: 'event', todo: 'todo', countdown: 'countdown' };
export const SCHEMA_VERSION = 1;

/* ---------- 比较器：显式写法。
   原型里曾用 `a.pin ? -1 : 1 || ...` 与 || 混写，导致置顶反而排到最后。 ---------- */
export function cmpInstance(a, b) {
  if (!!a.pin !== !!b.pin) return a.pin ? -1 : 1;
  if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
  return String(a.time || '').localeCompare(String(b.time || ''));
}

/* ---------- 展开：规则 → 实例 ----------
   三条硬规则（docs/02 §1-6、§3.3、§5）：
     1. kind !== 'event' 一律跳过：待办与倒数日永不进日历
     2. 多日日程要在跨越的每一天都出现，只落起始日会"中途消失"
     3. until 是"最后一天"，不是"第一天之后"——截断系列时必须是分界日前一天 */
export function expandRange(events, from, to) {
  const out = [];
  for (const e of events) {
    if (e.deletedAt || e.doneAt) continue;
    if ((e.kind || 'event') !== 'event') continue;
    if (!e.repeat) {
      const end = e.endDate || e.date;
      if (end < from || e.date > to) continue;
      const s = e.date > from ? e.date : from;
      const t = end < to ? end : to;
      for (let d = s; d <= t; d = dadd(d, 1)) out.push(inst(e, d));
      continue;
    }
    const r = e.repeat;
    const stop = r.until || to;
    const last = stop < to ? stop : to;
    let guard = 0;
    for (let d = (e.date > from ? e.date : from); d <= last; d = dadd(d, 1)) {
      if (guard++ > 400) break;                       // 护栏：宁告警不静默丢
      if (r.until && d > r.until) break;
      if (!matchRepeat(r, e.date, d)) continue;
      if ((e.exdates || []).includes(d)) continue;
      const ov = (e.overrides || {})[d];
      if (ov && ov.cancelled) continue;
      out.push(inst(e, d, ov));
    }
  }
  return out.sort(cmpInstance);
}

function matchRepeat(r, anchor, d) {
  const day = dparse(d).getDay();
  switch (r.freq) {
    case 'daily': return true;
    case 'weekdays': return day >= 1 && day <= 5;
    case 'weekly': return (r.byWeekdays || [dparse(anchor).getDay()]).includes(day);
    case 'monthly': return monthMatch(anchor, d, r);
    case 'yearly':
      /* 平年 2/29 的年度日程：按 docs/02 §4 的决定「跳过」，不挪到 2/28 */
      if (isLeapFeb29(anchor) && !isLeapYear(dparse(d).getFullYear())) return false;
      return d.slice(5) === anchor.slice(5);
    default: return false;
  }
}
function monthMatch(anchor, d, r) {
  const a = dparse(anchor), t = dparse(d);
  if (r.monthlyMode === 'byNthWeekday') {
    if (t.getDay() !== a.getDay()) return false;
    const nth = Math.ceil(t.getDate() / 7);
    return r.nth ? (r.nth > 0 ? nth === r.nth : isLastOfWeekday(t)) : nth === Math.ceil(a.getDate() / 7);
  }
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const want = Math.min(Number(anchor.slice(8)), lastDay);      // 短月落月末
  return t.getDate() === want;
}
const isLeapYear = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const isLeapFeb29 = s => s.slice(5) === '02-29';
function isLastOfWeekday(t) { return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 7).getMonth() !== t.getMonth(); }

function inst(e, date, ov) {
  const o = { ...e, date, instanceId: `${e.id}#${date}`, recur: !!e.repeat };
  if (ov) Object.assign(o, ov, { date });
  o.allDay = !o.time;
  return o;
}

/* ---------- 待办与倒数日：独立查询，不走展开 ---------- */
export const listTodos = events => events
  .filter(e => e.kind === 'todo' && !e.deletedAt)
  .sort((a, b) => (!!a.doneAt - !!b.doneAt) || (a.sortOrder || 0) - (b.sortOrder || 0) || a.createdAt.localeCompare(b.createdAt));
export const openTodos = events => listTodos(events).filter(e => !e.doneAt);

export function listCountdowns(events, today = todayKey()) {
  return events
    .filter(e => e.kind === 'countdown' && !e.deletedAt)
    .map(e => {
      let target = e.date;
      /* 带 yearly 的目标日过完自动滚到下一年；不带的一年过完转"已过"等人工处理 */
      if (target < today && e.repeat && e.repeat.freq === 'yearly')
        target = rollToNextYear(target, today);
      return { ...e, target, daysLeft: ddiff(today, target) };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/* 滚到"今年或明年"的最近一次：只比月日，跨年时年份 +1 */
function rollToNextYear(target, today) {
  let year = Number(today.slice(0, 4));
  let cand = `${year}${target.slice(4)}`;
  if (cand < today) cand = `${year + 1}${target.slice(4)}`;
  return cand;
}

/* ---------- 提醒时刻：返回实例的绝对触发时间（分钟精度） ---------- */
export function reminderTimes(e, today = todayKey()) {
  const list = e.reminders || [];
  if (!list.length) return [];
  const base = e.time ? `${e.date}T${e.time}` : `${e.date}T09:00`;
  return list.map(min => ({ minutes: min, at: new Date(new Date(base).getTime() - min * 60000) }))
    .sort((a, b) => a.minutes - b.minutes);      // 从近到远：先到的提醒排前面
}

/* 幂等键：日期 + 记录 + 提前量。重启/刷新/时间跳变后靠它做到不重发不漏发 */
export const firedKey = (e, date, minutes) => `${e.id}|${date}|${minutes}`;
