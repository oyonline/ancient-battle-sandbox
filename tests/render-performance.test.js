import test from 'node:test';
import assert from 'node:assert/strict';
import { OverlayRenderer } from '../js/render/overlay.js';
import { IsoBattleScene, makeScene, addUnit } from './battle-harness.js';

function drawing() {
    const g = { strokes: [], lines: [], clears: 0, textWrites: 0, destroyed: false };
    for (const key of ['setOrigin', 'setDepth', 'lineStyle', 'fillStyle', 'fillCircle', 'fillRect',
        'fillPoints', 'fillEllipse', 'strokeEllipse', 'fillTriangle', 'strokeTriangle', 'beginPath', 'arc', 'strokePath']) g[key] = () => g;
    g.clear = () => { g.clears++; g.strokes = []; g.lines = []; return g; };
    g.strokePoints = points => { g.strokes.push(points); return g; };
    g.lineBetween = (...points) => { g.lines.push(points); return g; };
    g.setText = text => { g.text = text; g.textWrites++; return g; };
    g.setPosition = (x, y) => { g.x = x; g.y = y; return g; };
    g.setScale = scale => { g.scale = scale; return g; };
    g.setVisible = visible => { g.visible = visible; return g; };
    g.setColor = color => { g.color = color; return g; };
    g.destroy = () => { g.destroyed = true; };
    return g;
}

function overlayScene() {
    const objects = [];
    const scene = { simulationTime: 1000, battleId: 1, battleOptions: { terrain: 'flat' },
        cameras: { main: { zoom: 0.4 } }, groundSamples: 0,
        add: { graphics: () => drawing(), text: () => { const label = drawing(); objects.push(label); return label; } },
        groundPoint(gx, gy) { this.groundSamples++; return { x: (gx - gy) * 32, y: (gx + gy) * 16 }; },
        flags: [{ gx: 30, gy: 30, owner: 'red', progress: 1, pulseAt: 1000 }], objects };
    return { scene, renderer: new OverlayRenderer(scene) };
}

test('占旗脉冲持续 1200ms，静态旗圈复用并随地形变化失效', () => {
    const { scene, renderer } = overlayScene();
    renderer.drawFlags();
    const ring = scene.flagGfx.strokes[0];
    assert.equal(scene.flagGfx.strokes.length, 2);
    scene.simulationTime = 1600;
    renderer.drawFlags();
    assert.equal(scene.flagGfx.strokes.length, 2, '600ms 时仍有扩散脉冲');
    assert.equal(scene.flagGfx.strokes[0], ring);
    scene.simulationTime = 2200;
    renderer.drawFlags();
    assert.equal(scene.flagGfx.strokes.length, 1, '1200ms 后脉冲结束');
    const samples = scene.groundSamples;
    for (let i = 0; i < 20; i++) renderer.drawFlags();
    assert.equal(scene.groundSamples, samples, '静态旗圈不逐帧重新采样地形');
    scene.battleOptions.terrain = 'hill';
    renderer.drawFlags();
    assert.notEqual(scene.flagGfx.strokes[0], ring, '切地形必须重新生成真实坡面几何');
});

