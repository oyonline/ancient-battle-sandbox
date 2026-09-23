const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({
    Phaser: { Scene: class {} },
    Snd: null,
    UI: { onBattleEnd() {} }
});
for (const name of ['units.js', 'combat.js', 'morale.js', 'tactics.js', 'game.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8'), context);
}
vm.runInContext('this.engine = { IsoBattleScene, UNIT_TYPES, CavalryAI, applyDamage, calculateAttackDamage, resolveAttack };', context);
const { IsoBattleScene, UNIT_TYPES, CavalryAI, applyDamage, calculateAttackDamage, resolveAttack } = context.engine;
const snapshot = value => JSON.parse(JSON.stringify(value));

function displayObject() {
    return {
        destroyed: false,
        x: 0, y: 0, scaleX: 1, scaleY: 1, frame: 0, texture: '',
        setOrigin(x, y) { this.originX = x; this.originY = y; return this; }, setScrollFactor() { return this; },
        setDepth(depth) { this.depth = depth; return this; },
        setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; },
        setFlipX(value) { this.flipX = value; return this; },
        setTexture(key, frame = 0) { this.texture = key; this.frame = frame; return this; },
        setFrame(frame) { this.frame = frame; return this; },
        setPosition(x, y) { this.x = x; this.y = y; return this; },
        setAngle(angle) { this.angle = angle; return this; }, setAlpha(alpha) { this.alpha = alpha; return this; },
        setTint() { return this; }, clearTint() { return this; }, anims: { stop() {} },
        destroy() { this.destroyed = true; },
        clear() {}, lineStyle() {}, lineBetween() {}, fillStyle() {}, fillCircle() {}, fillRect() {}
    };
}

function makeScene() {
    const scene = new IsoBattleScene();
    Object.assign(scene, {
        units: [], arrows: [], bloods: [], bloodQueue: [],
        sgrid: new Map(), _aliveArr: [], nextId: 1,
        redAlive: 0, blueAlive: 0, deadCount: 0,
        battleStarted: true, battleOver: false, paused: false, gameSpeed: 1,
        countdownTimers: [], countdownTexts: [],
        centroid: { red: { x: 0, y: 0 }, blue: { x: 0, y: 0 } },
        arrowGfx: displayObject(), spawnZoneGfx: displayObject(),
        cameras: { main: { width: 800, height: 600 } },
        cavalryAI: new CavalryAI(),
        add: { text: () => displayObject(), image: () => displayObject(), sprite: () => displayObject() },
        tweens: { killTweensOf() {}, add() {} },
        anims: { globalTimeScale: 1 },
        textures: { exists: () => false },
        time: { delayedCall(delay, callback) {
            return { delay, callback, removed: false, remove() { this.removed = true; } };
        } },
        playAttackAnim() {}, meleeImpact() {}, bloodBurst() {}, impactPuff() {}, chargeDust() {},
        showVictory(winner) { this.winner = winner; },
        drawSpawnZones() {},
        killUnit() { this.deadCount++; }
    });
    scene.resetBattleData();
    return scene;
}

function addUnit(scene, team, type, gx = 30, gy = 30) {
    // Keep spawning and every combat path real; only Phaser drawing/effects are stubbed.
    const unit = scene.spawnUnit(team, type, gx, gy);
    scene.redAlive = scene.battleStats.red.alive;
    scene.blueAlive = scene.battleStats.blue.alive;
    return unit;
}

module.exports = { context, IsoBattleScene, UNIT_TYPES, CavalryAI, applyDamage, calculateAttackDamage, resolveAttack, snapshot, makeScene, addUnit };
