// 归属变化播报的真实口径（Review P2-4 / P2-5 修复）：
//   P2-4 全局奖励（渡口通行 / 马场骑源）按"是否仍拥有任一同类据点"播报，
//        丢一座仍有另一座时说"仍保留"，不能误报"失效/被断"。
//   P2-5 同一据点"失去→收复→再次失去"必须三次都播报；归属持续不变时不刷屏；
//        去重键只含确定性模拟信息（归属变化序数），不用随机数或墙钟。
// 全部走真实 updateFlags 拉旗路径（部队占圈拉进度），不用直接改 owner 伪造变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { makeScene, addUnit } from './battle-harness.js';
import { setBoardSize, resetBoardSize } from '../js/board.js';
import { TERRITORY } from '../js/battle/economy.js';
import { updateFlags } from '../js/battle/territory-bridge.js';
import { shallowSpeedFor, ownsRole } from '../js/battle/site-traits.js';
import { UI } from '../js/ui.js';

setBoardSize(TERRITORY.W, TERRITORY.H);
after(() => resetBoardSize());

const STEP = 1000 / 60;

function eventScene() {
    const scene = makeScene();
    scene.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, territoryAI: false, terrain: 'territory' });
    scene.battleStarted = true;
    return scene;
}

const flagOf = (scene, name) => scene.flags.find(f => f.name === name);

// 在旗圈里放一队拉动方步兵，真实拉进度；达到谓词或步数耗尽即停。
function pull(scene, flag, team, done, maxSteps = 400) {
    for (let i = 0; i < 6; i++) {
        addUnit(scene, team, 'infantry', flag.gx + (i % 3) * 0.3, flag.gy + Math.floor(i / 3) * 0.3);
    }
    scene.rebuildSpatial();
    for (let i = 0; i < maxSteps && !done(); i++) {
        scene.simulationTime += STEP;
        updateFlags(scene, STEP / 1000);
    }
}

// 把某方在旗圈附近的部队挪走（避免拉锯双方净占领力归零、或事后继续拉动产生新变化）。
function disperse(scene, flag, team) {
    for (const u of scene.units) {
        if (u.team === team && !u.dead && Math.hypot(u.gx - flag.gx, u.gy - flag.gy) < 6) {
            u.gx = team === 'blue' ? 250 : 10; u.gy = 10;
        }
    }
    scene.rebuildSpatial();
}

test('渡口全局奖励：双点持有→丢一座说"仍保留"且浅滩仍 0.85→丢光才"失效"', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西渡口'), east = flagOf(scene, '东渡口');
    west.owner = 'red'; west.progress = 1;
    east.owner = 'red'; east.progress = 1;
    assert.equal(shallowSpeedFor(scene, 'red'), 0.85, '开局红方持两座渡口');

    // 蓝方夺走西渡口：红方仍持有东渡口 → 通行不能被播成"失效"。
    pull(scene, west, 'blue', () => west.owner === null || west.owner === 'blue');
    assert.equal(west.owner, null, '西渡口被拉过中线');
    assert.equal(shallowSpeedFor(scene, 'red'), 0.85, '仍持有东渡口：浅滩速度不变');
    const westLost = scene.ledger.events.filter(e => e.key.startsWith('trait-lost-西渡口-red-'));
    assert.equal(westLost.length, 1, '丢西渡口播报一次');
    assert.match(westLost[0].text, /仍保留/, '文案说明奖励仍保留');
    assert.doesNotMatch(westLost[0].text, /失效/, '不能误报通行失效');

    // 再丢东渡口：两座皆失 → 才是真正的"通行失效"，浅滩回 0.7。
    pull(scene, east, 'blue', () => east.owner === null);
    assert.equal(shallowSpeedFor(scene, 'red'), 0.7, '渡口丢光：浅滩回到默认');
    assert.equal(ownsRole(scene, 'red', 'ford'), false);
    const eastLost = scene.ledger.events.filter(e => e.key.startsWith('trait-lost-东渡口-red-'));
    assert.equal(eastLost.length, 1);
    assert.match(eastLost[0].text, /失效/, '丢光最后一座：播报失效');

    // 重新获得：红方拉回东渡口 → 播报生效，浅滩回 0.85。
    disperse(scene, east, 'blue');
    disperse(scene, west, 'blue');
    pull(scene, east, 'red', () => east.owner === 'red');
    assert.equal(shallowSpeedFor(scene, 'red'), 0.85, '重新获得渡口');
    const regain = scene.ledger.events.filter(e => e.key.startsWith('trait-东渡口-red-'));
    assert.equal(regain.length, 1, '获得奖励有一次播报');
    assert.match(regain[0].text, /生效/);
});

