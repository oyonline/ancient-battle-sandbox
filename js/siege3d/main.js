// ==================== 千人攻寨：主模拟 + 独立 Three.js 渲染 ====================
// 思路：跑「与 2D 经典版同一套」确定性模拟（IsoBattleScene + core.advanceBattle），
// 但把场景的视觉钩子（打击/血/尘/尸体/音效）全部替换成 Three.js 实例化实现。
// Phaser 仅在模块求值期被引用（game.js 类继承）——先桩后动态导入，与 tests/battle-harness.js 同套路。
globalThis.Phaser = { Scene: class {} };
globalThis.UI = { onBattleEnd() {} };

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Snd } from '../snd.js';
import { Terrain } from '../terrain.js';
import { campBounds, queueCampWalls, buildCampVisuals, disposeCampVisuals, updateCampGate } from './walls.js';
import { buildRamVisual, updateRamVisual } from './ram.js';
import { createCampSiege, siegeDeployment, installSiegeArrows, H_WORLD } from './deployment.js';
import { buildSiegeVisuals, climberWorldHeight } from './platforms.js';
import { CavalryAI, unitRand } from '../units.js';
import { board } from '../board.js';
import { TW, TH, OX, OY } from '../render/metrics.js';
import { stepBattle, SIMULATION_STEP_MS } from '../battle/core.js';

window.Snd = Snd;   // game.js / render 钩子里以全局 Snd 出声（die/win/arrow）

const TERRAIN_KEY = 'flat';
const ATTACKERS = { infantry: 380, pikeman: 80, archer: 140 };
const DEFENDERS = { infantry: 120, archer: 80 };
const TEAM_COLOR = { red: 0xc4553f, blue: 0x7fb0e0 };

const $ = id => document.getElementById(id);
const hud = $('hud');

// ---------------- Three 基础 ----------------
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.append(renderer.domElement);
const scene3d = new THREE.Scene();
scene3d.background = new THREE.Color('#b9c5ab');
scene3d.fog = new THREE.Fog('#b9c5ab', 90, 210);
const camera = new THREE.PerspectiveCamera(45, 1, .1, 400);
camera.position.set(0, 62, 74);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true; controls.dampingFactor = .08;
controls.maxPolarAngle = 1.32; controls.minDistance = 6; controls.maxDistance = 170;
function resize() {
    const { width, height } = viewport.getBoundingClientRect();
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport); resize();
scene3d.add(new THREE.HemisphereLight('#fff5da', '#556547', 1.5));
const sun = new THREE.DirectionalLight('#fff0cb', 1.9);
sun.position.set(-30, 55, 25); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, far: 160 });
sun.shadow.normalBias = .05;
scene3d.add(sun);

const groundH = (gx, gy) => Terrain.height(TERRAIN_KEY, gx, gy) * H_WORLD;
const surfaceH = (gx, gy) => groundH(gx, gy) + (scene?.siege?.heightAt(gx, gy) ?? 0) * H_WORLD;

// ---------------- 地面（2D 同一块确定性地形） ----------------
function buildGround(w, h) {
    const geo = new THREE.PlaneGeometry(w, h, 140, 140);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, colors = [];
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + w / 2, z = pos.getZ(i) + h / 2;   // 网格坐标 gx∈[0,w]
        const y = groundH(x, z);
        pos.setY(i, y);
        const c = new THREE.Color().setHSL(.23 + y * .012, .24, .34 + y * .05 + Math.sin(x * .8 + z * .5) * .015);
        colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    ground.receiveShadow = true;
    scene3d.add(ground);
}

