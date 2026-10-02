import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSpatialIndex } from '../js/battle/spatial.js';
import { nearestEnemy } from '../js/battle/targeting.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { ReferenceSpatialIndex, referenceNearestEnemy } from './targeting-reference.js';

const unit = (id, team, gx, gy, extra = {}) => ({ id, team, gx, gy, type: 'infantry', ...extra });
const brute = (units, u) => units.filter(e => e.team !== u.team && !e.dead && !e.withdrawn && !e.garrisonTowerId && e.type !== 'wagon')
    .sort((a, b) => ((a.gx - u.gx) ** 2 + (a.gy - u.gy) ** 2) - ((b.gx - u.gx) ** 2 + (b.gy - u.gy) ** 2) || a.id - b.id)[0] ?? null;

test('远敌索敌为精确最近，局部圈与敌军桶范围不相交时不读空桶', () => {
    setBoardSize(260, 180);
    const u = unit(1, 'red', 14, 90), far = unit(2, 'blue', 244, 90), closer = unit(3, 'blue', 240, 91);
    const index = new BattleSpatialIndex(); index.rebuild([u, far, closer]);
    let bucketReads = 0;
    const get = index.grid.get.bind(index.grid);
    index.grid.get = key => { bucketReads++; return get(key); };
    assert.equal(nearestEnemy(index, u), closer);
    assert.equal(bucketReads, 0);
    resetBoardSize();
});

function oracleCheck(units, queries = units) {
    const index = new BattleSpatialIndex(), reference = new ReferenceSpatialIndex();
    index.rebuild(units); reference.rebuild(units);
    for (const u of queries) {
        assert.equal(nearestEnemy(index, u), referenceNearestEnemy(reference, u), `unit ${u.id}`);
    }
    return { index, reference };
}

test('固定种子随机混兵、空军阵、量化边界和三阵营逐目标与旧算法一致', () => {
    setBoardSize(260, 180);
    let seed = 0x81c52;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const scene = { planningStep: true };
    try {
        for (let run = 0; run < 80; run++) {
            const units = Array.from({ length: run * 7 % 180 }, (_, i) => unit(i + 1,
                ['red', 'blue', 'neutral'][Math.floor(random() * 3)],
                Math.floor(random() * 87) * 3 + (i % 2 ? 0.024999999 : -0.025000001), random() * 180, {
                    scene, type: i % 11 === 0 ? 'wagon' : i % 4 === 0 ? 'cavalry' : 'infantry',
                    dead: i % 13 === 0, withdrawn: i % 17 === 0,
                    garrisonTowerId: i % 19 === 0 ? 'tower' : null,
                    moraleState: i % 7 === 0 ? 'routing' : 'steady'
                }));
            oracleCheck(units);
        }
    } finally { resetBoardSize(); }
});

test('远场分块不重排容差内的距离链，routing 敌军仍可被追击', () => {
    const scene = { planningStep: true }, u = unit(1000, 'red', 1, 90, { scene });
    const units = Array.from({ length: 64 }, (_, i) => unit(100 + i, 'blue', 250, i + 20, { scene }));
    units[0] = unit(30, 'blue', 200, 90, { scene });
    units[31] = unit(20, 'blue', 200, 90 + Math.sqrt(7e-10), { scene });
    units[63] = unit(10, 'blue', 200, 90 + Math.sqrt(1.4e-9), { scene, moraleState: 'routing' });
    const { index } = oracleCheck([u, ...units], [u]);
    assert.equal(nearestEnemy(index, u).id, 10, '旧容差链按原遍历顺序继续以较小 id 决胜');
});

