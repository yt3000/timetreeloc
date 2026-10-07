/* 架构静态校验：不依赖浏览器，检查那些"只有真机才会炸"的东西。
   注意：所有检查都要防止空转——扫描目标为空时必须报错，而不是给个绿灯。 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const R = f => readFileSync(join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + l + (e ? ' → ' + e : '')); }
  else { fail++; console.log('  ✗ ' + l + (e ? ' → ' + e : '')); } };

const SRC = ['src/domain.js', 'src/db.js', 'src/backup.js', 'src/alarm.js', 'src/gestures.js', 'src/views.js', 'src/main.js'];
const allSrc = SRC.map(R).join('\n');
const css = R('styles.css');
const html = R('index.html');

console.log('1 语法');
for (const f of [...SRC, 'sw.js']) {
  let err = '';
  try { execFileSync(process.execPath, ['--check', join(ROOT, f)]); } catch (e) { err = String(e.stderr || e.message).split('\n')[0]; }
  ok(`${f} 语法通过`, !err, err);
}

console.log('\n2 import 的名字在目标模块里真的存在');
const pairs = [...allSrc.matchAll(/import\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+'(\.\/[^']+)'/g)];
ok('扫描到 import 语句（防止空转）', pairs.length >= 8, pairs.length + ' 条');
let bad = [];
for (const m of pairs) {
  const target = resolve(ROOT, 'src', m[3].replace('./', ''));
  let mod;
  try { mod = await import('file://' + target); }
  catch (e) { bad.push(`${m[3]} 无法加载`); continue; }
  if (m[1]) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
    names.forEach(n => { if (!(n in mod)) bad.push(`${m[3]} 缺导出 ${n}`); });
  }
}
ok('所有命名导入都能在目标模块找到导出', bad.length === 0, bad.join('; ') || `${pairs.length} 条全部解析成功`);

console.log('\n3 data-* 与 handler 一一对应');
const hBlock = R('src/main.js');
const seg = hBlock.slice(hBlock.indexOf('const H = {'), hBlock.indexOf('\n};', hBlock.indexOf('const H = {')));
const Hkeys = [...seg.matchAll(/^  (?:async )?'([\w-]+)'/gm)].map(m => m[1])
  .concat([...seg.matchAll(/^  (?:async )?([\w-]+)\s*[:(]/gm)].map(m => m[1]));
const uniq = [...new Set(Hkeys)];
/* 属性出现在三个地方：views.js 的界面、index.html 的骨架、main.js 的提示条模板 */
const attrSrc = R('src/views.js') + R('src/main.js') + html;
const attrs = new Set([...attrSrc.matchAll(/data-([a-z][\w-]*)/g)].map(m => m[1]).filter(a => a !== 'theme'));
/* 手势属性由 gestures.js 的 pointer 监听消费，不走 click 委托——它们是例外，
   但例外必须被登记：既在这里列名，又要在 gestures.js 里真的被读到。
   属性名一改就静默失灵（点了没反应）是最难查的一类 bug，所以逐条钉住。 */
const POINTER_ONLY = ['drag', 'dragday', 'swipe'];
const gest = R('src/gestures.js');
ok('扫描到 handler 与属性（防止空转）', uniq.length > 15 && attrs.size > 15, `${uniq.length} 个 handler / ${attrs.size} 个属性`);
const noH = [...attrs].filter(a => !uniq.includes(a) && !POINTER_ONLY.includes(a));
ok('每个 data-* 都有 handler（或登记为手势属性）', noH.length === 0, noH.join(',') || '全覆盖');
const dead = uniq.filter(k => !attrs.has(k));
ok('没有定义了却没人用的 handler', dead.length === 0, dead.join(',') || '全覆盖');
const readBack = k => new RegExp('dataset\\.' + k.replace(/-([a-z])/g, (m, c) => c.toUpperCase()) + '\\b').test(gest);
const unbound = POINTER_ONLY.filter(k => !readBack(k) && !new RegExp('\\[data-' + k + '\\]').test(gest));
ok('手势属性真的被 gestures.js 读取', unbound.length === 0, unbound.map(k => k + ' 没人读').join(' ')
  || POINTER_ONLY.join('/') + ' 全部有对应读取');
