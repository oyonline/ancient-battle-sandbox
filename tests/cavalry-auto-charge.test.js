// S2 自动冲锋：旗边敌情优先 / 回撤中断交战并清冲锋动量 / 驻守缰绳 / 无手动命令的真实助跑冲锋
// 复现基线缺陷：battalionDirectCavalry 距目标旗 ≤4.5 格提前返回待命点，早于附近
// 敌情检查且不区分旗归属——中立/敌旗旁敌兵贴近时压住自动接敌；回撤令被 6 格内
// 敌情压住无法中断交战；驻守骑兵无缰绳可无限追击；接管换向继承旧冲锋动量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { Battalion } from '../js/battle/battalion.js';

const STEP = 1000 / 60;

function territoryScene(options = {}, red = { ...TERRITORY.OPENING }, blue = { ...TERRITORY.OPENING }) {
    const scene = makeScene();
    scene.deployUnits(red, blue, 'custom', 'custom', {}, { territory: true, ...options });
    scene.battleStarted = true;
    return scene;
}

function run(scene, seconds, pin) {
    for (let i = 0; i < 60 * seconds && !scene.battleOver; i++) {
        if (pin) pin();
        scene.advanceBattle(STEP);
    }
}

// 手工构造独立骑队（成建制、可下令）
function cavalryTroop(scene, spots) {
    const battalion = new Battalion('red', 'line');
    battalion.cavalry = true;
    for (const [gx, gy] of spots) {
        const cav = addUnit(scene, 'red', 'cavalry', gx, gy);
        cav.battalion = battalion;
        battalion.members.push(cav);
    }
    battalion.refreshPace();
    scene.battalions.battalions.push(battalion);
    return battalion;
}

test('旗边敌情优先：目标旗旁敌兵贴近时交还接敌，不再被待命点压住（中立旗/己旗）', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const flag = scene.flags[2];                       // 中央高地（中立）
    flag.owner = null; flag.progress = 0;
    const troop = cavalryTroop(scene, [[flag.gx - 4, flag.gy - 1], [flag.gx - 4.5, flag.gy + 1], [flag.gx - 5, flag.gy]]);
    troop.orderFlag = 2;
    const defenders = [
        addUnit(scene, 'blue', 'infantry', flag.gx + 0.5, flag.gy),
        addUnit(scene, 'blue', 'infantry', flag.gx - 0.5, flag.gy + 1)
    ];
    for (const u of [...troop.members, ...defenders]) { u.hp = u.maxHp = 4000; }
    scene.rebuildSpatial();
    const cav = troop.members[0];
    assert.ok(Math.hypot(flag.gx - cav.gx, flag.gy - cav.gy) <= 4.5, '骑兵在旗边待命圈内');
    // 直接断言：敌在 6 格内必须交还冲锋状态机（基线返回待命点吞掉接敌）
    assert.equal(scene.battalionDirectCavalry(cav), null, '中立旗旁敌兵贴近：应交还接敌');
    // 行为断言：拉到真实冲锋距离再进军——无任何手动 charge 命令完成助跑与打击
    const spots = [[flag.gx - 10, flag.gy - 1.2], [flag.gx - 10.5, flag.gy + 1.2], [flag.gx - 11, flag.gy]];
    troop.aliveMembers().forEach((c, i) => { c.gx = spots[i][0]; c.gy = spots[i][1]; });
    scene.rebuildSpatial();
    let maxRunUp = 0;
    const pin = () => {
        for (const d of defenders) { d.gx = flag.gx + (d === defenders[0] ? 0.5 : -0.5); d.gy = flag.gy + (d === defenders[0] ? 0 : 1); }
        for (const c of troop.aliveMembers()) maxRunUp = Math.max(maxRunUp, c.chargeDistance);
    };
    pin();
    run(scene, 6, pin);
    assert.ok(troop.chargeUntil === 0, '未使用任何手动冲锋令');
    assert.ok(defenders.some(d => d.hp < d.maxHp), '守旗敌兵已被骑兵打击（基线骑兵绕旗待命只挨打）');
    assert.ok(maxRunUp >= 3, `真实助跑 ≥3 格（实测峰值 ${maxRunUp.toFixed(1)}）`);
    // 己方旗同样不得吞掉接敌
    const near = [[flag.gx - 4, flag.gy - 1], [flag.gx - 4.5, flag.gy + 1], [flag.gx - 5, flag.gy]];
    troop.aliveMembers().forEach((c, i) => { c.gx = near[i][0]; c.gy = near[i][1]; });
    flag.owner = 'red';
    scene.rebuildSpatial();
    assert.equal(scene.battalionDirectCavalry(cav), null, '己旗旁敌兵贴近：同样交还接敌');
});

