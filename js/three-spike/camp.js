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

// ---------------- 寨门（+gy 侧：门柱 + 门楣 + 木门扇横木加固 + 斜撑） ----------------
// 门柱比齐胸栅栏高出一截并深入地面，门楣横跨两柱，门扇带横木加固与中缝立木，
// 两扇朝内微开露缝——这是"寨门"应有的木构架，而不是两块光板。
function gateGroup() {
    const z0 = WALL_R;                         // +gy 侧墙线（世界 z）
    const POST_T = .26, POST_H = 2.5;          // 门柱断面 / 高（高于栅顶 1.75）
    const POST_X = GATE_HALF + POST_T / 2;     // 门柱中心 x = ±1.33
    const LEAF_W = GATE_HALF - .03, LEAF_H = 2.0;
    const parts = [];
    for (const s of [-1, 1]) {
        parts.push(box(POST_T, POST_H, POST_T, s * POST_X, POST_H / 2, z0, TIMBER));       // 门柱
        parts.push(box(POST_T + .14, .18, POST_T + .14, s * POST_X, .09, z0, 0x6b6b60));   // 柱础
        parts.push(box(POST_T + .12, .12, POST_T + .12, s * POST_X, POST_H + .06, z0, 0x5a4429)); // 柱帽
    }
    // 门楣：横跨两柱 + 上方小额枋
    parts.push(box(POST_X * 2 + POST_T + .3, .22, POST_T + .04, 0, POST_H - .13, z0, TIMBER));
    parts.push(box(POST_X * 2, .13, .13, 0, POST_H + .26, z0, 0x8b633e));
    // 柱→楣 斜撑 ×2
    for (const s of [-1, 1]) {
        const brLen = Math.hypot(.52, .72);
        parts.push(box(.1, brLen, .1, s * (POST_X - .36), POST_H * .74, z0, 0x8b633e, 0, s * .63));
    }
    // 门扇：铰链在门柱内侧（局部 x=0），门板朝寨中心（dir=+1 左扇 / dir=-1 右扇）延伸
    const leafGeo = dir => {
        const g = [];
        g.push(box(LEAF_W, LEAF_H, .07, dir * LEAF_W / 2, LEAF_H / 2, 0, WOOD));         // 门板
        for (let i = 0; i < 4; i++) {                                                     // 4 道横木加固
            const y = .28 + i * (LEAF_H - .56) / 3;
            g.push(box(LEAF_W - .08, .12, .12, dir * LEAF_W / 2, y, .045, 0x6b4a2a));
        }
        g.push(box(.11, LEAF_H - .5, .11, dir * LEAF_W / 2, LEAF_H / 2, .05, 0x5f4226));  // 中缝立木
        return mergeGeometries(g);
    };
    const doorL = new THREE.Mesh(leafGeo(1), campMat);
    doorL.position.set(-GATE_HALF, 0, z0 - .08); doorL.rotation.y = Math.PI / 9;          // 左扇朝寨内开
    const doorR = new THREE.Mesh(leafGeo(-1), campMat);
    doorR.position.set(GATE_HALF, 0, z0 - .08); doorR.rotation.y = -Math.PI / 9;
    for (const m of [doorL, doorR]) { m.castShadow = true; m.receiveShadow = true; }
    const frame = new THREE.Mesh(mergeGeometries(parts), campMat);
    frame.castShadow = true; frame.receiveShadow = true;
    const group = new THREE.Group();
    group.add(frame, doorL, doorR);
    return group;
}

// ---------------- 寨墙靠墙梯 ×2（架在 ±gx 墙段外侧，从地面斜靠到踩台） ----------------
// 纯视觉占位：暗示进攻方翻墙路径。支点落在墙脚地面，顶部搭在踩台沿口。
// 注意：x=±r 墙段走向沿 Z，故梯子的倾角是绕 Z 轴（rz），且必须从地面起算（中点=两端之中点）。
function ladderGroup() {
    const parts = [], group = new THREE.Group();
    // side:-1 → 靠 x=-r 墙外侧；side:+1 → 靠 x=+r 墙外侧
    const wallLadder = (side, wz) => {
        const wallX = side * WALL_R;
        const baseX = wallX + side * .62;                 // 梯脚离墙 .62（外倾）
        const topX  = wallX + side * .04;                 // 梯顶抵住踩台沿口
        const topY  = WALKWAY_H + .38;                    // 顶端略高出踩台面
        const len   = Math.hypot(baseX - topX, topY);
        const tilt  = Math.atan2(baseX - topX, topY);     // 相对竖直的倾角（含方向符号）
        const midX  = (baseX + topX) / 2, midY = topY / 2;
        for (const dz of [-.15, .15])                     // 两根竖撑：rz=tilt 使顶端落在墙侧、底端落地外倾
            parts.push(box(.05, len, .05, midX, midY, wz + dz, TIMBER, 0, tilt));
        const steps = Math.max(3, Math.round(len / .3));
        for (let i = 1; i < steps; i++) {                 // 横档落在斜线上
            const t = i / steps;
            parts.push(box(.05, .05, .34, baseX + (topX - baseX) * t, topY * t, wz, 0x6b4a2a));
        }
    };
    wallLadder(-1, -1.2);
    wallLadder( 1,  1.2);
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return group;
}

// ---------------- 箭塔（四腿高台 + 三面垛口 + 塔梯 + 驻塔弓手，敞顶） ----------------
function towerGroup() {
    const deck = TOWER_DECK, parts = [
        box(1.7, .16, 1.7, 0, deck + .08, 0, 0xbf9d66),                // 平台
        box(.09, .42, 1.7, 0, deck + .45, -.8, WOOD),                  // 后垛口
        box(1.7, .42, .09, 0, deck + .45, .8, WOOD),                    // 侧垛口
        box(.09, .42, 1.7, -0.8, deck + .45, 0, WOOD),
        box(.06, 2.3, .06, .8, deck + 1.0, .8, TIMBER),                 // 旗杆
        box(.7, .42, .04, 1.1, deck + 1.7, .8, TEAM_COLOR)             // 队旗
    ];
    for (const [x, z] of [[-.65, -.65], [.65, -.65], [-.65, .65], [.65, .65]])
        parts.push(box(.16, deck, .16, x, deck / 2, z, TIMBER));       // 四腿
    // 塔梯：贴 -x 面（朝向寨内），从地面直上平台顶，登塔路径
    const ladTop = deck + .16, ladX = -.72;
    for (const dz of [-.14, .14])
        parts.push(box(.05, ladTop, .05, ladX, ladTop / 2, dz, TIMBER));
    for (let y = .34; y < ladTop - .08; y += .34)
        parts.push(box(.06, .05, .34, ladX, y, 0, 0x6b4a2a));
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    const px = WALL_R + 1.2, pz = WALL_R + .2;
    // 弓手站在平台上：位置用「组内局部坐标」，组再整体搬到塔位（此前多加了一次 px/pz 导致飘空）
    for (const [ox, oz] of [[-.35, 0], [.35, 0]])
        group.add(soldierMesh('archer', guardMat, ox, deck + .16, oz, Math.atan2(WALL_R, 0)));
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
    // 兜底：无头/节流环境里视口可能报 0×0，退到 window，再退到固定尺寸，保证画面可渲染
    if (!w || !h) w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) w = 1280, h = 720;
    viewport.style.width = w + 'px'; viewport.style.height = h + 'px';
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