test('马场易主：对手仍保有马场时不断言其骑源被断', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西马场'), east = flagOf(scene, '东马场');
    west.owner = 'blue'; west.progress = -1;
    east.owner = 'blue'; east.progress = -1;

    // 红方夺西马场：蓝方仍有东马场 → 只能说"仍保有马场"，不能说"骑源被断"。
    pull(scene, west, 'red', () => west.owner === 'red');
    const first = scene.ledger.events.filter(e => e.key.startsWith('ranch-西马场-red-'));
    assert.equal(first.length, 1, '夺马场播报一次');
    assert.match(first[0].text, /骑兵征募开启/);
    assert.match(first[0].text, /蓝方仍保有马场，骑源未断/, '对手仍有一座：不断言骑源被断');
    assert.equal(ownsRole(scene, 'blue', 'ranch'), true, '蓝方确实仍可征募骑兵');

    // 红方再夺东马场：蓝方马场丢光 → 才是"骑源被断"。
    pull(scene, east, 'red', () => east.owner === 'red');
    const second = scene.ledger.events.filter(e => e.key.startsWith('ranch-东马场-red-'));
    assert.equal(second.length, 1);
    assert.match(second[0].text, /蓝方骑源被断/, '丢光后才播报骑源被断');
    assert.equal(ownsRole(scene, 'blue', 'ranch'), false);
});

test('同一据点失去→收复→再次失去：三次变化都播报，状态不变时不刷屏', () => {
    const scene = eventScene();
    const flag = flagOf(scene, '西桥头');
    flag.owner = 'red'; flag.progress = 1;

    pull(scene, flag, 'blue', () => flag.owner === null);
    const firstLoss = scene.ledger.events.filter(e => e.key.startsWith('trait-lost-西桥头-red-'));
    assert.equal(firstLoss.length, 1, '第一次失去播报');
    assert.equal(firstLoss[0].key, 'trait-lost-西桥头-red-1', '去重键含归属变化序数（确定性模拟信息）');
    disperse(scene, flag, 'blue');

    pull(scene, flag, 'red', () => flag.owner === 'red');
    const recapture = scene.ledger.events.filter(e => e.key.startsWith('trait-西桥头-red-'));
    assert.equal(recapture.length, 1, '收复播报占领生效');
    assert.equal(flag.flipCount, 2, '两次归属变化');
    disperse(scene, flag, 'red');

    pull(scene, flag, 'blue', () => flag.owner === null);
    const secondLoss = scene.ledger.events.filter(e => e.key.startsWith('trait-lost-西桥头-red-'));
    assert.equal(secondLoss.length, 2, '再次失去必须再次播报（修复前被整场去重吞掉）');
    assert.equal(secondLoss[1].key, 'trait-lost-西桥头-red-3', '键随归属变化序数递增');
    const flagLost = scene.ledger.events.filter(e => e.key.startsWith('flag-lost-西桥头-red-'));
    assert.equal(flagLost.length, 2, '旗帜失去事件同样两次');

    // 持续处于同一归属状态：不重复播报（去重机制保留）。
    disperse(scene, flag, 'blue');
    const total = scene.ledger.events.length;
    for (let i = 0; i < 120; i++) {
        scene.simulationTime += STEP;
        updateFlags(scene, STEP / 1000);
    }
    assert.equal(scene.ledger.events.length, total, '归属不变不刷屏');
    // 去重标识不含随机数或墙钟：同一键重复入账仍被 ledger 去重。
    scene.addBattleEvent(secondLoss[1].key, '重复事件', 'red');
    assert.equal(scene.ledger.events.length, total, '战报系统的既有去重不被取消');
});

test('战报与 UI 提示一致：每次变化都有 toast，同一变化不重复弹', t => {
    const scene = eventScene();
    const previousDocument = globalThis.document;
    globalThis.document = { getElementById: () => ({ textContent: '', hidden: false, classList: { add() {}, remove() {} } }),
        body: { classList: { add() {}, remove() {} } } };
    t.after(() => { globalThis.document = previousDocument; });
    const toasts = [];
    const ui = { ...UI, scene, phase: 'battle', _seenTerritoryTips: new Set(),
        campControls: { targeting: null }, showNetToast: text => toasts.push(text) };
    const flag = flagOf(scene, '西桥头');
    flag.owner = 'red'; flag.progress = 1;

    pull(scene, flag, 'blue', () => flag.owner === null);
    ui.pollSiteTraitEvents();
    assert.equal(toasts.length, 1, '第一次失去弹一次');
    assert.match(toasts[0], /西桥头.*失效/);
    disperse(scene, flag, 'blue');

    pull(scene, flag, 'red', () => flag.owner === 'red');
    ui.pollSiteTraitEvents();
    assert.equal(toasts.length, 2, '收复（占领生效）弹一次');
    assert.match(toasts[1], /生效/);
    disperse(scene, flag, 'red');

    pull(scene, flag, 'blue', () => flag.owner === null);
    ui.pollSiteTraitEvents();
    assert.equal(toasts.length, 3, '再次失去再次弹出（修复前 UI 再也看不到这次失守）');
    assert.match(toasts[2], /西桥头.*失效/);
    ui.pollSiteTraitEvents();
    ui.pollSiteTraitEvents();
    assert.equal(toasts.length, 3, '没有新事件时不重复弹');
});

