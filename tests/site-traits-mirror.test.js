// 换座镜像门（领土模式）：把上一轮的 mirror 脚本缺口补上。
// 现有 debug-cav-mirror / debug-seat-mirror 跑的是非领土战场，shallowSpeedFor 直接短路，
// 因此它们看不到据点特色与民夫自卫。本文件用领土局（六类特色全部激活）做逐单位镜像比对：
// 场景 B 与 A 同坐标但旗子归属左右互换，于是 A 的红方 ↔ B 的蓝方 是镜像配对。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { TERRITORY } from '../js/battle/economy.js';
import { traitState, SITE_TRAITS } from '../js/battle/site-traits.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { HEALING_RULES } from '../js/battle/healing.js';

setBoardSize(TERRITORY.W, TERRITORY.H);
test.after(() => resetBoardSize());

const STEP = 1000 / 60;
const mirrorTeam = team => (team === 'red' ? 'blue' : 'red');
// 山河北西↔东南：据点名的镜像对照（中央高地自对称）。
const mirrorName = name => name.startsWith('西') ? '东' + name.slice(1)
    : name.startsWith('东') ? '西' + name.slice(1) : name;

// 换座镜像：同一支军队分别坐在红/蓝两侧，坐标与据点角色整体镜像。
// A 局红方坐西侧、拿西侧据点；B 局蓝方坐东侧、拿东侧同名据点——两边是同一个故事。
function seatScene() {
    const scene = makeScene();
    scene.deployUnits({ infantry: 6, archer: 4, worker: 2 }, { infantry: 6, archer: 4, worker: 2 },
        'custom', 'custom', {}, { territory: true, terrain: 'territory', territoryAI: false });
    scene.battleStarted = true;
    traitState(scene).refresh();
    return scene;
}

function stage(scene, team) {
    const camps = scene.territory.camps;
    const foe = team === 'red' ? 'blue' : 'red';
    const side = name => team === 'red' ? name : name.replace('西', '东');
    // 换座镜像的 x 变换：同一逻辑位置在红侧是 gx，在蓝侧是 board.W - gx。
    const mirX = gx => team === 'red' ? gx : board.W - gx;
    scene.territory.econ.treasury[team] = 5000;
    scene.territory.econ.treasury[foe] = 5000;
    const site = name => scene.flags.findIndex(f => f.name === side(name));
    const forest = site('西林口'), bridge = site('西桥头'), ford = site('西渡口'), crossroad = site('西南路口');
    const hill = scene.flags.findIndex(f => f.role === 'hill');
    const ranch = site('西马场');          // 换座后是东马场：同类据点必须落在镜像侧
    for (const index of [forest, bridge, ford, crossroad, hill, ranch]) scene.flags[index].owner = team;
    traitState(scene).refresh();

    // ① 林口施工中的民夫 ② 浅滩行军的步兵 ③ 对面的敌兵 ④ 高地驻守营
    // ⑤ 撤往路口的溃兵 ⑥ 塔上驻军 ⑦ 贴身互殴（民夫自卫）
    const worker = addUnit(scene, team, 'worker', mirX(40), 40);
    camps.createBuilding(team, 'camp', forest, true);
    const underConstruction = camps.createBuilding(team, 'tower', forest, false);
    worker.workerTask = { kind: 'build', buildingId: underConstruction.id };
    underConstruction.workerId = worker.id;
    Object.assign(worker, { gx: underConstruction.gx, gy: underConstruction.gy, pgx: underConstruction.gx, pgy: underConstruction.gy });
    addUnit(scene, team, 'infantry', mirX(board.W / 2 + 4), Math.round(board.H * 0.378) - 1);
    addUnit(scene, foe, 'infantry', mirX(board.W / 2 - 4), Math.round(board.H * 0.378) + 1);
    const held = addUnit(scene, team, 'infantry', scene.flags[hill].gx, scene.flags[hill].gy);
    held.battalion = { orderPoint: { gx: scene.flags[hill].gx, gy: scene.flags[hill].gy } };
    const routed = addUnit(scene, team, 'archer',
        scene.flags[crossroad].gx + 0.3 * (team === 'red' ? 1 : -1), scene.flags[crossroad].gy);
    routed.moraleState = 'routing'; routed.morale = 12; routed.hp = 20; routed.routStartedAt = 0;
    routed.healSiteId = crossroad;
    const tower = camps.createBuilding(team, 'tower', bridge, true);
    const archer = addUnit(scene, team, 'archer', tower.gx + 0.5 * (team === 'red' ? 1 : -1), tower.gy);
    archer.garrisonTowerId = tower.id; tower.garrisonIds.push(archer.id);
    const brawler = addUnit(scene, team, 'worker', mirX(60), 60);
    addUnit(scene, foe, 'infantry', mirX(60.7), 60);
    scene.rebuildSpatial();
    return { tower, brawler, underConstruction, worker, hill, crossroad, routed, held };
}