// ---------------- 低模兵坯（每兵种一个合并几何，实例化渲染） ----------------
function part(w, h, d, x, y, z, color, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    const count = g.attributes.position.count, colors = new Float32Array(count * 3);
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
}
const STEEL = 0xd8d4cc, DARK = 0x5a5448, SKIN = 0xd9b08c, WOOD = 0x8a6b42, METAL = 0xe8e6df;
function soldierGeo(kind) {
    const parts = [];
    if (kind === 'cavalry') {
        // 关键：本模型朝向为 +Z（步卒的矛沿 +Z 前伸可证）。马躯干长轴必须沿 Z，
        // 旧版把长轴放在 X，马是横在朝向侧面上的——这就是"骑兵看着别扭"的根因。
        // part() 无 X 轴俯仰（只有 ry/rz），故前倾的脖子、枪头的下压都用错位短块堆叠实现。
        // 马体用浅暖灰：旧版中棕 0x9c7a52 经队伍色相乘后发闷（蓝方尤其暗）。
        const HORSE = 0xcbbfa6, HORSE_LEG = 0xa1957f, MANE = 0x7a6a52, ARMOR = 0xd6d1c6;
        parts.push(part(.5, .54, 1.26, 0, .82, 0, HORSE));                          // 躯干（长轴沿 Z）
        parts.push(part(.54, .5, .48, 0, .84, .56, HORSE));                         // 前胸
        parts.push(part(.46, .46, .4, 0, .8, -.5, HORSE));                          // 后臀
        parts.push(part(.28, .44, .34, 0, 1.1, .72, HORSE));                        // 颈（下段）
        parts.push(part(.24, .4, .3, 0, 1.36, .94, HORSE));                         // 颈（上段，前移作出前倾）
        parts.push(part(.22, .26, .4, 0, 1.54, 1.1, HORSE));                        // 头
        parts.push(part(.17, .17, .2, 0, 1.47, 1.3, HORSE_LEG));                    // 口鼻
        for (const [y, z, h] of [[1.16, .6, .34], [1.4, .82, .3], [1.6, 1.02, .22]])
            parts.push(part(.09, h, .24, 0, y, z, MANE));                           // 鬃毛沿颈脊
        parts.push(part(.13, .46, .13, 0, .95, -.78, MANE));                        // 尾
        for (const [x, z] of [[-.19, .46], [.19, .46], [-.19, -.48], [.19, -.48]]) {
            parts.push(part(.17, .5, .17, x, .44, z, HORSE));                       // 腿（上段）
            parts.push(part(.13, .42, .13, x, .13, z + .03, HORSE_LEG));            // 腿（下段，略前错）
        }
        parts.push(part(.44, .54, .34, 0, 1.32, -.06, ARMOR));                      // 骑手胸甲
        for (const x of [-.24, .24]) parts.push(part(.12, .34, .16, x, 1.12, .04, ARMOR));  // 骑手腿贴马腹
        parts.push(part(.2, .22, .2, 0, 1.67, -.06, SKIN));                         // 头
        parts.push(part(.26, .19, .26, 0, 1.77, -.06, ARMOR));                      // 盔
        parts.push(part(.05, .05, 1.5, .25, 1.33, .48, WOOD));                      // 骑枪（长轴沿 Z 前伸）
        parts.push(part(.04, .04, .28, .25, 1.28, 1.26, METAL));                    // 枪尖（略低）
        parts.push(part(.1, .12, .13, .25, 1.3, .16, SKIN));                        // 持枪手
    } else {
        parts.push(part(.13, .42, .15, -.11, .21, 0, DARK), part(.13, .42, .15, .11, .21, 0, DARK));   // 腿
        parts.push(part(.36, .5, .24, 0, .68, 0, STEEL));                          // 躯干
        parts.push(part(.19, .19, .19, 0, 1.05, 0, SKIN));                         // 头
        if (kind === 'pikeman') parts.push(part(.045, .045, 1.7, .17, .95, .45, WOOD));
        else if (kind === 'archer') parts.push(part(.05, .8, .05, .16, .75, .12, WOOD, 0, .15));
        else { parts.push(part(.3, .42, .05, -.26, .68, .1, 0x946339));            // 盾
            parts.push(part(.05, .5, .05, .24, .8, .1, METAL, 0, -.4)); }         // 剑
    }
    return mergeGeometries(parts);
}
const UNIT_KINDS = ['infantry', 'pikeman', 'archer', 'cavalry'];
const CAP = { infantry: 700, pikeman: 160, archer: 220, cavalry: 160 };
const unitMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const unitMeshes = {}, corpseMeshes = {};
for (const kind of UNIT_KINDS) {
    const geo = soldierGeo(kind);
    const mesh = new THREE.InstancedMesh(geo, unitMat, CAP[kind]);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true; mesh.count = 0; mesh.frustumCulled = false;
    scene3d.add(mesh); unitMeshes[kind] = mesh;
    const corpses = new THREE.InstancedMesh(geo, unitMat, CAP[kind]);
    corpses.count = 0; corpses.frustumCulled = false;
    scene3d.add(corpses); corpseMeshes[kind] = corpses;
}
const _teamColor = new THREE.Color();
function setTeamColor(u, slot) {
    // 骑兵不再整体压暗：马体基色已改浅暖灰，旧版 ×0.9 会把蓝方马压成发闷的灰蓝（旧问题）。
    _teamColor.setHex(TEAM_COLOR[u.team]);
    unitMeshes[u.type].setColorAt(slot, _teamColor);
}

