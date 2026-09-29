// 锁步联机：回合门控 / 命令序 / 铺底 / 双模拟实例逐位一致（皇冠测试）/ 哈希不同步检测
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene } from './battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { Lockstep, NetBattle, battleProjection, hashProjection, LOCKSTEP } from '../js/net/lockstep.js';

const STEP = 1000 / 60;

test('锁步机制：铺底可起步、命令入前瞻槽、红前蓝后取出', () => {
    const red = new Lockstep('red', 4);
    const blue = new Lockstep('blue', 4);
    // 铺底：0..3 回合双方空包 → 可起步
    for (const packet of red.prime()) { red.receive(packet); blue.receive(packet); }   // 服务器双发含回环
    for (const packet of blue.prime()) { red.receive(packet); blue.receive(packet); }
    assert.equal(red.canStep(), true);
    assert.deepEqual(red.takeCommands(), []);          // 第 0 回合空（红方视角）
    assert.deepEqual(blue.takeCommands(), []);         // 第 0 回合空（蓝方视角）
    // 红方操作入下一包；commit 落在 (execTurn-1+lookahead)=4 号槽
    red.act({ k: 'buy', side: 'red', type: 'archer' });
    const packet = red.commitTurn();
    assert.equal(packet.exec, 4);
    assert.deepEqual(packet.cmds, [{ k: 'buy', side: 'red', type: 'archer' }]);
    blue.receive(packet);
    for (let turn = 1; turn <= 4; turn++) {
        blue.receive(blue.commitTurn());
        assert.deepEqual(blue.takeCommands(),
            turn === 4 ? [{ k: 'buy', side: 'red', type: 'archer' }] : [],
            turn === 4 ? '红方命令在预留槽生效' : undefined);
    }
});

test('锁步门控：对端包未到不推进，包到即放行', () => {
    const red = new Lockstep('red', 2);
    red.receive({ t: 'turn', exec: 0, side: 'red', cmds: [] });
    assert.equal(red.canStep(), false, '缺蓝方包');
    red.receive({ t: 'turn', exec: 0, side: 'blue', cmds: [{ k: 'buy' }] });
    assert.equal(red.canStep(), true);
    assert.deepEqual(red.takeCommands(), [{ k: 'buy' }], '红空包+蓝命令，红前蓝后合并');
});

test('双模拟实例：命令泵互通下 20 秒对局逐位一致（含买兵与营令）', () => {
    const makeSide = mySide => {
        const scene = makeScene();
        scene.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING }, 'custom', 'custom', {},
            { territory: true, terrain: 'territory', territoryAI: false, net: true, mySide });
        scene.battleStarted = true;
        return scene;
    };
    const sceneA = makeSide('red');
    const sceneB = makeSide('blue');
    // 命令泵：任何一端发包 = 服务器保序双发（含回环）
    const deliver = packet => { sceneA.net.handle(packet); sceneB.net.handle(packet); };
    sceneA.net = new NetBattle(sceneA, { send: deliver });
    sceneB.net = new NetBattle(sceneB, { send: deliver });
    sceneA.net.start();
    sceneB.net.start();

    const redBattalion = sceneA.battalions.battalions.find(b => b.team === 'red');
    const blueBattalion = sceneB.battalions.battalions.find(b => b.team === 'blue');
    assert.equal(sceneB.battalions.battalions[0].id, sceneA.battalions.battalions[0].id,
        '两端营 id 逐一对齐（网络令按 id 寻址的前提）');

    const TURNS = 60 * 20;
    let checkpoints = 0;
    for (let turn = 0; turn < TURNS && !sceneA.battleOver && !sceneB.battleOver; turn++) {
        // 双方各自的确定性命令脚本（红蓝不同令——命令通道本身的确定性）
        if (turn === 10) {
            sceneA.net.lockstep.act({ k: 'buy', side: 'red', type: 'archer' });
            sceneB.net.lockstep.act({ k: 'buy', side: 'blue', type: 'pikeman' });
        }
        if (turn === 30) {
            sceneA.net.lockstep.act({ k: 'order', side: 'red', id: redBattalion.id, flag: 2 });
            sceneB.net.lockstep.act({ k: 'order', side: 'blue', id: blueBattalion.id, flag: 0 });
        }
        if (turn === 100) {
            sceneA.net.lockstep.act({ k: 'buy', side: 'red', type: 'infantry' });
            sceneB.net.lockstep.act({ k: 'order', side: 'blue', id: blueBattalion.id, flag: 'home' });
        }
        for (const scene of [sceneA, sceneB]) {
            assert.ok(scene.net.lockstep.canStep(), `第 ${turn} 回合双方包应齐（前瞻铺底）`);
            const commands = scene.net.lockstep.takeCommands();
            for (const command of commands) scene.applyNetCommand(command);
            scene.simulationTime += STEP;
            scene.stepBattle(STEP / 1000);
            scene.net.onTurnDone();
        }
        if (turn % LOCKSTEP.HASH_EVERY === 0 && turn > 0) {
            checkpoints++;
            assert.equal(hashProjection(battleProjection(sceneA)), hashProjection(battleProjection(sceneB)),
                `第 ${turn} 回合两端状态投影应逐位一致`);
        }
    }
    assert.ok(checkpoints >= 2, '应完成多次哈希校验点');
    assert.equal(sceneA.net.desynced, false);
    assert.equal(sceneB.net.desynced, false);
    // 命令确实生效且两端一致
    assert.equal(sceneA.territory.recruit.spawned.blue >= 1, true, '蓝方买枪兵已出队（A 端视角）');
    assert.equal(sceneA.territory.recruit.spawned.blue, sceneB.territory.recruit.spawned.blue);
    assert.deepEqual(
        sceneA.battalions.battalions.map(b => [b.id, b.orderFlag, b.playerOrdered, b.retreat]),
        sceneB.battalions.battalions.map(b => [b.id, b.orderFlag, b.playerOrdered, b.retreat]),
        '两端营令状态逐位一致');
});

test('哈希不同步检测：分歧即上报且只报一次', () => {
    const sceneA = makeScene();
    sceneA.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING }, 'custom', 'custom', {},
        { territory: true, terrain: 'territory', territoryAI: false, net: true, mySide: 'red' });
    sceneA.battleStarted = true;
    const deliveries = [];
    let desyncTurn = null;
    sceneA.net = new NetBattle(sceneA, { send: packet => deliveries.push(packet) },
        { onDesync: turn => { desyncTurn = turn; } });
    sceneA.net.handle({ t: 'turn', exec: 0, side: 'red', cmds: [] });
    sceneA.net.handle({ t: 'turn', exec: 0, side: 'blue', cmds: [] });
    sceneA.net.lockstep.takeCommands();
    sceneA.net.lockstep.execTurn = 121;                       // 直设回合号，聚焦检测路径
    sceneA.simulationTime += STEP * LOCKSTEP.HASH_EVERY;
    sceneA.net.onTurnDone();       // 发出本端哈希
    const mine = deliveries.find(packet => packet.t === 'hash');
    assert.ok(mine, '应发出哈希包');
    sceneA.net.handle({ t: 'hash', turn: mine.turn, hash: 'different' });
    assert.equal(desyncTurn, mine.turn, '分歧应立即上报');
    assert.equal(sceneA.net.desynced, true);
    const before = desyncTurn;
    sceneA.net.handle({ t: 'hash', turn: mine.turn, hash: 'x' });
    assert.equal(desyncTurn, before, '只上报一次');
});
