# 部署与运维

> 下文所有 `https://example.com/timetreeloc/` 都是占位符，**换成你自己的域名**。
> 只用 iPad 的话可以先跳到「iPad 安装」一节——那部分不需要任何服务器配置。

## 静态文件清单（要上传的全部）

```
app/index.html
app/styles.css
app/manifest.webmanifest
app/sw.js
app/src/domain.js  db.js  views.js  main.js  alarm.js  backup.js  gestures.js
app/icons/icon-192.png  icon-512.png  icon-maskable-512.png  apple-touch-icon.png
```

`app/test/` 与 `app/tools/` 是开发期用的，**不用上传**。

## iPad 安装：不依赖任何服务器配置

iOS 的"添加到主屏幕"**不读 `rel="manifest"`**，只认 `index.html` 里这组标签（已内置）：

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="家庭日历">
<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
```

所以**只用 iPad 的话，下面这个 MIME 问题可以完全忽略**。

## `.webmanifest` 的 MIME（只影响安卓与桌面 Chrome 安装）

常见症状：`https://example.com/timetreeloc/manifest.webmanifest` 返回 `application/octet-stream`，
Chrome 会拒绝解析该 manifest，安装按钮不出现。正确值是 `application/manifest+json`。

**先判断你的站点是不是在 Cloudflare 后面**：

```bash
curl -sI https://example.com/timetreeloc/manifest.webmanifest | grep -iE "content-type|server|cf-cache-status"
```

看到 `Server: cloudflare` 且 `CF-Cache-Status: HIT`，说明**错误类型已被边缘缓存**——
改完源站后必须清缓存，否则你会以为没改成功：
Cloudflare 控制台 → 缓存 → 清除缓存 → 自定义缓存 → 填 `https://example.com/timetreeloc/manifest.webmanifest`

### 方案 A：Cloudflare Transform Rule（不动源站，推荐）

Rules → Transform Rules → Modify Response Header → 创建规则：

- 匹配条件：`URI Path 以 .webmanifest 结尾`
- 操作：`Set` → `Content-Type` → `application/manifest+json`

免费计划即可用，改完仍需清一次该 URL 缓存。

### 方案 B：源站配置

```nginx
# nginx
types { application/manifest+json webmanifest; }
```
```apache
# Apache 或 .htaccess
AddType application/manifest+json .webmanifest
```
```caddy
# Caddyfile
header /timetreeloc/*.webmanifest Content-Type "application/manifest+json"
```

### 方案 C：绕过（不想动任何配置）

把 `index.html` 里的 `href="./manifest.webmanifest"` 改成
`href="./manifest.json"`，同时把该文件重命名为 `manifest.json`——
`.json` 几乎所有服务器都配了正确的 `application/json`，Chrome 也接受。
代价是丢掉 `.webmanifest` 这个规范扩展名。

## 验证

```bash
# 内容类型是否已修正
curl -sI https://example.com/timetreeloc/manifest.webmanifest | grep -i content-type
# 期望：application/manifest+json

# 关键文件是否都在（漏一个 SW 预缓存会整体失败 → 离线全废；
# 漏一个 src/*.js 更狠：ES Module 依赖图断一环，页面直接白屏）
for f in index.html styles.css sw.js manifest.webmanifest \
         src/domain.js src/db.js src/views.js src/main.js src/alarm.js src/backup.js src/gestures.js \
         icons/apple-touch-icon.png; do
  printf "%-28s %s\n" "$f" "$(curl -s -o /dev/null -w '%{http_code}' https://example.com/timetreeloc/$f)"
done   # 全部应为 200
```

## 两个部署后常见的坑

**一、改了文件但页面没变。** 两层缓存要处理：Cloudflare 边缘缓存（按上面清缓存），
以及已安装的 Service Worker —— 它按预缓存清单提供旧版本。`sw.js` 里的
`CACHE = 'timetreeloc-v0.12'` 每次发布要**手动改版本号**，否则老用户拿不到新代码。

**二、`http://内网IP` 打不开 PWA。** Service Worker 与"添加到主屏幕"要求安全上下文，
只有 `https://` 或 `localhost` 算。局域网用 IP + http 只能看页面，装不了。

## 数据安全提醒

数据只存在这台 iPad 的浏览器数据库里，**没有服务器副本**。重装系统、清理 Safari 数据、
iOS 在空间紧张时回收存储，都可能让它消失。定期在 管理 → 备份 → 导出 JSON，
存到 iCloud 云盘或家里 NAS。界面上"上次备份"超过 14 天会提示，别一直忽略它。
