const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, Terrain, CombatRules } = require('./battle-harness');

const army = { infantry: 36, pikeman: 12, archer: 16, cavalry: 12 };
function deploy(team = 'blue', config = army, cavalry = 'auto') {
    const scene = makeScene();
    scene.deployUnits(config, config, 'custom', 'custom', { [team]: 'hold_ground' }, {
        terrain: `${team}_pass`, cavalryOrders: { [team]: cavalry }
    });
    return scene;
}
const dist = (a, b) => Math.hypot(a.gx - b.gx, a.gy - b.gy);

test('natural-slope defenders form one broad contiguous front with ridge archers and spaced cavalry wings', () => {
    const scene = deploy(), layout = Terrain.defenseLayout('blue_pass', 'blue');
    const defenders = scene.units.filter(u => u.team === 'blue');
    const front = defenders.filter(u => ['infantry', 'pikeman'].includes(u.type));
    const firstRow = front.filter(u => Math.abs(u.gx - layout.frontLine.gx) < 1e-9).sort((a, b) => a.gy - b.gy);
    assert.equal(firstRow.length, 24);
    assert.ok(firstRow.at(-1).gy - firstRow[0].gy > 19);
    for (let i = 1; i < firstRow.length; i++) assert.ok(Math.abs(firstRow[i].gy - firstRow[i - 1].gy - 0.86) < 1e-9);
    assert.equal(new Set(front.map(u => u.gx)).size, 2);
    for (const archer of defenders.filter(u => u.type === 'archer')) {
        assert.ok(Terrain.height('blue_pass', archer.gx, archer.gy) > 3.8);
        assert.ok(archer.gx >= layout.archerRect.x1 && archer.gx <= layout.archerRect.x2);
    }
    for (const cavalry of defenders.filter(u => u.type === 'cavalry')) assert.equal(cavalry.protectArchers, true);
    for (const unit of defenders) assert.ok(Terrain.walkable('blue_pass', unit.gx, unit.gy));
    for (let i = 0; i < scene.units.length; i++) for (let j = i + 1; j < scene.units.length; j++) {
        assert.ok(dist(scene.units[i], scene.units[j]) >= CombatRules.contactDistance(scene.units[i], scene.units[j]) - 1e-9);
    }
});

test('pass deployment mirrors and large armies spill to legal non-overlapping rear cells', () => {
    const large = { infantry: 300, pikeman: 60, archer: 80, cavalry: 60 };
    const red = deploy('red', large), blue = deploy('blue', large);
    const left = red.units.filter(u => u.team === 'red'), right = blue.units.filter(u => u.team === 'blue');
    for (let i = 0; i < left.length; i++) {
        assert.ok(Math.abs(left[i].gx + right[i].gx - 70) < 1e-9);
        assert.ok(Math.abs(left[i].gy - right[i].gy) < 1e-9);
        assert.ok(Terrain.walkable('red_pass', left[i].gx, left[i].gy));
        for (let j = i + 1; j < left.length; j++) assert.ok(dist(left[i], left[j]) >= 0.72 - 1e-9);
    }
    assert.ok(right.some(u => u.gx > 60), 'overflow uses the rear instead of stacking on the platform or wall');
});

test('auto guard cavalry reacts to threatened surviving archers beyond its ordinary local post', () => {
    const scene = deploy(), cavalry = scene.units.find(u => u.team === 'blue' && u.type === 'cavalry');
    const archer = scene.units.find(u => u.team === 'blue' && u.type === 'archer');
    const enemy = scene.units.find(u => u.team === 'red');
    Object.assign(archer, { gx: 57, gy: 35 });
    Object.assign(enemy, { gx: 56, gy: 35 });
    assert.ok(dist(cavalry.guardAnchor, enemy) > cavalry.guardLocalRadius);
    scene.rebuildSpatial();
    assert.equal(scene.tactics.groundThreat(cavalry), enemy);
    for (const unit of scene.units) if (unit.team === 'blue' && unit.type === 'archer') unit.dead = true;
    assert.equal(scene.tactics.groundThreat(cavalry), null, 'dead archer clusters cannot keep requesting protection');
    assert.equal(scene.tactics.isGroundGuard(cavalry), true);
    scene.battleOptions.cavalryOrders.blue = 'flank_archers';
    assert.equal(scene.tactics.isGroundGuard(cavalry), false);
    assert.equal(scene.tactics.isGroundGuard(scene.units.find(u => u.team === 'blue' && u.type === 'infantry')), true);
});

test('pass support is bounded, returns to post after threats leave, and is absent on legacy hills', () => {
    const scene = deploy(), cavalry = scene.units.find(u => u.team === 'blue' && u.type === 'cavalry');
    for (const unit of scene.units) if (unit.team === 'red') { unit.gx = 10; unit.gy = 35; }
    cavalry.gx = cavalry.guardAnchor.gx - 2;
    scene.rebuildSpatial(); scene.planningStep = true;
    assert.equal(scene.tactics.updateGroundGuard(cavalry, 2000, 1 / 60), true);
    assert.equal(cavalry.groundGuardReturning, true);
    assert.ok(cavalry.moveX > 0);
    scene.planningStep = false;
    scene.deployUnits(army, army, 'custom', 'custom', { blue: 'hold_ground' }, { terrain: 'blue_hill' });
    assert.ok(scene.units.filter(u => u.type === 'cavalry').every(u => !u.protectArchers));
});

test('legacy 150-pike hold formations retain their rigid slots on unobstructed natural slopes', () => {
    const scenes = ['red', 'blue'].map(team => {
        const scene = makeScene();
        scene.deployUnits({ pikeman: 150 }, { pikeman: 150 }, 'custom', 'custom', { [team]: 'hold' }, { terrain: `${team}_pass` });
        const formation = scene.tactics.formations[team];
        assert.ok(formation);
        assert.equal(formation.cx, team === 'red' ? 22 : 48, 'the natural slope does not invent an invisible wall');
        for (const slot of formation.slots) {
            if (!slot.unit) continue;
            assert.ok(Terrain.walkable(`${team}_pass`, slot.gx, slot.gy));
            assert.equal(slot.unit.gx, slot.gx);
            assert.equal(slot.unit.gy, slot.gy);
            assert.ok(Math.abs(slot.gx - formation.cx) <= formation.half + 1e-9);
        }
        for (let i = 0; i < scene.units.length; i++) for (let j = i + 1; j < scene.units.length; j++) {
            assert.ok(dist(scene.units[i], scene.units[j]) >= 0.72 - 1e-9);
        }
        return formation;
    });
    assert.ok(Math.abs(scenes[0].cx + scenes[1].cx - 70) < 1e-9);
    scenes[0].members.forEach((unit, index) => {
        assert.ok(Math.abs(unit.gx + scenes[1].members[index].gx - 70) < 1e-9);
        assert.equal(unit.gy, scenes[1].members[index].gy);
    });
});

test('mixed armies using the old pike hold order have no wall births or overlaps on new maps', () => {
    for (const terrain of ['blue_pass', 'red_pass', 'river']) {
        const scene = makeScene(), large = { infantry: 150, pikeman: 150, archer: 100, cavalry: 100 };
        scene.deployUnits(large, large, 'custom', 'custom', { red: 'hold', blue: 'hold' }, { terrain });
        for (const unit of scene.units) assert.ok(Terrain.walkable(terrain, unit.gx, unit.gy));
        for (let i = 0; i < scene.units.length; i++) for (let j = i + 1; j < scene.units.length; j++) {
            assert.ok(dist(scene.units[i], scene.units[j]) >= 0.72 - 1e-9, terrain + ' overlaps');
        }
    }
});
