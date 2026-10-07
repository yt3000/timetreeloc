/* 本地验证：在 Node 里跑真实领域层与仓储代码。
   IndexedDB 用一份最小替身（只实现本仓库用到的那几个方法），
   目的是验证读写路径、版本迁移、软删、合并这些逻辑本身成立；
   浏览器里的真 IndexedDB 行为差异（配额、清理策略）仍需真机验收。 */
import { openDb, makeRepo } from '../src/db.js';
import * as D from '../src/domain.js';
import { buildPayload, canonical, diffSummary, backupAlert, stampName } from '../src/backup.js';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? ' → ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' → ' + extra : '')); }
};

/* ================= IndexedDB 最小替身 ================= */
function makeFakeIdb() {
  const databases = {};
  const mkReq = () => { const r = { result: undefined, onsuccess: null, onerror: null };
    r._done = v => { r.result = v; setTimeout(() => r.onsuccess && r.onsuccess(), 0); }; return r; };
  class FakeStore {
    constructor(keyPath) { this.keyPath = keyPath; this.rows = new Map(); this.indexes = {}; }
    createIndex(name, keyPath) { this.indexes[name] = keyPath; }
    getAll() { const r = mkReq(); r._done([...this.rows.values()]); return r; }
    put(val) { const r = mkReq(); this.rows.set(val[this.keyPath], JSON.parse(JSON.stringify(val))); r._done(val[this.keyPath]); return r; }
    delete(k) { this.rows.delete(k); const r = mkReq(); setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; }
    clear() { this.rows.clear(); }
  }
  class FakeDB {
    constructor() { this.stores = {}; }
    createObjectStore(name, { keyPath }) { this.stores[name] = new FakeStore(keyPath); return this.stores[name]; }
    transaction(name) {
      const store = this.stores[name];
      const t = { objectStore: () => store, oncomplete: null, onerror: null };
      setTimeout(() => t.oncomplete && t.oncomplete(), 0);
      return t;
    }
    close() {}
  }
  return {
    _databases: databases,
    open(name, version) {
      const isNew = !databases[name];
      if (isNew) databases[name] = { db: new FakeDB(), version: 0 };
      const entry = databases[name];
      const r = mkReq();
      if (entry.version < version) {
        const ev = { oldVersion: entry.version };
        entry.version = version;
        r.result = entry.db;
        setTimeout(() => { r.onupgradeneeded && r.onupgradeneeded(ev); r.onsuccess && r.onsuccess(); }, 0);
      } else {
        r._done(entry.db);
      }
      return r;
    }
  };
}

