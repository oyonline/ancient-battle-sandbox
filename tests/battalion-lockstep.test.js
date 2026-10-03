// F3 锁步哈希覆盖营队状态：cavPool / 营 cavalry 标记 / corpsManaged / chargeDistance
// 等未进 battleProjection 时，两端营状态分叉（如一侧单骑出发、一侧继续集结）
// 哈希仍一致——检测有遗漏。本文件复现该遗漏并验证修复不引入误报。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { battleProjection, hashProjection, NetBattle } from '../js/net/lockstep.js';

const STEP = 1000 / 60;

function territoryScene(mySide = 'red') {
    const scene = makeScene();
    scene.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING }, 'custom', 'custom', {},
        { territory: true, terrain: 'territory', territoryAI: false, net: true, mySide });
    scene.battleStarted = true;
    return scene;
}

// 同构场景 + 一名入池骑兵（骑队池存在且可观测）
function sceneWithCavPool() {
    const scene = territoryScene();
    scene.rebuildSpatial();
    const cav = addUnit(scene, 'red', 'cavalry', 10, 90);
    scene.battalions.assignReinforcement(cav);
    scene.rebuildSpatial();
    return { scene, cav };
}

test('F3 投影检出：营队状态分叉必须改变投影哈希', () => {
    // 同构基准：投影逐字一致
    assert.equal(battleProjection(sceneWithCavPool().scene), battleProjection(sceneWithCavPool().scene),
        '同构场景投影一致（前提）');

    // 1) 用户探针场景：一侧骑队池提前激活（单骑出发），另一侧继续集结
    {
        const A = sceneWithCavPool();
        const B = sceneWithCavPool();
        B.scene.battalions.cavPool.red.gathering = false;
        B.scene.battalions.cavPool.red.kind = 'line';
        B.scene.battalions.cavPool.red = null;
        assert.notEqual(hashProjection(battleProjection(A.scene)), hashProjection(battleProjection(B.scene)),
            '骑队池激活状态分叉必须被哈希检出');
    }
    // 2) 营 cavalry 标记分叉（激活阈值与步速语义不同）
    {
        const A = sceneWithCavPool();
        const B = sceneWithCavPool();
        B.scene.battalions.cavPool.red.cavalry = false;
        assert.notEqual(hashProjection(battleProjection(A.scene)), hashProjection(battleProjection(B.scene)),
            '营 cavalry 标记分叉必须被检出');
    }
    // 3) 骑兵 corpsManaged 分叉（下一步是否交还冲锋状态机）
    {
        const A = sceneWithCavPool();
        const B = sceneWithCavPool();
        B.cav.corpsManaged = true;
        assert.notEqual(hashProjection(battleProjection(A.scene)), hashProjection(battleProjection(B.scene)),
            'corpsManaged 分叉必须被检出');
    }
    // 4) 骑兵 chargeDistance 量化值分叉（继承的助跑语义不同）
    {
        const A = sceneWithCavPool();
        const B = sceneWithCavPool();
        B.cav.chargeDistance = 2.5;
        assert.notEqual(hashProjection(battleProjection(A.scene)), hashProjection(battleProjection(B.scene)),
            'chargeDistance 分叉必须被检出');
    }
    // 5) 营令分叉：orderFlag / retreat / stance / chargeUntil
    {
        const A = territoryScene();
        const B = territoryScene();
        const bnA = A.battalions.battalions.find(b => b.team === 'red');
        const bnB = B.battalions.battalions.find(b => b.team === 'red');
        bnB.orderFlag = 2; bnB.retreat = true; bnB.stance = 'aggressive'; bnB.chargeUntil = 7000;
        assert.notEqual(hashProjection(battleProjection(A)), hashProjection(battleProjection(B)),
            '营令/姿态/冲锋窗口分叉必须被检出');
    }
});

