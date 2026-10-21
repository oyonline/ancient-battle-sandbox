// ==================== 3D 木栅营寨展示页（静态小样，不接模拟） ====================
// 目的：在接线进真实 3D 战场之前，先把「齐胸栅栏 + 内侧踩台」的新口径做成可旋转的立体样张，
// 让体量/比例（栅顶高度、守军露头肩、大帐体量、箭塔高台）一眼可判。
// 口径与 js/battle/camps.js 的 CAMP_RULES 对齐（前线营寨），但完全不读取模拟状态。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// 攻寨推演复用真实模拟口径：兵种数值与伤害结算、营寨守军倍率/掩体
import { createAssaultSim, WALL_R, wallPoint, ATTACK_KINDS, slotKind, ASSAULT_STEP_MS,
    ATK_ANIM_MS, HIT_ANIM_MS, TOWER_ARCHER_SLOTS, TOWER_ORIGINS, TOWER_HALF, ramButtonText, TENTS, LADDERS, GATE_HALF, WALK_INSET, RAM_REST, RAM_HIT, inwardPoint, viewPoint, bodyGap, poseOffset, meshPoint } from './camp-assault-sim.js';

// ---- 换算链：世界高度 = px / 24 × 2（Terrain.HEIGHT_SCALE = 24，spike 的 H_WORLD = 2）----
// 兵高 ≈ 1.145 世界单位（腿 0→0.42、躯干 0.43→0.93、头到 1.145）。
const H_WORLD = 2.0;
const WALL_SLOTS = 6;                     // 垛口数 = 周长等分
const GATE_POST_T = .26;                  // 寨门门柱断面（gateGroup 与栅栏让位共用）
const GATE_CLEAR = GATE_HALF + GATE_POST_T;    // 栅栏桩让开门柱的半宽（1.46）：否则桩会捅进门扇
const GATE_SPAN = GATE_HALF + .05;        // 门洞净宽半值（1.25）：踩台剖口 + 门内桥板半宽
const POST_STEP = 0.2;                    // 桩间距：一圈 8r=40 → ≈200 根
const FENCE_TOP = 1.75;                   // 齐胸栅栏顶面（≈1.53 兵高）＝ 21px
const WALKWAY_H = 1.0;                    // 内侧踩台面（守军脚底）＝ 12px
const WALKWAY_W = 0.6;                    // 踩台宽度
const FENCE_TOP_OLD = 3.5;                // 对照：旧口径 42px 桩
const GUARD_FEET_OLD = 28 / 24 * H_WORLD; // 对照：旧口径守军抬 28px 站墙顶
// 帐篷位置与尺寸由模拟模块 TENTS 提供。

// 箭塔：移入寨内后整体缩到 0.8（原按墙外高台口径，3D 里过高）。
const TOWER_S = .8;
const TOWER_DECK = 3.2 * TOWER_S;         // ≈2.56
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
function cyl(r, h, x, y, z, color, rx = 0, rz = 0, seg = 10) {
    const g = new THREE.CylinderGeometry(r, r, h, seg);
    if (rx) g.rotateX(rx);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    return tint(g, color);
}
const campMat = new THREE.MeshLambertMaterial({ vertexColors: true });

// ---------------- 低模兵坯（步卒/弓手/长枪兵，朝向 +Z） ----------------
function soldierGeo(kind) {
    const parts = [];
    parts.push(box(.13, .42, .15, -.11, .21, 0, DARK), box(.13, .42, .15, .11, .21, 0, DARK));   // 腿
    parts.push(box(.36, .5, .24, 0, .68, 0, STEEL));                                            // 躯干
    parts.push(box(.19, .19, .19, 0, 1.05, 0, SKIN));                                           // 头
    if (kind === 'archer') parts.push(box(.05, .8, .05, .16, .75, .12, WOOD, 0, .15));          // 弓
    else {
        parts.push(box(.3, .42, .05, -.26, .68, .1, 0x946339));                                  // 盾
        if (kind === 'pikeman') parts.push(box(.045, .045, 1.7, .17, .95, .45, WOOD));          // 长矛（沿 +Z 前伸）
        else parts.push(box(.05, .5, .05, .24, .8, .1, METAL, 0, -.4));                          // 剑
    }
    return mergeGeometries(parts);
}
const guardGeo = { infantry: soldierGeo('infantry'), archer: soldierGeo('archer'), pikeman: soldierGeo('pikeman') };
const guardMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: TEAM_COLOR });
const refMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0xd6d9cc });   // 体量参照兵（不上队伍色）

function soldierMesh(kind, mat, x, y, z, yaw = 0) {
    const m = new THREE.Mesh(guardGeo[kind], mat);
    m.position.set(x, y, z); m.rotation.y = yaw;
    m.castShadow = true; m.receiveShadow = true;
    return m;
}

// ---------------- 墙环几何：与 js/battle/camps.js 的 wallPointAt 同口径 ----------------
const inward = (gx, gy) => inwardPoint(gx, gy);

