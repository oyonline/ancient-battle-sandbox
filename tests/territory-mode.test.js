// 领土征服模式：经济 tick / 五旗初始归属 / 票数流失判胜 / 征兵出兵 / 战略 AI / 歼灭语义 / 确定性
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { board } from '../js/board.js';
import {
    TERRITORY, TerritoryEconomy, TicketSystem, makeTerritoryFlags
} from '../js/battle/economy.js';

const STEP = 1000 / 60;

function territoryScene(options = {}, red = { ...TERRITORY.OPENING }, blue = { ...TERRITORY.OPENING }) {
    const scene = makeScene();
    scene.deployUnits(red, blue, 'custom', 'custom', {}, { territory: true, ...options });
    scene.battleStarted = true;
    return scene;
}

function run(scene, seconds) {
    for (let i = 0; i < 60 * seconds && !scene.battleOver; i++) scene.advanceBattle(STEP);
}

// ---------- 纯模块 ----------

test('经济：基础+旗点收入按归属旗数累加', () => {
    const econ = new TerritoryEconomy();
    econ.tick(1, { red: 3, blue: 2 });
    assert.ok(Math.abs(econ.treasury.red - (TERRITORY.START_TREASURY + TERRITORY.BASE_INCOME + 3 * TERRITORY.FLAG_INCOME)) < 1e-9);
    assert.ok(Math.abs(econ.treasury.blue - (TERRITORY.START_TREASURY + TERRITORY.BASE_INCOME + 2 * TERRITORY.FLAG_INCOME)) < 1e-9);
    assert.equal(econ.costOf('infantry'), 30);
    assert.equal(econ.costOf('cavalry'), 72);
});

test('票数：多数旗方按旗数差抽对方票，归零判胜', () => {
    const tickets = new TicketSystem();
    tickets.tick(1, { red: 3, blue: 2 });          // 差 1 → 蓝每秒 -1.6
    assert.ok(Math.abs(tickets.tickets.blue - (TERRITORY.TICKETS - TERRITORY.TICKET_DRAIN)) < 1e-9);
    assert.equal(tickets.winner(), null);
    tickets.tickets.blue = 0.5;
    tickets.tick(1, { red: 3, blue: 2 });
    assert.equal(tickets.tickets.blue, 0, '票数不为负');
    assert.equal(tickets.winner(), 'red');
    // 平票不抽票
    const even = new TicketSystem();
    even.tick(10, { red: 2, blue: 2 });
    assert.equal(even.tickets.red, TERRITORY.TICKETS);
});

test('五旗布局：双方半场各两面起始归属 + 中场中立，换座镜像对称', () => {
    board.W = TERRITORY.W; board.H = TERRITORY.H;   // makeTerritoryFlags 读当前棋盘
    const flags = makeTerritoryFlags();
    board.W = 70; board.H = 70;
    assert.equal(flags.length, 11);
    assert.deepEqual(flags.slice(0,5).map(f=>f.owner),['red','red',null,'blue','blue']);
    assert.deepEqual(flags.slice(5).map(f=>f.owner),[null,null,null,null,null,null]);
    assert.equal(flags[2].gx, TERRITORY.W / 2);
    // 镜像对：x 之和 = W，y 相等
    for (let i = 0; i < 2; i++) {
        assert.ok(Math.abs(flags[i].gx + flags[3 + i].gx - TERRITORY.W) < 1e-9);
        assert.equal(flags[i].gy, flags[3 + i].gy);
    }
});

// ---------- 场景集成 ----------

test('开局：大地图生效、五旗就位、双方常备军与启动军费', () => {
    const scene = territoryScene();
    assert.equal(board.W, TERRITORY.W);
    assert.equal(scene.flags.length, 11);
    assert.equal(scene.flags.filter(f => f.owner === 'red').length, 2);
    assert.equal(scene.territory.econ.treasury.red, TERRITORY.START_TREASURY);
    const opening = Object.values(TERRITORY.OPENING).reduce((a, b) => a + b, 0);
    assert.equal(scene.redAlive, opening);
    assert.equal(scene.blueAlive, opening);
});

test('收入随时间流入：无人交战 5 秒后军费 = 启动 + (基础+2旗)×5', () => {
    const scene = territoryScene({ territoryAI: false }, {}, {});   // 双方停手，隔离经济变量
    run(scene, 5);
    const expected = TERRITORY.START_TREASURY + (TERRITORY.BASE_INCOME + 2 * TERRITORY.FLAG_INCOME) * 5;
    assert.ok(Math.abs(scene.territory.econ.treasury.red - expected) < 1e-6);
    assert.ok(Math.abs(scene.territory.econ.treasury.blue - expected) < 1e-6);
});

