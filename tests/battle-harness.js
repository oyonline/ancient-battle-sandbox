// 引擎各模块以真实 ES 模块加载（与浏览器同一张模块图）。
// 只有 game.js 在模块求值期就要 Phaser.Scene（类继承），而静态 import 先于模块体执行——
// 桩必须在动态 import game.js 之前注入；其余模块不依赖 Phaser，静态导入即可。
globalThis.Phaser = { Scene: class {} };
globalThis.Snd = null;
globalThis.UI = { onBattleEnd() {} };

import { Terrain } from '../js/terrain.js';
import { TerrainNavigation } from '../js/navigation.js';
import {
    UNIT_TYPES, CavalryAI, knockback, moveToward,
    applyDamage, calculateAttackDamage, resolveAttack,
    updatePikeBrace, isPreparedPike
} from '../js/units.js';
import { CombatRules } from '../js/combat.js';
import { MoraleSystem } from '../js/morale.js';
import { TacticsSystem } from '../js/tactics.js';

const { IsoBattleScene } = await import('../js/game.js');
const snapshot = value => JSON.parse(JSON.stringify(value));

function displayObject() {
    return {
        destroyed: false,
        x: 0, y: 0, scaleX: 1, scaleY: 1, frame: 0, texture: '',
        setOrigin(x, y) { this.originX = x; this.originY = y; return this; }, setScrollFactor() { return this; },
        setDepth(depth) { this.depth = depth; return this; }, setVisible(value) { this.visible = value; return this; },
        setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; },
        setFlipX(value) { this.flipX = value; return this; },
        setTexture(key, frame = 0) { this.texture = key; this.frame = frame; return this; },
        setFrame(frame) { this.frame = frame; return this; },
        setPosition(x, y) { this.x = x; this.y = y; return this; },
        setAngle(angle) { this.angle = angle; return this; }, setAlpha(alpha) { this.alpha = alpha; return this; },
        setTint() { return this; }, clearTint() { return this; }, anims: { stop() {} },
        destroy() { this.destroyed = true; },
        clear() {}, lineStyle() {}, lineBetween() {}, fillStyle() {}, fillCircle() {}, fillRect() {},
        fillTriangle() {}, strokeTriangle() {}, fillPoints() {}, strokePoints() {}, fillEllipse() {},
        strokeEllipse() {}, generateTexture() {},
        beginPath() {}, arc() {}, strokePath() {}, strokeCircle() {}
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
        add: { text: () => displayObject(), image: (x, y) => displayObject().setPosition(x, y),
            sprite: (x, y) => displayObject().setPosition(x, y),
            graphics: () => displayObject() },
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

export {
    Terrain, TerrainNavigation, CombatRules, MoraleSystem, TacticsSystem,
    UNIT_TYPES, CavalryAI, knockback, moveToward, updatePikeBrace, isPreparedPike,
    applyDamage, calculateAttackDamage, resolveAttack,
    IsoBattleScene, snapshot, makeScene, addUnit
};