// ---------------- 木栅墙（栅栏 + 一道横撑 + 踏板 + 垛口守军） ----------------
// platformH：守军踏板面高（新口径 = 内侧踩台 1.0；旧口径 = 墙顶 2.33），null 表示不设踏板。
function fenceGroup(fenceTop, platformH) {
    const parts = [], r = WALL_R, side = 2 * r, per = 8 * r;
    const railY = fenceTop * .55;
    for (let t = 0; t < per - 1e-9; t += POST_STEP) {
        const [gx, gy] = wallPoint(t, r);
        if (gy >= r - 1e-6 && Math.abs(gx) < GATE_CLEAR) continue;     // +gy 侧留寨门（让开门柱）
        parts.push(box(.13, fenceTop, .16, gx, fenceTop / 2, gy, WOOD));
    }
    // 一道横撑（尖头省略）
    parts.push(box(side, .09, .09, 0, railY, -r, TIMBER));
    // +gy 侧横撑被寨门剖开，只在门柱两侧各铺一段；否则整根横杆会横在门洞中间，门一开就挡住通道
    for (const s of [-1, 1])
        parts.push(box(r - GATE_CLEAR, .09, .09, s * (GATE_CLEAR + (r - GATE_CLEAR) / 2), railY, r, TIMBER));
    parts.push(box(.09, .09, side, r, railY, 0, TIMBER));
    parts.push(box(.09, .09, side, -r, railY, 0, TIMBER));
    const group = new THREE.Group();
    if (platformH) {   // 踏板：新口径是内侧踩台，旧口径是墙顶窄台
        const w = WALKWAY_W, inset = WALK_INSET, g = GATE_SPAN;
        const segL = side / 2 - g;                       // 单侧段长（寨门两侧）
        parts.push(box(side, platformH, w, 0, platformH / 2, -r + inset, WOOD));
        // +gy 侧踩台在寨门洞处剖开留口，门洞用一块桥板搭接（否则开门/撞门都会刮到踩台）
        for (const s of [-1, 1])
            parts.push(box(segL, platformH, w, s * (g + segL / 2), platformH / 2, r - inset, WOOD));
        parts.push(box(w, platformH, side, r - inset, platformH / 2, 0, WOOD));
        parts.push(box(w, platformH, side, -r + inset, platformH / 2, 0, WOOD));
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    // 垛口守军：站到踏板上，朝向场外
    // 守军网格与岗位参数一并挂到 group.userData，供攻寨推演复用（跑位 / 命中回位）
    const guards = [];
    const feet = platformH ?? 0;
    for (let i = 0; i < WALL_SLOTS; i++) {
        const t = i * per / WALL_SLOTS;
        const [gx, gy] = wallPoint(t, r);
        const [px, py] = inward(gx, gy);
        const yaw = Math.atan2(gx, gy);
        const m = soldierMesh('infantry', guardMat, px, feet, py, yaw);
        m.userData.home = { x: px, y: feet, z: py, yaw };
        m.userData.slotT = t;                        // 岗位墙环参数（无敌人时各回各垛口）
        guards.push(m);
        group.add(m);
    }
    group.userData.guards = guards;
    return group;
}

// ---------------- 帐篷（四棱锥顶 + 门帘；size 为帐体边长，可带旗杆队旗） ----------------
// 缩放基准：size 2.0 即原大帐（帐体 2.0 高 1.0、锥顶 r1.5 h1.2、门帘朝 +z）。
function tentGroup(x, z, size, withFlag) {
    const half = size / 2, wallH = size * .5;
    const parts = [
        box(size, wallH, size, 0, wallH / 2, 0, CANVAS),                                    // 帐体
        cone(size * .75, size * .6, 0, wallH + size * .3, 0, CANVAS_DK, Math.PI / 4),        // 四棱锥帐顶
        box(size * .32, size * .35, .1, 0, size * .175, half, 0x4a3a28)                     // 门帘（朝 +z）
    ];
    if (withFlag) {
        parts.push(box(.06, 2.6, .06, 0, 1.3, 0, TIMBER));                                  // 旗杆
        parts.push(box(.7, .4, .04, .4, 2.35, 0, TEAM_COLOR));                              // 队旗
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const group = new THREE.Group(); group.add(mesh); group.position.set(x, 0, z);
    return group;
}

// ---------------- 寨内 5 顶帐篷：中军大帐居中（带旗）+ 四角兵帐 ----------------
function tentsGroup() {
    const group = new THREE.Group();
    for (const t of TENTS) group.add(tentGroup(t.x, t.z, t.half * 2, t.x === 0 && t.z === 0));
    return group;
}

// ---------------- 寨门（+gy 侧：门柱 + 门楣 + 双扇联动门 + 门闩横木 + 门内站台） ----------------
// 门柱比齐胸栅栏高出一截并深入地面，门楣横跨两柱；两扇门各自绕门柱内侧的铰链旋转，
// 同一次动作一起开合（双扇联动），关门位有一根门闩横木横跨中缝。
// 开向：手动开门朝寨外（+z）推开（日常出入，不碰门内站台）；
//       冲车撞门则把两扇门朝寨内（-z）撞翻——撞开瞬间门闩断裂落地、门内站台被打塌、
//       台上两名守门兵被撞翻抛落到寨内地面。
function gateGroup() {
    const z0 = WALL_R;                         // +gy 侧墙线（世界 z）
    const POST_T = GATE_POST_T, POST_H = 2.5;  // 门柱断面 / 高（高于栅顶 1.75）
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
    const frame = new THREE.Mesh(mergeGeometries(parts), campMat);
    frame.castShadow = true; frame.receiveShadow = true;

    // 门内桥板：一块薄板横跨寨门洞、两端搭在左右两侧踩台面上（+gy 侧踩台已在门洞处剖开），
    // 守门兵站在板上。独立网格（几何以板中心为原点）：被冲车撞落时整块平躺着滑进寨内地面。
    const PLANK_T = .1, PLANK_W = GATE_SPAN * 2, PLANK_D = WALKWAY_W;
    const platZ = z0 - WALK_INSET, platY = WALKWAY_H + PLANK_T / 2;
    const plat = new THREE.Mesh(box(PLANK_W, PLANK_T, PLANK_D, 0, 0, 0, WOOD), campMat);
    plat.position.set(0, platY, platZ);                       // 板底＝踩台面（1.0），板面＝1.1
    plat.castShadow = true; plat.receiveShadow = true;

    // 门扇：铰链在门柱内侧（局部 x=0），门板朝门洞中缝延伸（dir=+1 左扇 / dir=-1 右扇）
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
    // 受力裂纹：冲车撞门后才显形（挂在门扇 Group 内，随门一起转）
    const crackGeo = dir => mergeGeometries([
        box(.05, .85, .02, dir * .3, 1.12, .05, 0x2e2116),
        box(.05, .6, .02, dir * .55, .9, .05, 0x2e2116),
        box(.05, 1.05, .02, dir * .8, 1.2, .05, 0x2e2116),
        box(.34, .05, .02, dir * .5, 1.45, .05, 0x2e2116)
    ]);
    const makeLeaf = (dir, hingeX) => {
        const g = new THREE.Group();
        const leaf = new THREE.Mesh(leafGeo(dir), campMat);
        leaf.castShadow = true; leaf.receiveShadow = true;
        const crack = new THREE.Mesh(crackGeo(dir), campMat);
        crack.visible = false;
        g.add(leaf, crack);
        g.position.set(hingeX, 0, z0 - .08);       // 铰链点；rotation.y = 0 即关门态
        g.userData = { crack };
        return g;
    };
    const doorL = makeLeaf(1, -GATE_HALF);
    const doorR = makeLeaf(-1, GATE_HALF);

    // 门闩横木：关门时横跨两扇中缝（独立网格，几何重心化；日常开门隐藏 / 被撞断即消失不留残骸）
    const BAR_Y = 1.15, BAR_Z = z0 - .22;                 // 落在门扇内侧、且不与关门位门板相切
    const bar = new THREE.Mesh(mergeGeometries([
        box(GATE_HALF * 2 - .05, .16, .16, 0, 0, 0, 0x5f4226),                                // 闩木
        box(.14, .3, .14, -POST_X + .12, 0, 0, DARK),                                        // 端部卡座
        box(.14, .3, .14,  POST_X - .12, 0, 0, DARK)
    ]), campMat);
    bar.position.set(0, BAR_Y, BAR_Z);
    bar.castShadow = true; bar.receiveShadow = true;

    const group = new THREE.Group();
    group.add(frame, plat, doorL, doorR, bar);
    // 守门兵 ×2：站在门内桥板上，面朝寨外（+z，yaw=0）；冲车撞门时被撞翻抛落到寨内地面
    const guards = [];
    for (const s of [-1, 1]) {
        const m = soldierMesh('infantry', guardMat, s * .55, WALKWAY_H + PLANK_T, platZ, 0);
        guards.push({ mesh: m, side: s });
        group.add(m);
    }
    group.userData = { doorL, doorR, bar, plat, guards, platTop: WALKWAY_H + PLANK_T, platY, platZ };
    return group;
}

// ---------------- 冲车（撞木 + 铁箍撞头 + 车架 + 四轮；撞门纯视觉） ----------------
// 停在寨门外 1.8 处，推进到撞头抵住门扇；连续撞满 6 次门才破——前 5 次只是把门撞得晃一下、
// 冲车弹回，第 3 次起门板开始显裂纹；第 6 次两扇门朝寨内（-z）彻底敞开 90°、门闩被撞断消失、
// 门内桥板被撞落、两名守门兵被撞翻抛落，随后冲车被反冲顶回停放位。
function ramGroup() {
    const parts = [
        cyl(.2, 2.5, 0, .72, 0, WOOD, Math.PI / 2),                                       // 撞木（沿 z）
        cyl(.24, .34, 0, .72, -1.32, METAL, Math.PI / 2)                                  // 撞头铁箍
    ];
    for (const s of [-1, 1]) parts.push(box(.14, .14, 2.3, s * .46, .72, 0, TIMBER));      // 侧梁
    parts.push(box(1.06, .14, .14, 0, .72, -1.0, TIMBER));                                 // 横档 ×2
    parts.push(box(1.06, .14, .14, 0, .72, 1.0, TIMBER));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        parts.push(box(.09, .5, .09, sx * .46, .55, sz * .95, TIMBER));                    // 车腿
        parts.push(cyl(.3, .12, sx * .56, .3, sz * .95, 0x6b4a2a, 0, Math.PI / 2));        // 车轮
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const group = new THREE.Group(); group.add(mesh);
    return group;
}

// ---------------- 寨墙靠墙梯 ×2（架在 ±gx 墙段外侧，从地面斜靠到踩台） ----------------
// 纯视觉占位：暗示进攻方翻墙路径。支点落在墙脚地面，顶部搭在踩台沿口。
// 注意：x=±r 墙段走向沿 Z，故梯子的倾角是绕 Z 轴（rz），且必须从地面起算（中点=两端之中点）。
function ladderGroup() {
    const parts = [], group = new THREE.Group();
    for (const l of LADDERS) {
        const topX = l.topX + l.nx * .04, topZ = l.topZ + l.nz * .04;
        const topY = WALKWAY_H + .38;
        const base = new THREE.Vector3(l.x, 0, l.z), top = new THREE.Vector3(topX, topY, topZ);
        const direction = top.clone().sub(base), len = direction.length();
        const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
        for (const offset of [-.15, .15]) {
            const rail = box(.05, len, .05, 0, 0, 0, TIMBER);
            rail.applyQuaternion(rotation);
            rail.translate((l.x + topX) / 2 + l.nz * offset, topY / 2, (l.z + topZ) / 2 - l.nx * offset);
            parts.push(rail);
        }
        const steps = Math.max(3, Math.round(len / .3));
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            parts.push(box(l.nz ? .34 : .05, .05, l.nx ? .34 : .05,
                l.x + (topX - l.x) * t, topY * t, l.z + (topZ - l.z) * t, WOOD));
        }
    }
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return group;
}

// ---------------- 箭塔（寨内望楼：四腿高台 + 四面垛口 + 塔梯 + 驻塔弓手，敞顶） ----------------
function singleTowerGroup(origin) {
    const s = TOWER_S, deck = TOWER_DECK, railY = deck + .45 * s;    // 整体按 s 缩放
    const pt = 2 * TOWER_HALF, ry = .8 * s, th = .16 * s, leg = .65 * s;
    const parts = [
        box(pt, th, pt, 0, deck + th / 2, 0, 0xbf9d66),                 // 平台
        // 四面垛口闭合：四条边栏均沿各自边线走向（此前 z=-0.8 那条把宽/深写反，
        // 变成一根沿 Z 捅出平台的长条，且 x=+0.8 这条整个漏做）
        box(pt, .42 * s, .09, 0, railY, -ry, WOOD),                     // 后垛口（沿 X）
        box(pt, .42 * s, .09, 0, railY,  ry, WOOD),                     // 前垛口（沿 X）
        box(.09, .42 * s, pt, -ry, railY, 0, WOOD),                     // 左垛口（沿 Z）
        box(.09, .42 * s, pt,  ry, railY, 0, WOOD),                     // 右垛口（沿 Z）
        box(.06, 1.9 * s, .06, .6 * s, deck + th + .95 * s, .6 * s, TIMBER),        // 旗杆：立在平台角上
        box(.7 * s, .42 * s, .04, .95 * s, deck + th + 1.7 * s, .6 * s, TEAM_COLOR) // 队旗
    ];
    for (const [x, z] of [[-leg, -leg], [leg, -leg], [-leg, leg], [leg, leg]])
        parts.push(box(th, deck, th, x, deck / 2, z, TIMBER));          // 四腿
    // 塔梯：贴 -x 面，从地面直上平台顶，登塔路径
    const ladTop = deck + th, ladX = -.72 * s;
    for (const dz of [-.14 * s, .14 * s])
        parts.push(box(.05, ladTop, .05, ladX, ladTop / 2, dz, TIMBER));
    for (let y = .34 * s; y < ladTop - .08 * s; y += .34 * s)
        parts.push(box(.06, .05, .34 * s, ladX, y, 0, 0x6b4a2a));
    const mesh = new THREE.Mesh(mergeGeometries(parts), campMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    // 整组移动到模拟定义的塔位。
    const { x: px, z: pz } = origin;
    // 弓手站在平台上：位置用「组内局部坐标」，组再整体搬到塔位
    // 世界坐标与网格一并挂到 userData，供攻寨推演把塔上弓手当守方复用（fixed，不跑位）
    // 每座塔四名弓手，共用模拟槽位。
    const archers = [];
    for (const { x: ox, z: oz, yaw } of TOWER_ARCHER_SLOTS) {
        const m = soldierMesh('archer', guardMat, ox, deck + th, oz, yaw);
        m.userData.homeYaw = m.rotation.y;
        archers.push({ mesh: m, x: px + ox, z: pz + oz });
        group.add(m);
    }
    group.userData.archers = archers;
    group.position.set(px, 0, pz);
    return group;
}

function towerGroup() {
    const group = new THREE.Group();
    const towers = TOWER_ORIGINS.map(singleTowerGroup);
    group.add(...towers);
    group.userData.archers = towers.flatMap(t => t.userData.archers);
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
camera.position.set(14, 14, 22);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.4, 0);
controls.enableDamping = true; controls.dampingFactor = .08;
controls.maxPolarAngle = 1.5; controls.minDistance = 3; controls.maxDistance = 64;

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
const grid = new THREE.GridHelper(40, 40, 0x5b6a43, 0x66754e);
grid.material.transparent = true; grid.material.opacity = .18; grid.position.y = .012;
scene.add(grid);

// 参照兵：站在寨门旁，标定 1.145 兵高（避开冲车推进通道）
scene.add(soldierMesh('infantry', refMat, 2.8, 0, WALL_R + 1.8, Math.PI));

// ---------------- 寨门开合 + 冲车撞门（仅展示页视觉：无耐久数值、无 sim 判定） ----------------
const GATE_OPEN_OUT = 1.3;      // 手动开门：双扇朝寨外（+z）推开 ≈74°（日常出入，不碰门内桥板）
const GATE_OPEN_IN  = Math.PI / 2;  // 冲车撞门：双扇朝寨内（-z）彻底敞开 90°——门扇贴着门柱立起，门洞完全畅通
const HITS_TO_BREAK = 6;        // 撞满 6 次门才破；前 5 次只把门撞得晃一下、冲车弹回
const JOLT_DUR = .3;            // 单次撞击后门扇回弹的时长
const BURST_DUR = .62;          // 破门阶段时长：前 CRUSH_DUR 内门闩/桥板/守门兵报废，之后门扇向内翻到 90°
const CRUSH_DUR = .12;          // 门闩被撞断 + 桥板撞落 + 守门兵抛落的时长（必须早于门扇扫到桥板）
const gate = gateGroup();
const ram = ramGroup();
ram.position.set(0, 0, RAM_REST);
const gateState = { phase: 'idle', t: 0, open: 0, angle: 0, inward: false, rammed: false, k: 0, hits: 0, jolt: 0 };

const tower = towerGroup();
const fixed = new THREE.Group();
fixed.add(tentsGroup(), tower, gate, ladderGroup(), ram);
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
// 开门/关门：一次动作双扇联动，日常一律朝寨外（+z）；若寨门已被冲车撞坏，本次操作顺带"修复"复位
$('btn-gate').onclick = () => {
    if (assault.active || gateState.phase !== 'idle') return;
    gateState.open = gateState.open ? 0 : 1;
    gateState.rammed = false;                  // 复位：门闩/桥板/守门兵随 k 回落归位
    gateState.hits = 0;                        // 撞击次数一并清零
};
// 冲车撞门：门若开着先自动关到位，再推进撞击。撞满 6 次才破门；前 5 次门只被撞得晃一下、冲车弹回。
// （不设"必须关门态"守卫，避免静默无反应；已破门时本次当作重新来过）
$('btn-ram').onclick = () => {
    if (assault.active || gateState.phase !== 'idle') return;
    if (gateState.rammed) gateState.hits = 0;  // 已破门：本次重头再撞
    gateState.t = 0; gateState.rammed = false; gateState.open = 0;
    gateState.phase = gateState.angle > .05 ? 'shut' : 'advance';
};

const clock = new THREE.Clock(), gateBtn = $('btn-gate'), ramBtn = $('btn-ram');
function updateGateAnim(dt) {
    const st = gateState, u = gate.userData;
    // 开向：冲车撞开 → 朝寨内；复位时先等门收回到关门位，再把符号切回"朝外"，避免翻角跳变
    if (st.rammed) st.inward = true;
    else if (st.inward && !st.open && st.angle < .04) st.inward = false;
    const target = st.phase === 'shut' ? 0 : (st.open ? (st.inward ? GATE_OPEN_IN : GATE_OPEN_OUT) : 0);
    st.angle += (target - st.angle) * Math.min(1, dt * 7);
    // 撞击回弹：每次冲车撞上门，双扇朝寨内抖一下再衰减。振幅上限 ~0.1rad，
    // 保证门板内缘（z ≈ 4.92 − 1.17·sin a）不会扎进门内桥板（板外沿 z = 4.75）
    st.jolt = Math.max(0, st.jolt - dt / JOLT_DUR);
    const jolt = st.jolt * (.045 + .009 * Math.min(st.hits, assault.active ? assault.gate.maxHp : HITS_TO_BREAK));
    const sgn = st.inward ? 1 : -1;                  // 左扇铰链在 -x：朝寨内为正角、朝寨外为负角（右扇镜像取反）
    u.doorL.rotation.y = sgn * st.angle + jolt;
    u.doorR.rotation.y = -sgn * st.angle - jolt;

    // 破坏进度 k：撞开时递增、复位时递减；门闩/桥板/守门兵的变换统一由 k 驱动。
    // p = √k 让破坏动作集中在撞上瞬间（前段加速），且必须早于门扇扫到桥板之前把板挪开。
    st.k = st.rammed ? Math.min(1, st.k + dt / CRUSH_DUR) : Math.max(0, st.k - dt / (CRUSH_DUR * 2));
    const p = Math.sqrt(st.k);
    u.plat.position.set(0, u.platY - (u.platY - .07) * p, u.platZ - 1.35 * p); // 桥板整块被撞落，平躺进寨内
    u.plat.rotation.x = -.06 * p;
    for (const g of u.guards) {                             // 守门兵：被撞翻，抛物线抛落到寨内地面
        g.mesh.position.set(g.side * (.55 + 1.0 * p),
            u.platTop * (1 - p) + .85 * Math.sin(Math.PI * p),
            u.platZ - 1.45 * p);
        g.mesh.rotation.set(-1.4 * p, 1.1 * p * g.side, .35 * p);
    }
    // 裂纹逐击显现：撞到第 3 次起门板开始裂；门闩只挂在关门位，一被撞断就整体消失（不留残骸）
    u.doorL.userData.crack.visible = u.doorR.userData.crack.visible = st.hits / (assault.active ? assault.gate.maxHp : HITS_TO_BREAK) >= .5;
    u.bar.visible = !st.rammed && st.angle < .18;

    if (!assault.active && st.phase === 'shut') {                               // 门开着：先关合到位再撞
        st.t += dt / .35;
        if (st.t >= 1 || st.angle < .03) { st.phase = 'advance'; st.t = 0; }
    } else if (!assault.active && st.phase === 'advance') {                     // 冲车推进（加速逼近）
        st.t = Math.min(1, st.t + dt / .55);
        ram.position.z = RAM_REST + (RAM_HIT - RAM_REST) * st.t * st.t;
        if (st.t >= 1) {                                     // 撞上：计一次数、门抖一下
            st.t = 0; st.jolt = 1; st.hits++;
            if (st.hits >= HITS_TO_BREAK) { st.phase = 'burst'; st.open = 1; st.rammed = true; }
            else st.phase = 'impact';
        }
    } else if (!assault.active && st.phase === 'impact') {                      // 未破：门只被撞得晃一下，冲车弹回停放位
        st.t = Math.min(1, st.t + dt / .34);
        ram.position.z = RAM_HIT + (RAM_REST - RAM_HIT) * Math.sqrt(st.t);
        if (st.t >= 1) { st.phase = 'idle'; st.t = 0; }
    } else if (!assault.active && st.phase === 'burst') {                       // 破门：门向内翻、破坏推进，冲车被反冲顶回（前快后缓）
        st.t = Math.min(1, st.t + dt / BURST_DUR);
        ram.position.z = RAM_HIT + (RAM_REST - RAM_HIT) * Math.sqrt(st.t);
        if (st.t >= 1) { st.phase = 'idle'; st.t = 0; }
    }
    if (assault.active) ram.position.z = assault.ram.z + .12 * Math.sin(st.jolt * Math.PI);
    const want = st.open ? '关门' : '开门';
    if (gateBtn.textContent !== want) gateBtn.textContent = want;
    ramBtn.disabled = assault.active;
    const ramWant = ramButtonText(assault.active, assault.gate, st.hits, assault.active ? undefined : HITS_TO_BREAK);
    if (ramBtn.textContent !== ramWant) ramBtn.textContent = ramWant;
}

// ==================== 攻寨推演（可开关的演示；固定步长、种子确定性方阵推进） ====================
// 数值口径复用真实模拟：伤害走 calculateAttackDamage，守军「居高临下」输出倍率取 CAMP_RULES。
// 塔上/寨墙上守军的受伤/射程做演示级加强（见 ASSAULT_COVER / TOWER_RANGE），因为真规则的
// WALL_GUARD_COVER=0.7 对「齐胸栅栏 + 踩台 + 箭塔」的实战遮蔽体现太弱，寨子形同虚设。
// 世界坐标系：x 向东、z 向南、营寨中心在原点；1 世界单位 ≈ 1 格，故 UNIT_TYPES 的
// range / speed / atkSpeed 可直接使用（atkSpeed 为毫秒）。
const ATK_COLOR = 0x7fb0e0;                 // 蓝方攻方队伍色（与红方营寨对比）
const INSTANCE_CAP = 200;
// 战斗表现（纯视觉，不影响结算）：出手前扑 / 受击后仰 / 倒地沉没 / 箭矢飞行 / 头顶血条
const DIE_FALL_MS = 380, DIE_SINK_MS = 800;
const ARROW_SPEED = 22;                    // 箭矢飞行速度（世界单位/秒，纯视觉）
// ---- 攻方实例化渲染：每种兵种一个 InstancedMesh，实例颜色涂蓝（200 个逐兵 Mesh 会掉帧） ----
const assaultMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const assaultMeshes = {};
for (const kind of ATTACK_KINDS) {
    const im = new THREE.InstancedMesh(guardGeo[kind], assaultMat, INSTANCE_CAP);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;                 // 实例矩阵每帧改写，几何包围球不作数
    im.castShadow = true; im.receiveShadow = true;
    im.count = 0;
    for (let i = 0; i < INSTANCE_CAP; i++) im.setColorAt(i, new THREE.Color(ATK_COLOR));
    im.instanceColor.needsUpdate = true;
    scene.add(im);
    assaultMeshes[kind] = im;
}
const dummy = new THREE.Object3D();

// 守方网格池：寨墙守军按「守军数量」档启用前 N 个（6/12/24），一律站寨墙环的踩台上；
// 兵种按同一周期规则分配（每 3 个垛口 1 名弓手 → N/3 名弓手），网格与逻辑兵种天然一致。
// 双塔 8 名弓手见 tower.userData.archers，也当守方复用（fixed=true，不跑位）。
const MAX_WALL_GUARDS = 24;
const defMeshes = [];
for (let i = 0; i < MAX_WALL_GUARDS; i++) {
    const m = soldierMesh(slotKind(i), guardMat, 0, WALKWAY_H, 0, 0);
    m.visible = false;
    scene.add(m);
    defMeshes.push(m);
}

// 箭矢（纯视觉）：弓手出手时生成一根飞行箭矢；伤害在出手拍已结算完毕，箭只为「看得见怎么打到的」
const ARROW_CAP = 160;
const arrowMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(.05, .05, .62),
    new THREE.MeshLambertMaterial({ vertexColors: true }), ARROW_CAP);
arrowMesh.count = 0; arrowMesh.frustumCulled = false;
scene.add(arrowMesh);
const arrows = [];                                       // {fx,fy,fz,tx,ty,tz,t,T,arc,team}
const _arrowC = { blue: new THREE.Color(0x9fb8d8), red: new THREE.Color(0xd89f9f) };
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _AXIS_X = new THREE.Vector3(1, 0, 0), _AXIS_Y = new THREE.Vector3(0, 1, 0), _AXIS_Z = new THREE.Vector3(0, 0, 1);
const _ap = { x: 0, y: 0, z: 0 };
const chestY = u => u.y + 1.0;   // 射手/目标胸口高（塔上/踩台/地面）
function spawnArrow(from, to) {
    if (arrows.length >= ARROW_CAP) arrows.shift();      // 演示到不了这个量，兜底丢最旧
    const d = Math.hypot(to.x - from.x, to.z - from.z) || 1;
    arrows.push({ fx: from.x, fy: chestY(from), fz: from.z, tx: to.x, ty: chestY(to), tz: to.z,
        t: 0, T: Math.max(.12, d / ARROW_SPEED), arc: .1 + d * .05, team: from.team });
}
function arrowPos(a, k, out) {
    out.x = a.fx + (a.tx - a.fx) * k;
    out.y = a.fy + (a.ty - a.fy) * k + Math.sin(Math.PI * k) * a.arc;
    out.z = a.fz + (a.tz - a.fz) * k;
}
function updateArrows(dt) {
    for (let i = arrows.length - 1; i >= 0; i--)
        if ((arrows[i].t += dt) >= arrows[i].T) arrows.splice(i, 1);
    arrowMesh.count = arrows.length;
    for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i], k = a.t / a.T;
        arrowPos(a, k, _v1);
        arrowPos(a, Math.min(1, k + .03), _ap);
        _v2.set(_ap.x - _v1.x, _ap.y - _v1.y, _ap.z - _v1.z).normalize();
        dummy.position.set(_v1.x, _v1.y, _v1.z);
        dummy.quaternion.setFromUnitVectors(_AXIS_Z, _v2);   // 箭体沿 +Z，指向飞行方向
        dummy.scale.setScalar(1); dummy.updateMatrix();
        arrowMesh.setMatrixAt(i, dummy.matrix);
        arrowMesh.setColorAt(i, a.team === 'red' ? _arrowC.red : _arrowC.blue);
    }
    arrowMesh.instanceMatrix.needsUpdate = true;
    if (arrowMesh.instanceColor) arrowMesh.instanceColor.needsUpdate = true;
}

