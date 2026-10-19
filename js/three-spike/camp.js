// ==================== 3D 木栅营寨展示页（静态小样，不接模拟） ====================
// 目的：在接线进真实 3D 战场之前，先把「齐胸栅栏 + 内侧踩台」的新口径做成可旋转的立体样张，
// 让体量/比例（栅顶高度、守军露头肩、大帐体量、箭塔高台）一眼可判。
// 口径与 js/battle/camps.js 的 CAMP_RULES 对齐（前线营寨），但完全不读取模拟状态。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// 攻寨推演复用真实模拟口径：兵种数值与伤害结算、营寨守军倍率/掩体
import { UNIT_TYPES, calculateAttackDamage } from '../units.js';
import { CAMP_RULES } from '../battle/camps.js';

// ---- 换算链：世界高度 = px / 24 × 2（Terrain.HEIGHT_SCALE = 24，spike 的 H_WORLD = 2）----
// 兵高 ≈ 1.145 世界单位（腿 0→0.42、躯干 0.43→0.93、头到 1.145）。
const H_WORLD = 2.0;
const WALL_R = 5.0;                       // 前线营寨墙环半径（继续放大；大本营 3.5）
const WALL_SLOTS = 6;                     // 垛口数 = 周长等分
const GATE_HALF = 1.2;                    // +gy 侧寨门半宽（2D 已有此约定：中间留 2 段缺口）
const GATE_POST_T = .26;                  // 寨门门柱断面（gateGroup 与栅栏让位共用）
const GATE_CLEAR = GATE_HALF + GATE_POST_T;    // 栅栏桩让开门柱的半宽（1.46）：否则桩会捅进门扇
const GATE_SPAN = GATE_HALF + .05;        // 门洞净宽半值（1.25）：踩台剖口 + 门内桥板半宽
const POST_STEP = 0.2;                    // 桩间距：一圈 8r=40 → ≈200 根
const FENCE_TOP = 1.75;                   // 齐胸栅栏顶面（≈1.53 兵高）＝ 21px
const WALKWAY_H = 1.0;                    // 内侧踩台面（守军脚底）＝ 12px
const WALKWAY_W = 0.6;                    // 踩台宽度
const WALK_INSET = WALL_R * .11;          // 踩台中心相对墙线的内缩（≈0.55）
const FENCE_TOP_OLD = 3.5;                // 对照：旧口径 42px 桩
const GUARD_FEET_OLD = 28 / 24 * H_WORLD; // 对照：旧口径守军抬 28px 站墙顶
// 内部 5 顶帐篷：中军大帐 2.2 居中 + 四角兵帐 1.8，角帐中心 ±2.8
// （角帐锥顶外沿 2.8+0.95＝3.75 < 踩台内沿 4.15，不顶墙）
const TENT_CMD = 2.2, TENT_SQ = 1.8, TENT_PITCH = 2.8;
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
function wallPoint(t, r) {
    const side = 2 * r, per = 8 * r;
    const s = ((t % per) + per) % per;
    const corners = [[-r, -r], [r, -r], [r, r], [-r, r]];
    const i = Math.min(3, Math.floor(s / side));
    const k = (s - i * side) / side;
    const [x0, y0] = corners[i], [x1, y1] = corners[(i + 1) % 4];
    return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
}
const inward = (gx, gy) => { const l = Math.hypot(gx, gy) || 1; return [gx - gx / l * WALK_INSET, gy - gy / l * WALK_INSET]; };

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
    group.add(tentGroup(0, 0, TENT_CMD, true));
    for (const sx of [-1, 1])
        for (const sz of [-1, 1])
            group.add(tentGroup(sx * TENT_PITCH, sz * TENT_PITCH, TENT_SQ, false));
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