test('征兵：入队扣费、训练时长后从老家出兵线附近入场', () => {
    const scene = territoryScene({}, {}, {});
    const recruit = scene.territory.recruit;
    const before = scene.territory.econ.treasury.red;
    assert.equal(recruit.enqueue('red', 'infantry'), true);
    assert.ok(Math.abs(scene.territory.econ.treasury.red - (before - 30)) < 1e-9);
    const aliveBefore = scene.aliveCount('red');
    run(scene, Math.ceil(TERRITORY.TRAIN_MS.infantry / 1000) + 1);
    assert.equal(recruit.queues.red.length, 0, '训练完成出队');
    assert.equal(scene.aliveCount('red'), aliveBefore + 1);
    const fresh = scene._aliveArr.filter(u => u.team === 'red').reduce((a, u) => Math.max(a, u.gx), 0);
    assert.ok(fresh < 20, '新兵在红方老家一侧（远离前线）');
    // 队列上限与买不起均拒绝
    scene.territory.econ.treasury.blue = 0;
    assert.equal(recruit.enqueue('blue', 'infantry'), false);
});

test('战略 AI：自动征兵按兵种配比补缺口（蓝方默认自动、红方默认手动）', () => {
    const scene = territoryScene({ territoryAI: true }, {}, {});
    run(scene, 12);
    assert.ok(scene.territory.recruit.spawned.red >= 1, 'territoryAI 双方都自动买兵');
    assert.ok(scene.territory.recruit.spawned.blue >= 1, '蓝方默认自动买兵');
    const manual = territoryScene({}, {}, {});
    run(manual, 12);
    assert.equal(manual.territory.recruit.spawned.red, 0, '红方手动模式不自动买兵');
});

test('票数判胜：多数旗抽干对方票 → endReason=tickets', () => {
    const scene = territoryScene({}, {}, {});
    // 隔离变量：手摆 3:2 归属，蓝方只剩 1 票，约 0.7 秒后判胜
    scene.flags[0].owner = 'red'; scene.flags[1].owner = 'red'; scene.flags[2].owner = 'red';
    scene.flags[3].owner = 'blue'; scene.flags[4].owner = 'blue';
    scene.territory.tickets.tickets.blue = 1;
    run(scene, 5);
    assert.ok(scene.battleOver);
    assert.equal(scene.winner, 'red');
    assert.equal(scene.endReason, 'tickets');
    assert.ok(scene.getBattleReport().events.some(e => e.text.includes('票数耗尽')), '战报含票数获胜事件');
    assert.ok(scene.getBattleReport().territory, '战报含领土经济摘要');
});

test('歼灭语义：暂时全员阵亡但还能补兵的一方不判负', () => {
    const scene = territoryScene({}, {}, {});       // 无部队
    scene.territory.econ.treasury.red = 500;        // 红方有钱补兵
    scene.territory.recruit.enqueue('red', 'infantry');
    run(scene, 3);                                  // 红蓝都 0 兵但都能补 → 不结算
    assert.equal(scene.battleOver, false, '双方均具补兵能力时不判负');
    // 经济枯竭 + 无队列 → 全灭即败
    const broke = territoryScene({}, { infantry: 10 }, {});
    broke.territory.econ.treasury.blue = 0;
    broke.territory.econ.earned.blue = 0;
    broke.flags[3].owner = 'red'; broke.flags[4].owner = 'red';   // 蓝方旗全丢，收入只剩基础
    broke.territory.econ.tick = (() => { const t = broke.territory.econ.tick.bind(broke.territory.econ); return (dt, o) => { o.blue = 0; t(dt, o); broke.territory.econ.treasury.blue = 0; }; })();
    run(broke, 40);
    assert.ok(broke.battleOver, '蓝方经济枯竭且全灭应结算');
    assert.equal(broke.winner, 'red');
});

test('镜像确定性：同构开局两局逐帧推进结果一致', () => {
    const play = () => {
        const scene = territoryScene({ territoryAI: true });
        run(scene, 30);
        return JSON.stringify({
            red: scene.redAlive, blue: scene.blueAlive,
            tickets: scene.territory.tickets.tickets,
            treasury: { red: Math.round(scene.territory.econ.treasury.red), blue: Math.round(scene.territory.econ.treasury.blue) },
            spawned: scene.territory.recruit.spawned,
            endReason: scene.endReason, over: scene.battleOver,
            events: scene.getBattleReport().events.length
        });
    };
    assert.equal(play(), play(), '两局同种子推进 30 秒结果应逐位一致');
});

test('兵力护栏：长时间自动运营不突破单方在场上限', () => {
    const scene = territoryScene({ territoryAI: true }, {}, { infantry: 4 });
    run(scene, 150);
    assert.ok(scene.aliveCount('red') <= TERRITORY.ALIVE_CAP + 1, `红方在场 ${scene.aliveCount('red')} 应 ≤ 上限`);
    assert.ok(scene.aliveCount('blue') <= TERRITORY.ALIVE_CAP + 1, `蓝方在场 ${scene.aliveCount('blue')} 应 ≤ 上限`);
});
