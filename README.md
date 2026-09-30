# 帝国亲子沙盒 · 统帅试炼

亲子向古代战争沙盒：配兵布阵、自动会战、读战报复盘。Phaser 3 等距渲染 + Node 原生测试，
纯前端单机 + 局域网双人对战，无后端依赖（对战服务器仅为消息中继，不做游戏逻辑）。

## 快速开始

```bash
npm install
npm run dev        # 本地开发/试玩 → http://localhost:5173
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | Vite 开发服务器（试玩入口） |
| `npm test` | 全量测试（node --test，纯模拟层，无需浏览器） |
| `npm run build` | 构建产物到 `dist/` |
| `npm run arena` | 启动局域网对战服务器（托管 `dist/` + WebSocket 房间） |

## 🌐 局域网对战（两台电脑，同一 WiFi）

**房主（红方）**：

```bash
npm run build && npm run arena
```

启动后会打印本机局域网地址，例如 `http://192.168.x.x:5300`。房主浏览器打开该地址，
点「🏰 创建房间」得到 4 位房间码。

**另一位玩家（蓝方）**：同一局域网的浏览器打开上面的地址 → 「🔵 加入房间」→ 输入房间码。

双方点「✅ 就绪」自动开战：山河大图、五面旗、军费征兵、营队指令、票数制。
两台电脑请使用同款浏览器（都是 Chrome）。命令行窗口保持开着（关掉即房间解散）。

> 技术说明：联机为锁步同步——两端各自运行完全相同的确定性模拟，网络只传
> 玩家命令（买兵/营令），每 2 秒交换状态哈希校验一致性。详见 `docs/DETERMINISM.md`。

## 玩法模式

- **🚩 领土征服**：大地图五旗会战——占旗产军费、老家征兵、点营下令，占多数旗抽干对方票数（支持 AI 对手或局域网真人）
- **⚑ 占点三旗 / 🛒 辎重护送 / ⚔️ 战阵演练**：3~5 分钟快速一局
- **🎖 挑战战役**（5 关）/ **⛰ 地形演练**（坡地/树林/河桥）/ **⚔️ 自由对战**（4000 金币配兵千人沙盒）

## 代码结构

```
js/game.js            战斗场景编排壳（模式编排 + sim→render 单行委托，渲染实现一律进 js/render/）
js/battle/            纯模拟层：core 战斗核 / economy 领土经济 / battalion 营队 /
                      recruit 征兵 / spatial 空间哈希 / report 战报 / determinism 确定性约定
js/render/            渲染层（BattleRenderer 门面）：world 地貌海面装饰烘焙 / metrics 世界度量 / sprites 精灵轮廓
js/snd.js             WebAudio 合成音效（无外部文件）
js/lobby.js           局域网房间流程（lobbyMethods 并入 UI）
js/tactics/           战术四组：deploy 布阵 / guards 守备纪律 / rally 集结波次 / steps 逐帧编排（原型混入 TacticsSystem）
js/net/               锁步联机：lockstep 调度与哈希 / arena-client 房间客户端
js/terrain|navigation 地形高度场与寻路（棋盘尺寸参数化，默认 70×70，领土图 104×72）
server/arena.mjs      局域网对战服务器（静态托管 + WebSocket 房间中继）
tests/                369 项测试：战斗规则/模式/营队/锁步一致性/服务器协议
```

铁律：`js/battle/` 与 `js/net/` 不碰 Phaser、不碰 DOM；渲染实现只进 `js/render/`，场景上仅留单行委托——新功能禁止把渲染/模拟实现堆回 game.js。
地图尺寸经 `js/board.js` 读取，禁止缓存旧尺寸。