// ---------------- 箭塔（寨内望楼：四腿高台 + 四面垛口 + 塔梯 + 驻塔弓手，敞顶） ----------------
function towerGroup() {
    const s = TOWER_S, deck = TOWER_DECK, railY = deck + .45 * s;    // 整体按 s 缩放
    const pt = 1.7 * s, ry = .8 * s, th = .16 * s, leg = .65 * s;
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
    // 移到寨内 -z 后墙中线：x=0 保持镜像对称，且远离 +gy 寨门与四角帐篷
    const px = 0, pz = -(WALL_R - 1.7);
    // 弓手站在平台上：位置用「组内局部坐标」，组再整体搬到塔位
    for (const [ox, oz] of [[-.35 * s, 0], [.35 * s, 0]])
        group.add(soldierMesh('archer', guardMat, ox, deck + th, oz, Math.atan2(WALL_R, 0)));
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
const RAM_REST = 8.2, RAM_HIT = 6.45;              // 冲车停放位 / 撞门位（撞头铁箍正好抵住门扇）
const HITS_TO_BREAK = 6;        // 撞满 6 次门才破；前 5 次只把门撞得晃一下、冲车弹回
const JOLT_DUR = .3;            // 单次撞击后门扇回弹的时长
const BURST_DUR = .62;          // 破门阶段时长：前 CRUSH_DUR 内门闩/桥板/守门兵报废，之后门扇向内翻到 90°
const CRUSH_DUR = .12;          // 门闩被撞断 + 桥板撞落 + 守门兵抛落的时长（必须早于门扇扫到桥板）
const gate = gateGroup();
const ram = ramGroup();
ram.position.set(0, 0, RAM_REST);
const gateState = { phase: 'idle', t: 0, open: 0, angle: 0, inward: false, rammed: false, k: 0, hits: 0, jolt: 0 };

const fixed = new THREE.Group();
fixed.add(tentsGroup(), towerGroup(), gate, ladderGroup(), ram);
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
    if (gateState.phase !== 'idle') return;
    gateState.open = gateState.open ? 0 : 1;
    gateState.rammed = false;                  // 复位：门闩/桥板/守门兵随 k 回落归位
    gateState.hits = 0;                        // 撞击次数一并清零
};
// 冲车撞门：门若开着先自动关到位，再推进撞击。撞满 6 次才破门；前 5 次门只被撞得晃一下、冲车弹回。
// （不设"必须关门态"守卫，避免静默无反应；已破门时本次当作重新来过）
$('btn-ram').onclick = () => {
    if (gateState.phase !== 'idle') return;
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
    const jolt = st.jolt * (.045 + .009 * Math.min(st.hits, HITS_TO_BREAK));
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
    u.doorL.userData.crack.visible = u.doorR.userData.crack.visible = st.hits >= 3;
    u.bar.visible = !st.rammed && st.angle < .18;

    if (st.phase === 'shut') {                               // 门开着：先关合到位再撞
        st.t += dt / .35;
        if (st.t >= 1 || st.angle < .03) { st.phase = 'advance'; st.t = 0; }
    } else if (st.phase === 'advance') {                     // 冲车推进（加速逼近）
        st.t = Math.min(1, st.t + dt / .55);
        ram.position.z = RAM_REST + (RAM_HIT - RAM_REST) * st.t * st.t;
        if (st.t >= 1) {                                     // 撞上：计一次数、门抖一下
            st.t = 0; st.jolt = 1; st.hits++;
            if (st.hits >= HITS_TO_BREAK) { st.phase = 'burst'; st.open = 1; st.rammed = true; }
            else st.phase = 'impact';
        }
    } else if (st.phase === 'impact') {                      // 未破：门只被撞得晃一下，冲车弹回停放位
        st.t = Math.min(1, st.t + dt / .34);
        ram.position.z = RAM_HIT + (RAM_REST - RAM_HIT) * Math.sqrt(st.t);
        if (st.t >= 1) { st.phase = 'idle'; st.t = 0; }
    } else if (st.phase === 'burst') {                       // 破门：门向内翻、破坏推进，冲车被反冲顶回（前快后缓）
        st.t = Math.min(1, st.t + dt / BURST_DUR);
        ram.position.z = RAM_HIT + (RAM_REST - RAM_HIT) * Math.sqrt(st.t);
        if (st.t >= 1) { st.phase = 'idle'; st.t = 0; }
    }
    const want = st.open ? '关门' : '开门';
    if (gateBtn.textContent !== want) gateBtn.textContent = want;
    const ramWant = st.hits > 0 && st.hits < HITS_TO_BREAK ? `冲车撞门 (${st.hits}/${HITS_TO_BREAK})` : '冲车撞门';
    if (ramBtn.textContent !== ramWant) ramBtn.textContent = ramWant;
}