test('回撤中断：home 令打断缠斗撤回老家，且不继承旧冲锋动量', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const foes = scene.units.filter(u => u.team === 'blue');
    const pinFoes = () => foes.filter(u => !troop.members.includes(u)).forEach((u, i) => { u.gx = 240; u.gy = 160 + i; u.hp = u.maxHp; });
    const troop = cavalryTroop(scene, [[120, 88], [120, 91], [119, 90]]);
    troop.orderFlag = 2;
    const enemies = [
        addUnit(scene, 'blue', 'infantry', 124, 89),
        addUnit(scene, 'blue', 'infantry', 124, 92)
    ];
    for (const u of [...troop.members, ...enemies]) { u.hp = u.maxHp = 5000; }
    const pin = () => {
        enemies[0].gx = 124; enemies[0].gy = 89;
        enemies[1].gx = 124; enemies[1].gy = 92;
    };
    pin(); pinFoes();
    run(scene, 2.5, () => { pin(); pinFoes(); });       // 先缠斗：进入交战状态
    const cav = troop.members[0];
    assert.ok(Math.min(...enemies.map(e => Math.hypot(e.gx - cav.gx, e.gy - cav.gy))) <= 6, '已处于接敌距离');
    // 下达回撤令
    assert.equal(scene.battalions.orderBattalion(troop, 'home'), true);
    assert.equal(troop.retreat, true);
    const home = scene.battalions.homeRally('red');
    const rally = scene.battalionDirectCavalry(cav);
    assert.ok(rally && Math.abs(rally.gx - home.gx) < 1e-9, '回撤令在敌情圈内仍接管（基线被 6 格敌情压住无法撤退）');
    run(scene, 3, () => { pin(); pinFoes(); });
    for (const c of troop.aliveMembers()) {
        assert.ok(Math.min(...enemies.map(e => Math.hypot(e.gx - c.gx, e.gy - c.gy))) > 6, '骑兵已脱离缠斗（>6 格）');
        assert.equal(c.chargeDistance, 0, '接管转换清理助跑距离（不继承旧冲锋动量）');
        assert.equal(c.chargeMomentum, 0, '接管转换清理冲锋动量');
    }
    const center = troop.center();
    assert.ok(center.gx < 115, `全营向老家方向撤退（x=${center.gx.toFixed(1)}，敌在 124+）`);
});

