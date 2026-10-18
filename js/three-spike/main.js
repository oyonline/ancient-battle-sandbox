// ==================== 3D 战争感验证 spike（不动 2D 任何现有代码） ====================
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
import { UNIT_TYPES, CavalryAI, unitRand } from '../units.js';
import { board } from '../board.js';
import { stepBattle, SIMULATION_STEP_MS } from '../battle/core.js';

window.Snd = Snd;   // game.js / render 钩子里以全局 Snd 出声（die/win/arrow）

const TERRAIN_KEY = 'red_pass';      // 自带坡地，3D 里高差可读
const H_WORLD = 2.0;                 // 1 个 2D 高度单位 ≈ 2 世界格：坡地 readable 优先
const CLASSIC = { infantry: 300, pikeman: 60, archer: 80, cavalry: 60 };   // 500 v 500
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
        parts.push(part(1.5, .5, .55, 0, .78, 0, 0x9c7a52));                       // 马身
        parts.push(part(.28, .55, .5, 0, 1.15, .62, 0x9c7a52, .5));                // 马颈
        parts.push(part(.24, .26, .5, 0, 1.5, .88, 0x836544));                     // 马头
        for (const [x, z] of [[-.5, .45], [.5, .45], [-.5, -.45], [.5, -.45]])
            parts.push(part(.14, .6, .14, x, .3, z, 0x7a5f3e));                    // 马腿
        parts.push(part(.4, .5, .3, 0, 1.25, -.05, STEEL));                        // 骑手躯干
        parts.push(part(.2, .2, .2, 0, 1.62, -.05, SKIN));                         // 骑手头
        parts.push(part(.05, .8, .05, .3, 1.45, .25, METAL, 0, -.6));              // 骑枪
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
const CAP = { infantry: 700, pikeman: 160, archer: 200, cavalry: 160 };
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
    _teamColor.setHex(TEAM_COLOR[u.team]);
    if (u.type === 'cavalry') _teamColor.multiplyScalar(.9);
    unitMeshes[u.type].setColorAt(slot, _teamColor);
}

// 血渍 / 尘土 / 箭矢
const BLOOD_CAP = 6000;
const bloodMesh = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4a0f0c, transparent: true, opacity: .8, depthWrite: false }), BLOOD_CAP);
bloodMesh.count = 0; bloodMesh.frustumCulled = false; bloodMesh.renderOrder = 1;
scene3d.add(bloodMesh);
let bloodCursor = 0;
function addBlood(gx, gy, r) {
    const i = bloodCursor++ % BLOOD_CAP;
    bloodMesh.count = Math.min(bloodCursor, BLOOD_CAP);
    dummy.position.set(gx - 35, groundH(gx, gy) + .03 + i * 1e-5, gy - 35);
    dummy.rotation.set(0, Math.random() * Math.PI, 0);
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
    d.m.position.set(gx - 35, groundH(gx, gy) + .2, gy - 35);
    d.m.scale.setScalar(big ? .5 : .3); d.m.visible = true;
}
const arrowMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(.022, .022, .62, 5).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xe8d7a1 }), 300);
arrowMesh.count = 0; arrowMesh.frustumCulled = false;
scene3d.add(arrowMesh);

const dummy = new THREE.Object3D();
const _av = new THREE.Vector3(), _bv = new THREE.Vector3();
// 弹道切线（p 处导数）：水平线性 + 高度端点插值 + 正弦弧的导数；箭几何沿 +Z，配 lookAt 出俯仰
function arrowVel(a, p, out) {
    out.set(a.tx - a.sx,
        ((a.targetHeight || 0) - (a.sourceHeight || 0)) * H_WORLD + Math.cos(p * Math.PI) * Math.PI * 1.1,
        a.ty - a.sy);
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
    return out;
}

