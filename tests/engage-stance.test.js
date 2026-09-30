// 接敌姿态（纯表现层）回归：出手 → 收势 → 持械戒备 → 蓄势 的姿态串场。
// 铁律：
//   1) 真实攻击仍是出手/音效的唯一触发——纯渲染帧推进不得调用 playAttackAnim/meleeImpact/伤害；
//   2) 移动/失去目标/目标倒下/溃逃/战斗结束后姿态立即退出，无状态残留；
//   3) 枪墙与守阵单位脚底稳定（阴影不随姿态漂移），朝向守卫纪律优先。
import test from 'node:test';
import assert from 'node:assert/strict';
import { IsoBattleScene, makeScene, addUnit } from './battle-harness.js';

function stanceScene(type = 'pikeman', { foeDX = 0.9, foeDY = 0 } = {}) {
    const scene = makeScene();
    scene.playAttackAnim = IsoBattleScene.prototype.playAttackAnim;
    scene.hpGfx = scene.arrowGfx;
    const unit = addUnit(scene, 'red', type);
    unit.spr.play = () => {};
    unit.slideOff = 0;
    const foe = addUnit(scene, 'blue', 'infantry', unit.gx + foeDX, unit.gy + foeDY);
    unit.meleeTarget = foe;
    scene.simulationTime = 0;
    return { scene, unit, foe };
}

// 攻击动画锁内的口径：出手后 lastAttack 由模拟写入（此处直接布置现场）
function attacked(scene, unit, at = 0) {
    unit.lastAttack = at;
    scene.simulationTime = at;
    scene.playAttackAnim(unit, unit.meleeTarget);
    scene.syncOne(unit, at);
}

test('出手后进入收势，再进入持械戒备（枪兵冷却长，戒备窗口可观测）', () => {
    const { scene, unit } = stanceScene('pikeman');
    attacked(scene, unit, 0);
    assert.equal(unit.animState, 'attack', '出手期间攻击动画锁生效');

    scene.simulationTime = 400;   // 320ms 攻击锁结束后的收势期（< 320+min(420, 2400*0.18)=752）
    scene.syncOne(unit, 400);
    assert.ok(unit.stancePose.active, '攻击锁结束后应进入接敌姿态');
    assert.equal(unit.stancePose.clip, 'walk', '收势期回落站姿');
    assert.ok(unit.stancePose.breath < 1, '收势期呼吸压低');

    unit.bobPhase = 0;
    scene.simulationTime = 800;   // 戒备期（sin(3.84)<-0.3 → 站姿换势）
    scene.syncOne(unit, 800);
    assert.ok(unit.stancePose.active);
    assert.equal(unit.stancePose.clip, 'walk');

    scene.simulationTime = 1500;  // 戒备期（sin(7.2)>-0.3 → 举械/收枪）
    scene.syncOne(unit, 1500);
    assert.equal(unit.stancePose.clip, 'attack');
    assert.ok(unit.spr.texture.includes('_attack'), '举械戒备显示攻击剪辑起手帧');
    assert.equal(unit.spr.frame, 0, '只持有静态帧，不播放剪辑');
});

test('蓄势：冷却临近终点收定在起手帧；冷却已就绪（受阻待发）同样蓄势', () => {
    const { scene, unit } = stanceScene('pikeman');
    attacked(scene, unit, 0);
    scene.simulationTime = 2000;   // 2400-450=1950 起进入蓄势
    scene.syncOne(unit, 2000);
    assert.ok(unit.stancePose.active);
    assert.equal(unit.stancePose.clip, 'attack');
    assert.equal(unit.stancePose.frame, 0);
    assert.ok(unit.stancePose.breath < 0.5, '蓄势期呼吸压低（收定待发）');

    // 从未出手、冷却一直就绪（枪线受阻等）：保持蓄势而不是发呆
    const fresh = stanceScene('pikeman');
    fresh.unit.lastAttack = -9999;
    fresh.scene.syncOne(fresh.unit, 100);
    assert.ok(fresh.unit.stancePose.active, '冷却就绪的接敌单位应进入姿态');
    assert.equal(fresh.unit.stancePose.clip, 'attack', '冷却就绪即蓄势待发');
});