test('驻守缰绳：稳健骑队追敌不脱防区，好战骑队追得更远', () => {
    const build = stance => {
        const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
        scene.rebuildSpatial();
        const foes = scene.units.filter(u => u.team === 'blue');
        foes.forEach((u, i) => { u.gx = 240; u.gy = 160 + i; });
        const troop = cavalryTroop(scene, [[60, 89], [60, 91], [60, 90]]);
        troop.stance = stance;
        scene.battalions.orderHold(troop, 60, 90);
        // 敌兵始终吊在最近骑兵前方 4.5 格（<6 保持接敌引骑兵追击），到驻点 14 格后钉住
        const foe = addUnit(scene, 'blue', 'infantry', 64.5, 90);
        foe.hp = foe.maxHp = 8000;
        for (const c of troop.members) { c.hp = c.maxHp = 8000; }
        scene.rebuildSpatial();
        let foeX = 64.5;
        const pin = () => {
            const front = Math.min(...troop.aliveMembers().map(c => c.gx));
            foeX = Math.max(foeX, Math.min(74, front + 4.5));
            foe.gx = foeX; foe.gy = 90;
        };
        pin();
        let maxFromPost = 0;
        for (let i = 0; i < 60 * 9; i++) {
            pin();
            scene.advanceBattle(STEP);
            for (const c of troop.aliveMembers()) {
                maxFromPost = Math.max(maxFromPost, Math.hypot(c.gx - 60, c.gy - 90));
            }
        }
        return { maxFromPost, endFromPost: Math.hypot(troop.center().gx - 60, troop.center().gy - 90) };
    };
    const steady = build('steady');
    const aggressive = build('aggressive');
    // 稳健缰绳 7：吊敌引到 14 格外，骑队最多追到 ~8 格即回防（基线无缰绳会一直追到吊敌处）
    assert.ok(steady.maxFromPost <= 9, `稳健骑队离驻点最远 ${steady.maxFromPost.toFixed(1)} 格（缰绳 7 + 判定余量）`);
    assert.ok(steady.endFromPost <= 9, `稳健骑队最终回防（距驻点 ${steady.endFromPost.toFixed(1)} 格）`);
    // 好战缰绳 14：吊敌钉在 14 格处仍在追击范围内，持续接敌
    assert.ok(aggressive.maxFromPost > steady.maxFromPost + 2,
        `好战骑队追得更远（${aggressive.maxFromPost.toFixed(1)} vs ${steady.maxFromPost.toFixed(1)}）`);
});

test('全自动冲锋链路：无任何手动 charge 命令，完成行军-接敌-真实助跑-伤害', () => {
    const scene = territoryScene({ territoryAI: false }, { cavalry: 3 }, { infantry: 4 });
    scene.rebuildSpatial();
    const flag = scene.flags[2];
    const defenders = scene.units.filter(u => u.team === 'blue');
    for (const d of defenders) { d.hp = d.maxHp = 6000; }
    const cav = scene.units.filter(u => u.team === 'red');
    for (const c of cav) { c.hp = c.maxHp = 6000; }
    const startHp = defenders.reduce((s, d) => s + d.hp, 0);
    const pin = () => defenders.forEach((d, i) => { d.gx = flag.gx + (i % 2 ? 1.2 : -1.2); d.gy = flag.gy + (i < 2 ? 0 : 1.4); });
    pin();
    for (const b of scene.battalions.battalions.filter(b => b.team === 'red')) {
        scene.battalions.orderBattalion(b, 2);          // 玩家只下达进军意图
    }
    let maxRunUp = 0;
    const probe = () => { for (const c of cav) maxRunUp = Math.max(maxRunUp, c.chargeDistance); };
    run(scene, 42, () => { pin(); probe(); });
    const troop = scene.battalions.battalions.find(b => b.team === 'red' && b.cavalry);
    assert.ok(troop, '红方为独立骑队（S1）');
    assert.equal(troop.chargeUntil, 0, '全程无手动冲锋令');
    assert.ok(maxRunUp >= 3, `发生真实助跑冲锋（峰值助跑 ${maxRunUp.toFixed(1)} 格 ≥3）`);
    const endHp = defenders.reduce((s, d) => s + d.hp, 0);
    assert.ok(endHp < startHp - 100, `守敌被打出真实伤害（掉血 ${Math.round(startHp - endHp)}）`);
});