// 血渍 / 尘土 / 箭矢
const BLOOD_CAP = 16000;   // 血粒子落地也盖渍，全场消耗 ~8K，上限留足不绕圈
const bloodMesh = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4a0f0c, transparent: true, opacity: .8, depthWrite: false }), BLOOD_CAP);
bloodMesh.count = 0; bloodMesh.frustumCulled = false; bloodMesh.renderOrder = 1;
scene3d.add(bloodMesh);
let bloodCursor = 0;
const _nUp = new THREE.Vector3(0, 1, 0), _n = new THREE.Vector3(), _nQ = new THREE.Quaternion(), _nQY = new THREE.Quaternion();
function groundNormal(gx, gy) {
    const e = .35;   // 差分采样求坡面法线：血渍贴坡不埋进山体
    const hx = groundH(gx + e, gy) - groundH(gx - e, gy);
    const hz = groundH(gx, gy + e) - groundH(gx, gy - e);
    return _n.set(-hx, 2 * e, -hz).normalize();
}
function addBlood(gx, gy, r) {
    const i = bloodCursor++ % BLOOD_CAP;
    bloodMesh.count = Math.min(bloodCursor, BLOOD_CAP);
    dummy.position.set(gx - board.W / 2, surfaceH(gx, gy) + .06 + i * 1e-5, gy - board.H / 2);
    _nQ.setFromUnitVectors(_nUp, groundNormal(gx, gy));          // 圆片贴坡面
    _nQY.setFromAxisAngle(_nUp, Math.random() * Math.PI * 2);    // 面内随机旋转
    dummy.quaternion.copy(_nQ).multiply(_nQY);
    dummy.scale.setScalar(r); dummy.updateMatrix();
    bloodMesh.setMatrixAt(i, dummy.matrix);
    bloodMesh.instanceMatrix.needsUpdate = true;
}
const dustPool = [];
for (let i = 0; i < 48; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 5),
        new THREE.MeshBasicMaterial({ color: 0xcbbf9d, transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false; scene3d.add(m); dustPool.push({ m, life: 0 });
}
function puff(gx, gy, big = false) {
    const d = dustPool.find(p => p.life <= 0); if (!d) return;
    d.life = d.max = big ? .8 : .55;
    d.m.position.set(gx - board.W / 2, groundH(gx, gy) + .2, gy - board.H / 2);
    d.m.scale.setScalar(big ? .5 : .3); d.m.visible = true;
}
const arrowMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(.022, .022, .62, 5).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xe8d7a1 }), 300);
arrowMesh.count = 0; arrowMesh.frustumCulled = false;
scene3d.add(arrowMesh);

// ---------------- 血粒子：命中喷溅 → 抛物线 → 落地并入血渍层 ----------------
// 模拟时钟驱动（暂停冻结/倍速同步），环形槽覆盖最老粒子。
const BLOOD_P_CAP = 800;
const bloodPMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(.075, .075, .075),
    new THREE.MeshBasicMaterial({ color: 0x9c2418 }), BLOOD_P_CAP);
bloodPMesh.count = 0; bloodPMesh.frustumCulled = false;
scene3d.add(bloodPMesh);
const bloodP = [];       // 存活粒子 { slot, gen, x0,y0,z0, vx,vy,vz, birth, life, gx, gy }
let bloodPCursor = 0;
function sprayBlood(gx, gy, n, power, k = 1) {
    const y0 = surfaceH(gx, gy) + .8 * Math.max(.7, k);        // 喷口≈胸口高
    const v0 = (power / 95) * (1.7 + Math.random() * 1.1);
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = .3 + Math.random() * .7;
        const gen = bloodPCursor++;
        bloodP.push({ slot: gen % BLOOD_P_CAP, gen,
            x0: gx - board.W / 2, y0, z0: gy - board.H / 2,
            vx: Math.sin(a) * r * v0 * .85, vy: (.55 + Math.random() * .8) * v0, vz: Math.cos(a) * r * v0 * .85,
            birth: scene.simulationTime, life: .45 + Math.random() * .3, gx, gy });
    }
    bloodPMesh.count = Math.min(bloodPCursor, BLOOD_P_CAP);
}
function updateBloodP(simNow) {
    const G = 9.5;
    for (let i = bloodP.length - 1; i >= 0; i--) {
        const p = bloodP[i], t = (simNow - p.birth) / 1000;
        if (t >= p.life) {
            // 落地：部分化成小血渍并入留痕层（全盖会耗尽血渍缓冲）
            if (Math.random() < .35) addBlood(p.gx + p.vx * p.life, p.gy + p.vz * p.life, .1 + Math.random() * .12);
            if (!bloodP.some(q => q !== p && q.slot === p.slot && q.gen > p.gen)) {
                dummy.position.set(0, -50, 0); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1e-4);
                dummy.updateMatrix(); bloodPMesh.setMatrixAt(p.slot, dummy.matrix);
            }
            bloodP.splice(i, 1); continue;
        }
        const gx = p.x0 + board.W / 2 + p.vx * t, gy = p.z0 + board.H / 2 + p.vz * t;
        dummy.position.set(gx - board.W / 2, Math.max(p.y0 + p.vy * t - .5 * G * t * t, surfaceH(gx, gy) + .04), gy - board.H / 2);
        dummy.rotation.set(t * 9 + p.gen, t * 7, 0);
        dummy.scale.setScalar(1); dummy.updateMatrix();
        bloodPMesh.setMatrixAt(p.slot, dummy.matrix);
    }
    bloodPMesh.instanceMatrix.needsUpdate = true;
}

