# 入口目录（Entry Catalog）

本文件只做入口清点，不涉及玩法逻辑修改。最后更新：2026-10-24。

## 1. 总览

| # | 入口文件 | 页面标题 | 开发地址（5301） | 首页链接 | vite 构建 | 脚本入口 | 状态 |
|---|---|---|---|---|---|---|---|
| 1 | `index.html` | 帝国亲子沙盒 · 选择战场 | `/index.html` | — | ✅ `home` | 无（纯静态） | 生产 |
| 2 | `classic.html` | 帝国亲子沙盒 · 统帅试炼 | `/classic.html` | ✅ | ✅ `classic` | `vendor/phaser.min.js` + `js/main.js` | 生产（完整玩法） |
| 3 | `battle3d.html` | 3D 体验版 | `/battle3d.html` | ✅ | ✅ `battle3d` | `js/three-demo/main.js` | 小样，待决策 |
| 4 | `siege3d.html` | 千人攻寨 · 3D 演示 | `/siege3d.html` | ✅ | ✅ `siege3d` | `js/siege3d/main.js` | 开发主线 |
| 5 | `camp3d.html` | 木栅营寨 · 3D 口径样张 | `/camp3d.html` | ✅ | ✅ `camp3d` | `js/three-spike/camp.js` | 实验样张 |
| 6 | `battle3d-spike.html` | 3D 战争感验证 · 千人对冲 spike | `/battle3d-spike.html` | ✅ | ✅ `battle3dSpike` | `js/three-spike/main.js` | 实验样张 |

非 HTML 入口：

| 入口 | 端口 | 作用 | 说明 |
|---|---|---|---|
| `server/arena.mjs`（`npm run arena`） | 5300 | 局域网对战服务器 | 先 `vite build`，静态托管 `dist/` + WebSocket 房间中继；只包含 4 个构建入口 |
| `vite.config.js` | 5301 | 本地开发服务器 | 所有 6 个 HTML 都可直接访问 |

## 2. 入口依赖树

```text
index.html
├── classic.html
│   ├── css/style.css
│   ├── public/vendor/phaser.min.js
│   └── js/main.js
│       ├── js/game.js          ← 场景编排 + BattleRenderer 门面
│       │   ├── js/battle/*     ← 纯模拟（核心/经济/营队/营寨/攻寨/士气/锁步）
│       │   ├── js/render/*     ← 渲染门面（world/units/fx/overlay/camera/camps）
│       │   ├── js/tactics/*    ← 战术四组
│       │   ├── js/net/*        ← 锁步与房间客户端
│       │   └── js/{terrain,navigation,units,combat,morale,manifest}.js
│       ├── js/ui.js            ← 大厅/模式入口/HUD（含 lobby、camp-controls mixin）
│       └── public/assets/units、assets/terrain
├── battle3d.html
│   ├── css/three-demo.css
│   └── js/three-demo/main.js
│       └── public/assets/3d-sample/{infantry,spear,archer,cavalry}-rigged.glb + tower.glb
├── siege3d.html
│   └── js/siege3d/main.js
│       ├── layout / deployment / walls / platforms / ram / defense-posts / scenery
│       └── js/battle/siege.js    ← 复用 2D 确定性攻寨模拟
├── camp3d.html
│   └── js/three-spike/camp.js
│       └── js/three-spike/camp-assault-sim.js   ← 独立的一套攻寨模拟
└── battle3d-spike.html
    └── js/three-spike/main.js
```

## 3. classic.html 内玩法入口

首页共 8 个玩法卡片（局域网对战为领土卡内的子入口）：

| 玩法 | 触发标记 | 处理函数 | `this.mode` / 特例 |
|---|---|---|---|
| 领土征服 · 山河会战 | `data-territory-entry` | `startTerritory` | `territory` |
| 局域网对战 / 合作模式 | `data-net-entry` → `#sec-net` | `openNetLobby` → `netCreate` / `netCreateCoop` / `netJoin` | 房间模式由房主决定 |
| 营寨攻防 | `data-siege-entry` | `startSiege` | `territory` + `stageSiege` |
| 占点三旗 | `data-control-entry` | `startControl` | `control` |
| 占点三旗 · 自定义配兵 | `data-control-custom` | `startControlCustom` | `control` + 配兵页 |
| 辎重护送 | `data-convoy-entry` | `startConvoy` | `convoy` |
| 辎重护送 · 自定义配兵 | `data-convoy-custom` | `startConvoyCustom` | `convoy` + 配兵页 |
| 战阵演练（预备队/正面/迂回） | `data-tactics-entry` | `startTactics` | `tactics` |
| 挑战战役（5 关） | `data-challenge` | `startChallenge` | `challenge` |
| 地形演练（坡地/林地/河桥） | `data-terrain-entry` | `startTerrain` | `terrain` |
| 自由对战 | `#btn-sandbox` | `resetAll` | `sandbox` |

## 4. 本地访问清单

```bash
npm install
npm run dev        # 5301：六个 HTML 全部可访问
```

| 入口 | 开发地址 | `npm run arena`（5300） |
|---|---|---|
| 版本选择 | `http://localhost:5301/` | ✅ |
| 2D 经典版 | `http://localhost:5301/classic.html` | ✅ |
| 3D 体验版 | `http://localhost:5301/battle3d.html` | ✅ |
| 千人攻寨 3D | `http://localhost:5301/siege3d.html` | ✅ |
| 木栅营寨样张 | `http://localhost:5301/camp3d.html` | ✅ |
| 千人对冲 spike | `http://localhost:5301/battle3d-spike.html` | ✅ |

## 5. 处置建议（按风险从低到高）

| 对象 | 建议 | 风险 |
|---|---|---|
| `camp3d.html`、`battle3d-spike.html`、`js/three-spike/` | 已挂首页并参与构建；若决定归档，需同步撤掉首页卡片与构建入口 | 低（仅涉及入口链接） |
| `public/assets/3d-sample/infantry.glb`、`cavalry.glb` | 删除；全仓库未发现引用（仅 `*-rigged.glb` 被 `three-demo` 使用） | 低 |
| `siege3d.html` | 已提升为正式 3D 入口并挂到 `index.html` | 已完成 |
| `battle3d.html` + `js/three-demo/` | 由“3D 体验版”改为“3D 小样”或下线；与 siege3d 二选一，避免双 3D 线 | 中（涉及首页文案与入口取舍） |
| `js/three-spike/camp-assault-sim.js` 与 `js/battle/siege.js` | 统一为一套攻寨模拟，删除重复实现 | 中高（需回归全部 siege 测试） |

> 若执行目录迁移（如 `lab/`），注意 HTML 内 `css/`、`js/`、`assets/` 的相对路径需同步调整；`vite.config.js` 的 `rollupOptions.input` 也要去掉对应入口。
