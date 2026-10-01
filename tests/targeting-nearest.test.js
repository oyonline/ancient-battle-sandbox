import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleSpatialIndex } from '../js/battle/spatial.js';
import { nearestEnemy } from '../js/battle/targeting.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';

const unit = (id, team, gx, gy, extra = {}) => ({ id, team, gx, gy, type: 'infantry', ...extra });
const brute = (units, u) => units.filter(e => e.team !== u.team && !e.dead && !e.withdrawn && !e.garrisonTowerId && e.type !== 'wagon')
    .sort((a, b) => ((a.gx - u.gx) ** 2 + (a.gy - u.gy) ** 2) - ((b.gx - u.gx) ** 2 + (b.gy - u.gy) ** 2) || a.id - b.id)[0] ?? null;

test('远敌索敌为精确最近且最多查询三个局部圈，不扫大图空桶', () => {
    setBoardSize(260, 180);
    const u = unit(1, 'red', 14, 90), far = unit(2, 'blue', 244, 90), closer = unit(3, 'blue', 240, 91);
    const index = new BattleSpatialIndex(); index.rebuild([u, far, closer]);
    let queries = 0;
    const visit = index.forEachNear.bind(index);
    index.forEachNear = (...args) => { queries++; return visit(...args); };
    assert.equal(nearestEnemy(index, u), closer);
    assert.equal(queries, 3);
    resetBoardSize();
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
    const units = Array.from({ length: 160 }, (_, i) => unit(i + 1, i < 80 ? 'red' : 'blue', i < 80 ? 8 + (i % 17) : 220 + (i % 17), 4 + (i * 31 % 170)));
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