test('远景营标记限量复用、文本按状态变化更新，不展示敌营或敌方目标', () => {
    const { scene, renderer } = overlayScene();
    scene.battleOptions.territory = true;
    const own = { id: 1, team: 'red', members: [{ gx: 10, gy: 10 }], orderFlag: 0 };
    const enemy = { id: 2, team: 'blue', members: [{ gx: 20, gy: 20 }], orderPoint: { gx: 99, gy: 88 } };
    scene.battalions = { battalions: [own, enemy] };
    renderer.updateBattalionMarkers();
    const marker = renderer.battalionMarkers.get(1), label = marker.label;
    assert.equal(renderer.battalionMarkers.size, 1);
    assert.match(label.text, /1营 · 1人/);
    assert.doesNotMatch(label.text, /99|88|2营/);
    scene.simulationTime += 200;
    renderer.updateBattalionMarkers();
    assert.equal(scene.objects.length, 1, '同一营复用 Text 对象');
    assert.equal(label.textWrites, 1, '状态相同不重新生成文字纹理');
    own.retreat = true;
    scene.simulationTime += 200;
    renderer.updateBattalionMarkers();
    assert.match(label.text, /回防/);
    assert.equal(label.textWrites, 2);
    scene.cameras.main.zoom = 1;
    renderer.updateBattalionMarkers();
    assert.equal(label.visible, false);
    scene.cameras.main.zoom = 0.4;
    renderer.updateBattalionMarkers();
    assert.equal(label.visible, true);
    scene.battalions.battalions.push(...Array.from({ length: 30 }, (_, i) => ({
        id: i + 3, team: 'red', members: [{ gx: i, gy: i }] })));
    scene.simulationTime += 200;
    renderer.updateBattalionMarkers();
    assert.equal(renderer.battalionMarkers.size, 24);
    scene.battleOptions.territory = false;
    renderer.updateBattalionMarkers();
    assert.equal(renderer.battalionMarkers.size, 0);
    assert.equal(label.destroyed, true);
});

test('离屏单位隐藏并停动画，离屏攻击不重启动画，回场恢复当前朝向和行走', () => {
    const scene = makeScene(), unit = addUnit(scene, 'red', 'infantry');
    scene.hpGfx = scene.arrowGfx;
    let stops = 0, plays = 0;
    unit.spr.anims.stop = () => { stops++; };
    unit.spr.play = () => { plays++; };
    unit.spr.setActive = value => { unit.spr.active = value; return unit.spr; };
    unit.moving = true;
    scene.syncOne(unit, 0, null);
    const view = { x0: -10, y0: -10, x1: 10, y1: 10 };
    scene.syncOne(unit, 16, view);
    assert.equal(unit.spr.visible, false);
    assert.equal(unit.shadow.visible, false);
    assert.equal(unit.spr.active, false);
    const stopped = stops, played = plays;
    scene.syncOne(unit, 32, view);
    assert.equal(stops, stopped, '持续离屏时不重复操作动画状态');
    scene.render.units.playAttackAnim(unit, { gx: unit.gx - 1, gy: unit.gy });
    assert.equal(plays, played, '离屏攻击不恢复 UpdateList 工作');
    scene.simulationTime = 1000;
    unit.gx -= 1;
    scene.syncOne(unit, 1000, view);
    assert.notEqual(unit.animState, 'attack', '攻击锁按模拟时间释放');
    scene.syncOne(unit, 1016, null);
    assert.equal(unit.spr.active, true);
    assert.equal(unit.spr.visible, true);
    assert.equal(unit.shadow.visible, true);
    assert.equal(unit.spr.flipX, true);
    assert.equal(unit.animState, 'walk');
    assert.equal(plays, played + 1);
});

test('离屏阵亡仍恢复死亡视觉供尸印盖章', () => {
    const scene = makeScene(), unit = addUnit(scene, 'red', 'infantry');
    scene.hpGfx = scene.arrowGfx;
    scene.syncOne(unit, 0, { x0: 0, x1: 1, y0: 0, y1: 1 });
    assert.equal(unit.visualCulled, true);
    unit.dead = true;
    IsoBattleScene.prototype.killUnit.call(scene, unit);
    scene.render.units.updateDeathVisuals(25);
    assert.equal(unit.visualCulled, false);
    assert.equal(unit.spr.visible, true);
    assert.equal(unit.shadow.visible, true);
});

