/* 备份：本机是唯一副本，所以这不是"设置页里的隐藏按钮"，而是一等公民。
   iOS 不承诺网页数据永久保留（存储紧张、系统升级都可能被清），
   丢一次就是全家日程清零，因此导出/导入 + 备份哨兵必须一起做。 */
import { SCHEMA_VERSION, todayKey } from './domain.js';

const FNAME = 'timetreeloc-backup';

/* 规范化序列化：键按字典序、数组按 id 排序，这样校验和才稳定 */
function canonical(obj) {
  if (Array.isArray(obj)) {
    const items = obj.map(canonical);
    if (obj.length && obj[0] && typeof obj[0].id === 'string')
      items.sort((a, b) => String(JSON.parse(a).id).localeCompare(String(JSON.parse(b).id)));
    return '[' + items.join(',') + ']';
  }
  if (obj && typeof obj === 'object')
    return '{' + Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',') + '}';
  return JSON.stringify(obj);
}
async function sha256(text) {
  if (!globalThis.crypto?.subtle) return 'sha256:unavailable';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'sha256:' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function buildPayload(repo) {
  const data = repo.dump();
  const body = { app: 'timetreeloc', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(),
    members: data.members, settings: data.settings, events: data.events };
  body.checksum = await sha256(canonical({ members: body.members, settings: body.settings, events: body.events }));
  return body;
}

export function stampName(at = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${FNAME}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.json`;
}

/* iOS Safari 没有 File System Access API，只能用 <a download> 交给"文件"App */
export async function downloadBackup(repo) {
  const payload = await buildPayload(repo);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = stampName(); a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  await repo.setMeta('lastBackupAt', new Date().toISOString());
  return { count: payload.events.length, file: a.download };
}

/* 导入前必须校验并预览，确认后才落库；合并按 updatedAt 取新，永不隐式删除 */
export async function readBackupFile(file) {
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('文件不是合法 JSON'); }
  if (payload.app !== 'timetreeloc') throw new Error('这不是 timetreeloc 的备份文件');
  if (payload.schemaVersion > SCHEMA_VERSION)
    throw new Error(`备份来自更新的版本 v${payload.schemaVersion}，请先升级应用`);
  if (payload.checksum && payload.checksum !== 'sha256:unavailable') {
    const want = await sha256(canonical({ members: payload.members || [], settings: payload.settings || {}, events: payload.events || [] }));
    if (want !== payload.checksum) throw new Error('校验和不一致，文件可能不完整，已拒绝导入');
  }
  return payload;
}

export function diffSummary(repo, payload) {
  const cur = { events: repo.dump().events, members: repo.dump().members };
  const count = (list, mine) => list.reduce((a, e) => {
    const old = mine.find(x => x.id === e.id);
    if (!old) a.add++;
    else if (Date.parse(e.updatedAt || 0) > Date.parse(old.updatedAt || 0)) a.upd++;
    else a.skip++;
    return a;
  }, { add: 0, upd: 0, skip: 0 });
  return { events: count(payload.events || [], cur.events), members: count(payload.members || [], cur.members) };
}

/* 备份哨兵：超过 14 天没导出就在管理界面提示；壁挂端不打扰 */
export function backupAlert(repo, days = 14) {
  const last = repo.settings().lastBackupAt;
  if (!last) return { level: 'never', days: null, text: '还没有备份过。数据只存在这台 iPad 上，去「备份」导出一份' };
  const d = Math.floor((Date.now() - Date.parse(last)) / 864e5);
  if (d >= days) return { level: 'warn', days: d, text: `上次备份已是 ${d} 天前，建议重新导出一份` };
  return { level: 'ok', days: d, text: `上次备份：${d} 天前` };
}

export { canonical };
