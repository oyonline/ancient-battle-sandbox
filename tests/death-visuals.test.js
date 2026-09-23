const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { context, IsoBattleScene, makeScene, addUnit } = require('./battle-harness');

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'manifest.js'), 'utf8') +
    '\nthis.deathTestManifest = MANIFEST;', context);
const deaths = context.deathTestManifest.deaths;

function visual(x = 0, y = 0, texture = '', frame = 0) {
    return {
        x, y, texture, frame, originX: 0.5, originY: 0.5, scaleX: 1, scaleY: 1,
        flipX: false, angle: 0, alpha: 1, depth: 0, destroyed: false,
        anims: { stop() {} },
        setTexture(key, index = 0) { this.texture = key; this.frame = index; return this; },
        setFrame(index) { this.frame = index; return this; },
        setOrigin(x, y = x) { this.originX = x; this.originY = y; return this; },
        setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; },
        setFlipX(value) { this.flipX = value; return this; },
        setAngle(value) { this.angle = value; return this; },
        setAlpha(value) { this.alpha = value; return this; },
        setPosition(x, y) { this.x = x; this.y = y; return this; },
        setDepth(value) { this.depth = value; return this; },
        clearTint() { return this; },
        destroy() { this.destroyed = true; }
    };
}

function appearance(object) {
    const { x, y, texture, frame, originX, originY, scaleX, scaleY, flipX, angle, alpha } = object;
    return { x, y, texture, frame, originX, originY, scaleX, scaleY, flipX, angle, alpha };
}

function deathScene({ sheets = true, corpse = false } = {}) {
    const scene = makeScene();
    scene.killUnit = IsoBattleScene.prototype.killUnit;
    scene.add.image = scene.add.sprite = visual;
    scene.textures = { exists: key => key === 'death-contact-shadow' ||
        (sheets && key.startsWith('units/death/')) || (corpse && key.startsWith('units/corpse_')) };
    scene.draws = [];
    scene.pools = [];
    scene.scarRT = { draw: object => scene.draws.push(appearance(object)), clear() { scene.draws = []; } };
    scene.addBloodPool = (x, y) => scene.pools.push({ x, y });
    return scene;
}

function kill(scene, type = 'infantry', team = 'red') {
    const unit = addUnit(scene, team, type, 30, 30);
    unit.dead = true;
    scene.killUnit(unit);
    return unit;
}

function advance(scene, ms) {
    for (let remaining = ms; remaining > 0; remaining -= 25) scene.updateDeathVisuals(Math.min(25, remaining));
}

test('preload uses the declared six-frame sheets and caches one contact-shadow texture', () => {
    const scene = deathScene();
    const sheets = [], textures = new Set();
    let graphics = 0;
    scene.load = { image() {}, spritesheet: (...args) => sheets.push(args) };
    scene.textures.exists = key => textures.has(key);
    scene.make = { graphics() {
        graphics++;
        return { fillStyle() {}, fillEllipse() {}, destroy() {}, generateTexture: key => textures.add(key) };
    } };
    scene.preload();
    const deathSheets = sheets.filter(([key]) => key.startsWith('units/death/'));
    assert.equal(deathSheets.length, 8);
    for (const [key, file, config] of deathSheets) {
        const def = Object.values(deaths).find(def => def.file === `${key}.png`);
        assert.equal(file, `assets/${key}.png`);
        assert.equal(config.frameHeight, def.fh);
        assert.equal(config.frameWidth, def.fw);
        assert.equal(def.frames, 6);
    }
    scene.anims.exists = () => true;
    scene.buildUnitAnims();
    scene.buildUnitAnims();
    assert.equal(graphics, 1);
    assert.deepEqual([...textures], ['death-contact-shadow']);
});

test('death preserves facing and absolute asset scale while removing the team ring', () => {
    const scene = deathScene();
    const unit = addUnit(scene, 'blue', 'cavalry', 30, 30);
    const shadow = unit.shadow;
    unit.faceDir = -1;
    unit.dead = true;
    scene.killUnit(unit, { gx: 50, gy: 30 });
    assert.equal(unit.spr.texture, 'units/death/blue_cavalry');
    assert.equal(unit.spr.frame, 0);
    assert.equal(unit.spr.flipX, true);
    assert.equal(unit.spr.scaleX, deaths.blue_cavalry.scale);
    assert.equal(unit.spr.scaleY, deaths.blue_cavalry.scale);
    assert.equal(unit.spr.originX, deaths.blue_cavalry.anchorX);
    assert.equal(unit.spr.originY, deaths.blue_cavalry.anchorY);
    assert.equal(unit.spr.angle, 0);
    assert.equal(unit.shadow, shadow);
    assert.equal(shadow.destroyed, false);
    assert.equal(shadow.texture, 'death-contact-shadow');
    assert.equal(scene.draws.length, 0);
});