// 血条（纯视觉）：始终朝向相机的实例化面片，右端固定、随血量从右往左缩短，绿→黄→红
const BAR_CAP = 200, BAR_W = .7, BAR_H = .085;
const barBg = new THREE.InstancedMesh(new THREE.PlaneGeometry(BAR_W, BAR_H),
    new THREE.MeshBasicMaterial({ color: 0x201a12, transparent: true, opacity: .75, depthWrite: false }), BAR_CAP);
const barFg = new THREE.InstancedMesh(new THREE.PlaneGeometry(BAR_W, BAR_H),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: .95, depthWrite: false }), BAR_CAP);
barBg.count = 0; barFg.count = 0;
barBg.frustumCulled = barFg.frustumCulled = false;
barBg.renderOrder = 3; barFg.renderOrder = 4;
for (let i = 0; i < BAR_CAP; i++) barFg.setColorAt(i, new THREE.Color(0xffffff));   // 预分配 instanceColor
scene.add(barBg, barFg);
const BAR_HP_COLOR = [[.55, 0x67c23a], [.28, 0xe6a23c], [-1, 0xf56c6c]];
const _barColor = new THREE.Color();
function updateBars() {
    let n = 0;
    if (assault.active) {
        _v2.set(1, 0, 0).applyQuaternion(camera.quaternion);          // 相机右向：血条锚左端
        const push = u => {
            if (u.dead || n >= BAR_CAP) return;
            const frac = u.hp / u.maxHp;
            const baseY = u.y;
            dummy.position.set(u.x, baseY + 1.62, u.z);
            dummy.quaternion.copy(camera.quaternion);
            dummy.scale.setScalar(1); dummy.updateMatrix();
            barBg.setMatrixAt(n, dummy.matrix);
            dummy.position.set(u.x - _v2.x * (BAR_W - BAR_W * frac) * .5, baseY + 1.62,
                u.z - _v2.z * (BAR_W - BAR_W * frac) * .5);
            dummy.scale.set(frac, 1, 1); dummy.updateMatrix();
            barFg.setMatrixAt(n, dummy.matrix);
            for (const [th, c] of BAR_HP_COLOR) if (frac > th) { _barColor.setHex(c); break; }
            barFg.setColorAt(n, _barColor);
            n++;
        };
        for (const u of assault.attackers) push(u);
        for (const u of assault.defenders) push(u);
    }
    barBg.count = n; barFg.count = n;
    barBg.instanceMatrix.needsUpdate = true; barFg.instanceMatrix.needsUpdate = true;
    if (barFg.instanceColor) barFg.instanceColor.needsUpdate = true;
}