test('单步多点归属变化：一次 updateFlags 内两座据点同时易主，各自播报且键不冲突', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西渡口'), bridge = flagOf(scene, '西桥头');
    west.owner = 'red'; west.progress = 0.005;      // 中线之上一点点
    bridge.owner = 'red'; bridge.progress = 0.005;
    pull(scene, west, 'blue', () => true, 1);        // 只为放置部队并推进一步
    // 手动把第二面旗的拉动者也放好，再单步同时拉过中线。
    for (let i = 0; i < 6; i++) {
        addUnit(scene, 'blue', 'infantry', bridge.gx + (i % 3) * 0.3, bridge.gy + Math.floor(i / 3) * 0.3);
    }
    scene.rebuildSpatial();
    scene.simulationTime += STEP;
    updateFlags(scene, STEP / 1000);
    assert.equal(west.owner, null, '西渡口单步易主');
    assert.equal(bridge.owner, null, '西桥头同一步易主');
    const lost = scene.ledger.events.filter(e => e.key.startsWith('trait-lost-'));
    assert.equal(lost.length, 2, '两座据点各有一条播报');
    assert.notEqual(lost[0].key, lost[1].key, '去重键互不冲突');
    for (const event of lost) {
        assert.match(event.key, /-red-1$/, '键含各自的变化序数');
        assert.match(event.text, /红方失去/);
    }
    // 渡口是全局奖励且红方再无渡口 → 失效；桥头是本点奖励 → 失效。
    assert.equal(shallowSpeedFor(scene, 'red'), 0.7);
});

// ==================== 复审剩余问题（第二轮）：同一步多据点易主的全局奖励提示 ====================
// 复现：两座渡口同一次 updateFlags 失守，最终 owners=[null,null]、浅滩 0.7，
// 战报却先说"通行仍保留"（读到中间状态：另一座尚未处理）、再说"通行失效"。
// 修复要求：先完成本步全部归属更新，再按本步最终归属生成全局奖励文案。

// 单步夹具：把若干旗摆到"一步之内必然翻转"的进度上，双方拉动者就位后推进一步。
function stepFlip(scene, setup) {
    for (const { flag, owner, progress } of setup) { flag.owner = owner; flag.progress = progress; }
    scene.ledger.events.length = 0;
    for (const { flag, puller } of setup) {
        if (!puller) continue;
        for (let i = 0; i < 6; i++) {
            addUnit(scene, puller, 'infantry', flag.gx + (i % 3) * 0.3, flag.gy + Math.floor(i / 3) * 0.3);
        }
    }
    scene.rebuildSpatial();
    scene.simulationTime += STEP;
    updateFlags(scene, STEP / 1000);
    return scene.ledger.events;
}

test('同一步两座渡口失守：按最终归属两条都播"失效"，不再先仍保留后失效', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西渡口'), east = flagOf(scene, '东渡口');
    const events = stepFlip(scene, [
        { flag: west, owner: 'red', progress: 0.005, puller: 'blue' },
        { flag: east, owner: 'red', progress: 0.005, puller: 'blue' }
    ]);
    assert.equal(west.owner, null); assert.equal(east.owner, null);
    assert.equal(shallowSpeedFor(scene, 'red'), 0.7, '最终红方无渡口');
    const lost = events.filter(e => e.key.startsWith('trait-lost-'));
    assert.equal(lost.length, 2, '两座各一条播报');
    for (const event of lost) {
        assert.match(event.text, /失效/, '最终无渡口：两条都应是失效（不再读中间状态误报"仍保留"）');
        assert.doesNotMatch(event.text, /仍保留/);
    }
    const flagLost = events.filter(e => e.key.startsWith('flag-lost-'));
    assert.equal(flagLost.length, 2, '旗帜失去事件两条、键不冲突');
    assert.notEqual(flagLost[0].key, flagLost[1].key);
});