// F1 驻守边缘折返（用户复验否决项）：缰绳边界逐帧切换"追敌/返回"（实测 3 秒 144
// 次换向、敌弓零战损）。滞回修复后：边界窗口换向次数有上限；合法接敌（敌在 6 格
// 交还圈内）不受滞回拖累，仍要打出真实伤害。
test('F1 驻守边缘滞回：缰绳边界不再逐帧折返，合法接敌仍造成真实打击（稳健/好战）', () => {
    // 场景骨架：开局杂兵全部钉去远角，只留骑队 + 一名真 AI 敌弓
    const setup = (stance, archerX, cavX) => {
        const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
        scene.rebuildSpatial();
        const others = scene.units.filter(u => u.type !== 'cavalry' || u.team !== 'red');
        const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
        pinOthers();
        const troop = cavalryTroop(scene, [[cavX, 89], [cavX, 91], [cavX + 0.5, 90]]);
        troop.stance = stance;
        scene.battalions.orderHold(troop, 60, 90);
        const archer = addUnit(scene, 'blue', 'archer', archerX, 90);
        scene.rebuildSpatial();
        return { scene, troop, archer, pinOthers };
    };
    // 统计最近 windowSeconds 秒内骑队营心 x 的换向次数（|dx|>0.002 才计入）
    const measure = (scene, troop, pinOthers, seconds, windowSeconds) => {
        const deltas = [];
        for (let i = 0; i < 60 * seconds && !scene.battleOver; i++) {
            pinOthers();
            const before = troop.center().gx;
            scene.advanceBattle(STEP);
            deltas.push(troop.center().gx - before);
        }
        let reversals = 0, lastDx = null;
        for (let i = deltas.length - 60 * windowSeconds; i < deltas.length; i++) {
            const dx = deltas[i];
            if (Math.abs(dx) > 0.002) {
                if (lastDx != null && Math.sign(dx) !== Math.sign(lastDx)) reversals++;
                lastDx = dx;
            }
        }
        return reversals;
    };
    // 1) 边界折返复现：骑队起点恰在缰绳外一点点（稳健 7.2 / 好战 14.2），
    //    敌弓站在缰绳边界外 5 格处（真 AI：射程内驻足放箭）——基线在边界逐帧
    //    切换追敌/返回，敌弓零战损。
    for (const [stance, cavX, archerX] of [['steady', 67.2, 72], ['aggressive', 74.2, 79]]) {
        const { scene, troop, archer, pinOthers } = setup(stance, archerX, cavX);
        const reversals = measure(scene, troop, pinOthers, 6, 3);
        assert.ok(reversals <= 5, `${stance}：最后3秒换向 ${reversals} 次（≤5；基线逐帧折返 ~144 次）`);
        assert.equal(archer.hp, archer.maxHp, `${stance}：折返期间敌弓不被误伤`);
    }
    // 2) 合法接敌不受滞回拖累：敌弓在 6 格交还圈内（驻点外 5.5 格），
    //    骑队正常出击并打出真实伤害，且窗口内同样无折返振荡。
    for (const stance of ['steady', 'aggressive']) {
        const { scene, troop, archer, pinOthers } = setup(stance, 65.5, 60);
        const reversals = measure(scene, troop, pinOthers, 5, 3);
        assert.ok(archer.hp < archer.maxHp || archer.dead, `${stance}：合法接敌必须造成真实打击（滞回不得吞掉接敌）`);
        assert.ok(reversals <= 5, `${stance}：合法接敌窗口换向 ${reversals} 次（≤5）`);
    }
});