test('活体状态实时过滤、驻军成员资格及非规划时移动保持旧索引语义', () => {
    const scene = { planningStep: true }, u = unit(1, 'red', 1, 40, { scene });
    const a = unit(2, 'blue', 100, 40), b = unit(3, 'blue', 170, 40), c = unit(4, 'blue', 200, 40);
    const { index, reference } = oracleCheck([u, a, b, c], [u]);
    const check = () => assert.equal(nearestEnemy(index, u), referenceNearestEnemy(reference, u));
    a.dead = true; check();
    b.garrisonTowerId = 'tower'; check();
    c.withdrawn = true; check();
    assert.equal(nearestEnemy(index, u), null);
    scene.planningStep = false;
    c.withdrawn = false; c.gx = 2; check(); // 旧桶仍在远处，原回退读实时坐标
    assert.equal(nearestEnemy(index, u), c);
    c.garrisonTowerId = 'tower';
    index.rebuild([u, c]); reference.rebuild([u, c]);
    c.garrisonTowerId = null; check(); // 远场 alive 扫描允许刚出塔但尚未重建的单位
    c.gx = 150;
    index.rebuild([u, c]); reference.rebuild([u, c]);
    scene.planningStep = true; check();
    index.rebuild([u]); reference.rebuild([u]); check();
    assert.equal(nearestEnemy(index, u), null, '缩短或清空索引不能读到上一轮分组');
});

test('规划开始时箭塔被定时攻击摧毁，刚出塔士兵按实时地面位置重新参与索敌', () => {
    const u = unit(1, 'red', 1, 40, { scene: { planningStep: true } });
    const units = [u, ...Array.from({ length: 15 }, (_, i) => unit(i + 2, 'blue', 100 + i, 40))];
    const crew = unit(30, 'blue', 105, 40, { garrisonTowerId: 'tower' });
    units.push(crew);
    const { index, reference } = oracleCheck(units, [u]);
    crew.garrisonTowerId = null; crew.gx = 99.5;
    assert.equal(nearestEnemy(index, u), referenceNearestEnemy(reference, u));
    assert.equal(nearestEnemy(index, u), crew);
});

test('同距 id 决胜；圆内近敌优先；近圈方形毛边不能误当最近', () => {
    setBoardSize(260, 180);
    const index = new BattleSpatialIndex(), u = unit(1, 'red', 20, 50);
    const diagonal = unit(2, 'blue', 26, 56), trueNear = unit(9, 'blue', 27, 50);
    index.rebuild([u, diagonal, trueNear]);
    assert.equal(nearestEnemy(index, u), trueNear, '首圈扫描到对角毛边时应继续扩圈');
    const highId = unit(30, 'blue', 180, 55), lowId = unit(4, 'blue', 180, 45);
    index.rebuild([u, highId, lowId]);
    assert.equal(nearestEnemy(index, u), lowId);
    resetBoardSize();
});

test('驻军仍在alive但离开地面索敌；车辆与撤离单位也不被选中', () => {
    setBoardSize(260, 180);
    const u = unit(1, 'red', 15, 90), towerCrew = unit(2, 'blue', 100, 90, { garrisonTowerId: 'tower:blue:home' });
    const wagon = unit(3, 'blue', 110, 90, { type: 'wagon' }), exited = unit(4, 'blue', 120, 90, { withdrawn: true });
    const foe = unit(5, 'blue', 240, 90), index = new BattleSpatialIndex();
    index.rebuild([u, towerCrew, wagon, exited, foe]);
    assert.ok(index.alive.includes(towerCrew));
    assert.equal(nearestEnemy(index, u), foe);
    index.rebuild([u, towerCrew, wagon, exited]);
    assert.equal(nearestEnemy(index, u), null);
    resetBoardSize();
});

test('远场索敌与精确全局对照一致，换座镜像选择同一单位 id', () => {
    setBoardSize(260, 180);
    const scene = { planningStep: true };
    const units = Array.from({ length: 160 }, (_, i) => unit(i + 1, i < 80 ? 'red' : 'blue', i < 80 ? 8 + (i % 17) : 220 + (i % 17), 4 + (i * 31 % 170), { scene }));
    const index = new BattleSpatialIndex(); index.rebuild(units);
    const mirrored = units.map(u => ({ ...u, gx: board.W - u.gx, team: u.team === 'red' ? 'blue' : 'red' }));
    const mirrorIndex = new BattleSpatialIndex(); mirrorIndex.rebuild(mirrored);
    for (let i = 0; i < units.length; i++) {
        const picked = nearestEnemy(index, units[i]);
        assert.equal(picked?.id, brute(units, units[i])?.id);
        assert.equal(picked?.id, nearestEnemy(mirrorIndex, mirrored[i])?.id);
    }
    resetBoardSize();
});
