# Indoor Navigation：Cloudflare 部署兼容性检查

结论：代码及静态资源已满足现有 Cloudflare Workers Assets 的部署要求。合并后的提交通过现有 CI/CD 并部署成功后，用户可直接通过正式域名的 `/indoor/` 访问，不需要安装依赖或启动本地服务器。本轮没有 commit、push、merge、上传或部署。

## 检查结果

| 检查项 | 结果 |
|---|---|
| Assets 根目录 | `outdoor-nav/wrangler.jsonc` 的 `./outdoor/static` 已包含完整 `indoor/`，无需修改配置 |
| 文件进入仓库 | Indoor HTML、JS、CSS、JSON 和 GLB 均已被 Git 跟踪，未依赖工作区外的 Sample 文件 |
| 页面路由 | Wrangler 本地 workerd 实测 `/indoor/` 返回 200 HTML；`/indoor`、`/indoor/index.html` 返回 307 到 `/indoor/` |
| 参数保留 | 上述重定向保留 `building`、`entrance`、`anchor`、`room`；Outdoor 到 Indoor 的参数接线测试通过 |
| JS/CSS | `app.js`、`context.js`、`routing.js`、`route-geometry.js`、`viewer.js` 和 `indoor.css` 返回 200，MIME 正确 |
| 导航数据 | `/indoor/data/graph.json`、`venue.json` 返回 200 `application/json` |
| 模型 | `/indoor/models/web.glb` 返回 200 `model/gltf-binary`；响应内容 SHA-256 与原文件一致 |
| 文件大小 | GLB 为 9,633,684 字节，低于单文件 25 MiB 上限 |
| 缺失资源 | 缺失 JS、GLB 返回 404，没有被改写为 Outdoor HTML |
| 本地依赖 | 生产页面代码没有 localhost、127.0.0.1、本地脚本或本地文件 URL 依赖 |
| Worker/API | 保留 `/api`、`/api/*` 的 Worker 处理规则；Outdoor 页面及建筑 API 的本地运行时请求通过 |
| CI/CD | 现有 `npm run check` 现在覆盖 Indoor；工作流、发布条件、D1 配置及依赖版本保持原样 |

Cloudflare 的默认 [HTML 路由规则](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)即为目录自动补斜杠，因此现有相对 JS/CSS/data/model 路径能正确解析。原生 Assets 已给出正确 MIME，无需增加 Worker 路由、SPA fallback 或自定义响应头。

## 本轮必要修改

新增 `outdoor-nav/tools/check-indoor-assets.mjs` 并接入 `package.json` 的现有 `check` 命令。它在 CI 中检查：

- 真实 Assets 配置、目录路由及缺失文件策略。
- HTML／模块引用的资源存在、大小写一致。
- 所有 Indoor JS 和入口内联模块的语法。
- 固定 HTTPS Three.js import map，没有生产代码依赖本地开发环境。
- NAV 数据完整性、GLB 文件头／大小／外部资源引用及测试目的地标识。

未修改生产 Indoor 逻辑、M1–M4 架构、Outdoor 路由或 Cloudflare 配置；这些部分经过检查已符合要求。原有按钮相关未提交修改予以保留。

## 验证

已执行并通过：

1. `npm run check`：10 个 Indoor 资源及全部相关模块检查通过。
2. `npm test`：73 项全部通过，含 Outdoor 回归、Handoff、最短路、箭头、移动端渲染策略与触控状态测试。
3. 锁文件指定的 Wrangler 4.162.0 dry-run：完整 Assets 目录识别到 16 个静态文件，Worker 打包检查通过，未上传或发布。
4. Wrangler 本地 workerd：实测重定向、查询参数、所有 Indoor 资源、MIME、GLB 内容、缺失资源、Outdoor 首页及建筑 API，临时运行时已停止。

开发者可复查：

```powershell
# 从 AIatUSC 目录运行；这些不是最终用户需要执行的操作。
npm run check
npm test
npx --no-install wrangler deploy --dry-run --config outdoor-nav/wrangler.jsonc
```

本轮安装的是现有锁文件中的开发依赖，没有增加依赖或修改锁文件。Python 引擎、数据和工作流未改；Python 测试与 Python/JS parity 本轮未重跑，仍由原有 CI 执行。dry-run 和本地运行时不验证远程账号权限、实际生产域名或线上 D1 状态，最终应以现有 CI/CD 结果为准。

## 发布后的手机验收

下面使用正式域名替换 `https://<正式域名>`。本轮未发布，也未将旧线上版本当成本次构建验收。

- 直接访问 `https://<正式域名>/indoor/`，应加载模型并显示手动选择。
- 直接访问 `/indoor/?building=JMC&entrance=jmc-main&anchor=entrance&room=258`，应自动展示一楼入口到二楼 Demo 位置的约 126 米路线。
- 从 Outdoor 的 `Indoor View` 进入，确认参数和目的地保留；缺参不应编造真实入口或房间。
- 分别在 iPhone Safari 和 Android Chrome 检查 GLB 首次加载、WebP 纹理／Meshopt 解码、箭头遮挡、播放与 Slider、单指 Walk 转向、Map 双指缩放和平移。
- 检查竖屏／横屏、刘海安全区域、浏览器地址栏伸缩、前后台切换及 WebGL 恢复。
- 使用实际 Wi-Fi／蜂窝网络检查首次加载耗时、帧率、发热与内存。Three.js／解码器沿用固定版本 CDN，必须能通过 HTTPS 访问该 CDN。

现有自动化覆盖了移动视口尺寸、触控状态、像素比限制、帧调度和失败恢复；它们不是 Safari／Chrome 真机的 WebGL 渲染或性能结论。真机验收仍待完成，不据此宣称所有手机均已验证。
