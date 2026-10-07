/* 无浏览器 DOM 替身：把界面层产出的 HTML 字符串真的解析成节点树，再派发 pointer / click 事件。
   为什么不用 jsdom：这个应用的前提是零依赖，测试也不该例外；
   而"拖动改日期""左滑删待办"这类手势，拿字符串断言等于没测——必须真的派发事件、真的走到写库。
   只实现到本应用用到的程度，不多做通用兼容。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'use', 'path', 'circle']);
const camel = k => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase());

let warnings = [];

class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag; this.attrs = { ...attrs }; this.children = []; this.seq = []; this.parentNode = null;
    this.text = ''; this.style = {}; this._rect = null; this.nodeType = tag === '#document' ? 9 : 1;
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get id() { return this.attrs.id || ''; }
  get dataset() {
    const o = {};
    for (const k in this.attrs) if (k.startsWith('data-')) o[camel(k.slice(5))] = this.attrs[k];
    return o;
  }
  /* seq 保留"文本与子元素交错的原序"：不保留就会把 <h2>标题<em>副</em></h2>
     序列化成 <h2><em>副</em>标题</h2>，正则断言全瞎——第一版就踩了这个坑 */
  get textContent() { return this.seq.map(p => (typeof p === 'string' ? p : p.textContent)).join(''); }
  set textContent(v) { this.children = []; this.seq = [String(v)]; }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    const put = a => { self.attrs.class = a.join(' '); };
    return {
      add: (...c) => { const a = list(); c.forEach(x => { if (!a.includes(x)) a.push(x); }); put(a); },
      remove: (...c) => put(list().filter(x => !c.includes(x))),
      contains: c => list().includes(c),
      toggle: (c, force) => {
        const has = list().includes(c), on = force === undefined ? !has : !!force;
        put(on ? [...new Set([...list(), c])] : list().filter(x => x !== c));
        return on;
      }
    };
  }
  hasAttribute(a) { return a in this.attrs; }
  getAttribute(a) { return a in this.attrs ? this.attrs[a] : null; }
  setAttribute(a, v) { this.attrs[a] = String(v); }
  appendChild(c) { c.parentNode = this; this.children.push(c); this.seq.push(c); return c; }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    const j = p.seq.indexOf(this);
    if (j >= 0) p.seq.splice(j, 1);
    this.parentNode = null;
  }
  /* 选择器只支持本应用用到的形式：.a.b / [attr] / [attr="v"] / tag，
     允许空格后代组合与逗号并列（.swipe [data-swdel] 这种要能命中） */
  matches(sel) { return String(sel).split(',').some(s => matchSel(this, s.trim())); }
  closest(sel) {
    let n = this;
    while (n) { if (n.nodeType !== 9 && n.matches && n.matches(sel)) return n; n = n.parentNode; }
    return null;
  }
  descendants() { const out = []; const walk = e => e.children.forEach(c => { out.push(c); walk(c); }); walk(this); return out; }
  querySelector(sel) { return this.descendants().find(e => e.matches(sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter(e => e.matches(sel)); }
  getBoundingClientRect() {
    if (this._rect) return this._rect;
    return this.parentNode ? this.parentNode.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  set innerHTML(v) { this.children = []; this.seq = []; this.text = ''; parseInto(this, String(v)); }
  get innerHTML() { return this.seq.map(serialize).join(''); }
  focus() {} click() {}
}

const escapeText = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const serialize = p => {
  if (typeof p === 'string') return escapeText(p);
  const at = Object.entries(p.attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<${p.tagName}${at ? ' ' + at : ''}>${p.seq.map(serialize).join('')}</${p.tagName}>`;
};

function matchCompound(el, comp) {
  const tokens = comp.match(/(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(\[[^\]]+\])/g) || [];
  if (!tokens.length) return false;
  return tokens.every(tk => {
    if (tk[0] === '.') return el.classList ? el.classList.contains(tk.slice(1)) : false;
    if (tk[0] === '[') {
      const m = tk.match(/^\[([\w:-]+)(?:=("?)([^"\]]*)\2)?\]$/);
      if (!m) { warnings.push('选择器没解析动：' + comp); return false; }
      const v = el.getAttribute(m[1]);
      if (v === null) return false;
      return m[3] === undefined || v === m[3];
    }
    return el.tagName === tk;
  });
}
function matchSel(el, sel) {
  const comps = String(sel).trim().split(/\s+/).filter(Boolean);
  if (!comps.length) return false;
  if (!el.matches || el.nodeType !== 1) return false;
  if (!matchCompound(el, comps[comps.length - 1])) return false;
  let n = el.parentNode;
  for (let i = comps.length - 2; i >= 0; i--) {
    let hit = false;
    while (n) {
      if (n.nodeType === 1 && matchCompound(n, comps[i])) { hit = true; break; }
      n = n.parentNode;
    }
    if (!hit) return false;
    n = n && n.parentNode;
  }
  return true;
}

function parseAttrs(s) {
  const out = {};
  for (const m of String(s).matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)')?/g))
    out[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : '');
  return out;
}

function parseInto(root, html) {
  const stack = [root];
  const addText = (el, t) => {
    const last = el.seq[el.seq.length - 1];
    if (typeof last === 'string') el.seq[el.seq.length - 1] = last + t;
    else el.seq.push(t);
  };
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  for (const m of String(html).matchAll(re)) {
    if (m[5] !== undefined) {
      const t = m[5].trim();
      if (t) addText(stack[stack.length - 1], t + ' ');
      continue;
    }
    const [, close, tag, rawAttrs, selfClose] = m;
    if (close) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
        /* 标签不配对：静默补全会让"看起来正常"的界面少一层容器，必须留下记录 */
        warnings.push(`</${tag}> 没有对应的开标签`);
      }
      continue;
    }
    const el = new El(tag, parseAttrs(rawAttrs));
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID.has(tag)) stack.push(el);
  }
}

/* ---------- 事件派发：捕获阶段与冒泡阶段分开，stopPropagation 真的能拦住冒泡 ----------
   这正是手势层"吞点击"能生效的原因：document 在捕获阶段先跑，
   调 stopPropagation 后，同一条路径上 document 的冒泡步骤不再执行。 */
export function makeDom(opts = {}) {
  const skeleton = opts.skeleton || readFileSync(join(HERE, '..', 'index.html'), 'utf8')
    .replace(/^[\s\S]*<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const doc = new El('#document', {});
  parseInto(doc, skeleton);
  const lis = {};
  const all = () => [doc, ...doc.descendants()];

  const api = {
    El, doc, lis, warnings,
    document: {
      get documentElement() { return doc.querySelector('html') || doc; },
      get body() { return doc.querySelector('body') || doc; },
      getElementById: id => all().find(e => e.id === id) || null,
      querySelector: sel => all().find(e => e.nodeType === 1 && e.matches(sel)) || null,
      querySelectorAll: sel => all().filter(e => e.nodeType === 1 && e.matches(sel)),
      createElement: tag => new El(tag, {}),
      addEventListener: (t, f, capture) => { (lis[t] = lis[t] || []).push({ f, capture: !!capture }); },
      elementFromPoint: (x, y) => {
        const hit = all().filter(e => e._rect && inRect(e._rect, x, y));
        return hit.length ? hit[hit.length - 1] : null;   // 深度优先遍历的最后一个 = 最深
      }
    },
    fire(type, ev = {}) {
      const e = { type, target: ev.target || null, clientX: ev.clientX || 0, clientY: ev.clientY || 0,
        button: ev.button || 0, key: ev.key, _stop: false,
        stopPropagation() { this._stop = true; }, preventDefault() { this._prevented = true; } };
      const list = lis[type] || [];
      list.filter(l => l.capture).forEach(l => { if (!e._stop) l.f(e); });
      const bubbled = e._stop;                       // 冒泡被吞掉要能被断言看到
      list.filter(l => !l.capture).forEach(l => { if (!e._stop) l.f(e); });
      return { stopped: bubbled, prevented: !!e._prevented };
    },
    /* 手势起止坐标全靠这里：真实浏览器有布局，替身只给"值得命中"的元素摆位置 */
    layout({ cellW = 120, cellH = 90, rowH = 44, actW = 96 } = {}) {
      const cells = doc.querySelectorAll('[data-day]');
      cells.forEach((c, i) => {
        const col = i % 7, row = Math.floor(i / 7);
        c._rect = { left: 40 + col * cellW, top: 120 + row * cellH, width: cellW - 4, height: cellH - 4 };
        c._rect.right = c._rect.left + c._rect.width; c._rect.bottom = c._rect.top + c._rect.height;
      });
      doc.querySelectorAll('.swipe').forEach((w, i) => {
        w._rect = { left: 40, top: 120 + i * rowH, width: 900, height: rowH - 2 };
        w._rect.right = 940; w._rect.bottom = w._rect.top + w._rect.height;
        ['.swacts.l', '.swacts.r'].forEach(sel => {
          const a = w.querySelector(sel); if (!a) return;
          const l = sel.endsWith('.l') ? 40 : 940 - actW;
          a._rect = { left: l, top: w._rect.top, width: actW, height: w._rect.height };
          a._rect.right = l + actW; a._rect.bottom = w._rect.bottom;
        });
      });
      return cells;
    },
    rectOf: sel => { const e = (typeof sel === 'string' ? api.document.querySelector(sel) : sel);
      return e ? e.getBoundingClientRect() : null; },
    center: rect => ({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }),
    makeEl: (tag, attrs) => new El(tag, attrs)
  };
  return api;
}

function inRect(r, x, y) { return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

/* IndexedDB 替身：够用到"重启后数据还在"这个程度（open/getAll/put/delete/clear/transaction） */
export function fakeIdb() {
  const dbs = {};
  const rq = () => { const r = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null };
    r._done = v => { r.result = v; setTimeout(() => r.onsuccess && r.onsuccess(), 0); }; return r; };
  class St { constructor(kp) { this.kp = kp; this.rows = new Map(); }
    createIndex() {}
    getAll() { const r = rq(); r._done([...this.rows.values()].map(v => JSON.parse(JSON.stringify(v)))); return r; }
    put(v) { const r = rq(); this.rows.set(v[this.kp], JSON.parse(JSON.stringify(v))); r._done(v[this.kp]); return r; }
    delete(k) { this.rows.delete(k); const r = rq(); setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; }
    clear() { this.rows.clear(); } }
  class DB { constructor() { this.s = {}; }
    createObjectStore(n, o) { this.s[n] = new St(o.keyPath); return this.s[n]; }
    transaction(n) { const s = this.s[n]; const t = { objectStore: () => s, oncomplete: null, onerror: null };
      setTimeout(() => t.oncomplete && t.oncomplete(), 0); return t; }
    close() {} }
  return { open(name, ver) {
    if (!dbs[name]) dbs[name] = { db: new DB(), v: 0 };
    const e = dbs[name], r = rq();
    if (e.v < ver) { const ev = { oldVersion: e.v }; e.v = ver; r.result = e.db;
      setTimeout(() => { r.onupgradeneeded && r.onupgradeneeded(ev); r.onsuccess && r.onsuccess(); }, 0); }
    else r._done(e.db);
    return r; } };
}

export { inRect };
export { El };