test('箭矢显示与模拟解耦：重复绘制不改时间或伤害，离屏箭仍命中', () => {
    const scene = makeScene();
    const archer = addUnit(scene, 'red', 'archer', 30, 30);
    const target = addUnit(scene, 'blue', 'infantry', 34, 30);
    scene.rebuildSpatial();
    scene.arrowGfx = drawing();
    scene._view = { x0: 0, y0: 0, x1: 1, y1: 1 };
    scene.fireArrow(archer, target);
    scene.updateArrows(0.1, 100);
    assert.equal(scene.arrowGfx.clears, 0, '固定步不清画 Graphics');
    const t = scene.arrows[0].t, hp = target.hp;
    for (let i = 0; i < 4; i++) scene.render.fx.drawArrows();
    assert.equal(scene.arrows[0].t, t);
    assert.equal(target.hp, hp);
    assert.equal(scene.arrowGfx.lines.length, 0, '离屏只略过绘图');
    scene._view = null;
    scene.render.fx.drawArrows();
    assert.equal(scene.arrowGfx.lines.length, 1);
    scene._view = { x0: 0, y0: 0, x1: 1, y1: 1 };
    scene.updateArrows(1, 1100);
    assert.ok(target.hp < hp);
    assert.equal(scene.arrows.length, 0);
    assert.equal(scene.getBattleReport().teams.red.damage, hp - target.hp);
});

test('尘土云团与单个 Graphics 循环复用，无逐团 Tween，新局清空旧尘', t => {
    t.mock.method(Math, 'random', () => 0.5);
    const scene = makeScene(), unit = addUnit(scene, 'red', 'cavalry');
    scene.time.now = 1000;
    scene._dustBudget = 8;
    let graphics = 0, tweens = 0;
    scene.add.graphics = () => { graphics++; return drawing(); };
    scene.tweens.add = () => { tweens++; };
    scene.groundFX = { add() {} };
    const fx = scene.render.fx;
    fx.chargeDust(unit);
    const cloud = fx.dust[0];
    assert.ok(cloud);
    fx.drawDust(1000);
    assert.equal(graphics, 1);
    scene.time.now = 1600;
    fx.drawDust(1600);
    assert.equal(fx.dust.length, 0);
    fx.chargeDust(unit);
    assert.equal(fx.dust[0], cloud);
    fx.drawDust(1600);
    assert.equal(graphics, 1);
    assert.equal(tweens, 0);
    scene.paused = true;
    scene.time.now = 1700;
    fx.chargeDust(unit);
    assert.equal(fx.dust.length, 1, '暂停不制造新尘土');
    scene.battleId++;
    fx.drawDust(1700);
    assert.equal(fx.dust.length, 0);
    assert.equal(graphics, 1);
});

test('本地目标圈即刻出现，按真实时间过期；模拟停等不冻结，换局不残留', t => {
    let clock = 10000;
    t.mock.method(performance, 'now', () => clock);
    const { scene, renderer } = overlayScene();
    scene.battleOptions.territory = true;
    scene.commandPreview = { gx: 30, gy: 30, at: clock, durationMs: 900, kind: 'hold', battalionId: 1 };
    renderer.drawCommandPreview();
    const gfx = renderer.previewGfx;
    assert.equal(renderer.previewDrawn, true);
    assert.equal(gfx.lines.length, 2, '驻守点用十字定位');
    clock += 450;
    renderer.drawCommandPreview();
    assert.equal(renderer.previewDrawn, true);
    assert.equal(scene.simulationTime, 1000, '表现不推进模拟时钟');
    assert.equal(renderer.previewGfx, gfx, '临时目标提示复用一个 Graphics');
    clock += 450;
    renderer.drawCommandPreview();
    assert.equal(renderer.previewDrawn, false, '锁步未前进也会在 900ms 后消失');
    assert.equal(gfx.lines.length, 0);
    scene.commandPreview = { gx: 30, gy: 30, at: clock, kind: 'rally' };
    renderer.drawCommandPreview();
    assert.equal(gfx.lines.length, 1, '集结点用旗杆区分驻守');
    scene.battleId++;
    renderer.drawCommandPreview();
    assert.equal(renderer.previewDrawn, false);
    assert.equal(scene.commandPreview, null);
    assert.equal(gfx.lines.length, 0);
    scene.commandPreview = { gx: 31, gy: 31, at: clock, kind: 'hold' };
    renderer.drawCommandPreview();
    assert.equal(renderer.previewDrawn, true, '新局仍可接收新命令提示');
    scene.battleOptions.territory = false;
    renderer.drawCommandPreview();
    assert.equal(renderer.previewDrawn, false);
});