test('纯渲染帧推进不制造攻击：无 playAttackAnim / 无 meleeImpact / 无伤害', () => {
    const { scene, unit, foe } = stanceScene('infantry');
    attacked(scene, unit, 0);
    let anims = 0, impacts = 0;
    scene.playAttackAnim = () => { anims++; };
    scene.meleeImpact = () => { impacts++; };
    const hp0 = foe.hp;
    // 覆盖整个冷却周期 + 蓄势窗口的纯渲染时间线（含姿态来回切换）
    for (let t = 33; t <= 1600; t += 33) {
        scene.simulationTime = t;
        scene.syncOne(unit, t);
    }
    assert.equal(anims, 0, '表现层不得自造攻击动画');
    assert.equal(impacts, 0, '表现层不得自造命中反馈');
    assert.equal(foe.hp, hp0, '表现层不得造成伤害');
});

test('姿态退出：移动 / 目标倒下 / 目标撤走 / 目标离圈 / 溃逃 / 战斗结束', () => {
    const { scene, unit, foe } = stanceScene('pikeman');
    attacked(scene, unit, 0);
    scene.simulationTime = 800;
    scene.syncOne(unit, 800);
    assert.ok(unit.stancePose.active, '前置：姿态应处于激活');

    unit.moving = true;
    scene.syncOne(unit, 833);
    assert.equal(unit.stancePose.active, false, '开始移动立即退出');
    assert.equal(unit.animState, 'walk', '移动切回行走动画');

    unit.moving = false;
    scene.syncOne(unit, 866);
    assert.ok(unit.stancePose.active, '停止移动且仍在接敌圈，姿态恢复');

    foe.dead = true;
    scene.syncOne(unit, 900);
    assert.equal(unit.stancePose.active, false, '目标倒下立即退出');
    foe.dead = false;

    foe.withdrawn = true;
    scene.syncOne(unit, 933);
    assert.equal(unit.stancePose.active, false, '目标撤离立即退出');
    foe.withdrawn = false;

    foe.gx = unit.gx + 5;
    scene.syncOne(unit, 966);
    assert.equal(unit.stancePose.active, false, '目标脱离接敌圈退出');
    foe.gx = unit.gx + 0.9;

    unit.moraleState = 'routing';
    scene.syncOne(unit, 1000);
    assert.equal(unit.stancePose.active, false, '溃逃不保持接敌姿态');
    unit.moraleState = 'steady';

    scene.battleOver = true;
    scene.syncOne(unit, 1033);
    assert.equal(unit.stancePose.active, false, '战斗结束姿态退场');

    scene.battleOver = false;
    scene.simulationTime = 1100;
    scene.syncOne(unit, 1100);
    assert.ok(unit.stancePose.active, '条件恢复后姿态可重新进入（无残留阻死）');
});

test('接敌朝向：姿态期朝向目标，近竖直方向保留原面（防闪烁口径沿用）', () => {
    const { scene, unit, foe } = stanceScene('infantry');
    attacked(scene, unit, 0);
    scene.simulationTime = 800;
    scene.syncOne(unit, 800);
    assert.equal(unit.spr.flipX, false, '目标在右侧（dx>dy）保持原图面');

    foe.gx = unit.gx - 0.9;   // 目标换到左侧
    scene.syncOne(unit, 833);
    assert.equal(unit.spr.flipX, true, '目标在左侧翻面');

    foe.gx = unit.gx - 0.45;  // 近竖直方向（dx≈dy）
    foe.gy = unit.gy - 0.45;
    scene.syncOne(unit, 866);
    assert.equal(unit.spr.flipX, true, '近竖直方向保留原面不翻转');
});

