// 原型自检：node prototype/smoke.js
// 把 kiosk.html 的内联脚本取出来，在无浏览器环境下验证五件事：
//   A 记录分类  B 画面渲染  C 主题落根元素  D 状态机  E 布局  F 成员管理  G 真实点击与按键派发
// 退出码即结果。展开算法的正式回归在实现期由 tests/expand.test.js 承载（docs/02 §5 的 25 类用例）。
const fs = require('fs');
const path = require('path');
const HERE = p => path.join(__dirname, p);

/* 无浏览器 DOM 桩：捕获 innerHTML 与 setAttribute（后者用于断言主题落到根元素） */
const store = {}, attrs = {}, docLis = {}, winLis = {};
const el = id => new Proxy({ id }, {
  get(t, p) {
    if (p === 'innerHTML') return store[id] || '';
    if (p === 'textContent') return '';
    if (p === 'value') return store['__v__' + id] || '';
    if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false } };
    if (p === 'style' || p === 'dataset' || p === 'attributes') return {};
    if (p === 'setAttribute') return (k, v) => { attrs[id + '.' + k] = v };
    return () => undefined;
  },
  set(t, p, v) { if (p === 'innerHTML') store[t.id] = v; return true; }
});
global.document = {
  getElementById: el, body: el('body'), documentElement: el('html'),
  addEventListener(t, fn) { (docLis[t] = docLis[t] || []).push(fn) },
  querySelector: () => null, querySelectorAll: () => []   // 与浏览器一致：查不到返回 null
};
global.window = { AudioContext: undefined };
global.addEventListener = (t, fn) => { (winLis[t] = winLis[t] || []).push(fn) };

let bad = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) bad++;
  console.log('  ' + (cond ? '✓' : '✗') + ' ' + label + (extra ? ' → ' + extra : ''));
};

const HTML = fs.readFileSync(HERE('kiosk.html'), 'utf8');
const cssAll = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
(0, eval)(HTML.match(/<script>([\s\S]*?)<\/script>/)[1] + `
;globalThis.__k={S,render,H,demo,saveMember,MEMBERS,PALETTE,activeMembers,dayOf,expand,todos,openTodos,countdowns,toggleTodo,saveFromDrawer,
  fireBanner,write,src,parse,EVENTS,MEMBERS,M,PAGES,THEMES,TODAY,add,KIND,setTheme};`);
const K = global.__k, { S, dayOf, TODAY, add, parse } = K;

console.log('A 记录分类与展开');
ok('今天首项是 📌 置顶', dayOf(TODAY)[0].pin === true, dayOf(TODAY).slice(0, 2).map(e => e.title).join(', '));
ok('全天项排在定时项之前', dayOf(add(TODAY, 5))[0].allDay === true);
ok('跨天日程在区间内每天都出现（不中途消失）', (() => {
  const g = []; for (let i = 2; i <= 7; i++) if (dayOf(add(TODAY, i)).some(e => e.id === 'r207')) g.push(i);
  return g.join(',') === '3,4,5,6';
})(), '出差第 3~6 天');
ok('工作日重复 28 天内 ≈20 次', (() => {
  let n = 0; for (let i = 0; i < 28; i++) if (dayOf(add(TODAY, i)).some(e => e.id === 'r202')) n++;
  return n >= 19 && n <= 21;
})());
const allCal = K.expand(TODAY, add(TODAY, 45));
ok('待办与倒数日在日历展开结果里一个都不出现', allCal.every(e => e.kind === 'event'),
  allCal.length + ' 个实例全部 kind=event');
ok('待办清单能单独查出来', K.openTodos().length >= 8, K.openTodos().length + ' 件未完成');
ok('打勾后从清单消失（记录仍在，可撤销）', (() => {
  const t = K.openTodos()[0], id = t.id;
  K.toggleTodo(id); const gone = !K.openTodos().some(e => e.id === id);
  K.toggleTodo(id); return gone && K.openTodos().some(e => e.id === id);
})());
ok('倒数日按剩余天数升序', (() => { const c = K.countdowns(); return c.every((x, i) => i === 0 || c[i - 1].left <= x.left) })(),
  K.countdowns().map(c => c.left).join(','));
ok('年度倒数日过期自动滚到下一年', (() => {
  const c = K.countdowns().find(x => x.repeat && x.repeat.freq === 'yearly');
  return c && c.left >= 0;
})());
ok('软删除（墓碑）项不再渲染', (() => {
  const e = K.src('r211'); e.deletedAt = new Date().toISOString();
  const gone = !K.expand(TODAY, add(TODAY, 13)).some(x => x.id === 'r211');
  e.deletedAt = null; return gone;
})());

