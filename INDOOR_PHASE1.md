# DoorSteps Phase 1：JMC Indoor 集成

## 本地启动

需要 Node.js 24（与仓库 `.nvmrc` 一致）。从 `AIatUSC` 目录运行：

```powershell
node outdoor-nav/tools/dev-indoor.mjs
```

访问 <http://127.0.0.1:8000/>。端口被占用时可追加 `--port 8001`。
这个启动方式无需安装依赖，使用现有 Cloudflare Worker 和步行路由，提供只读本地预览；驾驶路线、持久化报告仍需要项目原有的 Wrangler、D1 和 Secret 配置。未修改这些配置。

保留原有 Cloudflare 本地启动方式：已有依赖和配置时，可直接使用 `npm run dev`。新增 Indoor 文件位于现有静态资源目录内。

## 完整演示流程

Event QR 可编码以下链接（`at` 是演示用的固定起点，不代表实时定位）：

<http://127.0.0.1:8000/?to=JMC&room=258&at=34.02065,-118.28720>

1. Outdoor 计算到 JMC 的路线。
2. 在演示中点击 **I'm at the building**；真实使用也可由靠近入口的 GPS 触发。
3. 查看入口照片，点击 **Continue inside →**。
4. Indoor 读取 `building`、`entrance=jmc-main`、`anchor=entrance`、`room=258`。
5. 自动计算从一楼 Entrance lobby 经楼梯到二楼 Room 258 的路线并进入 Walk View，显示约 126 米及 **Take the stairs up to floor 2**。
6. 检查 Play／Pause／Replay、进度条、Map View、楼层切换及返回 Outdoor。将进度拖到终点，确认 Walk View 位于二楼；切换 Map View，应选中 Floor 2。

也可直接验证 Indoor：

<http://127.0.0.1:8000/indoor/?building=JMC&entrance=jmc-main&anchor=entrance&room=258>

无参数的 <http://127.0.0.1:8000/indoor/> 保留手动选择，用于参考 Sample 的同层／跨层测试。缺少起点或目的地时不会悄悄使用默认值。

## 入口与临时目的地的依据

配置文件：`outdoor-nav/outdoor/static/indoor/data/venue.json`。

| 项目 | 映射与依据 |
|---|---|
| 建筑 | 项目所有者确认 Outdoor 与 Indoor Sample 均为 JMC |
| 真实入口 | 项目所有者明确确认 `jmc-main` 与原 Sample `NAV.anchors[0]` Entrance lobby 为同一入口 |
| 起点 | `anchor=entrance` → `sample-entrance-lobby` → NAV 节点 `19150` |
| 临时目的地 | `258` → 原 NAV `dests[0]` 的二楼中部走廊位置 → 节点 `23822` |
| Demo 坐标／楼层 | 节点世界坐标约 `[16.975, 3.700, 1.025]`，Floor 2 |
| 距离 | 节点 `19150` → `23822` 的 NAV 图三维最短距离为 **126.0326307089743 米**（显示约 126 米） |
| 楼梯验证 | 路线包含 26 个高度处于 0.3～3.4 米的中间节点，楼梯段约位于 X=46.675～48.475、Z=−39.475～−37.825，生成上二楼指令 |

`258` 的 `kind` 为 `demo`，`isRealRoom` 为 `false`。它是用户授权的临时测试位置，**不是已测绘的真实房间**；页面会显示同样的说明。

真实房间映射目前为空。传入 `room_205` 等未知 ID 时，页面显示缺少映射，不会自动改为 Demo Room 或其他 Sample 目的地。返回 Outdoor 的链接保留原 `room`。

## 模块和接口

```text
现有 Outdoor 到达链接
       ↓
context.js (M4)：解析、校验并保留 Handoff
       ↓
app.js (M2 接线)：等待模型，协调状态及启动
       ↓
routing.js (M3)：findRoute(startNodeId, destinationNodeId)
       ↓
viewer.js (M1)：setRoute(route)
```

- `context.js`：入口／目的地映射，URL 参数优先于手选，拒绝未知建筑、未知房间、重复参数和入口／Anchor 冲突。
- `routing.js`：从原 Sample 提取的纯 JavaScript 模块。解码 NAV 一次，建立索引，按需运行 A*，不依赖 DOM 或 Three.js。
- `viewer.js`：复用原 Sample 的 Three.js 场景、材质、箭头路线带、相机及播放逻辑；不读取 Graph、不计算路线。
- `app.js`：连接上下文、Routing、Viewer、页面控制与错误状态。Viewer 在模型加载成功后接收路线。
- `indoor.css`：复用 Outdoor 的颜色、系统字体、按钮、卡片和间距规则；不修改 Outdoor CSS。
- `data/graph.json`：原 NAV 原样提取，保留 Base64、网格和高度信息。
- `models/web.glb`：原文件逐字节复制，保留所有节点变换，没有重新缩放或居中。