test('F3 不误报：骑兵令密集的真实双端对局，投影全程一致', () => {
    const makeSide = mySide => {
        const scene = makeScene();
        scene.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING }, 'custom', 'custom', {},
            { territory: true, terrain: 'territory', territoryAI: false, net: true, mySide });
        scene.battleStarted = true;
        // 两侧同构预设马场归属：解锁骑兵征募（确定性直改模拟态，两端一致）
        scene.flags.find(f => f.role === 'ranch' && f.gx < 130).owner = 'red';
        scene.flags.find(f => f.role === 'ranch' && f.gx > 130).owner = 'blue';
        scene.territory.econ.treasury.red = 2000;
        scene.territory.econ.treasury.blue = 2000;
        return scene;
    };
    const sceneA = makeSide('red');
    const sceneB = makeSide('blue');
    const deliver = packet => { sceneA.net.handle(packet); sceneB.net.handle(packet); };
    sceneA.net = new NetBattle(sceneA, { send: deliver });
    sceneB.net = new NetBattle(sceneB, { send: deliver });
    sceneA.net.start();
    sceneB.net.start();

    // F14：按各方取本方骑队营 id（红蓝营 id 不同；此前蓝方误用红营 id，命令被
    // id+team 双重匹配正确忽略，蓝方从未成功下令而测试照样通过）
    const cavTroopId = side => sceneA.battalions.battalions.find(b => b.team === side && b.cavalry)?.id;
    const TURNS = 60 * 26;
    let checkpoints = 0, spawnedCavalry = 0;
    for (let turn = 0; turn < TURNS && !sceneA.battleOver && !sceneB.battleOver; turn++) {
        if (turn === 30) {
            sceneA.net.lockstep.act({ k: 'buy', side: 'red', type: 'cavalry' });
            sceneB.net.lockstep.act({ k: 'buy', side: 'blue', type: 'cavalry' });
        }
        if (turn === 240) {
            sceneA.net.lockstep.act({ k: 'buy', side: 'red', type: 'cavalry' });
            sceneB.net.lockstep.act({ k: 'buy', side: 'blue', type: 'cavalry' });
        }
        if (turn === 450) {
            sceneA.net.lockstep.act({ k: 'buy', side: 'red', type: 'cavalry' });   // 第3骑：满员整队激活
            sceneB.net.lockstep.act({ k: 'buy', side: 'blue', type: 'cavalry' });
        }
        if (turn === 900 && cavTroopId('red') != null && cavTroopId('blue') != null) {
            sceneA.net.lockstep.act({ k: 'order', side: 'red', id: cavTroopId('red'), flag: 2 });
            sceneB.net.lockstep.act({ k: 'order', side: 'blue', id: cavTroopId('blue'), flag: 2 });
        }
        for (const scene of [sceneA, sceneB]) {
            assert.ok(scene.net.lockstep.canStep(), `第 ${turn} 回合双方包应齐`);
            for (const command of scene.net.lockstep.takeCommands()) scene.applyNetCommand(command);
            scene.simulationTime += STEP;
            scene.stepBattle(STEP / 1000);
            scene.net.onTurnDone();
        }
        if (turn === 960) {
            // F14 生效断言：红蓝骑队令都真实落地（playerOrdered 恒为玩家令专属，
            // aiAssign 不写它——若命令被 id/team 匹配忽略，此处必红）
            for (const [scene, tag] of [[sceneA, 'A'], [sceneB, 'B']]) {
                for (const side of ['red', 'blue']) {
                    const troop = scene.battalions.battalions.find(b => b.team === side && b.cavalry);
                    assert.ok(troop, `${tag} 端 ${side} 骑队存在`);
                    assert.equal(troop.orderFlag, 2, `${tag} 端 ${side} 骑队旗令已生效`);
                    assert.equal(troop.playerOrdered, true, `${tag} 端 ${side} 骑队为玩家令（非 AI 令）`);
                }
            }
        }
        if (turn % 240 === 0 && turn > 0) {
            checkpoints++;
            assert.equal(battleProjection(sceneA), battleProjection(sceneB),
                `第 ${turn} 回合两端投影（含营队状态）应逐位一致`);
        }
    }
    spawnedCavalry = sceneA.territory.recruit.spawned.red;
    assert.ok(spawnedCavalry >= 3, `骑兵征募与骑队池已真实运转（spawned=${spawnedCavalry}）`);
    assert.ok(sceneA.battalions.battalions.some(b => b.team === 'red' && b.cavalry && !b.gathering),
        '红方骑队已激活成建制');
    assert.equal(sceneA.net.desynced, false, '全程无 desync 误报');
    assert.equal(sceneB.net.desynced, false);
    assert.ok(checkpoints >= 2, '应完成多次投影校验点');
});