const simulation = createAssaultSim();
const { assault } = simulation;
// Render ownership stays here; the simulation never reads a frame clock or a THREE object.
let fxMs = 0, accumulator = 0;
let effects = new WeakMap(), guardViews = new Map();
const effectOf = u => effects.get(u) ?? { atkAt: -Infinity, hitAt: -Infinity, dieAt: -Infinity };
const animOf = u => ({
    atkN: Math.max(0, 1 - (fxMs - effectOf(u).atkAt) / ATK_ANIM_MS),
    hitN: Math.max(0, 1 - (fxMs - effectOf(u).hitAt) / HIT_ANIM_MS)
});

function startAssault(preset, defCount, seed = 1) {
    resetAssault();
    simulation.startAssault(preset, defCount, seed);
    let wallIndex = 0, towerIndex = 0;
    for (const u of assault.defenders) {
        const mesh = u.fixed ? tower.userData.archers[towerIndex++].mesh : defMeshes[wallIndex++];
        guardViews.set(u, { mesh, meshBase: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z } });
    }
    for (const m of chestHigh.userData.guards) m.visible = false;   // 装饰守军让位给守方池
    fxMs = 0; accumulator = 0;
    gateBtn.disabled = ramBtn.disabled = true;
    arrows.length = 0; arrowMesh.count = 0;
    $('battle').hidden = false;
    syncAssaultMeshes(); syncGuardMeshes(); renderAssaultHud();
}

