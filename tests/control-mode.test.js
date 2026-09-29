// 占点征服模式（英雄连式兵力拔河）：占领判定 / 拔河 / 中立反占 / 积分胜利 / 歼灭仍胜 / AI 聚拢 / 对称同步
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';

const STEP = 1000 / 60;

function controlScene(armies) {
    const scene = makeScene();
    scene.deployUnits(armies?.red ?? {}, armies?.blue ?? {},
        'custom', 'custom', {}, { control: true });
    scene.battleStarted = true;
    return scene;
}

test('占点：单方剑士约 10 秒拉满占领，归属旗每秒 +1 分', () => {
    const scene = controlScene();
    const flag = scene.flags[1];                       // 中路 (35, 35)
    addUnit(scene, 'red', 'infantry', flag.gx, flag.gy);
    scene.rebuildSpatial();
    // 直测占领状态机（AI 行为另有测试），红兵恒在圈内
    for (let i = 0; i < 60 * 11; i++) scene.updateFlags(STEP / 1000);
    assert.equal(flag.owner, 'red', '剑士占领力 10，约 10 秒拉满');
    assert.ok(flag.progress >= 1);
    for (let i = 0; i < 60; i++) scene.updateFlags(0.5);   // 30 秒 × 1 分/秒
    assert.ok(scene.controlScore.red >= 29.5, '归属旗每秒 +1 分');
});

test('占点：兵力拔河——同圈 2v1 人多的一方硬拔进度', () => {
    const scene = controlScene();
    const flag = scene.flags[0];
    addUnit(scene, 'blue', 'infantry', flag.gx, flag.gy);          // 蓝先占
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 11; i++) scene.updateFlags(STEP / 1000);
    assert.equal(flag.owner, 'blue');
    addUnit(scene, 'red', 'infantry', flag.gx + 0.5, flag.gy);
    addUnit(scene, 'red', 'infantry', flag.gx - 0.5, flag.gy);     // 红 2 剑士入圈：净 +10 向红
    scene.rebuildSpatial();
    let neutralized = false;
    for (let i = 0; i < 60 * 22; i++) {
        scene.updateFlags(STEP / 1000);
        if (flag.owner === null) neutralized = true;
        if (flag.owner === 'red') break;
    }
    assert.ok(flag.contested, '双方同圈仍是争夺态');
    assert.ok(neutralized, '兵力劣势方应被拉过中线失去归属');
    assert.equal(flag.owner, 'red', '人多的一方完成硬拔');
});

test('占点：兵力相当的真僵持（同型 1v1 谁也拉不动）', () => {
    const scene = controlScene();
    const flag = scene.flags[0];
    addUnit(scene, 'red', 'infantry', flag.gx, flag.gy);
    addUnit(scene, 'blue', 'infantry', flag.gx + 1, flag.gy);
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 8; i++) scene.advanceBattle(STEP);
    assert.ok(flag.contested, '双方在场应判定争夺');
    assert.equal(flag.owner, null, '净占领力为零不应产生归属');
    assert.ok(Math.abs(scene.controlScore.red - scene.controlScore.blue) < 1e-6, '僵持期双方都不得分');
});

test('占点：夺旗先拉过中线（中立化）再拉满自己端', () => {
    const scene = controlScene();
    const flag = scene.flags[2];
    addUnit(scene, 'red', 'infantry', flag.gx, flag.gy);
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 11; i++) scene.updateFlags(STEP / 1000);
    assert.equal(flag.owner, 'red');
    scene.units.find(u => u.team === 'red').dead = true;   // 红兵退场（不再计入驻圈）
    const blue = addUnit(scene, 'blue', 'infantry', flag.gx, flag.gy);
    scene.rebuildSpatial();
    let neutralized = false;
    for (let i = 0; i < 60 * 25; i++) {
        scene.updateFlags(STEP / 1000);
        if (flag.owner === null) neutralized = true;
        if (flag.owner === 'blue') break;
    }
    assert.ok(neutralized, '反占前应先被拉过中线（中立化）');
    assert.equal(flag.owner, 'blue', '中立后蓝方拉满完成反占');
    assert.ok(blue);
});