// ==================== 攻寨推演（可开关的演示；固定步长确定性推进，全程不用随机数） ====================
// 数值口径全部复用真实模拟：伤害走 calculateAttackDamage，守军「居高临下」攻/防倍率取 CAMP_RULES。
// 世界坐标系：x 向东、z 向南、营寨中心在原点；1 世界单位 ≈ 1 格，故 UNIT_TYPES 的
// range / speed / atkSpeed 可直接使用（atkSpeed 为毫秒）。
const ATK_COLOR = 0x7fb0e0;                 // 蓝方攻方队伍色（与红方营寨对比）
const MELEE_STOP_R = WALL_R + 0.4;          // 近战迫近停步圈（切比雪夫 = 5.4）：不得穿墙
const ARCHER_STOP_R = 7.5;                  // 弓手停步半径（欧氏 = 7.5），用 range 9.5 远程射
const GUARD_MELEE_CAP = 3;                  // 一个垛口同时最多被 3 名近战攻方贴身围攻
const ASSAULT_STEP_MS = 1000 / 60;          // 固定步长 1/60 秒
const INSTANCE_CAP = 200;                   // 每种攻方 InstancedMesh 容量（≥200；不能逐兵建 Mesh）
const FORCE_PRESETS = {                     // 兵力预设：守方固定 6 名剑士
    squad:   { infantry: 24, pikeman: 6,  archer: 8  },
    company: { infantry: 48, pikeman: 12, archer: 16 },
    brigade: { infantry: 96, pikeman: 24, archer: 32 }
};
const ATTACK_KINDS = ['infantry', 'pikeman', 'archer'];

// 墙环上离给定点最近的参数（方形环，与 camps.js wallParamToward 同口径；营寨中心在原点）
function wallParamToward(x, z) {
    const r = WALL_R, side = 2 * r;
    const m = Math.max(Math.abs(x), Math.abs(z));
    if (m < 1e-6) return 0;
    const ex = x / m * r, ey = z / m * r;
    if (Math.abs(ex) >= Math.abs(ey)) return ex > 0 ? side + (ey + r) : 3 * side + (r - ey);
    return ey < 0 ? ex + r : 2 * side + (r - ex);
}

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

const assault = {
    active: false, attackers: [], defenders: [], acc: 0, elapsedMs: 0, result: null, preset: 'company'
};

function makeDemoUnit(team, role, type, x, z, yaw) {
    const typeData = UNIT_TYPES[type];
    return { team, role, type, typeData, x, z, yaw, hp: typeData.hp, maxHp: typeData.hp, cd: 0, dead: false, target: null };
}

// 按兵种均匀分布：三种兵按占比交错排在圆周上（确定性决策，不用随机数）
function assaultSequence(preset) {
    const counts = FORCE_PRESETS[preset] ?? FORCE_PRESETS.company;
    const total = counts.infantry + counts.pikeman + counts.archer;
    const taken = { infantry: 0, pikeman: 0, archer: 0 }, seq = [];
    for (let i = 0; i < total; i++) {
        let best = null, bestKey = Infinity;
        for (const kind of ATTACK_KINDS) {
            if (taken[kind] >= counts[kind]) continue;
            const key = (taken[kind] + 0.5) / counts[kind];   // 取「已排/应有」最小者 → 均匀交错
            if (key < bestKey) { bestKey = key; best = kind; }
        }
        taken[best]++; seq.push(best);
    }
    return seq;
}

function startAssault(preset) {
    resetAssault();                                  // 演示进行中「开始攻寨」→ 先重置再开始
    assault.preset = preset;
    const seq = assaultSequence(preset), spawnR = 11;
    const slotOf = { infantry: 0, pikeman: 0, archer: 0 };
    for (let i = 0; i < seq.length; i++) {
        const ang = i / seq.length * Math.PI * 2;    // 布在寨外半径约 11 的圆周上
        const x = Math.cos(ang) * spawnR, z = Math.sin(ang) * spawnR;
        const u = makeDemoUnit('blue', 'attack', seq[i], x, z, Math.atan2(-x, -z));
        u.slot = slotOf[seq[i]]++;                   // 在该兵种 InstancedMesh 里的实例槽位
        assault.attackers.push(u);
    }
    // 红方守方 = 复用寨墙上 6 名垛口守军：逻辑位置在寨墙环（半边长 5.0），网格仍站踩台（内缩）
    assault.defenders = chestHigh.userData.guards.map(mesh => {
        const t = mesh.userData.slotT;
        const [px, pz] = wallPoint(t, WALL_R);
        const u = makeDemoUnit('red', 'defend', 'infantry', px, pz, Math.atan2(px, pz));
        u.mesh = mesh; u.homeT = t;
        return u;
    });
    assault.active = true; assault.acc = 0; assault.elapsedMs = 0; assault.result = null;
    $('battle').hidden = false;
    syncAssaultMeshes(); syncGuardMeshes(); renderAssaultHud();
}

