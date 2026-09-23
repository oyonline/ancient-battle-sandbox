const test = require('node:test');
const assert = require('node:assert/strict');
const { IsoBattleScene, makeScene, addUnit } = require('./battle-harness');

function guardScene() {
    const scene = makeScene();
    const guard = addUnit(scene, 'blue', 'pikeman');
    guard.tacticalRole = 'guard';
    guard.guardFacingX = -1;
    guard.guardFacingY = 0;
    guard.spr.play = () => {};
    scene.hpGfx = scene.arrowGfx;
    scene.playAttackAnim = IsoBattleScene.prototype.playAttackAnim;
    return { scene, guard };
}

test('a stationary guard visibly follows its spear facing without requiring displacement', () => {
    const { scene, guard } = guardScene();
    scene.syncOne(guard, 0);
    assert.equal(guard.spr.flipX, true);
    guard.guardFacingX = 0;
    guard.guardFacingY = -1;
    scene.syncOne(guard, 50);
    assert.equal(guard.spr.flipX, false);
    assert.equal(guard.shadow.scaleX, 1);
    assert.equal(guard.moving, false);
});

test('guard attack faces the actual target and stays locked until the attack ends', () => {
    const { scene, guard } = guardScene();
    scene.playAttackAnim(guard, { gx: guard.gx + 1, gy: guard.gy });
    assert.equal(guard.spr.flipX, false);
    scene.syncOne(guard, 100);
    assert.equal(guard.spr.flipX, false, 'the opposite spear facing cannot flip an active attack');
    scene.simulationTime = 321;
    scene.syncOne(guard, 321);
    assert.equal(guard.spr.flipX, true);
    assert.equal(guard.shadow.scaleX, -1);
});

test('near-vertical spear headings keep the previous sprite side; routing faces retreat motion', () => {
    const { scene, guard } = guardScene();
    scene.syncOne(guard, 0);
    guard.guardFacingX = 0.71;
    guard.guardFacingY = 0.70;
    scene.syncOne(guard, 50);
    assert.equal(guard.spr.flipX, true);
    guard.guardFacingX = -1;
    guard.guardFacingY = 0;
    guard.moraleState = 'routing';
    guard.gx += 1;
    guard.moving = true;
    scene.syncOne(guard, 100);
    assert.equal(guard.spr.flipX, false, 'retreat motion must override the abandoned guard facing');
});
