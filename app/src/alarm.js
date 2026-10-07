/* 前台提醒调度。
   为什么不用系统通知：iOS 上网页不能调 new Notification()，Web Push 又要经 Apple 的 APNs
   通道（纯离线/内网不可达），且切后台或锁屏后定时器被冻结。
   所以提醒的可靠上限 = "这块屏亮着且停在本应用"。壁挂端常亮 + 引导式访问正好满足这个前提。
   详见 docs/01 §6.3。 */
import { expandRange, reminderTimes, firedKey, todayKey } from './domain.js';

export function makeAlarm({ repo, onFire, onMissed, now = () => new Date(),
  staleMinutes = 30, tickMs = 15000 }) {
  let timer = null, keys = new Set(), lastDay = null, enabled = true;

  async function loadKeys(day) {
    keys = new Set();
    try {
      const rows = await repo.readMetaByPrefix('fired:');
      rows.forEach(r => { if (!r.k.endsWith(day)) repo.dropMeta(r.k); });   // 滚动清理，防无限增长
      const today = rows.find(r => r.k === 'fired:' + day);
      if (today) keys = new Set(JSON.parse(today.v));
    } catch { /* 读不到就当没发过，宁可重发一次也不静默 */ }
  }
  async function saveKeys(day) {
    await repo.setMeta('fired:' + day, JSON.stringify([...keys]));
  }

  async function scan() {
    if (!enabled) return [];
    const n = now(), day = todayKey(n);
    if (day !== lastDay) { lastDay = day; await loadKeys(day); }
    const fired = [], missed = [];
    const todays = expandRange(repo.events(), day, day);
    for (const e of todays) {
      for (const r of reminderTimes(e, day)) {
        const key = firedKey(e, day, r.minutes);
        if (keys.has(key)) continue;
        const delta = n - r.at;                       // >0 已到点
        if (delta < 0) continue;                      // 还没到
        keys.add(key);
        if (delta > staleMinutes * 60000) { missed.push({ e, at: r.at }); continue; }
        fired.push({ e, at: r.at, minutes: r.minutes });
      }
    }
    if (fired.length || missed.length) await saveKeys(day);
    if (fired.length) onFire?.(fired);
    if (missed.length) onMissed?.(missed);            // 超 30 分钟只标灰，不补发声
    return fired;
  }

  return {
    start() { if (!timer) { scan(); timer = setInterval(scan, tickMs); } },
    stop() { clearInterval(timer); timer = null; },
    scan,                                            // 手动触发（测试与"立即检查"按钮用）
    setEnabled(v) { enabled = !!v; },
    get enabled() { return enabled; },
    /* 供设置页"试听"：不写幂等键，纯演示 */
    preview() { const day = todayKey(); const list = expandRange(repo.events(), day, day);
      return list.find(e => (e.reminders || []).length) || list[0] || null; }
  };
}

/* 提示音：WebAudio 现场合成，不引外部音频文件（保持"零网络资源"）。
   注意 iPad 侧边静音开关会掐掉网页音频，且无法绕过——所以设置页必须有"试听"与提示。 */
let ctx = null;
export async function playChime() {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    ctx = ctx || new AC();
    if (ctx.state === 'suspended') await ctx.resume();
    [0, 0.28].forEach((off, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + off;
      o.type = 'sine'; o.frequency.value = i ? 1046 : 784;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.24);
    });
    return true;
  } catch { return false; }
}