test('占点：单位离开进度保持（断点不清零）', () => {
    const scene = controlScene();
    const flag = scene.flags[1];
    const red = addUnit(scene, 'red', 'infantry', flag.gx, flag.gy);
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 5; i++) scene.updateFlags(STEP / 1000);
    const mid = flag.progress;
    assert.ok(mid > 0.4 && mid < 1, '半程进度');
    red.dead = true; scene.rebuildSpatial();                // 红兵离场
    for (let i = 0; i < 60 * 5; i++) scene.updateFlags(STEP / 1000);
    assert.ok(Math.abs(flag.progress - mid) < 1e-9, '无人时进度保持不清零');
});

test('占点：积分先到 60 判胜，endReason=control', () => {
    const scene = controlScene({ red: {}, blue: { archer: 4 } });
    const flag = scene.flags[1];
    // 守旗人钉在旗心并回满血；蓝方四弓钉死在对角远处（隔离走位/士气/对射，
    // 只验证"占领→攒分→60 分判胜"这条链路）
    const keeper = addUnit(scene, 'red', 'infantry', flag.gx, flag.gy);
    const foes = scene.units.filter(u => u.team === 'blue');
    foes.forEach((u, i) => { u.gx = 2; u.gy = 2 + i; });
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 90 && !scene.battleOver; i++) {
        keeper.gx = flag.gx; keeper.gy = flag.gy; keeper.hp = keeper.maxHp;
        foes.forEach((u, j) => { u.gx = 2; u.gy = 2 + j; u.hp = u.maxHp; if (u.moraleState === 'routing') u.moraleState = 'steady'; });
        scene.advanceBattle(STEP);
    }
    assert.ok(scene.battleOver, '应已结束');
    assert.equal(scene.winner, 'red');
    assert.equal(scene.endReason, 'control');
    assert.ok(scene.getBattleReport().events.some(e => e.text.includes('积分获胜')), '应有占点获胜战报');
});

test('占点：歼灭对手仍直接获胜', () => {
    const scene = controlScene({ red: { infantry: 10 }, blue: { archer: 1 } });
    for (let i = 0; i < 60 * 30 && !scene.battleOver; i++) scene.advanceBattle(STEP);
    assert.ok(scene.battleOver);
    assert.equal(scene.winner, 'red');
    assert.notEqual(scene.endReason, 'control', '歼灭路径不被占点积分覆盖');
});

test('占点 AI：对称军团开进后向旗聚拢', () => {
    const scene = controlScene({ red: { infantry: 12 }, blue: { infantry: 12 } });
    let gathered = 0;
    for (let i = 0; i < 60 * 25 && !scene.battleOver; i++) {
        scene.advanceBattle(STEP);
        if (i % 60 === 0) {
            const near = scene.units.filter(u => !u.dead &&
                scene.flags.some(f => Math.hypot(f.gx - u.gx, f.gy - u.gy) <= 2.8)).length;
            gathered = Math.max(gathered, near);
        }
    }
    assert.ok(gathered >= 3, `两军应向旗聚拢（旗圈峰值 ${gathered} 人）`);
});

test('占点：镜像对称布置同步争夺（换座公平）', () => {
    const scene = controlScene({ red: { infantry: 1 }, blue: { infantry: 1 } });
    // 手摆镜像对：关于中路旗 (35,35) 对称（x→70-x, y 不变），相向而行恰在旗心相遇
    const flag = scene.flags[1];
    scene.units[0].gx = flag.gx - 4; scene.units[0].gy = flag.gy;
    scene.units[1].gx = flag.gx + 4; scene.units[1].gy = flag.gy;
    scene.rebuildSpatial();
    let contestedSeen = false;
    for (let i = 0; i < 60 * 4; i++) {
        scene.advanceBattle(STEP);
        contestedSeen ||= scene.flags[1].contested;
    }
    assert.ok(contestedSeen, '对称双单位应同时入圈形成争夺');
    assert.ok(Math.abs(scene.controlScore.red - scene.controlScore.blue) < 1e-6, '对称局面双方得分相等');
});