// F4 回撤中断攻建筑（用户复验旧问题）：正在攻塔的骑兵收到回撤令后仍原地攻塔
// （camps.updateUnit 的攻寨自动接管在营队回撤分支之前 continue 掉了骑兵）。
test('F4 回撤中断攻建筑：回撤令抢占攻寨接管，骑兵脱战撤走、塔血止跌', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const others = scene.units.slice();   // 开局杂兵钉远，避免干扰
    const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
    pinOthers();
    // 蓝方在东桥头（flag 3，开局归属蓝）立一座已完成的箭塔
    const tower = scene.territory.camps.createBuilding('blue', 'tower', 3, true);
    const troop = cavalryTroop(scene, [
        [tower.gx + 2.0, tower.gy], [tower.gx + 2.2, tower.gy + 1.1], [tower.gx + 2.2, tower.gy - 1.1]]);
    scene.rebuildSpatial();
    // 前提：自动攻寨接管生效，骑兵持续打塔
    run(scene, 2, pinOthers);
    const hpAfterSiege = tower.hp;
    assert.ok(hpAfterSiege < tower.maxHp, `攻塔前提成立（650→${Math.round(hpAfterSiege)}）`);
    // 下回撤令：必须抢占攻寨接管
    assert.equal(scene.battalions.orderBattalion(troop, 'home'), true);
    const startX = troop.center().gx;
    run(scene, 1.5, pinOthers);
    assert.ok(troop.center().gx < startX - 3, `1.5 秒内脱战向老家移动（x ${startX.toFixed(1)}→${troop.center().gx.toFixed(1)}）`);
    const hpAt15 = tower.hp;
    run(scene, 1.5, pinOthers);
    assert.ok(troop.center().gx < startX - 8, `持续撤退（x=${troop.center().gx.toFixed(1)}）`);
    assert.equal(tower.hp, hpAt15, '回撤后塔血不再下降（基线继续掉血）');
    for (const c of troop.aliveMembers()) {
        assert.equal(c.chargeDistance, 0, '接管转换清理助跑（与 F1/F2 机制协同）');
    }
});

// F8 改令清驻点：leashReturning 在 orderPoint 清空（改旗令/回撤/清令）时显式复位——
// 新驻守点不携带旧"返程承诺"，接敌资格等同新单位。
test('F8 改令清驻点：旧返程承诺随之复位，新驻点立即恢复接敌资格', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const others = scene.units.slice();
    const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
    pinOthers();
    const troop = cavalryTroop(scene, [[60, 89], [60, 91], [60, 90]]);
    scene.battalions.orderHold(troop, 60, 90);
    // 吊敌引骑兵出缰（>7 格）置返程承诺
    const foe = addUnit(scene, 'blue', 'infantry', 64.5, 90);
    foe.hp = foe.maxHp = 9000;
    for (const c of troop.members) c.hp = c.maxHp = 9000;
    scene.rebuildSpatial();
    let foeX = 64.5;
    const kite = () => {
        const front = Math.min(...troop.aliveMembers().map(c => c.gx));
        foeX = Math.max(foeX, Math.min(72, front + 4.5));
        foe.gx = foeX; foe.gy = 90;
    };
    kite();
    let committed = false;
    for (let i = 0; i < 60 * 4 && !committed; i++) {
        kite(); pinOthers();
        scene.advanceBattle(STEP);
        committed = troop.aliveMembers().some(c => c.leashReturning === true);
    }
    assert.ok(committed, '前提：出缰返程承诺已置位');
    // 改旗令（orderPoint 清空）：承诺应随驻点清除而复位
    scene.battalions.orderBattalion(troop, 2);
    assert.equal(troop.orderPoint, null, '驻点已清');
    for (let i = 0; i < 3; i++) { pinOthers(); foe.gx = foeX; foe.gy = 90; scene.advanceBattle(STEP); }
    assert.ok(troop.aliveMembers().every(c => !c.leashReturning), '旧返程承诺已复位（基线携带陈旧承诺跨令）');
    // 新驻守点：距骑兵 > 0.65×缰绳（>4.55）、敌在 6 格交还圈内且在新缰绳内
    // （敌挪到驻点与骑兵之间：西向出击可及，接敌在几何上可达成）——无旧承诺应立即接敌
    const center = troop.center();
    scene.battalions.orderHold(troop, center.gx - 5.5, center.gy);
    const foeWest = { gx: center.gx - 4.2, gy: center.gy };
    foe.gx = foeWest.gx; foe.gy = foeWest.gy;
    scene.rebuildSpatial();
    const cav0 = troop.aliveMembers()[0];
    assert.equal(scene.battalionDirectCavalry(cav0), null, '新驻点不携带旧承诺：敌在交还圈内立即接敌');
    // 行为佐证：1.5 秒内敌受到真实打击（出击点在新缰绳内）
    const hp0 = foe.hp;
    run(scene, 1.5, () => { pinOthers(); foe.gx = foeWest.gx; foe.gy = foeWest.gy; });
    assert.ok(foe.hp < hp0, '接敌发生真实伤害');
});