const dummy = new THREE.Object3D();
const _av = new THREE.Vector3(), _bv = new THREE.Vector3();
const arrowArcs = new WeakMap();
function arrowArc(a) {
    if (arrowArcs.has(a)) return arrowArcs.get(a);
    let arc = 1.1;
    // 仅提高视觉抛物线以跨过木栅；不改模拟箭矢、飞行时长或伤害。
    for (const r of scene.dynamicBlockers.list) {
        const enter = Terrain.sweep(r, a.sx, a.sy, a.tx, a.ty);
        if (!enter) continue;
        const exit = Terrain.sweep(r, a.tx, a.ty, a.sx, a.sy);
        for (const p of [enter.t, 1 - (exit?.t ?? 0)]) {
            const t = Math.max(.001, Math.min(.999, p));
            const baseline = ((a.sourceHeight || 0) * (1 - t) + (a.targetHeight || 0) * t) * H_WORLD + .5;
            arc = Math.max(arc, ((r.kind === 'gate' ? 2.4 : 1.75) + .15 - baseline) / Math.sin(t * Math.PI));
        }
    }
    arrowArcs.set(a, arc);
    return arc;
}
// 弹道切线（p 处导数）：水平线性 + 高度端点插值 + 正弦弧的导数；箭几何沿 +Z，配 lookAt 出俯仰
function arrowVel(a, p, out) {
    out.set(a.tx - a.sx,
        ((a.targetHeight || 0) - (a.sourceHeight || 0)) * H_WORLD + Math.cos(p * Math.PI) * Math.PI * arrowArc(a),
        a.ty - a.sy);
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
    return out;
}

// ---------------- 2D 模拟场景（真模拟 + 桩渲染），钩子全部换成 3D 实现 ----------------
let scene;
const headings = new Map();      // unitId → 朝向（弧度，平滑跟随移动方向）
let lastSound = {};
function throttled(key, gap = 60) { const t = performance.now(); if (t - (lastSound[key] || 0) < gap) return false; lastSound[key] = t; return true; }

let groundBuilt = false, campVisuals = null, campLayer = null, campVersion = -1;
let gateRects = [], ramVisual = null, heardRamHits = 0, heardGateBreak = false;
function refreshCampVisuals() {
    const layer = scene.dynamicBlockers;
    if (campLayer === layer && campVersion === layer.version) return;
    disposeCampVisuals(campVisuals);
    // 开战前预览排队矩形；开战后读固定时点提交的 list，渲染不调用 commit。
    const rects = layer.size ? layer.list : [...layer.pending.values()].filter(Boolean);
    if (campLayer !== layer) {
        gateRects = rects.filter(r => r.kind === 'gate');
        heardRamHits = 0; heardGateBreak = false;
    }
    // Physics removes the gate; keep its leaves and posts for the opening animation.
    campVisuals = buildCampVisuals([...rects.filter(r => r.kind !== 'gate'), ...gateRects]);
    campVisuals.add(buildSiegeVisuals(scene.siege));
    ramVisual = scene.siege?.ram ? buildRamVisual() : null;
    if (ramVisual) campVisuals.add(ramVisual);
    scene3d.add(campVisuals);
    campLayer = layer; campVersion = layer.version;
}
function positionArmies() {
    const b = campBounds();
    scene.siege = createCampSiege(b, { ladders: true });
    for (const { unit: u, gx, gy, siegeAnchor } of siegeDeployment(scene.units, b, scene.siege)) {
        u.gx = u.pgx = gx; u.gy = u.pgy = gy;
        u.moveX = u.moveY = u.pushX = u.pushY = u.velX = u.velY = 0;
        u.siegeAnchor = siegeAnchor;
    }
    scene.rebuildSpatial();
}