function resetAssault() {
    simulation.resetAssault();
    effects = new WeakMap(); guardViews = new Map();
    gateBtn.disabled = ramBtn.disabled = false;
    Object.assign(gateState, { phase: 'idle', t: 0, open: 0, angle: 0, inward: false, rammed: false, k: 0, hits: 0, jolt: 0 });
    ram.position.z = RAM_REST;
    arrows.length = 0; arrowMesh.count = 0;              // 飞行中的箭一并清掉
    for (const kind of ATTACK_KINDS) {
        const im = assaultMeshes[kind];
        im.count = 0; im.instanceMatrix.needsUpdate = true;
    }
    for (const m of defMeshes) m.visible = false;                // 守方池收起
    for (const mesh of chestHigh.userData.guards) {              // 装饰守军回岗位、复现
        const h = mesh.userData.home;
        mesh.position.set(h.x, h.y, h.z);
        mesh.rotation.set(0, h.yaw, 0);
        mesh.visible = true;
    }
    for (const a of tower.userData.archers) {          // 塔上弓手复位（阵亡后需重新显形，否则装饰兵消失）
        a.mesh.rotation.set(0, a.mesh.userData.homeYaw, 0);
        a.mesh.visible = true;
    }
    $('battle').hidden = true;
}

// Logic emits successful attacks; projectile rendering stays here.
function stepAssault(ms) {
    const events = simulation.stepAssault(ms);
    for (const event of events) {
        if (event.type === 'ram_hit') {
            gateState.hits = assault.gate.maxHp - event.hp; gateState.jolt = 1;
        } else if (event.type === 'gate_broken') {
            Object.assign(gateState, { rammed: true, inward: true, open: 1 });
        } else if (event.type === 'attack') {
            const { from, to } = event;
            const a = { ...effectOf(from), atkAt: fxMs }, d = { ...effectOf(to), hitAt: fxMs };
            if (to.dead) d.dieAt = fxMs;
            effects.set(from, a); effects.set(to, d);
            if (from.type === 'archer') spawnArrow(from, to);
        }
    }
    return events;
}

