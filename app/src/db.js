/* 数据仓储：IndexedDB 是唯一出入口，界面层不感知它。
   策略：家庭数据量级很小（几千条封顶），启动时一次性读进内存，
   读路径全部走内存、写路径异步落库。不做花哨的索引查询——那是过早优化。
   索引仍然建好，为的是将来若做多端同步或数据量涨上来时不必改结构。 */
import { SCHEMA_VERSION, todayKey, prevDay, dadd, ddiff } from './domain.js';

export const DB_NAME = 'timetreeloc';
export const DB_VERSION = 1;

/* 版本 → 迁移。加字段就在此追加一版，别改历史版本 */
const MIGRATIONS = {
  1: db => {
    const ev = db.createObjectStore('events', { keyPath: 'id' });
    ev.createIndex('date', 'date');
    ev.createIndex('memberId', 'memberId');
    ev.createIndex('kind', 'kind');
    ev.createIndex('seriesId', 'seriesId');
    const mb = db.createObjectStore('members', { keyPath: 'id' });
    mb.createIndex('sortOrder', 'sortOrder');
    db.createObjectStore('meta', { keyPath: 'k' });
  }
};

export async function openDb(idb = globalThis.indexedDB) {
  if (!idb) throw new Error('此浏览器不支持 IndexedDB');
  const db = await new Promise((res, rej) => {
    const r = idb.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = async e => {
      const d = r.result;
      for (let v = e.oldVersion + 1; v <= DB_VERSION; v++) {
        if (!MIGRATIONS[v]) throw new Error(`缺少 schema v${v} 的迁移`);
        MIGRATIONS[v](d, r.transaction);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('IndexedDB 打开失败'));
  });
  return db;
}

const nowIso = () => new Date().toISOString();
const uuid = () => (globalThis.crypto?.randomUUID
  ? crypto.randomUUID()
  : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

export async function makeRepo({ indexedDB: idbImpl, db } = {}) {
  const handle = db || await openDb(idbImpl);
  let events = [], members = [], meta = {};

  async function readAll(name) {
    return new Promise((res, rej) => {
      const t = handle.transaction(name, 'readonly');
      const r = t.objectStore(name).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  }
  async function write(storeName, val) {
    return new Promise((res, rej) => {
      const t = handle.transaction(storeName, 'readwrite');
      const r = t.objectStore(storeName).put(val);
      r.onsuccess = () => res(r.result);
      t.onerror = () => rej(t.error);
    });
  }
  async function remove(storeName, key) {
    return new Promise((res, rej) => {
      const t = handle.transaction(storeName, 'readwrite');
      t.objectStore(storeName).delete(key);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  }

  const api = {
    /* ---------- 启动 ---------- */
    async init() {
      meta = Object.fromEntries((await readAll('meta')).map(r => [r.k, r.v]));
      const sv = Number(meta.schemaVersion || 0);
      if (sv > SCHEMA_VERSION) throw new Error(`本机数据版本 v${sv} 比程序新，请升级应用，不做猜测式迁移`);
      events = await readAll('events');
      members = await readAll('members');
      if (!members.length) await api.seedDefaults();
      if (!meta.schemaVersion) await api.setMeta('schemaVersion', String(SCHEMA_VERSION));
      return { events: api.events(), members: api.members(), settings: api.settings() };
    },
    /* 首次启动只给「全家」一个成员：预先建"爸爸/妈妈"是替用户做决定。
       另放两条示例，避免新设备打开是一片空白；备注里写明是示例，用户一看就懂。 */
    async seedDefaults() {
      const fam = { id: 'm-family', name: '全家', colorKey: 'slate', initial: '家',
        kind: 'family', sortOrder: 0, archived: false, createdAt: nowIso(), updatedAt: nowIso() };
      await write('members', fam);
      const day = n => { const t = new Date(); t.setDate(t.getDate() + n);
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
      const samples = [
        { id: 'demo-1', kind: 'event', seriesId: 'demo-1', title: '接孩子放学',
          note: '示例数据，可改成自己的或直接删除', memberId: 'm-family', date: day(0), time: '18:30',
          reminders: [10], repeat: { freq: 'weekdays' }, exdates: [], overrides: {}, pin: false },
        { id: 'demo-2', kind: 'todo', seriesId: 'demo-2', title: '交物业费',
          note: '示例数据，点圆圈即完成', memberId: 'm-family', date: day(0), time: null,
          reminders: [], repeat: null, exdates: [], overrides: [], sortOrder: 1, pin: false }
      ];
      for (const e of samples) {
        await write('events', { allDay: !e.time, doneAt: null, deletedAt: null, version: 1,
          createdAt: nowIso(), updatedAt: nowIso(), updatedBy: '示例', ...e });
      }
      members = await readAll('members');
      events = await readAll('events');
    },

    /* ---------- 读（全走内存） ---------- */
    events: () => events.map(e => ({ ...e })),
    members: () => members.map(m => ({ ...m })),
    activeMembers: () => members.filter(m => !m.archived).map(m => ({ ...m })),
    settings: () => ({
      theme: meta.theme || 'wood', weekStartsOn: Number(meta.weekStartsOn ?? 1),
      kioskRotSec: Number(meta.kioskRotSec || 20), nightDim: meta.nightDim || '22:30-07:00',
      cdRotSec: Number(meta.cdRotSec || 5),
      dayBackSec: Number(meta.dayBackSec || 180),
      lastBackupAt: meta.lastBackupAt || null
    }),

    /* ---------- 写：先落库、成功后再改内存，避免"界面有、库里没" ---------- */
    async putEvent(input) {
      if (!input.title || !String(input.title).trim()) throw new Error('标题不能为空');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new Error('日期格式应为 YYYY-MM-DD');
      if (!input.memberId) throw new Error('必须指定成员');
      const cur = events.find(e => e.id === input.id);
      const e = {
        kind: 'event', reminders: [], exdates: [], overrides: {}, pin: false, doneAt: null,
        sortOrder: 0, ...input,
        id: input.id || uuid(),
        seriesId: input.seriesId || input.id || null,
        allDay: !input.time,
        version: (cur?.version || 0) + 1,
        createdAt: cur?.createdAt || nowIso(),
        updatedAt: nowIso(), updatedBy: '本机', deletedAt: cur?.deletedAt ?? null
      };
      e.seriesId = e.seriesId || e.id;
      await write('events', e);
      events = cur ? events.map(x => x.id === e.id ? e : x) : [...events, e];
      return { ...e };
    },
    /* 删除一律软删（墓碑）：将来做多端同步时，硬删会让另一端无法收敛 */
    async deleteEvent(id) {
      const cur = events.find(e => e.id === id);
      if (!cur) return null;
      const e = { ...cur, deletedAt: nowIso(), version: (cur.version || 0) + 1, updatedAt: nowIso() };
      await write('events', e);
      events = events.map(x => x.id === id ? e : x);
      return { ...e };
    },
    async purgeTombstones(olderThanDays = 30) {
      const cut = Date.now() - olderThanDays * 864e5;
      const dead = events.filter(e => e.deletedAt && Date.parse(e.deletedAt) < cut);
      for (const e of dead) await remove('events', e.id);
      events = events.filter(e => !dead.includes(e));
      return dead.length;
    },
    async setTodoDone(id, done) {
      const cur = events.find(e => e.id === id);
      if (!cur || cur.kind !== 'todo') return null;
      const e = { ...cur, doneAt: done ? nowIso() : null, version: (cur.version || 0) + 1, updatedAt: nowIso() };
      await write('events', e);
      events = events.map(x => x.id === id ? e : x);
      return { ...e };
    },
    async putMember(input) {
      if (!input.name || !String(input.name).trim()) throw new Error('名字不能为空');
      const cur = members.find(m => m.id === input.id);
      const m = {
        kind: 'person', sortOrder: 0, archived: false, ...input,
        id: input.id || uuid(),
        initial: (input.initial || '').trim() || String(input.name).trim().slice(0, 1),
        version: (cur?.version || 0) + 1,
        createdAt: cur?.createdAt || nowIso(), updatedAt: nowIso()
      };
      await write('members', m);
      members = cur ? members.map(x => x.id === m.id ? m : x) : [...members, m];
      return { ...m };
    },
    async setMeta(k, v) {
      await write('meta', { k, v: String(v) });
      meta[k] = String(v);
      return v;
    },
    /* meta 按前缀读：提醒的幂等键存在 fired:<日期> 下，需要滚动清理 */
    async readMetaByPrefix(prefix) {
      const all = await readAll('meta');
      return all.filter(r => r.k.startsWith(prefix));
    },
    async dropMeta(k) {
      await remove('meta', k);
      delete meta[k];
    },

    /* ---------- 重复日程的"三选一"落库（语义见 docs/02 §4.1） ----------
       one    改 → overrides[日期]；删 → exdates 追加该日期
       future 改 → 父系列 until = 分界日前一天 + 新建一条独立日程；删 → 同样只截断 until
       all    改 → 直接改系列（所有单次覆盖失效）；删 → 写墓碑
       until 必须是「前一天」：写成当天会让分界日出现两条（本地测试抓到过） */
    async patchEvent(id, patch) {
      const cur = events.find(e => e.id === id);
      if (!cur) return null;
      const e = { ...cur, ...patch, version: (cur.version || 0) + 1, updatedAt: nowIso(), updatedBy: '本机' };
      await write('events', e);
      events = events.map(x => x.id === id ? e : x);
      return { ...e };
    },
    async applyScope(id, scope, day, patch = {}) {
      const cur = events.find(e => e.id === id);
      if (!cur) return null;
      const editing = Object.keys(patch).length > 0;
      if (scope === 'one') {
        if (editing) {
          const overrides = { ...(cur.overrides || {}), [day]: patch };
          return api.patchEvent(id, { overrides });
        }
        const exdates = Array.from(new Set([...(cur.exdates || []), day])).sort();
        return api.patchEvent(id, { exdates });
      }
      if (scope === 'future') {
        const repeat = { ...(cur.repeat || {}), until: prevDay(day) };
        const parent = await api.patchEvent(id, { repeat });
        if (!editing) return parent;
        const child = await api.putEvent({ ...cur, ...patch, id: null, seriesId: null,
          date: day, repeat: null, exdates: [], overrides: {}, version: 0 });
        return { parent, child };
      }
      /* 整个系列：改起始日会让所有单次覆盖与例外失效 */
      if (!editing) return api.patchEvent(id, { deletedAt: nowIso() });
      const keep = cur.date === day ? {} : {};
      return api.patchEvent(id, { ...patch, ...(patch.date ? { exdates: [], overrides: {} } : keep) });
    },

    /* ---------- 拖动改日期（docs/02 §4.1 的"仅此事件"变体） ----------
       非重复：整条平移。多日日程连 endDate 一起挪，跨度保持不变——
               只改 date 会把"三天出差"压成一天。
       重复  ：overrides 按实例日期索引，表达不了"这一次挪到别的日子"，
               所以拆成「原日加例外 + 目标日新建一条独立日程」。
       返回可撤销描述，界面层据此给"撤销"按钮；撤销不走墓碑，是直接回写。 */
    async moveInstance(id, from, to) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new Error('目标日期格式应为 YYYY-MM-DD');
      const cur = events.find(e => e.id === id && !e.deletedAt);
      if (!cur) throw new Error('记录不存在，可能已被删除');
      if (from === to || !from) return null;
      if ((cur.kind || 'event') !== 'event') throw new Error('只有日程有日期可挪，待办与倒数日不在日历里');
      if (!cur.repeat) {
        const delta = ddiff(from, to);
        const before = { date: cur.date, endDate: cur.endDate || null };
        const patch = { date: dadd(cur.date, delta) };
        if (cur.endDate) patch.endDate = dadd(cur.endDate, delta);
        await api.patchEvent(id, patch);
        return { kind: 'shift', id, before };
      }
      const exdates = Array.from(new Set([...(cur.exdates || []), from])).sort();
      await api.patchEvent(id, { exdates });
      const child = await api.putEvent({ ...cur, id: null, seriesId: null, date: to, endDate: null,
        time: cur.time, repeat: null, exdates: [], overrides: {}, doneAt: null, version: 0 });
      return { kind: 'split', id, from, childId: child.id };
    },
    async undoMove(info) {
      if (!info) return false;
      if (info.kind === 'shift') {
        const back = { date: info.before.date };
        if (info.before.endDate) back.endDate = info.before.endDate; else back.endDate = null;
        await api.patchEvent(info.id, back);
        return true;
      }
      const cur = events.find(e => e.id === info.id);
      if (cur) await api.patchEvent(info.id, { exdates: (cur.exdates || []).filter(d => d !== info.from) });
      await api.deleteEvent(info.childId);      // 挪出去那条转墓碑：本机永不静默硬删
      return true;
    },
    /* 滑动删除的撤销：清墓碑，记录原样回来（含 updatedAt 之外的所有字段） */
    async undelete(id) {
      const cur = events.find(e => e.id === id);
      if (!cur || !cur.deletedAt) return null;
      return api.patchEvent(id, { deletedAt: null });
    },

    /* ---------- 存储健康：本机是唯一副本，这两项不是可选项 ---------- */
    async persist() {
      try { return await navigator.storage?.persist?.() === true; } catch { return false; }
    },
    async estimate() {
      try {
        const e = await navigator.storage?.estimate?.();
        return { usage: e?.usage || 0, quota: e?.quota || 0 };
      } catch { return { usage: 0, quota: 0 }; }
    },
    stats() {
      const live = events.filter(e => !e.deletedAt);
      return {
        total: events.length, live: live.length,
        events: live.filter(e => e.kind === 'event').length,
        todos: live.filter(e => e.kind === 'todo' && !e.doneAt).length,
        countdowns: live.filter(e => e.kind === 'countdown').length,
        members: members.filter(m => !m.archived).length,
        lastBackupAt: meta.lastBackupAt || null, today: todayKey()
      };
    },

    /* ---------- 备份用的原始读写（导入按 updatedAt 合并，绝不静默删除） ---------- */
    dump() {
      return { app: 'timetreeloc', schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(),
        members: api.members(), events: api.events(), settings: api.settings() };
    },
    async merge(payload, { onConflict } = {}) {
      const add = { events: 0, updates: 0, skipped: 0 };
      for (const m of payload.members || []) {
        const cur = members.find(x => x.id === m.id);
        if (!cur) { await api.putMember(m); add.events++; continue; }
        if (Date.parse(m.updatedAt || 0) > Date.parse(cur.updatedAt || 0)) { await api.putMember({ ...cur, ...m }); add.updates++; }
        else add.skipped++;
      }
      for (const e of payload.events || []) {
        const cur = events.find(x => x.id === e.id);
        if (!cur) { await write('events', { ...e, id: e.id || uuid() }); events = await readAll('events'); add.events++; continue; }
        if (Date.parse(e.updatedAt || 0) > Date.parse(cur.updatedAt || 0)) {
          await write('events', { ...cur, ...e }); events = await readAll('events'); add.updates++;
        } else add.skipped++;
        onConflict?.(cur, e);
      }
      return add;
    },
    async clearAll() {
      for (const s of ['events', 'members']) {
        await new Promise((res, rej) => {
          const t = handle.transaction(s, 'readwrite');
          t.objectStore(s).clear();
          t.oncomplete = res; t.onerror = () => rej(t.error);
        });
      }
      events = []; members = [];
      await api.seedDefaults();
    },
    close() { handle.close(); }
  };
  return api;
}