test('守阵枪兵：姿态期间维持守卫朝向纪律，持枪静态戒备不摇摆', () => {
    const scene = makeScene();
    scene.playAttackAnim = IsoBattleScene.prototype.playAttackAnim;
    scene.hpGfx = scene.arrowGfx;
    const guard = addUnit(scene, 'red', 'pikeman');
    guard.spr.play = () => {};
    guard.slideOff = 0;
    guard.tacticalRole = 'guard';
    guard.guardFacingX = -1; guard.guardFacingY = 0;
    const foe = addUnit(scene, 'blue', 'infantry', guard.gx + 0.9, guard.gy);   // 敌在背后（守卫面朝 -x）
    guard.target = foe;
    guard.lastAttack = 0;
    scene.simulationTime = 800;
    scene.syncOne(guard, 800);
    assert.ok(guard.stancePose.active, '守阵单位接敌同样进入姿态');
    assert.equal(guard.stancePose.clip, 'attack', '守阵/枪墙静态持枪戒备');
    assert.equal(guard.spr.flipX, true, '守卫朝向纪律优先，不为背后敌人翻面');
});

test('普通枪墙（braceHold）：架枪朝向优先于目标朝向，画面不背离模拟枪口（P2 回归）', () => {
    const { scene, unit, foe } = stanceScene('pikeman');
    unit.lastAttack = 0;
    unit.braceHold = true;
    unit.braceSupport = 2;
    unit.braceFacingX = 1; unit.braceFacingY = 0;      // 模拟侧：枪口朝 +x（reviewer 复现现场）
    foe.gx = unit.gx - 0.9;                            // 粘滞目标在另一侧
    scene.simulationTime = 800;
    scene.syncOne(unit, 800);
    assert.ok(unit.stancePose.active, '架枪单位接敌同样进入姿态');
    assert.equal(unit.stancePose.clip, 'attack', '枪墙静态持枪');
    assert.equal(unit.faceDir, 1, '画面朝向保持架枪方向 +x');
    assert.equal(unit.spr.flipX, false, '不得为另一侧的目标翻面背离枪口');

    // 出手仍按既有口径朝向实际目标（攻击朝向锁不被架枪朝向覆盖）
    scene.simulationTime = 900;
    scene.playAttackAnim(unit, foe);
    assert.equal(unit.spr.flipX, true, '真实出手仍朝向目标');
    scene.simulationTime = 1300;
    scene.syncOne(unit, 1300);
    assert.equal(unit.spr.flipX, false, '出手结束回到架枪朝向，无状态残留');

    // 解除架枪后恢复正常接敌朝向（朝目标）
    unit.braceHold = false;
    scene.simulationTime = 1500;
    scene.syncOne(unit, 1500);
    assert.equal(unit.spr.flipX, true, '解除架枪后接敌姿态朝向目标');
});

test('脚底稳定：姿态换帧不带动阴影与碰撞位置（枪墙观感纪律）', () => {
    const { scene, unit } = stanceScene('pikeman');
    attacked(scene, unit, 0);
    unit.bobPhase = 0;
    scene.simulationTime = 800;   // 站姿换势
    scene.syncOne(unit, 800);
    const shadow = { x: unit.shadow.x, y: unit.shadow.y };
    const baseX = unit.spr.x, baseY = unit.spr.y;
    const lunge = { ...unit.lunge };
    scene.simulationTime = 1500;  // 举械换势
    scene.syncOne(unit, 1500);
    assert.equal(unit.stancePose.clip, 'attack', '前置：姿态发生了换帧');
    assert.equal(unit.shadow.x, shadow.x, '阴影不随姿态动作漂移');
    assert.equal(unit.shadow.y, shadow.y, '阴影不随姿态动作漂移');
    // 精灵横向只允许逐帧对齐补正量级的偏移（枪兵 attack 帧0 对齐 +1px）
    assert.ok(Math.abs(unit.spr.x - baseX) <= 4, `姿态换帧精灵横向偏移应在逐帧对齐量级，实际 ${unit.spr.x - baseX}`);
    assert.ok(Math.abs(unit.spr.y - baseY) <= 4, `姿态换帧精灵纵向不应位移，实际 ${unit.spr.y - baseY}`);
    assert.deepEqual(unit.lunge, lunge, '姿态不产生打击位移');
});
