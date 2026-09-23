const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({
    Phaser: { Scene: class {} },
    Snd: null,
    UI: { onBattleEnd() {} }
});
for (const name of ['units.js', 'game.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', name), 'utf8'), context);
}
vm.runInContext('this.engine = { IsoBattleScene, UNIT_TYPES, CavalryAI, applyDamage };', context);
const { IsoBattleScene, UNIT_TYPES, CavalryAI, applyDamage } = context.engine;
const snapshot = value => JSON.parse(JSON.stringify(value));

function displayObject() {
    return {
        destroyed: false,
        setOrigin() { return this; }, setScrollFactor() { return this; },
        setDepth() { return this; }, setScale() { return this; }, setFlipX() { return this; },
        setTint() { return this; }, anims: { stop() {} },
        destroy() { this.destroyed = true; },
        clear() {}, lineStyle() {}, lineBetween() {}, fillStyle() {}, fillCircle() {}
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

module.exports = { context, IsoBattleScene, UNIT_TYPES, CavalryAI, applyDamage, snapshot, makeScene, addUnit };
