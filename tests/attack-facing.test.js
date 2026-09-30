// 攻击朝向回归：普通剑士/枪兵/弓手出手时朝向实际目标，攻击期间保持稳定；
// 骑兵八向、守卫枪向逻辑不变（守卫用例见 guard-visuals.test.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { IsoBattleScene, makeScene, addUnit } from './battle-harness.js';

function footScene(type) {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', type);
    unit.spr.play = () => {};
    scene.playAttackAnim = IsoBattleScene.prototype.playAttackAnim;
    return { scene, unit };
}

test('普通单位出手朝向实际目标：右侧目标不翻面、左侧目标翻面', () => {
    for (const type of ['infantry', 'pikeman', 'archer']) {
        const { scene, unit } = footScene(type);
        scene.playAttackAnim(unit, { gx: unit.gx + 1, gy: unit.gy });
        assert.equal(unit.spr.flipX, false, `${type} 攻击 +x 目标应保持原图面`);
        assert.equal(unit.faceDir, 1);
        scene.playAttackAnim(unit, { gx: unit.gx - 1, gy: unit.gy });
        assert.equal(unit.spr.flipX, true, `${type} 攻击 -x 目标应翻面`);
        assert.equal(unit.faceDir, -1);
        // +y 与 -y 方向（等距投影中的另外两条斜向）也各有确定朝向
        scene.playAttackAnim(unit, { gx: unit.gx, gy: unit.gy - 1 });
        assert.equal(unit.spr.flipX, false, `${type} 攻击 -y 目标（屏幕右向）应保持原图面`);
        scene.playAttackAnim(unit, { gx: unit.gx, gy: unit.gy + 1 });
        assert.equal(unit.spr.flipX, true, `${type} 攻击 +y 目标（屏幕左向）应翻面`);
    }
});

test('近竖直方向不翻面（素材只有左右两面，避免闪烁）', () => {
    const { scene, unit } = footScene('infantry');
    scene.playAttackAnim(unit, { gx: unit.gx - 1, gy: unit.gy });
    assert.equal(unit.spr.flipX, true);
    // 屏幕近竖直方向（dgx≈dgy）保留当前面
    scene.playAttackAnim(unit, { gx: unit.gx + 1, gy: unit.gy + 1 });
    assert.equal(unit.spr.flipX, true, '近竖直出手方向应保留原面，不翻转');
});

test('攻击期间朝向锁定：出手后行走翻面逻辑不覆盖攻击朝向', () => {
    const { scene, unit } = footScene('infantry');
    scene.simulationTime = 100;
    scene.playAttackAnim(unit, { gx: unit.gx - 1, gy: unit.gy });
    assert.equal(unit.spr.flipX, true);
    // 攻击锁内制造"应向右"的位移输入，不得翻回
    const planarX = unit.lastSX;
    unit.lastSX = planarX - 5;   // 下一帧 sdx = +5，若无攻击门会翻回 false
    scene.syncOne(unit, 100);
    assert.equal(unit.spr.flipX, true, '攻击锁期间行走翻面不得覆盖攻击朝向');
    // 锁过期后恢复行走朝向（重新制造向右位移输入）
    scene.simulationTime = 500;
    unit.lastSX = planarX - 5;
    scene.syncOne(unit, 500);
    assert.equal(unit.spr.flipX, false, '攻击锁过期后按行走方向正常翻面');
});