test('同一步失一得一：渡口调包后最终仍保留，失去与获得文案都不误报失效', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西渡口'), east = flagOf(scene, '东渡口');
    const events = stepFlip(scene, [
        { flag: west, owner: 'red', progress: 0.005, puller: 'blue' },      // 西渡口失守
        { flag: east, owner: null, progress: 0.999, puller: 'red' }         // 东渡口同一步被红夺取
    ]);
    assert.equal(west.owner, null, '西渡口失去');
    assert.equal(east.owner, 'red', '东渡口同一步易手');
    assert.equal(shallowSpeedFor(scene, 'red'), 0.85, '最终红方仍拥有渡口');
    const westLost = events.find(e => e.key.startsWith('trait-lost-西渡口-red-'));
    assert.ok(westLost, '西渡口失去有播报');
    assert.match(westLost.text, /仍保留/, '按最终归属：红方仍有东渡口，不误报失效');
    const eastGain = events.find(e => e.key.startsWith('trait-东渡口-red-'));
    assert.ok(eastGain, '东渡口获得有播报');
    assert.match(eastGain.text, /生效/);
    assert.ok(!events.some(e => /失效/.test(e.text)), '本步没有任何"失效"误报');
});

test('同一步两座马场变化：对手骑源描述按最终归属（蓝方丢光才"骑源被断"）', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西马场'), east = flagOf(scene, '东马场');
    // 蓝方保有东马场（中线之下一点，即将失去）；西马场中立、红方一步夺取。
    // 最终：红方拥有西马场，蓝方一无所有 → 夺占播报必须是"蓝方骑源被断"。
    const events = stepFlip(scene, [
        { flag: west, owner: null, progress: 0.999, puller: 'red' },
        { flag: east, owner: 'blue', progress: -0.005, puller: 'red' }
    ]);
    assert.equal(west.owner, 'red', '红方夺西马场');
    assert.equal(east.owner, null, '蓝方同一步失去东马场');
    const ranch = events.find(e => e.key.startsWith('ranch-西马场-red-'));
    assert.ok(ranch, '夺马场有播报');
    assert.match(ranch.text, /蓝方骑源被断/, '按最终归属：蓝方同一步丢光，不能再说"仍保有马场"');
    assert.doesNotMatch(ranch.text, /仍保有马场/);
    const eastLost = events.find(e => e.key.startsWith('trait-lost-东马场-blue-'));
    assert.ok(eastLost, '蓝方失去东马场有播报');
    assert.match(eastLost.text, /失效/, '蓝方最终无马场：骑兵征募权失效');
});

test('同一步渡口与桥头同时失守：全局与局部文案各按自己的口径生成', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西渡口'), east = flagOf(scene, '东渡口');
    const bridge = flagOf(scene, '西桥头');
    const events = stepFlip(scene, [
        { flag: west, owner: 'red', progress: 0.005, puller: 'blue' },
        { flag: east, owner: 'blue', progress: -1 },                        // 东渡口一直归蓝，红方最终无渡口
        { flag: bridge, owner: 'red', progress: 0.005, puller: 'blue' }
    ]);
    assert.equal(west.owner, null); assert.equal(bridge.owner, null);
    assert.equal(shallowSpeedFor(scene, 'red'), 0.7);
    const fordLost = events.find(e => e.key.startsWith('trait-lost-西渡口-red-'));
    assert.ok(fordLost);
    assert.match(fordLost.text, /失效/, '渡口（全局）：红方最终无渡口 → 失效');
    const bridgeLost = events.find(e => e.key.startsWith('trait-lost-西桥头-red-'));
    assert.ok(bridgeLost);
    assert.match(bridgeLost.text, /失效/, '桥头（局部）：本点易主 → 失效');
    assert.equal(events.filter(e => e.key.startsWith('flag-lost-')).length, 2);
});

test('同一步变化后再夺再失仍播报、归属不变不刷屏（两阶段重构不破坏既有节奏）', () => {
    const scene = eventScene();
    const west = flagOf(scene, '西渡口');
    west.owner = 'red'; west.progress = 1;
    pull(scene, west, 'blue', () => west.owner === null);
    disperse(scene, west, 'blue');
    pull(scene, west, 'red', () => west.owner === 'red');
    disperse(scene, west, 'red');
    pull(scene, west, 'blue', () => west.owner === null);
    disperse(scene, west, 'blue');
    const lost = scene.ledger.events.filter(e => e.key.startsWith('trait-lost-西渡口-red-'));
    assert.equal(lost.length, 2, '两次失去都播报');
    const gain = scene.ledger.events.filter(e => e.key.startsWith('trait-西渡口-red-'));
    assert.equal(gain.length, 1, '收复播报一次');
    const total = scene.ledger.events.length;
    for (let i = 0; i < 120; i++) { scene.simulationTime += STEP; updateFlags(scene, STEP / 1000); }
    assert.equal(scene.ledger.events.length, total, '归属不变不刷屏');
});