test('pause freezes the complete death visual and 0.5x/1x/2x advance the same animation clock', () => {
    const samples = [];
    for (const speed of [0.5, 1, 2]) {
        const scene = deathScene();
        const unit = kill(scene);
        scene.setSpeed(speed);
        advance(scene, 150 / speed);
        samples.push({ elapsed: unit.deathVisual.elapsed, sprite: appearance(unit.spr), shadow: appearance(unit.shadow) });
        scene.togglePause();
        const before = JSON.stringify(samples.at(-1));
        advance(scene, 500);
        assert.equal(JSON.stringify({ elapsed: unit.deathVisual.elapsed,
            sprite: appearance(unit.spr), shadow: appearance(unit.shadow) }), before);
    }
    assert.deepEqual(samples[0], samples[1]);
    assert.deepEqual(samples[1], samples[2]);
    assert.equal(samples[0].elapsed, 150);
    assert.equal(samples[0].sprite.frame, 1);
});

test('the production update finishes existing deaths after battleOver but respects pause', () => {
    const scene = deathScene();
    const unit = kill(scene);
    scene.battleOver = true;
    scene._fpsN = 0;
    scene._fpsT = 0;
    scene.time.now = 0;
    scene.updateBloods = scene.flushBloodQueue = scene.syncRender = () => {};
    scene.paused = true;
    scene.update(25, 25);
    assert.equal(unit.deathVisual.elapsed, 0);
    scene.paused = false;
    for (let time = 25; time <= 600; time += 25) scene.update(time, 25);
    assert.equal(scene.dyingUnits.size, 0);
    assert.equal(unit.spr.destroyed, true);
    assert.equal(scene.draws.length, 2);
});

test('last frame and its contact shadow are stamped exactly as displayed, including cavalry drift', () => {
    for (const team of ['red', 'blue']) {
        const scene = deathScene();
        const unit = addUnit(scene, team, 'cavalry', 30, 30);
        unit.velX = team === 'red' ? 5 : -5;
        unit.velY = 1;
        unit.dead = true;
        scene.killUnit(unit);
        const startX = unit.spr.x, startY = unit.spr.y;
        advance(scene, 650);
        assert.equal(unit.spr.frame, 5);
        const sprite = appearance(unit.spr), shadow = appearance(unit.shadow);
        assert.ok(Math.hypot(sprite.x - startX, sprite.y - startY) > 0);
        assert.ok(Math.hypot(sprite.x - startX, sprite.y - startY) <= 14 + 1e-8);
        advance(scene, 110);
        assert.deepEqual(scene.draws, [shadow, sprite]);
        assert.deepEqual(scene.pools, [{ x: sprite.x, y: sprite.y }]);
        assert.equal(unit.spr.destroyed, true);
        assert.equal(unit.shadow.destroyed, true);
        assert.equal(unit.deathVisual, null);
        advance(scene, 1000);
        assert.equal(scene.draws.length, 2, 'a completed corpse is stamped only once');
    }
});

test('restarting clears a compacted dying unit and stale epochs cannot stamp into the new battle', () => {
    const scene = deathScene();
    const unit = kill(scene);
    const oldDeath = unit.deathVisual;
    scene.units = [];
    scene.clearUnits();
    assert.equal(unit.spr.destroyed, true);
    assert.equal(unit.shadow.destroyed, true);
    assert.equal(unit.deathVisual, null);
    assert.equal(scene.dyingUnits.size, 0);
    // Exercise the production epoch guard even if stale work is reintroduced after cleanup.
    unit.deathVisual = oldDeath;
    scene.dyingUnits.add(unit);
    assert.equal(scene.stampCorpse(unit), false);
    advance(scene, 1000);
    assert.equal(scene.draws.length, 0);
    assert.equal(scene.pools.length, 0);
    assert.equal(scene.dyingUnits.size, 0);
});

test('missing sheets fall back without cardboard rotation and missing corpses cleanly disappear', () => {
    for (const corpse of [true, false]) {
        const scene = deathScene({ sheets: false, corpse });
        const unit = kill(scene);
        advance(scene, 125);
        assert.equal(unit.spr.angle, 0);
        if (corpse) assert.equal(unit.spr.texture, 'units/corpse_red_infantry');
        else assert.ok(unit.spr.alpha < 1);
        advance(scene, 125);
        assert.equal(unit.spr.destroyed, true);
        assert.equal(unit.shadow.destroyed, true);
        assert.equal(scene.dyingUnits.size, 0);
        assert.equal(scene.draws.length, corpse ? 2 : 0);
    }
});

test('many simultaneous deaths reuse display objects and leave no per-unit render objects behind', () => {
    const scene = deathScene();
    const units = Array.from({ length: 1000 }, (_, index) => kill(scene, index % 2 ? 'cavalry' : 'infantry'));
    scene.add.image = scene.add.sprite = () => assert.fail('death playback must reuse existing sprites');
    scene.add.graphics = () => assert.fail('death playback must not create per-unit graphics');
    advance(scene, 800);
    assert.equal(scene.draws.length, 2000);
    assert.equal(scene.dyingUnits.size, 0);
    assert.ok(units.every(unit => unit.spr.destroyed && unit.shadow.destroyed));
});