function advance(scene, steps) {
    for (let i = 0; i < steps; i++) {
        scene.simulationTime += STEP;
        scene.stepBattle(STEP / 1000);
    }
}

const near = (a, b, eps, message) => assert.ok(Math.abs(a - b) <= eps, `${message}: ${a} vs ${b}`);

function compareUnits(a, b, label) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const x = a[i], y = b[i];
        assert.equal(x.type, y.type, `${label} #${i} 兵种一致`);
        near(x.gx + y.gx, board.W, 1e-9, `${label} #${i} x 镜像`);
        near(x.gy, y.gy, 1e-9, `${label} #${i} y 相同`);
        near(x.hp, y.hp, 1e-9, `${label} #${i} 生命`);
        near(x.morale ?? 100, y.morale ?? 100, 1e-9, `${label} #${i} 士气`);
        assert.equal(x.moraleState, y.moraleState, `${label} #${i} 士气状态`);
        assert.equal(x.dead, y.dead, `${label} #${i} 存活`);
        assert.equal(x.workerTask?.kind ?? null, y.workerTask?.kind ?? null, `${label} #${i} 民夫任务`);
    }
}

test('领土换座镜像：六类特色 + 民夫自卫下场逐单位一致（2400 步）', () => {
    const a = seatScene(), b = seatScene();
    // A：红方坐西；B：蓝方坐东（同名据点的镜像侧）。
    const stagedA = stage(a, 'red'), stagedB = stage(b, 'blue');
    // 镜像配对：A 的红方 ↔ B 的蓝方；B 的镜像局长在老位置上。
    const redA = () => a.units.filter(u => u.team === 'red');
    const blueB = () => b.units.filter(u => u.team === 'blue');
    const blueA = () => a.units.filter(u => u.team === 'blue');
    const redB = () => b.units.filter(u => u.team === 'red');
    assert.equal(redA().length, blueB().length, '红/蓝配对兵力一致');
    compareUnits(redA(), blueB(), '开局红');
    compareUnits(blueA(), redB(), '开局蓝');
    // 特色在同一逻辑位置对同一角色生效：A 的红方与 B 的蓝方拿到同一份奖励
    assert.equal(a.flags.find(f => f.name === '西渡口').owner, 'red');
    assert.equal(b.flags.find(f => f.name === '东渡口').owner, 'blue');
    assert.equal(SITE_TRAITS.ford.shallowSpeed, 0.85);

    for (let block = 0; block < 24; block++) {
        advance(a, 100); advance(b, 100);
        compareUnits(redA(), blueB(), `第 ${(block + 1) * 100} 步红`);
        compareUnits(blueA(), redB(), `第 ${(block + 1) * 100} 步蓝`);
        for (let i = 0; i < a.flags.length; i++) {
            const j = b.flags.findIndex(f => f.name === mirrorName(a.flags[i].name));
            assert.ok(j >= 0, `镜像据点 ${mirrorName(a.flags[i].name)} 存在`);
            assert.equal(a.flags[i].owner === null ? null : mirrorTeam(a.flags[i].owner), b.flags[j].owner,
                `第 ${(block + 1) * 100} 步旗 ${a.flags[i].name}↔${b.flags[j].name} 归属镜像`);
            near(a.flags[i].progress, -b.flags[j].progress, 1e-6, `旗 ${a.flags[i].name} 进度相反数`);
        }
    }
    // 建筑状态（施工进度、驻军、血量）同样成对：按"镜像队伍 + 镜像据点"找回对面那座。
    const mirrorSiteIndex = index => index === 'home' ? 'home'
        : b.flags.findIndex(f => f.name === mirrorName(a.flags[index].name));
    for (const key of Object.keys(a.territory.camps.byId)) {
        const ba = a.territory.camps.getBuilding(key);
        if (!ba) continue;
        const mirroredKey = `${ba.type}:${mirrorTeam(ba.team)}:${mirrorSiteIndex(ba.siteId)}`;
        const bb = b.territory.camps.getBuilding(mirroredKey);
        assert.ok(bb, `镜像建筑 ${mirroredKey} 存在`);
        near(ba.progress, bb.progress, 1e-9, `建筑 ${key} 进度`);
        near(ba.hp, bb.hp, 1e-9, `建筑 ${key} 血量`);
        assert.equal(ba.paused, bb.paused, `建筑 ${key} 停工状态`);
        assert.equal(ba.garrisonIds.length, bb.garrisonIds.length, `建筑 ${key} 驻军数`);
    }
    // 局面必须真的推进过（否则镜像断言是空转）
    const built = a.territory.camps.getBuilding(stagedA.underConstruction.id);
    assert.ok(built.progress > 0, '林口施工真的在推进');
    assert.ok(stagedA.brawler.workerEngageAt != null, '民夫自卫真的触发过');
    assert.ok(stagedB.brawler.workerEngageAt != null, '镜像侧同样触发');
    assert.equal(CAMP_RULES.tower.hp > 0 && HEALING_RULES.BASE_CAPACITY === 8, true);
});