// 攻方实例矩阵：位置用 (x, 0, z)，yaw = atan2(方向x, 方向z)
// 活着：出手前扑 + 受击后仰的位移；阵亡：朝面向前扑倒 → 沉没 → 缩为 0 隐藏（纯视觉）
function syncAssaultMeshes() {
    const bodies = [...assault.attackers, ...assault.defenders];
    const n = { infantry: 0, pikeman: 0, archer: 0 };
    for (const a of assault.attackers) n[a.type]++;
    for (const kind of ATTACK_KINDS) assaultMeshes[kind].count = n[kind];
    for (const a of assault.attackers) {
        const im = assaultMeshes[a.type];
        const [mx, mz] = viewPoint(a);
        if (a.dead) {
            const f = fxMs - effectOf(a).dieAt;
            if (f >= DIE_FALL_MS + DIE_SINK_MS) {
                dummy.position.set(mx, 0, mz);
                dummy.scale.setScalar(0);
                dummy.rotation.set(0, 0, 0);
            } else {
                const fall = Math.min(1, f / DIE_FALL_MS);
                const sink = f <= DIE_FALL_MS ? 0 : (f - DIE_FALL_MS) / DIE_SINK_MS;
                dummy.position.set(mx, a.y - .85 * sink, mz);
                dummy.scale.setScalar(1);
                _q1.setFromAxisAngle(_AXIS_Y, a.yaw);
                _q2.setFromAxisAngle(_AXIS_X, 1.5 * fall);   // 绕本地 X 前倒（面朝下扑）
                dummy.quaternion.copy(_q1.multiply(_q2));
            }
        } else {
            const { atkN, hitN } = animOf(a);
            const [px, pz] = meshPoint(a, atkN, hitN, bodyGap(a, bodies));
            dummy.position.set(px, a.y, pz);
            dummy.rotation.set(0, a.yaw, 0);
            dummy.scale.setScalar(1);
        }
        dummy.updateMatrix();
        im.setMatrixAt(a.slot, dummy.matrix);
    }
    for (const kind of ATTACK_KINDS) assaultMeshes[kind].instanceMatrix.needsUpdate = true;
}