function resetAssault() {
    assault.active = false;
    assault.attackers = []; assault.defenders = [];
    assault.acc = 0; assault.elapsedMs = 0; assault.result = null;
    for (const kind of ATTACK_KINDS) {
        const im = assaultMeshes[kind];
        im.count = 0; im.instanceMatrix.needsUpdate = true;
    }
    for (const mesh of chestHigh.userData.guards) {      // 守军回岗位、复现
        const h = mesh.userData.home;
        mesh.position.set(h.x, h.y, h.z);
        mesh.rotation.set(0, h.yaw, 0);
        mesh.visible = true;
    }
    $('battle').hidden = true;
}

// 攻方推进：近战到切比雪夫 5.4 停下（不穿墙），弓手到欧氏 7.5 停下
function advanceAttacker(a, ms) {
    const r = Math.hypot(a.x, a.z);
    if (r < 1e-6) return;
    const stopR = a.type === 'archer' ? ARCHER_STOP_R
        : MELEE_STOP_R * r / Math.max(Math.abs(a.x), Math.abs(a.z));   // 该方位上切比雪夫 5.4 对应的欧氏半径
    const nr = Math.max(r - a.typeData.speed * ms / 1000, stopR);
    if (nr >= r - 1e-9) return;
    const k = nr / r;
    a.x *= k; a.z *= k;
}

// 射程内最近的一名目标（水平距离判定，忽略高度差；同距取数组序 → 确定性）
function nearestInRange(list, from, range) {
    let best = null, bestD = Infinity;
    for (const u of list) {
        if (u.dead) continue;
        const d = Math.hypot(u.x - from.x, u.z - from.z);
        if (d > range) continue;
        if (d < bestD - 1e-9) { bestD = d; best = u; }
    }
    return best;
}
function nearestOf(list, from) {
    let best = null, bestD = Infinity;
    for (const u of list) {
        if (u.dead) continue;
        const d = Math.hypot(u.x - from.x, u.z - from.z);
        if (d < bestD - 1e-9) { bestD = d; best = u; }
    }
    return best;
}

function strike(target, dmg) {
    if (target.dead) return;
    target.hp -= dmg;
    if (target.hp <= 0) { target.hp = 0; target.dead = true; }
}

// 单个固定步长：1/60 秒
function stepAssault(ms) {
    assault.elapsedMs += ms;
    const atk = assault.attackers.filter(u => !u.dead);
    const def = assault.defenders.filter(u => !u.dead);
    for (const a of atk) a.cd -= ms;
    for (const d of def) d.cd -= ms;

    // 垛口名额分配：每个守军同一时刻最多被 3 名近战攻方贴身围攻；多余的改打其他守军或外围待命
    const load = new Map();
    for (const d of def) load.set(d, 0);
    for (const a of atk) {
        a.target = null;
        if (a.type === 'archer') continue;                 // 远程不计入贴身名额
        let best = null, bestD = Infinity;
        for (const d of def) {
            const dd = Math.hypot(a.x - d.x, a.z - d.z);
            if (dd > a.typeData.range) continue;           // 射程外不占名额
            if (load.get(d) >= GUARD_MELEE_CAP) continue;  // 垛口已满 3 人
            if (dd < bestD - 1e-9) { bestD = dd; best = d; }
        }
        if (best) { a.target = best; load.set(best, load.get(best) + 1); }
    }

    for (const a of atk) {
        advanceAttacker(a, ms);
        a.yaw = a.target && !a.target.dead ? Math.atan2(a.target.x - a.x, a.target.z - a.z) : Math.atan2(-a.x, -a.z);
    }

    // 攻方出手：对守军有效伤害 = max(1, floor(base × WALL_GUARD_COVER))（居高临下更耐打）
    for (const a of atk) {
        if (a.cd > 0) continue;
        const tgt = a.type === 'archer' ? nearestInRange(def, a, a.typeData.range) : a.target;
        if (!tgt || tgt.dead) continue;
        const base = calculateAttackDamage(a, tgt, { multiplier: 1 });
        strike(tgt, Math.max(1, Math.floor(base * CAMP_RULES.WALL_GUARD_COVER)));
        a.cd = a.typeData.atkSpeed;
    }

    // 守方跑位：沿寨墙环（半边长 5.0）朝最近活着的攻方挪动，不许穿寨
    const per = 8 * WALL_R;
    for (const d of def) {
        if (d.dead) continue;
        const nf = nearestOf(atk, d);
        const have = wallParamToward(d.x, d.z);
        const want = nf ? wallParamToward(nf.x, nf.z) : d.homeT;
        let diff = want - have;
        if (diff > per / 2) diff -= per; else if (diff < -per / 2) diff += per;
        if (Math.abs(diff) > 1e-3) {
            const step = Math.min(Math.abs(diff), d.typeData.speed * ms / 1000) * Math.sign(diff);
            const p = wallPoint(have + step, WALL_R);
            d.x = p[0]; d.z = p[1];
        }
        d.yaw = nf ? Math.atan2(nf.x - d.x, nf.z - d.z) : Math.atan2(d.x, d.z);
    }

    // 守方出手：只打射程内最近的一名攻方；居高临下 × WALL_GUARD_ATTACK
    for (const d of def) {
        if (d.dead || d.cd > 0) continue;
        const tgt = nearestInRange(atk, d, d.typeData.range);
        if (!tgt) continue;
        strike(tgt, calculateAttackDamage(d, tgt, { multiplier: CAMP_RULES.WALL_GUARD_ATTACK }));
        d.cd = d.typeData.atkSpeed;
    }

    if (assault.result === null) {
        if (!assault.defenders.some(u => !u.dead)) assault.result = 'break';   // 守军全灭 = 攻方破寨
        else if (!assault.attackers.some(u => !u.dead)) assault.result = 'hold'; // 攻方全灭 = 守方守住
    }
}