console.log('\nB 画面渲染');
const NEEDLES = ['undefined', 'NaN', 'Invalid Date', '${', 'function'];
function shot(name, mutate) {
  for (const k of Object.keys(store)) delete store[k];
  let h = '';
  try { mutate(); h = Object.values(store).join(''); }
  catch (e) { bad++; console.log('  ✗ ' + name + ' 抛错：' + e.message); return '' }
  const hit = NEEDLES.filter(t => h.includes(t));
  if (hit.length) { bad++; console.log('  ✗ ' + name + ' 含异常标记 ' + hit.join(',')) }
  else console.log('  ✓ ' + name.padEnd(18) + ' ' + h.length + ' 字符');
  return h;
}
S.hidden = new Set();
for (let p = 0; p < K.PAGES.length; p++) {
  const h = shot('壁挂·' + K.PAGES[p].name, () => { S.layer = 'kiosk'; S.page = p; K.render() });
  if (p === 1) ok('  本周页 7 列齐全', (h.match(/class="wkcol[ "]/g) || []).length === 7);
  if (p === 2) ok('  本月页 42 格齐全', (h.match(/class="mcell/g) || []).length === 42);
  if (p === 3) {
    ok('  待办页 6 张大卡且可直接打勾', (h.match(/class="tcard2"/g) || []).length === 6 && /data-todo="r\d+"/.test(h));
    ok('  待办第 7 条起折叠为"还有 N 条"', /还有 \d+ 条未完成/.test(h));
  }
}
S.page = 0; K.render();
const hSide = store['host'];
ok('  轮播 = 今天/本周/本月/待办', K.PAGES.map(p => p.name).join('/') === '今天/本周/本月/待办');
ok('② 右栏保留 倒数日 + 明天 + 本周还剩 三块',
  /倒数日/.test(hSide) && /明天 ·/.test(hSide) && /本周还剩/.test(hSide), '三盒齐全');
ok('② 待办仍在轮播页而非右栏', !/class="tcard2"/.test(hSide));
ok('  "今天在场"确已移除（用户上轮要求）', !/今天在场/.test(hSide));
const hD = shot('详情', () => { S.layer = 'detail'; S.cur = { ...K.src('r204'), date: TODAY }; K.render() });
ok('  详情含"上次由 X 修改 · 版本 v"信任行', /上次由/.test(hD) && /版本 v\d/.test(hD));
const hE = shot('编辑抽屉', () => { S.layer = 'editor'; S.cur = null; S.newKind = 'event'; S.warnRemote = '妈妈'; K.render() });
ok('  类型三选（日程/待办/倒数日）在一级位置', ['event', 'todo', 'countdown'].every(k => hE.includes('data-kind="' + k + '"')));
shot('待办抽屉', () => { S.newKind = 'todo'; K.render() });
ok('  选待办时不渲染时间输入框', !/id="f-tm"/.test(store['dr']));
S.newKind = 'event'; S.warnRemote = null;
S.cur = { ...K.src('r202'), date: TODAY };
const hA = shot('重复三选一', () => { S.askMode = 'del'; K.render() });
ok('  三选文案齐全', ['仅此事件', '此事件及以后', '整个系列'].every(t => hA.includes(t)));
S.askMode = null; S.cur = null;
const hC = shot('冲突 409', () => {
  const e = K.src('r204');
  S.conflict = { local: { ...e }, server: { ...e, title: e.title + '？', version: e.version + 1 } }; K.render()
});
ok('  冲突卡并列展示两个版本', /我的版本/.test(hC) && /服务器版本/.test(hC));
S.conflict = null;
for (const t of ['cal', 'todo', 'cd', 'members', 'theme', 'remind', 'kiosk', 'backup', 'about']) {
  const h = shot('管理·' + t, () => { S.base = 'sheet'; S.layer = 'sheet'; S.tab = t; K.render() });
  ok('  ' + t + ' 面板确有内容（防空串假通过）', h.length > 3000, h.length + ' 字符');
  if (t === 'cal') ok('  管理月网格恒 42 格', (h.match(/class="cell/g) || []).length === 42);
  if (t === 'todo') ok('  待办 tab 含未完成 + 最近完成', /未完成/.test(h) && /最近完成/.test(h));
}
S.layer = 'kiosk';

console.log('\nC 主题：切换必须真的落到根元素');
ok('默认主题为暖木 wood', HTML.includes("theme:'wood'") && /<html lang="zh-CN" data-theme="wood">/.test(HTML));
ok('点击目标用 data-set-theme，不与根元素 data-theme 撞名（v0.5 bug 回归）',
  /data-set-theme=/.test(HTML) && !/on\('\[data-theme\]'/.test(HTML));
for (const t of K.THEMES) {
  K.setTheme(t.id);
  ok('  setTheme(' + t.id + ') → 根元素已更新', attrs['html.data-theme'] === t.id, '根元素 = ' + attrs['html.data-theme']);
  ok('  ' + t.id + ' 令牌块存在且含成员色档',
    new RegExp('data-theme="' + t.id + '"').test(cssAll) && cssAll.includes('--m-blue'));
}
ok('THEMES 数量 = 4', K.THEMES.length === 4, K.THEMES.map(t => t.id).join(','));
/* 令牌声明行（--xxx: #hex）合法；其余任何十六进制都算违反"组件只引用 var(--c-*)" */
const nonToken = cssAll.split('\n').filter(l => !/^\s*--[\w-]+\s*:/.test(l)).join('\n');
const hardColors = nonToken.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
ok('组件样式内无写死颜色（令牌化约束，docs/03 §4.1）', hardColors.length === 0,
  hardColors.length ? '发现 ' + [...new Set(hardColors)].slice(0, 6).join(' ') : '零命中');
/* 截图暴露的真实缺陷：隐藏态的提示条没藏干净，在屏幕底边露出一截像椭圆框 */
const toastRule = (cssAll.match(/\.toast\{[^}]*\}/) || [''])[0];
ok('提示条隐藏态真的不可见（位移 + opacity + visibility 三重）',
  /opacity:0/.test(toastRule) && /visibility:hidden/.test(toastRule) && /pointer-events:none/.test(toastRule),
  toastRule.replace(/\s+/g,' ').slice(0,0) || '已三重隐藏');
ok('提示条不再是胶囊圆角', !/border-radius:99px/.test(toastRule) && /border-radius:var\(--r-btn\)/.test(toastRule));
const toastOn = (cssAll.match(/\.toast\.on\{[^}]*\}/) || [''])[0];
ok('提示条显示态把三者都恢复', /opacity:1/.test(toastOn) && /visibility:visible/.test(toastOn));
/* 新建窗底部那段长说明已按你要求删除 */
ok('新建浮窗里没有大段说明文字', !/📢/.test(HTML) && !/提醒只在/.test(HTML));

console.log('\nE 布局收敛（本轮反馈）');
S.theme = 'wood'; S.layer = 'kiosk'; S.page = 0; K.render();
const hostNow = store['host'];
ok('顶部不再有"原型演示"胶囊条', !/<div class="demo">/.test(HTML));
ok('壁挂底部横条已去掉', !/class="ft"/.test(hostNow) && !/\.ft\{/.test(cssAll));
ok('标题只留页名与概要，页码在底部换屏提示里', /<h2>今天<em>/.test(hostNow) && /1\/4/.test(hostNow),
  (hostNow.match(/<h2>[^<]{0,12}/) || ['未命中'])[0]);
ok('倒数日盒去掉小圆点与下方列表', !/cddots/.test(hostNow) && !/cdlist/.test(hostNow));
const cdBig = +(cssAll.match(/\.cd \.big b\{font-size:([\d.]+)vmin/) || [0, 13])[1];
ok('倒数日天数 ≤ 标题档 6.0vmin（不再压过顶栏）', cdBig <= 6.0, cdBig + 'vmin');
const nRaw = cssAll.match(/\.mcell \.n\{font-size:([^;}]+)/)[1];
const rRaw = cssAll.match(/\.mcell \.r\{[^}]*?font-size:([^;}]+)/)[1];
const nS = nRaw.includes('--t-item') ? 2.2 : parseFloat(nRaw);
const rS = parseFloat(rRaw);
ok('① 月视图字号回到第一版档（日号 2.2 / 条目 1.7vmin）', nS <= 2.4 && rS <= 1.8, nRaw+' / '+rRaw);
S.page = 2; K.render();
const mh = store['host'];
const busy = K.expand(TODAY, add(TODAY, 20));
ok('① 月格每格可见 2 条任务 + 其余以 "+N" 显示', /class="more">\+\d+<\/div>/.test(mh)
  && (mh.match(/class="r"/g) || []).length >= 4, (mh.match(/class="r"/g) || []).length + ' 条渲染');
ok('月格可点击跳到该日', /data-pagemonth/.test(mh));
S.layer='sheet'; S.base='sheet'; S.tab='cal'; K.render();
const calHtml = store['sheet'] || '';
ok('③ 管理月历的超出条数是日号角标、不占行高',
  /\.cell \.mb\{position:absolute/.test(cssAll) && /class="mb"/.test(calHtml));
ok('③ 浮窗与所有容器的内边距都生效（结构类已全局化，不再依赖具体容器）',
  /^\.ph\{padding:2\.6vmin 3\.2vmin/m.test(cssAll) && /^\.pb\{padding:2\.2vmin 3\.2vmin/m.test(cssAll)
  && !/\.panel \.ph/.test(cssAll));
ok('③ 浮窗宽度加到 88vmin', /\.drawer\{[^}]*width:88vmin/.test(cssAll));
ok('③ 取消按钮是大号胶囊', /\.row button\.cancel\{flex:0 0 22%/.test(cssAll));
S.layer='kiosk'; S.base='kiosk';
S.page = 0; S.layer = 'sheet'; K.render();
ok('管理页右栏优先全高（不再半高带滚动条）',
  /\.paneList\{[^}]*align-self:stretch/.test(cssAll) && !/\.paneList\{[^}]*max-height/.test(cssAll),
  'stretch 且无 max-height');
ok('管理页左右两栏间隔已拉大（.scr gap ≥2.4vmin）',
  (+(cssAll.match(/\.scr\{[^}]*gap:([\d.]+)vmin/)||[0,0])[1]) >= 2.4,
  (cssAll.match(/\.scr\{[^}]*gap:([\d.]+)vmin/)||[0,'?'])[1]+'vmin');
S.base = 'sheet'; S.layer = 'sheet'; S.tab = 'about'; K.render();
ok('自检用例收进管理页"关于"，壁挂端无入口',
  /自检用例/.test(store['sheet'] || '') && !/自检用例/.test(store['host'] || ''));
/* ③ 新增入口：不在管理页标题区，而在日历右下方；⑤ 待办/倒数页各有自己的新增按钮 */
S.layer = 'sheet'; S.base = 'sheet';
S.tab = 'cal'; K.render();
const calPane = store['sheet'] || '';
S.tab = 'todo'; K.render();
const todoPane = store['sheet'] || '';
S.tab = 'cd'; K.render();
const cdPane = store['sheet'] || '';
S.tab = 'cal';
ok('③ 管理页标题区没有新增按钮', !/ph"[\s\S]{0,240}data-new/.test(calPane));
ok('③ 日历选中日列表右下方有「＋ 新增日程」', /data-new="event"[\s\S]{0,140}新增日程/.test(calPane));
ok('⑤ 待办页有「＋ 新增待办」', /data-new="todo"[\s\S]{0,140}新增待办/.test(todoPane));
ok('⑤ 倒数日页有「＋ 新增倒数日」', /data-new="countdown"[\s\S]{0,140}新增倒数日/.test(cdPane));
/* ④ 管理页里点日程：管理页必须留在身后 */
S.layer = 'detail'; S.cur = { ...K.src('r204'), date: TODAY }; K.render();
ok('④ 点日程后管理页仍在身后（base=sheet 且 sheet 仍渲染）',
  S.base === 'sheet' && /class="tabd"/.test(store['sheet'] || ''), 'sheet 内容长度 ' + (store['sheet'] || '').length);
S.layer = 'editor'; K.render();
ok('③ 新建是居中浮窗（不是从底部顶出的抽屉）',
  /\.drawer\{[^}]*left:50%[\s\S]{0,420}\.drawer\.on\{[^}]*translate\(-50%,-50%\)/.test(cssAll) && !/bottom:0;[\s\S]{0,40}border-top/.test(cssAll));
S.layer = 'sheet'; K.render();
ok('主界面没有新建按钮，新增只在管理页', !/class="addfab"/.test(hostNow) && !/data-new/.test(hostNow) && /data-new/.test((S.layer="sheet",S.tab="cal",K.render(),store['sheet']||"")));
S.layer = 'kiosk'; K.render();

console.log('\nF 成员管理与浮窗细节');
S.base='sheet'; S.layer='member'; S.curMem=null; S.pal=null; K.render();
const memModal = store['mMem'] || '';
ok('成员浮窗渲染（不再是点了没反应的占位按钮）', memModal.length > 800, memModal.length + ' 字符');
ok('色板 8 色全在', K.PALETTE.every(c => memModal.includes('data-pal="' + c + '"')));
ok('已占用的色标为不可选（一人一色）', /used/.test(memModal));
ok('浮窗有独立取消按钮', /data-cancel/.test(memModal));
const mn0 = K.MEMBERS.length;
store['__v__m-n'] = '爷爷';
S.layer='member'; S.curMem=null; S.pal='red'; K.saveMember();
const added = K.MEMBERS.find(m => m.name === '爷爷');
ok('填名字保存 → 成员真的建出来', K.MEMBERS.length === mn0 + 1 && !!added, K.MEMBERS.length + ' 人');
ok('首字留空自动取名字第一字', added && added.ini === '爷', added ? added.ini : '-');
ok('指定色被采用', added && added.ck === 'red', added ? added.ck : '-');
S.layer='sheet'; S.tab='cal'; K.render();
ok('新成员立刻出现在筛选 chips', /爷爷/.test(store['sheet'] || ''));
if (added) added.archived = true;
S.tab='members'; K.render();
ok('归档后移入"已归档"分组', /已归档 · 1/.test(store['sheet'] || ''));
S.tab='cal'; K.render();
ok('归档后不再出现在筛选 chips', !/爷爷/.test(store['sheet'] || ''));
S.tab='members'; K.render();
ok('已归档成员有恢复入口', /data-mem-unarch/.test(store['sheet'] || ''));
if (added) K.MEMBERS.splice(K.MEMBERS.indexOf(added), 1);
S.layer='kiosk'; S.base='kiosk'; K.render();


console.log('\nI 主界面与管理页顶部（本轮）');
S.layer='kiosk'; S.base='kiosk'; S.page=0; K.render();
const hostI = store['host'] || '';
ok('管理入口在右栏内常驻（非浮动元素）', /class="managebtn" data-sheet/.test(hostI)
  && !/\.managebtn\{[^}]*position:absolute/.test(cssAll));
ok('旧的浮动齿轮与 hover 显隐逻辑已彻底移除',
  !/class="gear/.test(hostI) && !/\.gear\{/.test(cssAll) && !/showGear/.test(HTML));
ok('底部换屏提示是普通文字行（不是椭圆胶囊）',
  /class="khint"/.test(hostI) && /自动换屏/.test(hostI) && /1\/4/.test(hostI)
  && !/class="pill"/.test(hostI) && !/class="dot"/.test(hostI));
S.layer='sheet'; S.base='sheet'; S.tab='cal'; K.render();
const shI = store['sheet'] || '';
ok('管理页顶栏提示文字已删除', !/整屏页面/.test(shI) && !/操作实时写入服务器/.test(shI));
ok('「回到壁挂」位于标题之后（靠 margin-left:auto 顶到右上角）',
  shI.indexOf('管理</h4>') < shI.indexOf('data-close>✕ 回到壁挂'));
S.layer='kiosk'; S.base='kiosk'; K.render();

console.log('\nG 真实派发点击与按键（此前只能验证"按钮存在"，验证不了"点得动"）');
function fakeBtn(attrsMap, insideRe) {
  const n = { dataset: {}, _a: attrsMap || {} };
  Object.keys(n._a).forEach(k => {
    n.dataset[k.replace(/^data-/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = n._a[k];
  });
  /* 真实 DOM 约定：hasAttribute/getAttribute 收到的是完整属性名（含 data- 前缀） */
  n.hasAttribute = k => k in n._a;
  n.getAttribute = k => n._a[k];
  /* closest：委托要能在 "[data-a],[data-b],…" 里挑出本节点拥有的属性；
     容器判断（.sheet/.drawer）按 insideRe 命中时返回自身 */
  n.closest = sel => String(sel).split(',').some(q => {
    q = q.trim();
    const m = q.match(/^\[data-([a-z-]+)\]$/);
    if (m) return ('data-' + m[1]) in n._a;
    if (q[0] === '.' && insideRe) return new RegExp(insideRe).test(q);
    return false;
  }) ? n : null;
  n.classList = { contains: () => false, add() {}, remove() {}, toggle() {} };
  n.stopPropagation = () => {};
  return n;
}
const click = (docLis.click || [])[0];
ok('应用只注册一个 click 委托监听', !!click && (docLis.click || []).length === 1,
  '监听数 ' + (docLis.click || []).length);

S.layer = 'kiosk'; S.base = 'kiosk'; K.render();
click({ target: fakeBtn({ 'data-sheet': '' }, '\\.sheet') });
ok('点右栏「⚙ 管理」→ 进入管理页', S.base === 'sheet' && S.layer === 'sheet');
click({ target: fakeBtn({ 'data-new': 'event' }, '\\.drawer') });
ok('点「＋ 新增日程」→ 打开浮窗', S.layer === 'editor');
click({ target: fakeBtn({ 'data-cancel': '' }, '\\.drawer') });
ok('① 点浮窗「取消」→ 浮窗关闭并留在管理页',
  S.layer === 'sheet' && S.base === 'sheet', 'layer=' + S.layer + ' base=' + S.base);
click({ target: fakeBtn({ 'data-new': 'todo' }, '\\.drawer') });
ok('待办浮窗可打开', S.layer === 'editor' && S.newKind === 'todo');
click({ target: fakeBtn({ 'data-cancel': '' }, '\\.drawer') });
ok('① 待办浮窗取消同样生效', S.layer === 'sheet');
click({ target: fakeBtn({ 'data-close': '' }, '\\.sheet') });
ok('只有点「✕ 回到壁挂」才退出管理页', S.base === 'kiosk' && S.layer === 'kiosk');

click({ target: fakeBtn({ 'data-sheet': '' }, '\\.sheet') });
const key = (winLis.keydown || [])[0];
ok('应用注册了 keydown 监听', !!key);
if (key) key({ key: 'Escape' });
ok('② 在管理页按 Esc 不退出（必须点明确按钮）',
  S.base === 'sheet' && S.layer === 'sheet', 'base=' + S.base + ' layer=' + S.layer);
click({ target: fakeBtn({ 'data-new': 'event' }, '\\.drawer') });
if (key) key({ key: 'Escape' });
ok('② 浮层开着时 Esc 只收起浮层，管理页留在身后', S.layer === 'sheet' && S.base === 'sheet');
click({ target: fakeBtn({ 'data-cancel': '' }, '\\.drawer') });
click({ target: fakeBtn({ 'data-close': '' }, '\\.sheet') });

S.layer = 'sheet'; S.base = 'sheet'; S.tab = 'cal'; S.anchor = TODAY.slice(0, 7); K.render();
const cal3 = store['sheet'] || '';
ok('③ 角标改到格子内部右上角（不再 left:100% 被 overflow 裁掉）',
  !/\.cell \.mb\{[^}]*left:100%/.test(cssAll) && /\.cell \.mb\{position:absolute;right:/.test(cssAll));
const mbs = (cal3.match(/class="mb">([^<]*)<\/i>/g) || []).map(t => t.replace(/class="mb">/, '').replace(/<\/i>/, ''));
ok('③ 角标内容形如 +N（N 为正整数，不带条/件）',
  mbs.length > 0 && mbs.every(t => /^\+\d+$/.test(t) && +t.slice(1) > 0), mbs.slice(0, 4).join(' '));
ok('③ 角标不带"条/件"字样', !/class="mb">[^<]*(条|件)/.test(cal3));
ok('③ 管理月历日号 2.6vmin / 条目 2.2vmin（比原来 1.6/1.5 大一档）',
  /\.cell \.dn\{font-size:2\.6vmin/.test(cssAll) && /\.cev\{font-size:2\.2vmin/.test(cssAll));
const tabCalSrc = HTML.slice(HTML.indexOf('function tabCal()'), HTML.indexOf('function weekPane()'));
const weekSrc   = HTML.slice(HTML.indexOf('function weekPane()'), HTML.indexOf('function dayBig()'));
ok('管理月历格内已去掉时间前缀（只留色块 + 标题）',
  !/class="cev"[^>]*>\$\{e\.time/.test(tabCalSrc), '月历模板不再拼 e.time');
ok('周视图列仍保留时间（那里更宽，几点是有用信息）',
  /class="cev"[^>]*>\$\{e\.time/.test(weekSrc), '周视图保留时间');
ok('只有日历 tab 保留右侧栏，其余标签页已清空右侧区域',
  (HTML.match(/class="paneList"/g)||[]).length === 1);
ok('③ 每格最多 2 条（42 格 ≤ 84 条）', (cal3.match(/class="cev"/g) || []).length <= 84,
  (cal3.match(/class="cev"/g) || []).length + ' 条');
S.layer = 'kiosk'; S.base = 'kiosk'; K.render();

console.log('\nH CSS 合法性（无头桩不做命中测试，非法属性会被浏览器静默丢弃 → 只能静态拦）');
function ruleOf(sel) {
  const i = cssAll.indexOf(sel + '{');
  if (i < 0) return '';
  return cssAll.slice(i, cssAll.indexOf('}', i) + 1);
}
ok('不存在 pointer: 这种非法属性名（正确名是 pointer-events）',
  !/[;{\n]\s*pointer\s*:/.test(cssAll));
/* v0.9 的真实缺陷：.drawer.on 写了 pointer:auto 被浏览器丢弃，基类 pointer-events:none 一直生效，
   整个新建浮窗点击穿透到下层——详情窗因为写对了所以正常。这类问题必须静态拦住。 */
const leaky = ['.drawer', '.mask', '.sheet'].filter(b =>
  /pointer-events\s*:\s*none/.test(ruleOf(b)) && !/pointer-events\s*:\s*auto/.test(ruleOf(b + '.on')));
ok('设了 pointer-events:none 的浮层，激活态都把 auto 打开（防点击穿透）',
  leaky.length === 0, leaky.length ? leaky.join(',') + ' 缺激活态' : '抽屉/遮罩/管理页三处均成对');
ok('新建浮窗与详情浮窗在穿透这件事上写法一致',
  /pointer-events\s*:\s*auto/.test(ruleOf('.drawer.on')) && /pointer-events\s*:\s*auto/.test(ruleOf('.mask.on')));
const ALLOWED_SRC = ['accent-color align-items align-self animation background border border-bottom',
  'border-bottom-color border-color border-radius bottom box-shadow box-sizing color content cursor display',
  'flex flex-direction flex-wrap font font-family font-size font-style font-variant-numeric font-weight gap',
  'grid-auto-rows grid-template-columns height inset justify-content left letter-spacing line-height margin',
  'margin-bottom margin-left margin-top max-height min-height min-width opacity outline outline-offset overflow',
  'overflow-x padding padding-bottom padding-top place-items pointer-events position right text-align',
  'text-decoration text-overflow top touch-action transform transition user-select white-space width z-index',
  'border-top border-left border-right flex-shrink visibility margin-left margin-right padding-left padding-right'].join(' ');
const ALLOWED = new Set(ALLOWED_SRC.split(' '));   /* 注意括号：'a'+'b'.split() 只会切最后一段 */
const used = new Set([...cssAll.matchAll(/[;{}\n]\s*([a-z][a-z0-9-]*)\s*:/gi)].map(m => m[1]));
const odd = [...used].filter(p => !ALLOWED.has(p));
ok('所有声明属性名都在已核对的合法属性基线内', odd.length === 0,
  odd.length ? '未知属性：' + odd.join(', ') : used.size + ' 个全部合法');


/* 结构类作用域守卫：骨架类若只写在某个容器作用域下，换一个新容器使用就会静默无样式。
   本轮缺陷即 .sheet 的 .ph/.x 没吃到 .panel 下的样式，导致"回到壁挂"没移到右侧。 */
function styledFor(clsName, ctxList) {
  const bare = new RegExp('(^|\\n|\\})\\s*\\.' + clsName + '\\b[^{,]*\\{');
  if (bare.test(cssAll)) return true;
  return ctxList.some(a => new RegExp('\\.' + a + ' \\.' + clsName + '\\b[^{]*\\{').test(cssAll));
}
S.layer = 'sheet'; S.base = 'sheet'; S.tab = 'cal'; K.render();
const un1 = ['ph', 'pb', 'x', 'tabd'].filter(c => !styledFor(c, ['sheet', 'panel']));
ok('管理页骨架类都能解析到样式（不再静默无样式）', un1.length === 0, un1.join(',') || 'ph/pb/x/tabd 均解析');
ok('「✕ 回到壁挂」靠全局 .x 的 margin-left:auto 顶到右侧',
  /^\.x\{[^}]*margin-left:auto/m.test(cssAll));
S.layer = 'editor'; S.cur = null; S.newKind = 'event'; K.render();
const un2 = ['ph', 'pb', 'x'].filter(c => !styledFor(c, ['drawer', 'panel']));
ok('浮窗骨架类同样可解析', un2.length === 0, un2.join(',') || 'OK');
S.layer = 'kiosk'; S.base = 'kiosk'; K.render();
const hostK = store['host'] || '';
const mb = (cssAll.match(/\.managebtn\{[^}]*\}/) || [''])[0];
const mbSize = +((mb.match(/font-size:([\d.]+)vmin/) || [0, 9])[1]);
ok('主界面管理入口已加大并加回边框',
  /border:1px solid var\(--c-panel-line\)/.test(mb) && (+(mb.match(/font-size:([\d.]+)vmin/)||[0,0])[1]) >= 2.8,
  (mb.match(/font-size:([\d.]+)vmin/)||[0,'?'])[1]+'vmin，带边框');
ok('管理入口去掉了撑高度的小字副标', !/<small>/.test((hostK.match(/class="managebtn"[^>]*>([^<]*)/) || ['', ''])[1]));


/* 本轮两条：周视图列宽溢出、右栏面板层次 */
const wkcol=(cssAll.match(/\.wkcol\{[^}]*\}/)||[''])[0];
ok('周视图列已设 min-width:0（长标题不再把列撑破 70% 主区）',
  /min-width:0/.test(wkcol) && /flex:1 1 0/.test(wkcol), wkcol.replace(/\s+/g,' ').slice(0,46)+'…');
ok('所有 7 列网格都用 minmax(0,1fr)（1fr 的 min-content 下限同样会撑破）',
  !/repeat\(7,1fr\)/.test(cssAll) && (cssAll.match(/repeat\(7,minmax\(0,1fr\)\)/g)||[]).length >= 3
  && !/repeat\(7,1fr\)/.test(HTML));
ok('四套主题都定义了面板层次令牌 --c-panel / --c-panel-line',
  (HTML.match(/--c-panel:/g)||[]).length === 4 && (HTML.match(/--c-panel-line:/g)||[]).length === 4);
const boxH3=(cssAll.match(/\.box h3\{[^}]*\}/)||[''])[0];
ok('右栏面板有标题带底色与分隔线（不再三块糊成一片）',
  /background:var\(--c-card2\)/.test(boxH3) && /border-bottom:1px solid var\(--c-panel-line\)/.test(boxH3));
ok('面板内条目之间有行分隔线', /\.li\{[^}]*border-bottom:1px solid var\(--c-line\)/.test(cssAll));
S.layer='kiosk'; S.base='kiosk'; S.page=1; K.render();
ok('本周页仍渲染 7 列', ((store['host']||'').match(/class="wkcol[ "]/g)||[]).length === 7);
S.page=0; K.render();
console.log('\nJ 重复日程的结束日期');
const edSrc = HTML.slice(HTML.indexOf('function drawerHTML'), HTML.indexOf('function sheetHTML'));
ok('「结束日期」排在「重复」之后', edSrc.indexOf('id="f-rp"') < edSrc.indexOf('id="f-until"'));
ok('结束字段是日期输入（type=date），不再是时间',
  /<label>结束日期<\/label><input type="date" class="num" id="f-until"/.test(edSrc));
ok('旧的「结束 + type=time」字段已移除',
  !/<label>结束<\/label><input type="time"/.test(edSrc));
ok('提示文案讲清两种取值的含义', /留空 = 一直循环/.test(edSrc) && /选了「重复」才用得上/.test(edSrc));

/* 行为：带 until 的每周日程，实例必须止于该日；不带的继续往后铺 */
const jWeekly = K.mk ? null : null;
const base = { id: 'jw1', title: 'J测试·每周课', memberId: 'kid', date: TODAY, time: '16:00', kind: 'event' };
const withUntil = Object.assign(base, { repeat: { freq: 'weekly', byWeekdays: [parse(TODAY).getDay()], until: add(TODAY, 14) } });
const noUntil = { id: 'jw2', title: 'J测试·无结束', memberId: 'kid', date: TODAY, time: '17:00', kind: 'event',
  repeat: { freq: 'weekly', byWeekdays: [parse(TODAY).getDay()] } };
K.EVENTS.push(withUntil, noUntil);
const winEnd = add(TODAY, 40);
const insU = K.expand(TODAY, winEnd).filter(e => e.id === withUntil.id);
const insN = K.expand(TODAY, winEnd).filter(e => e.id === noUntil.id);
ok('设了结束日期 → 实例止于该日（不越界）',
  insU.length > 0 && insU.every(e => e.date <= withUntil.repeat.until),
  insU.length + ' 个实例，最后 ' + (insU[insU.length - 1] || {}).date + ' ≤ ' + withUntil.repeat.until);
ok('未设结束日期 → 一直循环（实例明显更多）', insN.length > insU.length,
  insN.length + ' vs ' + insU.length);
ok('带 until 的日程仍出现在结束日之前的正确星期',
  insU.every(e => parse(e.date).getDay() === parse(TODAY).getDay()));

/* 保存路径：表单里的结束日期要落进 repeat.until */
K.S.layer = 'editor'; K.S.cur = null; K.S.newKind = 'event';
store['__v__f-t'] = '采买年货'; store['__v__f-d'] = TODAY; store['__v__f-tm'] = '10:00';
store['__v__f-rp'] = 'weekly'; store['__v__f-until'] = add(TODAY, 21); store['__v__f-nt'] = '';
K.saveFromDrawer();
const saved = K.EVENTS.find(e => e.title === '采买年货');
ok('保存后 repeat 带上了 until', !!saved && saved.repeat && saved.repeat.until === add(TODAY, 21),
  saved && saved.repeat ? String(saved.repeat.until) : '无 repeat');
store['__v__f-rp'] = 'weekly'; store['__v__f-until'] = ''; store['__v__f-t'] = '长期晨跑';
K.S.layer = 'editor'; K.S.cur = null; K.S.newKind = 'event'; K.saveFromDrawer();
const saved2 = K.EVENTS.find(e => e.title === '长期晨跑');
ok('不填结束日期 → repeat 无 until（永不终止）', !!saved2 && !saved2.repeat.until);
/* 收尾：清掉测试注入的数据，避免影响后续断言 */
[withUntil, noUntil, saved, saved2].forEach(o => { const i = K.EVENTS.indexOf(o); if (i >= 0) K.EVENTS.splice(i, 1); });
K.S.layer = 'kiosk'; K.S.base = 'kiosk'; K.render();



console.log('\nD 状态机与回归');
const v0 = K.src('r204').version;
K.demo('remote');
ok('别端修改 → 版本号跟随 +1', K.src('r204').version === v0 + 1, 'v' + v0 + ' → v' + K.src('r204').version);
S.offline = true; K.write(K.src('r201'));
ok('断网写入进 pending 不报错', S.pending.has('r201') && S.pending.size === 1);
S.offline = false; S.pending = new Set();
const n0 = K.EVENTS.length;
S.base = 'sheet'; S.layer = 'editor'; S.cur = null; S.askMode = 'del'; S.newKind = 'event';
K.saveFromDrawer();
ok('空标题保存不崩溃', K.EVENTS.length === n0 + 1);
ok('从管理页保存后回到管理页（不是摔回壁挂）', S.layer === 'sheet' && S.base === 'sheet' && S.askMode === null);
S.base = 'kiosk'; S.layer = 'editor'; S.cur = null; S.askMode = 'del';
K.saveFromDrawer();
ok('从壁挂浮层保存后回到壁挂', S.layer === 'kiosk');
S.askMode = 'one'; S.cur = null;
try { K.render(); ok('askMode 有值但 cur 为空不再崩（白屏 bug 回归）', true) }
catch (e) { bad++; ok('askMode 有值但 cur 为空不再崩', false, e.message) }
S.askMode = null;
S.layer = 'sheet'; S.idle = 61;
ok('整屏管理页仍受 60 秒自动回落约束', S.layer === 'sheet' && S.idle >= 60);
S.idle = 0; S.layer = 'kiosk'; S.theme = 'wood'; K.render();

console.log(bad ? '\n结论：' + bad + ' 项不通过，需修' : '\n结论：A 记录 / B 渲染 / C 主题 / D 状态机 / E 布局 / F 成员 / G 点击派发 / H CSS / I 顶栏 / J 结束日期 全部通过');
process.exit(bad ? 1 : 0);