// 守军网格：逻辑位置在寨墙环，网格仍落在踩台（内缩 WALK_INSET，与静态样张一致）；
// 出手前扑/受击后仰/倒地沉没与攻方同套；箭塔弓手（fixed）网格坐标是塔组局部坐标，只加偏移
function syncGuardMeshes() {
    const bodies = [...assault.attackers, ...assault.defenders];
    for (const d of assault.defenders) {
        const { mesh, meshBase } = guardViews.get(d);
        if (d.dead) {
            const f = fxMs - effectOf(d).dieAt;
            if (f >= DIE_FALL_MS + DIE_SINK_MS) { mesh.visible = false; continue; }
            const fall = Math.min(1, f / DIE_FALL_MS);
            const sink = f <= DIE_FALL_MS ? 0 : (f - DIE_FALL_MS) / DIE_SINK_MS;
            mesh.visible = true;
            if (d.fixed) {
                mesh.position.set(meshBase.x, meshBase.y - .85 * sink, meshBase.z);
            } else {
                const [ix, iz] = viewPoint(d);
                mesh.position.set(ix, d.y - .85 * sink, iz);
            }
            _q1.setFromAxisAngle(_AXIS_Y, d.yaw);
            _q2.setFromAxisAngle(_AXIS_X, 1.5 * fall);
            mesh.quaternion.copy(_q1.multiply(_q2));
            continue;
        }
        mesh.visible = true;
        const { atkN, hitN } = animOf(d);
        // 箭塔弓手（fixed）不参与身位口径，姿态偏移不截断
        const [lx, lz] = poseOffset(d, atkN, hitN, d.fixed ? Infinity : bodyGap(d, bodies));
        if (d.fixed) {
            mesh.position.set(meshBase.x + lx, meshBase.y, meshBase.z + lz);
            mesh.rotation.set(0, d.yaw, 0);
        } else {
            const [ix, iz] = viewPoint(d);
            mesh.position.set(ix + lx, d.y, iz + lz);
            mesh.rotation.set(0, d.yaw, 0);
        }
    }
}