async function boot() {
    const { IsoBattleScene } = await import('../game.js');
    scene = new IsoBattleScene();
    const stub = () => ({
        destroyed: false, x: 0, y: 0, setOrigin() { return this; }, setScrollFactor() { return this; },
        setDepth() { return this; }, setVisible() { return this; }, setScale() { return this; },
        setFlipX() { return this; }, setTexture() { return this; }, setFrame() { return this; },
        setPosition() { return this; }, setAngle() { return this; }, setAlpha() { return this; },
        setText() { return this; }, setColor() { return this; }, setTint() { return this; },
        clearTint() { return this; }, anims: { stop() {} }, destroy() {},
        clear() {}, lineStyle() {}, lineBetween() {}, fillStyle() {}, fillCircle() {}, fillRect() {},
        fillTriangle() {}, fillPoints() {}, strokePoints() {}, fillEllipse() {}, strokeEllipse() {},
        beginPath() {}, arc() {}, strokePath() {}, strokeCircle() {}, generateTexture() {}
    });
    Object.assign(scene, {
        units: [], arrows: [], bloods: [], bloodQueue: [], sgrid: new Map(), _aliveArr: [], nextId: 1,
        redAlive: 0, blueAlive: 0, blackAlive: 0, deadCount: 0,
        battleStarted: false, battleOver: false, paused: false, gameSpeed: 1,
        countdownTimers: [], countdownTexts: [], dyingUnits: new Set(),
        centroid: { red: { x: 0, y: 0 }, blue: { x: 0, y: 0 } },
        arrowGfx: stub(), spawnZoneGfx: stub(),
        cameras: { main: { width: 960, height: 720, worldView: null, zoom: 1 } },
        cavalryAI: new CavalryAI(),
        add: { text: () => stub(), image: () => stub(), sprite: () => stub(), graphics: () => stub() },
        tweens: { killTweensOf() {}, add() {} },
        anims: { globalTimeScale: 1 },
        textures: { exists: () => false },
        time: { delayedCall(d, cb) { return { remove() {} }; } },
        fpsHud: null, groundImage: null, terrainLoading: false, lowFX: false,
        showVictory(winner) { hudWinner = winner === 'red' ? '红方胜' : winner === 'blue' ? '蓝方胜' : '结束'; }
    });
    installSiegeArrows(scene);
    scene.resetBattleData();                  // 桩就位后重放初始化（士气/战报/时钟），与测试 harness 同套路
    Object.assign(scene.render.world, { drawSpawnZones() {} });
    scene._boardW = -1;                       // 强制 deployUnits 走一次棋盘尺寸分支（写入地形键）
    scene.battleOptions.terrain = TERRAIN_KEY;
    scene.clearUnits = () => {};              // 全新场景无需清理；绕开 2D 渲染层依赖
    scene.applyBoardSize = function () { this._boardW = board.W; this._boardH = board.H; };

    // ---- 视觉钩子 → 3D 实现（覆盖原型上的 2D 委托） ----
    scene.playAttackAnim = u => { u._lungeUntil = performance.now() + 220; };
    scene.meleeImpact = (attacker, target, kind) => {
        if (throttled(kind || 'hit')) Snd.play(kind === 'thrust' ? 'stab' : kind === 'charge' ? 'charge' : 'hit');
        puff(target.gx, target.gy);
    };
    // 2D 钩子契约：血液/落尘钩子收的是等距屏幕坐标（gridToScreen 系），先反解回网格
    const s2g = (sx, sy) => { const a = (sx - OX) / (TW / 2), b = (sy - OY) / (TH / 2); return [(a + b) / 2, (b - a) / 2]; };
    const onField = (gx, gy) => gx > -2 && gx < 72 && gy > -2 && gy < 72;
    scene.bloodBurst = (sx, sy, n = 6, power = 95, k = 1) => {
        const [gx, gy] = s2g(sx, sy);
        if (!onField(gx, gy)) return;
        sprayBlood(gx, gy, Math.max(4, Math.round(n * .8)), power, k);           // 空中喷溅
        if (Math.random() < .8) addBlood(gx, gy, (.22 + Math.random() * .3) * Math.max(.7, k));   // 地面底渍
    };
    scene.addGroundBlood = (sx, sy, s) => { const [gx, gy] = s2g(sx, sy); if (onField(gx, gy)) addBlood(gx, gy, .25 + s * .2); };
    scene.addBloodPool = (sx, sy, s) => { const [gx, gy] = s2g(sx, sy); if (onField(gx, gy)) addBlood(gx, gy, .5 + s * .4); };
    scene.flushBloodQueue = () => {};
    scene.chargeDust = u => { if (Math.random() < .4) puff(u.gx, u.gy, true); };
    scene.impactPuff = (sx, sy) => { const [gx, gy] = s2g(sx, sy); if (onField(gx, gy)) puff(gx, gy); };
    scene.sparkBurst = () => {}; scene.slashArc = () => {};
    scene.spawnOrderText = () => {}; scene.orderFlash = () => {};
    scene.drawTactics = () => {}; scene.drawFlags = () => {}; scene.stampCorpse = () => {};
    scene.updateBloods = () => {};

    // 尸体记录：真 killUnit 继续跑（计数/阵亡音/血），3D 侧顺手盖印尸体
    const realKill = scene.killUnit;
    scene.killUnit = function (unit, from) {
        recordCorpse(unit, from);
        return realKill.call(this, unit, from);
    };

    // 先部署并重排单位，再排队添加本场墙体；第一步由开战后的主循环推进。
    scene.deployUnits(ATTACKERS, DEFENDERS, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: TERRAIN_KEY });
    positionArmies();
    queueCampWalls(scene);
    refreshCampVisuals();
    if (!groundBuilt) { buildGround(board.W, board.H); groundBuilt = true; }
    sync3D._t = 0;
    sync3D(0, performance.now());
}

