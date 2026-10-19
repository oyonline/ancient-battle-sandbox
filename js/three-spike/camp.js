// ==================== 3D 木栅营寨展示页（静态小样，不接模拟） ====================
// 目的：在接线进真实 3D 战场之前，先把「齐胸栅栏 + 内侧踩台」的新口径做成可旋转的立体样张，
// 让体量/比例（栅顶高度、守军露头肩、大帐体量、箭塔高台）一眼可判。
// 口径与 js/battle/camps.js 的 CAMP_RULES 对齐（前线营寨），但完全不读取模拟状态。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---- 换算链：世界高度 = px / 24 × 2（Terrain.HEIGHT_SCALE = 24，spike 的 H_WORLD = 2）----
// 兵高 ≈ 1.145 世界单位（腿 0→0.42、躯干 0.43→0.93、头到 1.145）。
const H_WORLD = 2.0;
const WALL_R = 3.2;                       // 前线营寨墙环半径（外扩后；大本营为 3.5）
const WALL_SLOTS = 6;                     // 垛口数 = 周长等分
const GATE_HALF = 1.2;                    // +gy 侧寨门半宽（2D 已有此约定：中间留 2 段缺口）
const POST_STEP = 0.2;                    // 桩间距：一圈 8r=25.6 → ≈128 根
const FENCE_TOP = 1.75;                   // 齐胸栅栏顶面（≈1.53 兵高）＝ 21px
const WALKWAY_H = 1.0;                    // 内侧踩台面（守军脚底）＝ 12px
const FENCE_TOP_OLD = 3.5;                // 对照：旧口径 42px 桩
const GUARD_FEET_OLD = 28 / 24 * H_WORLD; // 对照：旧口径守军抬 28px 站墙顶
const HALL_R = 1.6, TOWER_R = 0.9;
// 箭塔平台：2D 贴图里 82px 是 sprite 视觉偏移，3D 不能当真 6.83 世界单位。
// 取 ~3.2（≈2.8 兵高），仍能俯射栅栏外但腿不夸张。
const TOWER_DECK = 3.2;
const TEAM = 'red', TEAM_COLOR = 0xc4553f;

// ---- 调色板（与 2D 营寨美术同族） ----
const WOOD = 0x8a6b42, TIMBER = 0x785535;
const CANVAS = 0xe8e2cf, CANVAS_DK = 0xcfc8b2;
const STEEL = 0xd8d4cc, DARK = 0x5a5448, SKIN = 0xd9b08c, METAL = 0xe8e6df;
const GROUND = 0x6f7d4c;

const $ = id => document.getElementById(id);

// ---------------- 基础几何（盒子/锥体统一涂顶点色，便于 mergeGeometries 合成单网格） ----------------
function tint(geo, color) {
    const n = geo.attributes.position.count, arr = new Float32Array(n * 3);
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
}
function box(w, h, d, x, y, z, color, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return tint(g, color);
}
function cone(r, h, x, y, z, color, ry = 0) {
    const g = new THREE.ConeGeometry(r, h, 4);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return tint(g, color);
}
const campMat = new THREE.MeshLambertMaterial({ vertexColors: true });

// ---------------- 低模兵坯（步卒/弓手，朝向 +Z） ----------------
function soldierGeo(kind) {
    const parts = [];
    parts.push(box(.13, .42, .15, -.11, .21, 0, DARK), box(.13, .42, .15, .11, .21, 0, DARK));   // 腿
    parts.push(box(.36, .5, .24, 0, .68, 0, STEEL));                                            // 躯干
    parts.push(box(.19, .19, .19, 0, 1.05, 0, SKIN));                                           // 头
    if (kind === 'archer') parts.push(box(.05, .8, .05, .16, .75, .12, WOOD, 0, .15));          // 弓
    else {
        parts.push(box(.3, .42, .05, -.26, .68, .1, 0x946339));                                  // 盾
        parts.push(box(.05, .5, .05, .24, .8, .1, METAL, 0, -.4));                               // 剑
    }
    return mergeGeometries(parts);
}
const guardGeo = { infantry: soldierGeo('infantry'), archer: soldierGeo('archer') };
const guardMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: TEAM_COLOR });
const refMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xd6d9cc });   // 体量参照兵（不上队伍色）