// ---------------- 2D 模拟场景（真模拟 + 桩渲染），钩子全部换成 3D 实现 ----------------
let scene;
const headings = new Map();      // unitId → 朝向（弧度，平滑跟随移动方向）
let lastSound = {};
function throttled(key, gap = 60) { const t = performance.now(); if (t - (lastSound[key] || 0) < gap) return false; lastSound[key] = t; return true; }

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
    scene.bloodBurst = (x, y, n = 6, power = 95, k = 1) => { if (Math.random() < .8) addBlood(x, y, (.22 + Math.random() * .3) * Math.max(.7, k)); };
    scene.addGroundBlood = (x, y, s) => addBlood(x, y, .25 + s * .2);
    scene.addBloodPool = (x, y, s) => addBlood(x, y, .5 + s * .4);
    scene.flushBloodQueue = () => {};
    scene.chargeDust = u => { if (Math.random() < .4) puff(u.gx, u.gy, true); };
    scene.impactPuff = (x, y) => puff(x, y);
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

    // ---- 经典 500 v 500 部署（与 2D 经典版同一入口） ----
    scene.deployUnits(CLASSIC, CLASSIC, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: TERRAIN_KEY });
    scene.battleStarted = true;
    buildGround(board.W, board.H);
    hud.textContent = '准备完毕';
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
    dummy.position.set(f.x + f.slideX * drift, f.y + f.lift * Math.sin(theta), f.z + f.slideZ * drift);
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
    if (kind === 'cavalry') _teamColor.multiplyScalar(.9);
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
    const f = { kind, slot: i, x: u.gx - 35, z: u.gy - 35, y: groundH(u.gx, u.gy),
        yaw, fx, fz, slideX, slideZ,
        start: scene.simulationTime, dur: kind === 'cavalry' ? 760 : 600,   // 模拟时钟：暂停冻结/倍速同步
        lift: kind === 'cavalry' ? .3 : .16, puffed: false };
    falling.push(f);
    writeFall(f, 0);   // 立即写直立姿态，接棒活体槽，无缝换岗
    addBlood(u.gx, u.gy, kind === 'cavalry' ? .8 : .5);
}

// ---------------- 每帧同步：模拟状态 → 实例矩阵 ----------------
let hudWinner = null;
function sync3D(dt, now) {
    let cursor = { infantry: 0, pikeman: 0, archer: 0, cavalry: 0 };
    for (const u of scene.units) {
        const kind = u.type, mesh = unitMeshes[kind], slot = cursor[kind]++;
        if (slot >= CAP[kind]) continue;
        // 朝向：跟随实际位移（短弧平滑），静止保持
        let st = headings.get(u.id);
        if (!st) st = { a: u.team === 'red' ? Math.PI / 2 : -Math.PI / 2, bob: Math.random() * 6 };
        if (u.moving) {
            const target = Math.atan2(u.velX ?? 0, u.velY ?? 0);
            if ((u.velX ?? 0) ** 2 + (u.velY ?? 0) ** 2 > 1e-6) {
                let d = target - st.a;
                d = Math.atan2(Math.sin(d), Math.cos(d));
                st.a += d * Math.min(1, dt * 10);
            }
        }
        headings.set(u.id, st);
        const bob = u.moving ? Math.abs(Math.sin(now * .012 + st.bob)) * .09 : 0;
        const lunge = u._lungeUntil > now ? .18 * Math.sin(Math.min(1, (u._lungeUntil - now) / 220) * Math.PI) : 0;
        const y = groundH(u.gx, u.gy);
        dummy.position.set(u.gx - 35 + Math.sin(st.a) * lunge, y + bob, u.gy - 35 + Math.cos(st.a) * lunge);
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
        dummy.position.set(gx - 35, hgt * H_WORLD + Math.sin(p * Math.PI) * 1.1 + .5, gy - 35);
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
        if (!f.puffed && p >= .88) { f.puffed = true; puff(f.x + 35 + f.slideX, f.z + 35 + f.slideZ, f.kind === 'cavalry'); }
        if (p >= 1) falling.splice(i, 1);
    }
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
    if (scene) sync3D(delta / 1000, now);
    sync3D._perf.syncMs = performance.now() - _t1;
    controls.update();
    const _t2 = performance.now();
    renderer.render(scene3d, camera);
    sync3D._perf.renderMs = performance.now() - _t2;
});

// ---------------- 控件 ----------------
window.__spike = { camera, controls, getScene: () => scene, unitMeshes, corpseMeshes, bloodMesh, puff, renderer, scene3d, falling };
let started = false;
$('btn-start').onclick = () => { $('gate').hidden = true; Snd.play('go'); started = true; boot(); };
$('btn-pause').onclick = e => { if (!scene) return; scene.paused = !scene.paused; e.target.textContent = scene.paused ? '继续' : '暂停'; };
for (const [id, v] of [['btn-s1', 1], ['btn-s2', 2], ['btn-s4', 4]]) {
    $(id).onclick = () => { if (!scene) return; scene.gameSpeed = v;
        for (const b of [$('btn-s1'), $('btn-s2'), $('btn-s4')]) b.style.fontWeight = '400';
        $(id).style.fontWeight = '700'; };
}
$('btn-reset').onclick = () => location.reload();