// ---------------- 尸体 ----------------
const corpseCursor = { infantry: 0, pikeman: 0, archer: 0, cavalry: 0 };
// ---------------- 死亡倒下：先翻倒（物理滑移），落定后尸体留在原地 ----------------
// 复用尸体实例槽做动画：死亡瞬间写入直立姿态，0.6s 内绕脚底水平轴翻到平躺，
// 与 2D 死亡序列（命中→定向倒下→落地尘土→盖印）对齐。倒向确定性取自攻击者方位/生前速度。
const falling = [];
const _up = new THREE.Vector3(0, 1, 0), _faxis = new THREE.Vector3();
const _qf = new THREE.Quaternion(), _qy = new THREE.Quaternion();
function writeFall(f, p) {
    // 前 15% 是命中僵直，之后加速翻倒；滑移三次缓出（同 2D drift）
    const tp = p < .15 ? 0 : (p - .15) / .85;
    const theta = tp * tp * Math.PI / 2;
    const drift = 1 - Math.pow(1 - p, 3);
    dummy.position.set(f.x + f.slideX * drift, f.y + f.platformLift * (1 - p) + f.lift * Math.sin(theta), f.z + f.slideZ * drift);
    _qf.setFromAxisAngle(_faxis.set(f.fz, 0, -f.fx), theta);
    _qy.setFromAxisAngle(_up, f.yaw);
    dummy.quaternion.copy(_qf.multiply(_qy));
    dummy.scale.setScalar(1); dummy.updateMatrix();
    corpseMeshes[f.kind].setMatrixAt(f.slot, dummy.matrix);
    corpseMeshes[f.kind].instanceMatrix.needsUpdate = true;
}
function recordCorpse(u, from) {
    if (!UNIT_KINDS.includes(u.type)) return;
    const kind = u.type, i = corpseCursor[kind]++ % CAP[kind];
    corpseMeshes[kind].count = Math.min(corpseCursor[kind], CAP[kind]);
    // 尸体槽也挂队伍色：死亡瞬间不掉色（活体槽随单位移除即复用）
    _teamColor.setHex(TEAM_COLOR[u.team]);
    corpseMeshes[kind].setColorAt(i, _teamColor);
    if (corpseMeshes[kind].instanceColor) corpseMeshes[kind].instanceColor.needsUpdate = true;
    const yaw = headings.get(u.id)?.a ?? (u.team === 'red' ? Math.PI / 2 : -Math.PI / 2);   // headings 存的是 {a, bob} 状态对象
    let fx, fz, slideX = 0, slideZ = 0;
    if (kind === 'cavalry') {
        // 骑兵：沿生前速度滑移 + 侧倒（马向侧面翻）
        const vx = u.velX || 0, vz = u.velY || 0, sp = Math.hypot(vx, vz);
        if (sp > .3) { const s = Math.min(1.4, sp * .1); slideX = vx / sp * s; slideZ = vz / sp * s; }
        fx = Math.cos(yaw); fz = -Math.sin(yaw);
        if (unitRand(u) < .5) { fx = -fx; fz = -fz; }
    } else if (from && from.gx !== undefined && !from.isBuilding) {
        // 步兵：倒离攻击者
        const dx = u.gx - from.gx, dz = u.gy - from.gy, d = Math.hypot(dx, dz);
        if (d > 1e-3) { fx = dx / d; fz = dz / d; }
    }
    if (fx === undefined) { const a = unitRand(u) * Math.PI * 2; fx = Math.sin(a); fz = Math.cos(a); }
    // 尸体躺平后跨 ~1.5 格：高度取身体跨度内最高点，避免上坡侧被地形吞掉
    const span = kind === 'cavalry' ? 1.5 : 1.1;
    let cy = groundH(u.gx, u.gy);
    for (const t of [.5, 1]) cy = Math.max(cy, groundH(u.gx + fx * span * t, u.gy + fz * span * t));
    const f = { kind, slot: i, x: u.gx - board.W / 2, z: u.gy - board.H / 2, y: cy,
        yaw, fx, fz, slideX, slideZ, platformLift: u.siegeClimb ? climberWorldHeight(u.siegeClimb) : (scene.siege?.heightAt(u.gx, u.gy) ?? 0) * H_WORLD,
        start: scene.simulationTime, dur: kind === 'cavalry' ? 760 : 600,   // 模拟时钟：暂停冻结/倍速同步
        lift: kind === 'cavalry' ? .3 : .16, puffed: false };
    falling.push(f);
    writeFall(f, 0);   // 立即写直立姿态，接棒活体槽，无缝换岗
    addBlood(u.gx, u.gy, kind === 'cavalry' ? .8 : .5);
}