ok('data-theme 只用于根元素（不与点击目标撞名）',
  (html.match(/data-theme=/g) || []).length === 1 && !/data-theme="\$\{/.test(R('src/views.js')));

console.log('\n4 样式覆盖与约束');
const used = new Set();
for (const m of attrSrc.matchAll(/class="([^"$]+)"/g))
  m[1].trim().split(/\s+/).forEach(c => c && used.add(c));
ok('扫描到 class 使用（防止空转）', used.size > 60, used.size + ' 个类');
const missing = [...used].filter(c => !new RegExp('\\.' + c.replace(/[-]/g, '\\-') + '(?![-\\w])').test(css)).sort();
ok('视图用到的每个类都有样式定义', missing.length === 0, missing.join(' ') || '无缺失');
/* 手势层用 classList 加的类不在任何 class="" 里，漏写样式同样静默失效 */
const gestCls = [...gest.matchAll(/classList\.(?:add|toggle|remove)\('([\w-]+)'/g)].map(m => m[1]);
ok('扫到手势层切换的类名（防止空转）', gestCls.length >= 5, [...new Set(gestCls)].join(' '));
const gMissing = [...new Set(gestCls)].filter(c => !new RegExp('\\.' + c + '(?![-\\w])').test(css));
ok('手势层切换的每个类都有样式', gMissing.length === 0, gMissing.join(' ') || '无缺失');
const nonToken = css.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
const hex = nonToken.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
ok('组件样式不写死颜色（只允许令牌块内定义）', hex.length === 0, [...new Set(hex)].slice(0, 4).join(' ') || '零命中');
ok('四套主题都定义了成员色与面板色',
  (css.match(/--m-blue:/g) || []).length === 4 && (css.match(/--c-panel:/g) || []).length === 4);
/* 用户定的规矩：内容区字号不超过 --t-day(6.0vmin)，只有顶栏日期/时钟两个令牌可以更大 */
const bigFont = [...css.matchAll(/font-size:([\d.]+)vmin/g)].map(m => +m[1]).filter(v => v > 6.0);
ok('没有超过标题档（6.0vmin）的字号', bigFont.length === 0, bigFont.join(',') || '全部 ≤ 6.0vmin');

console.log('\n5 运行时零依赖、零后端');
ok('不引任何第三方包', !/from '(?!\.|node:)/.test(allSrc) && !/require\(/.test(allSrc));
ok('不请求任何 API（没有后端可言）', !/fetch\(['"`]\/?api/.test(allSrc) && !/XMLHttpRequest/.test(allSrc));
ok('运行时代码不含 Node 专属 API', !/\bprocess\.|__dirname|readFileSync/.test(allSrc));
ok('数据只在 IndexedDB，没有 localStorage/sessionStorage',
  !/localStorage|sessionStorage/.test(allSrc), '（iOS 上 localStorage 更易被清）');
/* 日期一律本地墙钟：UTC 字符串截出来的"今天"在 UTC+8 的凌晨会比本地早一天。
   真炸过一次——测试晚上跑全绿、早上跑红一条，这种"看时间脸色"的断言必须拦在结构层。 */
const everyJs = [...readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.js')).map(f => R('src/' + f)),
  ...readdirSync(join(ROOT, 'test')).filter(f => f.endsWith('.mjs')).map(f => R('test/' + f))].join('\n');
const utcLines = [];
const lines = everyJs.split('\n');
ok('扫到 src + test 全部代码（防止空转）', lines.length > 900, lines.length + ' 行');
lines.forEach((l, i) => { if (/toISOString\(\)\s*\.slice\(/.test(l)) utcLines.push((i + 1) + ': ' + l.trim()); });
ok('没有任何地方把 UTC 字符串截成本地日期', utcLines.length === 0,
  utcLines.join(' | ') || '日期只从 domain 的 todayKey / dadd / dkey 来');

console.log('\n6 Service Worker 清单');
const sw = R('sw.js');
const precache = [...sw.matchAll(/'(\.\/[^']+)'/g)].map(m => m[1]).filter(p => p !== './');
ok('预缓存清单非空', precache.length >= 10, precache.length + ' 项');
const absent = precache.filter(p => !existsSync(join(ROOT, p.slice(2))));
ok('预缓存的每个文件都真实存在（漏一个 addAll 整体失败 → 离线全废）', absent.length === 0, absent.join(' ') || '全部存在');
/* 真实不变量：SW 只接管同源 GET。非 GET 或跨源请求必须原样放行，
   否则将来一旦加了接口就会被静默缓存成"数据是旧的" */
ok('SW 只接管同源 GET（非 GET / 跨源直接放行）',
  /url\.origin\s*!==\s*location\.origin\s*\|\|\s*e\.request\.method\s*!==\s*'GET'/.test(sw));
ok('SW 缓存不碰 IndexedDB（数据与 HTTP 缓存分离）',
  !/indexedDB|IDBDatabase/.test(sw));
/* 新加一个模块却忘了进预缓存 / 忘了写进部署清单，是"本地好好的、线上白屏"的头号原因：
   ES Module 依赖图断一环，整个应用不执行 */
const deploy = R('DEPLOY.md');
const realSrc = readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.js')).sort();
ok('扫到 src 目录下的模块（防止空转）', realSrc.length >= 7, realSrc.join(' '));
const noCache = realSrc.filter(f => !precache.includes('./src/' + f));
ok('src 下每个模块都在 SW 预缓存清单里', noCache.length === 0, noCache.join(' ') || '全覆盖');
const noDeploy = realSrc.filter(f => !deploy.includes(f));
ok('src 下每个模块都写进了 DEPLOY.md 的上传清单', noDeploy.length === 0, noDeploy.join(' ') || '全覆盖');

console.log('\n7 manifest');
const mf = JSON.parse(R('manifest.webmanifest'));
ok('display 为 standalone（全屏壁挂必需）', mf.display === 'standalone');
ok('start_url / scope 用相对路径（子目录部署不挂）',
  mf.start_url.startsWith('./') && mf.scope === './', `${mf.start_url} @ ${mf.scope}`);
ok('图标路径都存在', (mf.icons || []).every(i => existsSync(join(ROOT, i.src.replace('./', '')))),
  (mf.icons || []).map(i => i.src).join(' '));

console.log('\n8 iOS 安装能力（不依赖服务器 MIME）');
ok('有 apple-mobile-web-app-capable（iPad 全屏运行必需）',
  /apple-mobile-web-app-capable"\s+content="yes"/.test(html));
ok('有 apple-mobile-web-app-title（主屏图标下的名字）',
  /apple-mobile-web-app-title"\s+content="家庭日历"/.test(html));
ok('有 apple-touch-icon 且文件真实存在',
  /rel="apple-touch-icon"[^>]*icons\/apple-touch-icon\.png/.test(html)
  && existsSync(join(ROOT, 'icons/apple-touch-icon.png')));
ok('status-bar 用 black-translucent（常亮壁挂不出现白条）',
  /apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/.test(html));
ok('manifest 链接仍在（安卓与桌面 Chrome 用）', /rel="manifest"/.test(html));

console.log('\n9 手势接线结构（行为在 test/gesture.mjs 里派发事件验）');
ok('main.js 只有一个 document click 派发委托（手势不许另开一个）',
  (hBlock.match(/document\.addEventListener\('click'/g) || []).length === 1,
  (hBlock.match(/document\.addEventListener\('click'/g) || []).length + ' 个');
ok('gestures.js 的吞点击在捕获阶段、且只吞一次',
  /addEventListener\('click'[\s\S]{0,260}\}, true\)/.test(gest) && /swallowAt = 0;/.test(gest));
ok('拖动元素设了 touch-action:none（不设就拖不动，会被浏览器当成滚动）',
  /\[data-drag\]\{[^}]*touch-action:none/.test(css));
ok('待办行用 pan-y：横向交给手势，纵向列表仍能滚',
  /\.swbody\{[^}]*touch-action:pan-y/.test(css));
ok('不用 HTML5 拖放（draggable/dragstart/dataTransfer 在 iOS 触摸下等于没有）',
  !/addEventListener\('drag|\.draggable\s*=|dataTransfer|ondrag/i.test(allSrc));
ok('任何浮层打开时手势一律不认',
  /!S\.form && !S\.memForm && !S\.askMode && !S\.cur/.test(hBlock), '拖动/滑动只在管理页且无浮层时生效');
ok('破坏性动作不由手势直接执行：滑动只负责露出按钮',
  !/onSwipe|onAction/.test(gest) && /data-swdel/.test(R('src/views.js')));
ok('会改数据的手势都配了撤销路径',
  /run: async \(\) => \{ await repo\.undoMove/.test(hBlock) && /run: async \(\) => \{ await repo\.undelete/.test(hBlock));
ok('提示条收起时同时用位移与 visibility（只靠位移会露边）',
  /\.toast\{[^}]*visibility:hidden/.test(css) && /\.toast\.on\{[^}]*visibility:visible/.test(css));


console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