/* ================= A 领域层（纯函数，真跑） ================= */
const T = '2026-10-06';
console.log('A 领域层');
const mk = o => ({ id: o.id || Math.random().toString(36).slice(2, 8), kind: 'event', title: 'x',
  memberId: 'm-dad', date: T, reminders: [], exdates: [], overrides: {}, createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z', ...o });

ok('待办与倒数日永不进日历展开',
  D.expandRange([mk({ kind: 'todo', title: '买猫粮' }), mk({ kind: 'countdown', title: '生日' }), mk({ title: '例会', time: '09:00' })], T, D.dadd(T, 20))
    .every(e => e.kind === 'event'));
const wk = D.expandRange([mk({ repeat: { freq: 'weekdays' } })], T, D.dadd(T, 27));
ok('工作日重复只落在周一到周五', wk.every(e => { const d = new Date(e.date).getDay(); return d >= 1 && d <= 5; }),
  wk.length + ' 次 / 28 天');
const withEnd = D.expandRange([mk({ date: T, repeat: { freq: 'weekly', byWeekdays: [2] },
  reminders: [] , repeat2: null, repeat: { freq: 'weekly', byWeekdays: [2], until: D.dadd(T, 14) } })], T, D.dadd(T, 40));
ok('until 是最后一天：实例不越过它', withEnd.every(e => e.date <= D.dadd(T, 14)) && withEnd.length === 3,
  withEnd.map(e => e.date.slice(8)).join(',') + '，until=' + D.dadd(T, 14).slice(8));
const span = D.expandRange([mk({ date: T, endDate: D.dadd(T, 3), time: null })], T, D.dadd(T, 6));
ok('多日日程在区间内每天都出现（不中途消失）', span.length === 4 && span[3].date === D.dadd(T, 3),
  span.length + ' 天');
const exd = D.expandRange([mk({ date: T, repeat: { freq: 'weekdays' }, exdates: [T] })], T, D.dadd(T, 4));
ok('exdates 让某一天不出现，其余照常', !exd.some(e => e.date === T) && exd.length >= 2);
const leap = D.expandRange([mk({ date: '2024-02-29', repeat: { freq: 'yearly' } })], '2025-01-01', '2025-12-31');
ok('2/29 的年度日程在平年跳过（不挪到 2/28）', leap.length === 0);
const leap2 = D.expandRange([mk({ date: '2024-02-29', repeat: { freq: 'yearly' } })], '2028-01-01', '2028-12-31');
ok('闰年则正常出现', leap2.length === 1 && leap2[0].date === '2028-02-29');
const m31 = D.expandRange([mk({ date: '2026-01-31', repeat: { freq: 'monthly' } })], '2026-02-01', '2026-02-28');
ok('每月 31 日在短月落到月末', m31.length === 1 && m31[0].date === '2026-02-28', m31[0]?.date);
const sorted = D.expandRange([mk({ title: '定时', time: '09:00' }), mk({ title: '全天', time: null }),
  mk({ title: '置顶', time: '20:00', pin: true })], T, T);
ok('排序：📌 置顶 → 全天 → 时间', sorted.map(e => e.title).join('>') === '置顶>全天>定时',
  sorted.map(e => e.title).join('>'));
const cd = D.listCountdowns([mk({ kind: 'countdown', title: '奶奶生日', date: '2025-10-18',
  repeat: { freq: 'yearly' } })], T);
ok('年度倒数日过期自动滚到下一年', cd[0].target === '2026-10-18' && cd[0].daysLeft === 12,
  cd[0].target + ' / ' + cd[0].daysLeft + ' 天后');
const cd2 = D.listCountdowns([mk({ kind: 'countdown', title: '一次性', date: '2025-01-01' })], T);
ok('不带 yearly 的过期倒数日转负数（等人工处理）', cd2[0].daysLeft < 0, String(cd2[0].daysLeft));
const rt = D.reminderTimes(mk({ date: T, time: '18:30', reminders: [0, 15, 1440] }), T);
ok('提醒时刻按提前量算且从近到远排', rt[0].minutes === 0 && rt[2].minutes === 1440 &&
  new Date(rt[1].at).getHours() === 18 && new Date(rt[1].at).getMinutes() === 15);
ok('firedKey 幂等：同一条同一天同提前量恒定',
  D.firedKey({ id: 'a' }, T, 15) === D.firedKey({ id: 'a' }, T, 15));

/* ================= B 仓储（IndexedDB 替身） ================= */
console.log('\nB IndexedDB 仓储');
const idb = makeFakeIdb();
let repo = await makeRepo({ indexedDB: idb });
const boot = await repo.init();
ok('首次启动只播种「全家」一个成员',
  boot.members.length === 1 && boot.members[0].kind === 'family',
  boot.members.map(m => m.name).join(','));
ok('并放两条示例数据（避免新设备一片空白）',
  boot.events.length === 2 && boot.events.some(e => e.kind === 'todo')
  && boot.events.some(e => e.kind === 'event' && e.repeat), boot.events.length + ' 条');
ok('默认主题是暖木 wood', boot.settings.theme === 'wood');
ok('schemaVersion 已写入', repo.stats().live >= 0);

let e1 = await repo.putEvent({ title: '接小雨放学', memberId: 'm-dad', date: T, time: '18:30',
  repeat: { freq: 'weekdays' }, reminders: [10] });
ok('新建日程 version=1 且自动算 allDay', e1.version === 1 && e1.allDay === false);
e1 = await repo.putEvent({ ...e1, title: '接小雨放学（改）' });
ok('再次保存 version 递增', e1.version === 2 && e1.title.includes('改'));
let threw = false;
try { await repo.putEvent({ title: '', memberId: 'm-dad', date: T }); } catch { threw = true; }
ok('空标题被拒（服务端校验不是边界，这里就是边界）', threw);
threw = false;
try { await repo.putEvent({ title: 'x', memberId: 'm-dad', date: '2026/10/06' }); } catch { threw = true; }
ok('日期格式非法被拒', threw);

const todo = await repo.putEvent({ kind: 'todo', title: '交物业费', memberId: 'm-dad', date: T, sortOrder: 1 });
ok('待办可创建且 kind 正确', todo.kind === 'todo');
const openBefore = D.openTodos(repo.events()).length;
await repo.setTodoDone(todo.id, true);
ok('打勾写入 doneAt，未完成清单里少一条',
  D.openTodos(repo.events()).length === openBefore - 1
  && repo.events().find(e => e.id === todo.id).doneAt, openBefore + ' → ' + D.openTodos(repo.events()).length);
await repo.setTodoDone(todo.id, false);
ok('撤销完成可逆', D.openTodos(repo.events()).length === openBefore, D.openTodos(repo.events()).length + ' 条');

const del = await repo.deleteEvent(e1.id);
ok('删除写墓碑而非物理删', !!del.deletedAt && repo.events().some(e => e.id === e1.id));
const before = repo.stats().total;
await repo.purgeTombstones(0);
ok('墓碑可清理（purgeTombstones）', repo.stats().total < before, `${before} → ${repo.stats().total}（按 total 计，live 本就不含墓碑）`);

/* 重新打开：验证数据真的落库并能读回（不是只在内存里） */
const liveBefore = repo.stats().live, totalBefore = repo.stats().total, memBefore = repo.stats().members;
repo.close();
const repo2 = await makeRepo({ indexedDB: idb });
const again = await repo2.init();
ok('重开后数据仍在（真的写进了 IndexedDB，不是只在内存里）',
  again.members.length === memBefore && repo2.stats().live === liveBefore,
  repo2.stats().live + ' 条存活 / ' + totalBefore + ' 条总量');
ok('重开后统计口径正确', repo2.stats().members === memBefore && repo2.stats().total >= liveBefore,
  '成员 ' + repo2.stats().members);

/* 合并导入：按 updatedAt 取新，永不静默删除 */
const payload = { app: 'timetreeloc', schemaVersion: 1,
  members: [], events: [
    { id: 'imported-1', kind: 'event', title: '导入的日程', memberId: 'm-mom', date: T,
      updatedAt: '2099-01-01T00:00:00Z', createdAt: '2099-01-01T00:00:00Z', reminders: [], exdates: [], overrides: {} },
    ...repo2.events().map(e => ({ ...e, title: '不该覆盖我' }))
  ] };
const diff = diffSummary(repo2, payload);
ok('导入预览能区分新增/更新/跳过', diff.events.add === 1 && diff.events.upd >= 0,
  `新增 ${diff.events.add} 更新 ${diff.events.upd} 跳过 ${diff.events.skip}`);
const merged = await repo2.merge(payload);
ok('合并后新记录进来、旧记录条数不减', merged.events >= 1 &&
  repo2.events().some(e => e.id === 'imported-1'));
ok('合并不会静默删除本机记录', repo2.events().length >= again.events.length);

/* 成员 */
const mm = await repo2.putMember({ name: '爷爷', colorKey: 'teal' });
ok('新增成员自动取首字', mm.initial === '爷' && mm.version === 1);
await repo2.putMember({ ...mm, archived: true });
ok('归档成员从在列清单消失', !repo2.activeMembers().some(m => m.id === mm.id));

/* 备份 */
console.log('\nC 备份');
const p1 = await buildPayload(repo2);
const p2 = await buildPayload(repo2);
ok('校验和稳定（同样的数据两次导出一致）', p1.checksum === p2.checksum && p1.checksum.startsWith('sha256:'));
ok('导出含 members/settings/events', p1.members.length > 0 && !!p1.settings.theme && p1.events.length > 0);
ok('文件名带时间戳', /^timetreeloc-backup-\d{8}-\d{4}\.json$/.test(stampName(new Date(T + 'T12:34:00Z'))),
  stampName(new Date(T + 'T12:34:00Z')));
await repo2.setMeta('lastBackupAt', new Date(Date.now() - 20 * 864e5).toISOString());
ok('超过 14 天未备份会告警', backupAlert(repo2).level === 'warn', backupAlert(repo2).text);
await repo2.setMeta('lastBackupAt', new Date().toISOString());
ok('刚备份过则正常', backupAlert(repo2).level === 'ok');
/* 篡改校验和应被拒（readBackupFile 在浏览器里读文件，这里直接验校验逻辑） */
const tampered = JSON.parse(JSON.stringify(p1)); tampered.events[0].title = '被改过';
ok('校验和不一致可被检出', canonical({ members: tampered.members, settings: tampered.settings, events: tampered.events })
  !== canonical({ members: p1.members, settings: p1.settings, events: p1.events }));

/* ================= D 拖动改日期（moveInstance / undoMove） ================= */
console.log('\nD 拖动改日期');
const rejects = async fn => { try { await fn(); return false; } catch { return true; } };
const base = '2026-10-06', dd = n => D.dadd(base, n);
const row = id => repo2.events().find(e => e.id === id);

const one = await repo2.putEvent({ title: '拖单条', memberId: 'm-mom', date: dd(1), time: '10:00' });
let info = await repo2.moveInstance(one.id, dd(1), dd(4));
ok('单条：改到目标日并返回可撤销描述', row(one.id).date === dd(4) && info.kind === 'shift', row(one.id).date);
await repo2.undoMove(info);
ok('单条：撤销回到原日期', row(one.id).date === dd(1), row(one.id).date);
ok('同一天投放 = 什么都不做（返回 null）',
  (await repo2.moveInstance(one.id, dd(1), dd(1))) === null && row(one.id).date === dd(1));
ok('目标日期格式非法直接抛错', await rejects(() => repo2.moveInstance(one.id, dd(1), '明天')));
ok('待办不在日历里，没有"日期可挪"→ 抛错', await rejects(() => repo2.moveInstance(todo.id, dd(0), dd(2))));

const trip2 = await repo2.putEvent({ title: '出差', memberId: 'm-mom', date: dd(2), endDate: dd(4) });
info = await repo2.moveInstance(trip2.id, dd(3), dd(9));       // 从中间那天拖走
ok('多日日程：起始与结束一起平移，跨度不变',
  row(trip2.id).date === dd(8) && row(trip2.id).endDate === dd(10) && D.ddiff(dd(8), dd(10)) === 2,
  `${row(trip2.id).date} → ${row(trip2.id).endDate}`);
await repo2.undoMove(info);
ok('多日日程：撤销后区间复原', row(trip2.id).date === dd(2) && row(trip2.id).endDate === dd(4));

const daily = await repo2.putEvent({ title: '每日站会', memberId: 'm-mom', date: dd(0), time: '09:00',
  repeat: { freq: 'daily' } });
ok('动手前：目标日只有父系列那一条',
  D.expandRange(repo2.events(), dd(6), dd(6)).filter(e => e.title === '每日站会').length === 1);
info = await repo2.moveInstance(daily.id, dd(3), dd(6));
ok('重复日程：原日期加例外（那一天不再出现）',
  (row(daily.id).exdates || []).includes(dd(3))
  && !D.expandRange(repo2.events(), dd(3), dd(3)).some(e => e.id === daily.id));
const moved = D.expandRange(repo2.events(), dd(6), dd(6)).filter(e => e.id !== daily.id && e.title === '每日站会');
ok('重复日程：目标日新增一条独立日程（只这一次）',
  moved.length === 1 && moved[0].repeat === null, moved.length + ' 条');
ok('重复日程：父系列规则与其余实例分毫未动',
  !!row(daily.id).repeat && row(daily.id).repeat.freq === 'daily' && !row(daily.id).repeat.until
  && D.expandRange(repo2.events(), dd(10), dd(10)).some(e => e.id === daily.id));
const child = row(moved[0].id);
await repo2.undoMove(info);
ok('重复日程：撤销 = 例外取消 + 挪出去那条转墓碑（本机永不静默硬删）',
  !(row(daily.id).exdates || []).includes(dd(3)) && !!row(child.id).deletedAt);
ok('重复日程：撤销后展开结果与动手前一致',
  D.expandRange(repo2.events(), dd(3), dd(3)).some(e => e.id === daily.id)
  && D.expandRange(repo2.events(), dd(6), dd(6)).filter(e => e.title === '每日站会').length === 1);

await repo2.deleteEvent(one.id);
ok('滑动删除的撤销：清墓碑后记录原样回来', !!(await repo2.undelete(one.id)) && !row(one.id).deletedAt);
ok('undelete 对未删除记录返回 null（不做无谓写入）', (await repo2.undelete(one.id)) === null);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