const elBattle = $('battle');
function renderAssaultHud() {
    if (!elBattle || !assault.active) return;
    const atkAlive = assault.attackers.reduce((n, u) => n + (u.dead ? 0 : 1), 0);
    const defAlive = assault.defenders.reduce((n, u) => n + (u.dead ? 0 : 1), 0);
    const atkLost = assault.attackers.length - atkAlive, defLost = assault.defenders.length - defAlive;
    $('atk-alive').textContent = atkAlive; $('atk-lost').textContent = atkLost;
    $('def-alive').textContent = defAlive; $('def-lost').textContent = defLost;
    const nInf = assault.defenders.reduce((n, u) => n + (u.type === 'infantry' ? 1 : 0), 0);
    const nArc = assault.defenders.reduce((n, u) => n + (u.type === 'archer' ? 1 : 0), 0);
    $('def-comp').textContent = `剑士 ${nInf} · 弓手 ${nArc}（含箭塔 ${tower.userData.archers.length}）`;
    // 战损比 = 攻方阵亡 : 守方阵亡（守方为 0 时显示「∞ / -」）
    $('ratio').textContent = defLost === 0 ? '∞ / -' : `${atkLost} : ${defLost}`;
    $('elapsed').textContent = (assault.elapsedMs / 1000).toFixed(1);
    $('battle-phase').textContent = assault.phase;
    $('gate-hp').textContent = `${assault.gate.hp}/${assault.gate.maxHp}`;
    // 夺旗进度：净权重对冲的拉锯条，-1（守方完全掌控）→ 0（中线）→ +1（拔旗）。
    // 数字显示攻方接管百分比 0% → 100%；条内填充从中线朝当前占优方向推进。
    const flagP = assault.flagProgress;
    $('flag-progress').textContent = `${Math.floor((flagP + 1) / 2 * 100)}%`;
    const fill = $('flag-fill'), reach = Math.abs(flagP) * 50;
    fill.style.width = `${reach}%`;
    fill.style.left = `${flagP >= 0 ? 50 : 50 - reach}%`;
    $('verdict').textContent = assault.result === 'break' ? '攻方拔旗破寨' : assault.result === 'hold' ?
        (assault.retreated ? '攻方溃退' : '守方守住') : '进行中';
}

// 固定步长累加器（参考 main.js 的 accumulator 写法）：与帧率无关，纯确定性
// 分出胜负后停止步进（用时定格），但表现层继续跑（箭矢飞完、尸体倒完、血条跟随）
function updateAssault(dtSec) {
    const dtMs = dtSec * 1000;
    if (assault.active) {
        fxMs += dtMs;
        if (assault.result === null) {
            accumulator += dtMs;
            let guard = 0;
            while (accumulator >= ASSAULT_STEP_MS && guard++ < 8) {
                stepAssault(ASSAULT_STEP_MS);
                accumulator -= ASSAULT_STEP_MS;
            }
            if (guard >= 8) accumulator = 0;
        }
        syncAssaultMeshes(); syncGuardMeshes(); renderAssaultHud();
    }
    updateArrows(dtSec); updateBars();
}

$('btn-assault').onclick = () => { startAssault($('sel-force').value, +$('sel-def').value); };
$('btn-assault-reset').onclick = () => { resetAssault(); };

renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), .05);
    updateGateAnim(dt);
    updateAssault(dt);
    controls.update(); renderer.render(scene, camera);
});

window.__camp = { scene, camera, controls, chestHigh, wallTop, renderer, gate, ram, gateState,
    assault, assaultMeshes, startAssault, resetAssault, stepAssault };