function soldierMesh(kind, mat, x, y, z, yaw = 0) {
    const m = new THREE.Mesh(guardGeo[kind], mat);
    m.position.set(x, y, z); m.rotation.y = yaw;
    m.castShadow = true; m.receiveShadow = true;
    return m;
}

// ---------------- 墙环几何：与 js/battle/camps.js 的 wallPointAt 同口径 ----------------
function wallPoint(t, r) {
    const side = 2 * r, per = 8 * r;
    const s = ((t % per) + per) % per;
    const corners = [[-r, -r], [r, -r], [r, r], [-r, r]];
    const i = Math.min(3, Math.floor(s / side));
    const k = (s - i * side) / side;
    const [x0, y0] = corners[i], [x1, y1] = corners[(i + 1) % 4];
    return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
}
const inward = (gx, gy) => { const l = Math.hypot(gx, gy) || 1; return [gx - gx / l * .35, gy - gy / l * .35]; };

// ---------------- 木栅墙（栅栏 + 一道横撑 + 踏板 + 垛口守军） ----------------
// platformH：守军踏板面高（新口径 = 内侧踩台 1.0；旧口径 = 墙顶 2.33），null 表示不设踏板。
function fenceGroup(fenceTop, platformH) {
    const parts = [], r = WALL_R, side = 2 * r, per = 8 * r;
    const railY = fenceTop * .55;
    for (let t = 0; t < per - 1e-9; t += POST_STEP) {
        const [gx, gy] = wallPoint(t, r);
        if (gy >= r - 1e-6 && Math.abs(gx) < GATE_HALF) continue;      // +gy 侧留寨门
        parts.push(box(.13, fenceTop, .16, gx, fenceTop / 2, gy, WOOD));
    }
    // 一道横撑（尖头省略）
    parts.push(box(side, .09, .09, 0, railY, -r, TIMBER));
    parts.push(box(side, .09, .09, 0, railY, r, TIMBER));               // 前缘被门剖开，下面重铺门两侧
    parts.push(box(r - GATE_HALF, .09, .09, -(GATE_HALF + (r - GATE_HALF) / 2), railY, r, TIMBER));
    parts.push(box(r - GATE_HALF, .09, .09, (GATE_HALF + (r - GATE_HALF) / 2), railY, r, TIMBER));
    parts.push(box(.09, .09, side, r, railY, 0, TIMBER));
    parts.push(box(.09, .09, side, -r, railY, 0, TIMBER));
    const group = new THREE.Group();
    if (platformH) {   // 踏板：新口径是内侧踩台，旧口径是墙顶窄台
        const w = .5, inset = .35;
        parts.push(box(side, platformH, w, 0, platformH / 2, -r + inset, WOOD));
        parts.push(box(side, platformH, w, 0, platformH / 2, r - inset, WOOD));
        parts.push(box(w, platformH, side, r - inset, platformH / 2, 0, WOOD));
        parts.push(box(w, platformH, side, -r + inset, platformH / 2, 0, WOOD));
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    // 垛口守军：站到踏板上，朝向场外
    const feet = platformH ?? 0;
    for (let i = 0; i < WALL_SLOTS; i++) {
        const [gx, gy] = wallPoint(i * per / WALL_SLOTS, r);
        const [px, py] = inward(gx, gy);
        group.add(soldierMesh('infantry', guardMat, px, feet, py, Math.atan2(gx, gy)));
    }
    return group;
}

// ---------------- 大帐（锥顶帐 + 门帘 + 旗，尺度收窄到 footprint 2.0×2.0） ----------------
function hallGroup() {
    const parts = [
        box(2.0, 1.0, 2.0, 0, .5, 0, CANVAS),                             // 帐体
        cone(1.5, 1.2, 0, 1.0 + .6, 0, CANVAS_DK, Math.PI / 4),           // 四棱锥帐顶
        box(.65, .7, .12, 0, .35, 1.0, 0x4a3a28),                        // 门帘
        box(.06, 2.6, .06, 0, 1.3, 0, TIMBER),                           // 旗杆
        box(.7, .4, .04, .4, 2.35, 0, TEAM_COLOR)                        // 队旗
    ];
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const group = new THREE.Group(); group.add(mesh);
    group.position.set(0, 0, 0);
    return group;
}

// ---------------- 寨门（+gy 侧缺口：两扇木门 + 横梁 + 门栓） ----------------
function gateGroup() {
    const GATE_H = 1.9, GATE_D = .08, BEAM_W = 2.6;
    // 两扇门（朝内斜开 ±18°，露出门缝）
    const doorL = new THREE.Mesh(mergeGeometries([
        box(GATE_HALF - .02, GATE_H, GATE_D, -(GATE_HALF - .02) / 2, GATE_H / 2, 0, WOOD)
    ]), campMat);
    doorL.position.set(-(GATE_HALF - .02) / 2 - .02, 0, WALL_R + GATE_D / 2);
    doorL.rotation.y = -Math.PI / 10;
    doorL.castShadow = true; doorL.receiveShadow = true;
    const doorR = new THREE.Mesh(mergeGeometries([
        box(GATE_HALF - .02, GATE_H, GATE_D, (GATE_HALF - .02) / 2, GATE_H / 2, 0, WOOD)
    ]), campMat);
    doorR.position.set((GATE_HALF - .02) / 2 + .02, 0, WALL_R + GATE_D / 2);
    doorR.rotation.y = Math.PI / 10;
    doorR.castShadow = true; doorR.receiveShadow = true;
    // 上方横梁 + 门栓
    const parts = [
        box(BEAM_W, .14, .14, 0, GATE_H + .07, WALL_R + .07, TIMBER),
        box(GATE_HALF * 2 - .2, .08, .05, 0, GATE_H * .55, WALL_R + GATE_D / 2 + .04, 0x4a3a28)
    ];
    const beamBolt = new THREE.Mesh(mergeGeometries(parts), campMat);
    beamBolt.castShadow = true; beamBolt.receiveShadow = true;
    const group = new THREE.Group();
    group.add(doorL, doorR, beamBolt);
    return group;
}

// ---------------- 梯子（箭塔竖梯 + 寨墙靠墙梯） ----------------
// 用于视觉占位：箭塔侧面竖梯、寨墙缺口旁靠墙梯子，暗示进攻方登塔/翻墙路径。
// 本次展示页只做纯视觉，sim 攻城机制暂缓。
function ladderGroup() {
    const parts = [], group = new THREE.Group();
    // --- 1. 箭塔竖梯：贴 (TOWER_DECK 里 x=+.65, z=+.65) 那条 leg ---
    const legX = .65, legZ = .65;
    const LAD_H = TOWER_DECK + .3;
    const railGap = .26;
    parts.push(box(.05, LAD_H, .05, legX - railGap / 2, LAD_H / 2, legZ - .08, TIMBER));
    parts.push(box(.05, LAD_H, .05, legX + railGap / 2, LAD_H / 2, legZ - .08, TIMBER));
    for (let y = .3; y < TOWER_DECK; y += .35)
        parts.push(box(railGap + .04, .05, .05, legX, y, legZ - .08, 0x6b4a2a));
    // --- 2. 寨墙靠墙梯 ×2：分别架在 +gx 侧（x=r 墙段）和 -gx 侧（x=-r 墙段）各一架 ---
    // 墙段上用 wallPoint 取两个 z 位置，梯子斜靠（底部距墙 .45，顶部靠踩台 1.3 高）
    const wallLadder = (wx, wz) => {
        const topY = WALKWAY_H + .2, baseOffset = .45;
        // 竖撑两根（沿斜向）
        const angle = Math.atan2(topY, baseOffset);
        const lx = wx < 0 ? wx - .3 : wx + .3;   // 梯子在墙外
        const lz = wz;
        const len = Math.hypot(baseOffset, topY);
        parts.push(box(.04, len, .04, lx - .1, topY / 2, lz, TIMBER, 0, -angle));
        parts.push(box(.04, len, .04, lx + .1, topY / 2, lz, TIMBER, 0, -angle));
        // 横档
        for (let t = .3; t < len; t += .3) {
            const ty = (t / len) * topY;
            const tx = lx + (t / len) * (baseOffset * Math.sign(wx));
            parts.push(box(.26, .04, .04, tx, ty, lz, 0x6b4a2a));
        }
    };
    wallLadder(-WALL_R, -1.2);   // -gx 侧（x=-r 墙段）外侧
    wallLadder( WALL_R,  1.2);   // +gx 侧（x=+r 墙段）外侧
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return group;
}

// ---------------- 箭塔（四腿高台 + 垛口 + 锥顶 + 驻塔弓手） ----------------
function towerGroup() {
    const deck = TOWER_DECK, parts = [
        box(1.7, .16, 1.7, 0, deck + .08, 0, 0xbf9d66),                // 平台
        box(.09, .42, 1.7, 0, deck + .45, -.8, WOOD),                  // 后垛口
        box(1.7, .42, .09, 0, deck + .45, .8, WOOD),                    // 侧垛口
        box(.09, .42, 1.7, -0.8, deck + .45, 0, WOOD),
        cone(1.55, .95, 0, deck + 1.25, 0, 0xab976b, Math.PI / 4),       // 顶棚
        box(.06, 2.3, .06, .8, deck + 1.0, .8, TIMBER),
        box(.7, .42, .04, 1.1, deck + 1.7, .8, TEAM_COLOR)             // 队旗
    ];
    for (const [x, z] of [[-.65, -.65], [.65, -.65], [-.65, .65], [.65, .65]])
        parts.push(box(.16, deck, .16, x, deck / 2, z, TIMBER));
    for (const [x, z, rz, rx] of [[-.65, 0, .5, 0], [.65, 0, -.5, 0]])
        parts.push(box(.09, deck * 1.02, .09, x, deck / 2, z, 0x8b633e, 0, rz));   // 斜撑
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    const px = WALL_R + 1.2, pz = WALL_R + .2;
    for (const [ox, oz] of [[-.35, 0], [.35, 0]])
        group.add(soldierMesh('archer', guardMat, px + ox, deck + .16, pz + oz, Math.atan2(WALL_R, 0)));
    group.position.set(px, 0, pz);
    return group;
}

// ---------------- 场景 ----------------
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#b9c5ab');
scene.fog = new THREE.Fog('#b9c5ab', 34, 78);

const camera = new THREE.PerspectiveCamera(45, 1, .1, 200);
camera.position.set(9, 9.5, 14.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true; controls.dampingFactor = .08;
controls.maxPolarAngle = 1.5; controls.minDistance = 3; controls.maxDistance = 46;

function resize() {
    let w = viewport.clientWidth, h = viewport.clientHeight;
    // browser_use 等无头环境里 viewport 可能是 0×0，退而用 window 尺寸
    if (!w || !h) { w = window.innerWidth; h = window.innerHeight; viewport.style.width = w + 'px'; viewport.style.height = h + 'px'; }
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
// ResizeObserver 首次回调可能延迟，立刻跑一次确保无头环境也能初始化
resize();

scene.add(new THREE.HemisphereLight('#fff5da', '#556547', 1.45));
const sun = new THREE.DirectionalLight('#fff0cb', 1.85);
sun.position.set(-9, 16, 11); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, far: 60 });
sun.shadow.normalBias = .04;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(44, 44, 1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1 }));
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(24, 24, 0x5b6a43, 0x66754e);
grid.material.transparent = true; grid.material.opacity = .18; grid.position.y = .012;
scene.add(grid);

// 参照兵：站在门前，标定 1.145 兵高
scene.add(soldierMesh('infantry', refMat, 0, 0, WALL_R + 2.2, Math.PI));

const fixed = new THREE.Group();
fixed.add(hallGroup(), towerGroup(), gateGroup(), ladderGroup());
scene.add(fixed);
const chestHigh = fenceGroup(FENCE_TOP, WALKWAY_H);              // 新口径：齐胸栅栏 + 内侧踩台
const wallTop = fenceGroup(FENCE_TOP_OLD, GUARD_FEET_OLD);       // 旧口径：高栅栏 + 守军站墙顶窄台
scene.add(chestHigh, wallTop);
wallTop.visible = false;

$('btn-toggle').onclick = e => {
    const toOld = chestHigh.visible;
    chestHigh.visible = !toOld; wallTop.visible = toOld;
    e.target.textContent = toOld ? '口径：站墙顶（旧）· 点击切回齐胸' : '口径：齐胸栅栏（新）· 点击对照旧口径';
    $('hud').classList.toggle('old', toOld);
};

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

window.__camp = { scene, camera, controls, chestHigh, wallTop, renderer };