// F13 回撤路径陈旧承诺（用户复验否决项）：回撤分支提前 return 绕过 F8 的复位——
// 回撤会清 orderPoint，旧返程承诺跨回撤令存活，压坏下一次驻守的接敌。
// 用户真实序列：驻守出界（置承诺）→ 回撤 30 帧 → 新驻守。
test('F13 回撤路径复位：返程承诺不跨回撤令存活，新驻守立即恢复接敌', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const others = scene.units.slice();
    const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
    pinOthers();
    const troop = cavalryTroop(scene, [[60, 89], [60, 91], [60, 90]]);
    scene.battalions.orderHold(troop, 60, 90);
    // 吊敌引骑兵出缰置返程承诺
    const foe = addUnit(scene, 'blue', 'infantry', 64.5, 90);
    foe.hp = foe.maxHp = 9000;
    for (const c of troop.members) c.hp = c.maxHp = 9000;
    scene.rebuildSpatial();
    let foeX = 64.5;
    const kite = () => {
        const front = Math.min(...troop.aliveMembers().map(c => c.gx));
        foeX = Math.max(foeX, Math.min(72, front + 4.5));
        foe.gx = foeX; foe.gy = 90;
    };
    kite();
    let committed = false;
    for (let i = 0; i < 60 * 4 && !committed; i++) {
        kite(); pinOthers();
        scene.advanceBattle(STEP);
        committed = troop.aliveMembers().some(c => c.leashReturning === true);
    }
    assert.ok(committed, '前提：出缰返程承诺已置位');
    // 回撤 30 帧（用户真实序列）
    scene.battalions.orderBattalion(troop, 'home');
    assert.equal(troop.retreat, true);
    assert.equal(troop.orderPoint, null, '回撤已清驻点');
    for (let i = 0; i < 30; i++) { pinOthers(); foe.gx = foeX; foe.gy = 90; scene.advanceBattle(STEP); }
    assert.ok(troop.aliveMembers().every(c => !c.leashReturning), '回撤期间返程承诺已复位（基线跨回撤令存活）');
    // 新驻守点：骑距新驻点 >0.65×缰绳（>4.55）、敌在 6 格交还圈内且在新缰绳内
    const center = troop.center();
    scene.battalions.orderHold(troop, center.gx - 5.5, center.gy);
    const foeWest = { gx: center.gx - 4.2, gy: center.gy };
    foe.gx = foeWest.gx; foe.gy = foeWest.gy;
    scene.rebuildSpatial();
    const cav0 = troop.aliveMembers()[0];
    assert.equal(scene.battalionDirectCavalry(cav0), null, '新驻点无旧承诺：敌在交还圈内立即接敌');
    // 行为断言（对齐用户对照实测）：3 秒内敌受到实质打击——基线旧承诺压制接敌只回位挨打
    const hp0 = foe.hp;
    const cavHp0 = troop.aliveMembers().reduce((s, c) => s + c.hp, 0);
    run(scene, 3, () => { pinOthers(); foe.gx = foeWest.gx; foe.gy = foeWest.gy; });
    assert.ok(foe.hp < hp0 - 30, `3 秒内敌受到实质打击（${Math.round(hp0 - foe.hp)} 伤害；基线旧承诺下敌保持不动）`);
    assert.ok(troop.aliveMembers().reduce((s, c) => s + c.hp, 0) < cavHp0 + 1e-9, '接敌是双向交火（骑兵也承伤，非单方面挨打后仍不还手）');
});