M3 输出包含 `nodeIds`、`nodePoints`、`pts`、`cum`、`length`、`steps`、`face` 和起终节点 ID，均使用模型世界坐标。Viewer 只在路线绘制时添加一次 0.07 米抬高。

## 最短距离审查与修正

旧版本不能保证显示路线是 NAV 图上的最短行走距离：

- 边权为 `w * (1 + 靠墙惩罚)`，其中 `w` 为 `1` 或近似值 `1.414`；它优化的是带净空偏好的成本，未按米计入真实高度变化。
- 原 octile 启发函数与该加权网格成本相容，但这不能使优化目标变为三维行走距离。
- 拉直与圆角会改变节点路径、长度并生成不属于原图的线段；即使仍可通行，也不能继续把显示距离称为原图最短距离。

本轮只修改 M3 的距离目标与输出几何，保持 NAV 数据、八方向邻接及原高度连接限制不变：

```text
edgeCost(u,v) = sqrt((xv-xu)^2 + (yv-yu)^2 + (zv-zu)^2)  // 米
heuristic(n)  = Euclidean3D(position(n), position(goal))   // 米
```

移除靠墙惩罚，节点高度与累计搜索距离使用 Float64。三维直线距离由三角不等式满足一致性 `h(u) <= edgeCost(u,v) + h(v)`，因此 A* 在现有图、固定起终节点上得到最短三维折线距离（受双精度浮点误差约束）。`1.414` 仅保留在原图的高度连通性阈值中，不再作为边权。

取消路径拉直与圆角。M1 收到的 `pts` 就是有序节点世界坐标；`length`、`cum`、进度条和相机均沿同一条图路径。原地到达只额外复制同一个点以兼容 Viewer，不增加长度。原 `simplify()` 只用于生成文字方向，不修改路径几何。

保证范围为 **NAV 图上的最短距离**，不代表建筑内连续空间的全局几何最短路，也不增加未测绘的连接。节点贴近墙面时仍可能被选中，这是去掉软惩罚后的正常结果。现有网格边界采样同时修正了对合法对角楼梯边界点的误拒，不改变图边。

## 测试

本轮结果：**64 项 JavaScript 测试全部通过**，包括原有 49 项回归测试和 15 项 Indoor 测试。现有后端及 Indoor 模块的语法检查、`git diff --check` 均通过。

完整 JavaScript 回归（无新增测试依赖）：

```powershell
node --test --test-isolation=none outdoor-nav/tests/*.test.mjs
```

也可使用仓库原有 `npm test`；沙箱限制子进程时，上面的进程内模式可用于本地验证。

距离测试使用 `tests/helpers/indoor-dijkstra.mjs`：独立解码 NAV、显式构建邻接表、使用独立优先队列运行 Dijkstra，不调用 M3 的搜索或启发函数。对照包含 12 条原 Sample 路线，以及 43 组配置地点／反向上下楼／原地到达／固定随机节点对，距离误差要求小于 `1e-8` 米，不连通的结果也须一致。另用合成图验证无靠墙惩罚、精确对角距离及真实高度代价，并检查目标启发函数在全部 NAV 边上的一致性。

Demo 的 A* 与 Dijkstra 均为 `126.0326307089743` 米，差值为 `0`；43 组对照的最大距离差也是 `0` 米。判断最优性使用距离而非节点序列：若存在等长路线，节点序列可以不同。

其他覆盖：原 NAV／GLB 校验、原地到达、断开图、无效输入、入口映射、参数优先级、未知房间、真实 Outdoor API 与到达链接、自动进入二楼 Demo 路线、上楼指令、页面控制接线、模型加载错误、静态资源及本地 HTTP 服务。

M1 另有 GPU 边界替身测试，运行真实 Viewer 代码，检查坐标、路线抬高、相机／进度控制和释放。这些测试**不等同于真实浏览器 WebGL 画面验收**。

## 验证边界与后续验收

- 浏览器连接器不可用；Chrome Computer Use 授权等待超时，本轮未完成真实浏览器画面验证。请按上述流程验收模型显示和交互。
- Three.js 与 MeshoptDecoder 仍使用原 Sample 的固定版本 CDN，首次加载需要网络；模型与导航数据由本地服务器提供。
- NAV 是扫描模型的已有导航数据，未新增 Mesh-to-Graph、Coordinate Picker 或真实房间标注，也未宣称全楼通行／无障碍已现场验证。
- Outdoor 主页面、路由、入口数据、Cloudflare 图、部署配置及 package 文件均保持不变；只替换原 Indoor 占位页面并新增室内模块、测试、启动脚本和本报告。
- Phase 1 结束后停止，不执行 commit、push 或 deploy，等待用户验收。