// ---------------- 每帧同步：模拟状态 → 实例矩阵 ----------------
let hudWinner = null;
function sync3D(dt, now) {
    const siege = scene.siege;
    if (siege?.ram && ramVisual) {
        updateRamVisual(ramVisual, siege.ram, scene.simulationTime, groundH(siege.ram.gx, siege.ram.gy));
        updateCampGate(campVisuals, siege.gate, scene.simulationTime);
        if (siege.ram.hits > heardRamHits) { Snd.play('hit'); heardRamHits = siege.ram.hits; }
        if (siege.gate.broken && !heardGateBreak) { Snd.play('die'); heardGateBreak = true; }
    }
    let cursor = { infantry: 0, pikeman: 0, archer: 0, cavalry: 0 };
    for (const u of scene.units) {
        if (u.dead || u.withdrawn) continue; // 尸体由独立实例层接管，不等模拟数组周期压实。
        const kind = u.type, mesh = unitMeshes[kind], slot = cursor[kind]++;
        if (slot >= CAP[kind]) continue;
        // 朝向：跟随实际位移（短弧平滑），静止保持
        let st = headings.get(u.id);
        if (!st) st = { a: u.team === 'red' ? Math.PI / 2 : -Math.PI / 2, bob: Math.random() * 6 };
        if (u.siegeRole === 'ram') st.a = Math.PI;
        if (u.moving) {
            const target = Math.atan2(u.velX ?? 0, u.velY ?? 0);
            if ((u.velX ?? 0) ** 2 + (u.velY ?? 0) ** 2 > 1e-6) {
                let d = target - st.a;
                d = Math.atan2(Math.sin(d), Math.cos(d));
                st.a += d * Math.min(1, dt * 10);
            }
        }
        if (u.siegeClimb) {
            const { foot, top } = u.siegeClimb.ladder;
            st.a = Math.atan2(top.gx - foot.gx, top.gy - foot.gy);
        }
        headings.set(u.id, st);
        const bob = u.moving ? Math.abs(Math.sin(now * .012 + st.bob)) * .09 : 0;
        const lunge = u._lungeUntil > now ? .18 * Math.sin(Math.min(1, (u._lungeUntil - now) / 220) * Math.PI) : 0;
        const y = u.siegeClimb ? groundH(u.gx, u.gy) + climberWorldHeight(u.siegeClimb) : surfaceH(u.gx, u.gy);
        dummy.position.set(u.gx - board.W / 2 + Math.sin(st.a) * lunge, y + bob, u.gy - board.H / 2 + Math.cos(st.a) * lunge);
        dummy.rotation.set(u.moving && u.type === 'cavalry' ? .12 : 0, st.a, 0);
        dummy.scale.setScalar(1); dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        setTeamColor(u, slot);        // 颜色跟单位走（阵亡移除会改变槽位分配）
    }
    for (const kind of UNIT_KINDS) {
        const mesh = unitMeshes[kind];
        for (let i = cursor[kind]; i < mesh.count; i++) { dummy.position.set(0, -50, 0); dummy.scale.setScalar(1e-4); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); }
        mesh.count = cursor[kind];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // 箭矢：直接读模拟层的飞行数据。高度契约同 2D arrowPoint：端点插值已是绝对
    // 地形高度，不再叠加中途 groundH（坡地上会双重抬高、随地形起伏穿帮）。
    const arrows = scene.arrows;
    for (let i = 0; i < Math.min(arrows.length, 300); i++) {
        const a = arrows[i], p = Math.min(1, a.t / a.dur);
        const gx = a.sx + (a.tx - a.sx) * p, gy = a.sy + (a.ty - a.sy) * p;
        const hgt = (a.sourceHeight || 0) * (1 - p) + (a.targetHeight || 0) * p;
        dummy.position.set(gx - board.W / 2, hgt * H_WORLD + Math.sin(p * Math.PI) * arrowArc(a) + .5, gy - board.H / 2);
        // 姿态沿弹道切线：水平速度恒定 + 垂直分量为高度插值与正弦弧的导数 → 上仰/下俯
        arrowVel(a, p, _bv);
        _av.copy(dummy.position).add(_bv);
        dummy.lookAt(_av);
        dummy.scale.setScalar(1); dummy.updateMatrix();
        arrowMesh.setMatrixAt(i, dummy.matrix);
    }
    arrowMesh.count = Math.min(arrows.length, 300);
    arrowMesh.instanceMatrix.needsUpdate = true;
    // 死亡倒下推进：翻倒加速 + 滑移缓出，落定瞬间扬尘（走模拟时钟，暂停即冻结）
    const simNow = scene.simulationTime;
    for (let i = falling.length - 1; i >= 0; i--) {
        const f = falling[i], p = Math.min(1, (simNow - f.start) / f.dur);
        writeFall(f, p);
        if (!f.puffed && p >= .88) { f.puffed = true; puff(f.x + board.W / 2 + f.slideX, f.z + board.H / 2 + f.slideZ, f.kind === 'cavalry'); }
        if (p >= 1) falling.splice(i, 1);
    }
    updateBloodP(simNow);   // 血粒子抛物线推进（同一模拟时钟）
    // 尘土衰减
    for (const d of dustPool) {
        if (d.life <= 0) { if (d.m.visible) d.m.visible = false; continue; }
        d.life -= dt;
        const k = Math.max(0, d.life / d.max);
        d.m.material.opacity = k * .4;
        d.m.scale.setScalar(d.m.scale.x + dt * 1.6);
        if (d.life <= 0) d.m.visible = false;
    }
    // HUD
    if ((!sync3D._t || now - sync3D._t > 400) && scene) {
        sync3D._t = now;
        const fps = Math.round(sync3D._fps || 0);
        const p = sync3D._perf || {};
        hud.innerHTML = `<span style="color:${fps >= 55 ? '#9cf5a0' : fps >= 30 ? '#ffd24a' : '#ff6b6b'}">${fps} FPS</span>` +
            ` · sim <b>${(p.simMs || 0).toFixed(1)}</b>/sync <b>${(p.syncMs || 0).toFixed(1)}</b>/draw <b>${(p.renderMs || 0).toFixed(1)}</b>ms` +
            ` · 存活 <b class="red">${scene.redAlive}</b> / <b class="blue">${scene.blueAlive}</b> · 阵亡 ${scene.deadCount}` +
            (siege?.gate ? ` · ${siege.gate.broken ? '寨门已破' : `寨门 ${siege.gate.hp}/${siege.gate.maxHp}`}` : '') +
            (siege?.ladders ? ` · 登墙 ${siege.landedCount}` : '') +
            (hudWinner ? ` —— <b style="color:#ffd24a">${hudWinner}</b>` : '');
    }
}