// 攻方实例矩阵：位置用 (x, 0, z)，yaw = atan2(方向x, 方向z)；阵亡者缩到 0 隐藏
// （队伍色在创建时已由 setColorAt 一次性涂蓝，之后不变，故每帧只更新矩阵）
function syncAssaultMeshes() {
    const n = { infantry: 0, pikeman: 0, archer: 0 };
    for (const a of assault.attackers) n[a.type]++;
    for (const kind of ATTACK_KINDS) assaultMeshes[kind].count = n[kind];
    for (const a of assault.attackers) {
        const im = assaultMeshes[a.type];
        dummy.position.set(a.x, 0, a.z);
        dummy.rotation.set(0, a.dead ? 0 : a.yaw, 0);
        dummy.scale.set(a.dead ? 0 : 1, a.dead ? 0 : 1, a.dead ? 0 : 1);
        dummy.updateMatrix();
        im.setMatrixAt(a.slot, dummy.matrix);
    }
    for (const kind of ATTACK_KINDS) assaultMeshes[kind].instanceMatrix.needsUpdate = true;
}

// 守军网格：逻辑位置在寨墙环，网格仍落在踩台（内缩 WALK_INSET，与静态样张一致）
function syncGuardMeshes() {
    for (const d of assault.defenders) {
        if (d.dead) { d.mesh.visible = false; continue; }
        d.mesh.visible = true;
        const [ix, iz] = inward(d.x, d.z);
        d.mesh.position.set(ix, WALKWAY_H, iz);
        d.mesh.rotation.y = d.yaw;
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
    // 战损比 = 攻方阵亡 : 守方阵亡（守方为 0 时显示「∞ / -」）
    $('ratio').textContent = defLost === 0 ? '∞ / -' : `${atkLost} : ${defLost}`;
    $('elapsed').textContent = (assault.elapsedMs / 1000).toFixed(1);
    $('verdict').textContent = assault.result === 'break' ? '攻方破寨' : assault.result === 'hold' ? '守方守住' : '进行中';
}

// 固定步长累加器（参考 main.js 的 accumulator 写法）：与帧率无关，纯确定性
// 分出胜负后停止步进（用时定格），只继续刷新画面与读数
function updateAssault(dtSec) {
    if (!assault.active) return;
    if (assault.result === null) {
        assault.acc += dtSec * 1000;
        let guard = 0;
        while (assault.acc >= ASSAULT_STEP_MS && guard++ < 8) {
            stepAssault(ASSAULT_STEP_MS);
            assault.acc -= ASSAULT_STEP_MS;
        }
        if (guard >= 8) assault.acc = 0;
    }
    syncAssaultMeshes(); syncGuardMeshes(); renderAssaultHud();
}

$('btn-assault').onclick = () => { startAssault($('sel-force').value); };
$('btn-assault-reset').onclick = () => { resetAssault(); };

renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), .05);
    updateGateAnim(dt);
    updateAssault(dt);
    controls.update(); renderer.render(scene, camera);
});

window.__camp = { scene, camera, controls, chestHigh, wallTop, renderer, gate, ram, gateState,
    assault, assaultMeshes, startAssault, resetAssault, stepAssault };