// ---------------- 主循环 ----------------
let last = performance.now(), fpsAcc = 0, fpsN = 0;
renderer.setAnimationLoop(now => {
    const realGap = now - last; last = now;
    const delta = Math.min(realGap, 50);
    fpsAcc += realGap; fpsN++; if (fpsAcc > 400) { sync3D._fps = 1000 * fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    const _t0 = performance.now();
    if (scene && scene.battleStarted && !scene.paused && !scene.battleOver) {
        // 同一套确定性推进（stepBattle 与 2D 完全一致，箭矢弹道与命中在步内推进）。
        // 接战期每步 ~13.6ms，无上限追帧会死亡螺旋（欠账→补 3 步→更慢→锁死 ~17fps）；
        // 每帧最多 2 步，落后时丢账让模拟节奏稍放慢（与 net 路径 catchUp 同思路），
        // 步序不变，换边镜像不受影响。
        scene.simulationAccumulator += Math.max(0, Math.min(delta, 50)) * scene.gameSpeed;
        let steps = 0;
        while (scene.simulationAccumulator + 1e-7 >= SIMULATION_STEP_MS && !scene.battleOver && steps < 2) {
            scene.simulationAccumulator = Math.max(0, scene.simulationAccumulator - SIMULATION_STEP_MS);
            scene.simulationTime += SIMULATION_STEP_MS;
            stepBattle(scene, SIMULATION_STEP_MS / 1000);
            steps++;
        }
        if (steps === 2 && scene.simulationAccumulator > SIMULATION_STEP_MS) scene.simulationAccumulator = SIMULATION_STEP_MS;
    }
    if (!sync3D._perf) sync3D._perf = { simMs: 0, syncMs: 0, renderMs: 0 };
    sync3D._perf.simMs = performance.now() - _t0;
    const _t1 = performance.now();
    if (scene) { refreshCampVisuals(); sync3D(scene.battleStarted && !scene.paused && !scene.battleOver ? delta / 1000 * scene.gameSpeed : 0, now); }
    sync3D._perf.syncMs = performance.now() - _t1;
    controls.update();
    const _t2 = performance.now();
    renderer.render(scene3d, camera);
    sync3D._perf.renderMs = performance.now() - _t2;
});

// ---------------- 控件 ----------------
// 只读观察入口供截图/HUD 验收，模拟仍由主循环推进。
window.__siege = { camera, controls, getScene: () => scene, unitMeshes, corpseMeshes, bloodMesh, renderer, scene3d,
    get campVisuals() { return campVisuals; },
    get bloodCursor() { return bloodCursor; }, get corpseCursor() { return corpseCursor; } };
let deploying = false;
async function redeploy() {
    if (deploying) return;
    deploying = true;
    $('btn-start').disabled = true; $('btn-start').textContent = '部署中…';
    $('gate').hidden = false;
    if (scene) scene.battleStarted = false;
    hudWinner = null; headings.clear(); lastSound = {};
    bloodCursor = bloodPCursor = 0; bloodP.length = falling.length = 0;
    bloodMesh.count = bloodPMesh.count = arrowMesh.count = 0;
    for (const kind of UNIT_KINDS) { corpseCursor[kind] = 0; corpseMeshes[kind].count = unitMeshes[kind].count = 0; }
    for (const d of dustPool) { d.life = 0; d.m.visible = false; }
    $('btn-pause').textContent = '暂停';
    for (const id of ['btn-s1', 'btn-s2', 'btn-s4']) $(id).style.fontWeight = id === 'btn-s1' ? '700' : '400';
    try {
        await boot();
        $('btn-start').disabled = false; $('btn-start').textContent = '开 战';
    } catch (error) {
        console.error(error); hud.textContent = '部署失败，请查看控制台';
        $('btn-start').textContent = '部署失败';
    } finally { deploying = false; }
}
$('btn-start').onclick = () => {
    if (deploying || !scene) return;
    $('gate').hidden = true; Snd.play('go'); scene.battleStarted = true;
};
$('btn-pause').onclick = e => { if (!scene || deploying) return; scene.paused = !scene.paused; e.target.textContent = scene.paused ? '继续' : '暂停'; };
for (const [id, v] of [['btn-s1', 1], ['btn-s2', 2], ['btn-s4', 4]]) {
    $(id).onclick = () => { if (!scene || deploying) return; scene.gameSpeed = v;
        for (const b of [$('btn-s1'), $('btn-s2'), $('btn-s4')]) b.style.fontWeight = '400';
        $(id).style.fontWeight = '700'; };
}
$('btn-reset').onclick = redeploy;
redeploy();
