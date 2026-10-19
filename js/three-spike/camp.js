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
const WALL_R = 5.0;                       // 前线营寨墙环半径（继续放大；大本营 3.5）
const WALL_SLOTS = 6;                     // 垛口数 = 周长等分
const GATE_HALF = 1.2;                    // +gy 侧寨门半宽（2D 已有此约定：中间留 2 段缺口）
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
const inward = (gx, gy) => { const l = Math.hypot(gx, gy) || 1; return [gx - gx / l * WALK_INSET, gy - gy / l * WALK_INSET]; };

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
        const w = WALKWAY_W, inset = WALK_INSET;
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
// 开向说明：门洞内侧就是守门兵站台（台面 1.0 高），门扇若朝寨内开必然扫过台面穿模，
// 故门扇一律朝寨外（+z）推开——正好也是被门外冲车撞击的方向。
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
    // 门内站台：门洞内侧一块木板台（守门兵站位），台面齐踩台高；台下两根支柱落地
    const PLAT_D = .6, PLAT_W = GATE_HALF * 2, PLAT_H = WALKWAY_H, platZ = z0 - .55;
    parts.push(box(PLAT_W, .12, PLAT_D, 0, PLAT_H - .06, platZ, WOOD));                    // 台面
    for (const s of [-1, 1])
        parts.push(box(.14, PLAT_H - .12, .14, s * .85, (PLAT_H - .12) / 2, platZ, TIMBER)); // 支柱
    const frame = new THREE.Mesh(mergeGeometries(parts), campMat);
    frame.castShadow = true; frame.receiveShadow = true;

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

    // 门闩横木：关门时横跨两扇中缝（独立网格，开门/被撞开后脱落隐藏）
    const bar = new THREE.Mesh(mergeGeometries([
        box(GATE_HALF * 2 - .05, .16, .16, 0, 1.15, z0 - .12, 0x5f4226),                     // 闩木
        box(.14, .3, .14, -POST_X + .12, 1.15, z0 - .12, DARK),                              // 端部卡座
        box(.14, .3, .14, POST_X - .12, 1.15, z0 - .12, DARK)
    ]), campMat);
    bar.castShadow = true; bar.receiveShadow = true;

    const group = new THREE.Group();
    group.add(frame, doorL, doorR, bar);
    // 守门兵 ×2：站在门内站台上，面朝寨外（+z，yaw=0）
    for (const s of [-1, 1])
        group.add(soldierMesh('infantry', guardMat, s * .55, PLAT_H, platZ, 0));
    group.userData = { doorL, doorR, bar };
    return group;
}

// ---------------- 冲车（撞木 + 铁箍撞头 + 车架 + 四轮；撞门纯视觉） ----------------
// 停在寨门外 1.8 处，推进到撞头抵住门扇的位置，随后门扇被撞开、冲车被顶回。
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
const GATE_OPEN_ANGLE = 1.3;                       // 双扇联动全开 ≈74.5°（朝寨外推开）
const RAM_REST = 8.2, RAM_HIT = 6.45;              // 冲车停放位 / 撞门位（撞头铁箍正好抵住门扇）
const gate = gateGroup();
const ram = ramGroup();
ram.position.set(0, 0, RAM_REST);
const gateState = { phase: 'idle', t: 0, open: 0, angle: 0, rammed: false };

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
// 开门/关门：一次动作双扇联动；关门位重新挂上门闩横木
$('btn-gate').onclick = () => { gateState.open = gateState.open ? 0 : 1; };
// 冲车撞门：推进 → 撞上瞬间门扇向外弹开、门闩脱落、门板显裂纹 → 冲车被顶回
$('btn-ram').onclick = () => { if (gateState.phase === 'idle' && !gateState.open) gateState.phase = 'advance'; };

const clock = new THREE.Clock(), gateBtn = $('btn-gate');
function updateGateAnim(dt) {
    const st = gateState, u = gate.userData;
    // 双扇联动：同一次动作一起开合（左扇负角、右扇正角，绕各自铰链朝寨外转）
    st.angle += ((st.open ? GATE_OPEN_ANGLE : 0) - st.angle) * Math.min(1, dt * 7);
    u.doorL.rotation.y = -st.angle;
    u.doorR.rotation.y = st.angle;
    u.bar.visible = st.angle < .18;                     // 门闩只存在于关门位
    u.doorL.userData.crack.visible = u.doorR.userData.crack.visible = st.rammed;
    if (st.phase === 'advance') {                       // 冲车推进（加速逼近）
        st.t = Math.min(1, st.t + dt / .55);
        ram.position.z = RAM_REST + (RAM_HIT - RAM_REST) * st.t * st.t;
        if (st.t >= 1) { st.phase = 'burst'; st.t = 0; st.open = 1; st.rammed = true; }
    } else if (st.phase === 'burst') {                  // 撞上：门扇向外弹开，冲车被反冲顶回（前段快、后段缓）
        st.t = Math.min(1, st.t + dt / .35);
        ram.position.z = RAM_HIT + (RAM_REST - RAM_HIT) * Math.sqrt(st.t);
        if (st.t >= 1) { st.phase = 'idle'; st.t = 0; }
    }
    const want = st.open ? '关门' : '开门';
    if (gateBtn.textContent !== want) gateBtn.textContent = want;
}

renderer.setAnimationLoop(() => {
    updateGateAnim(Math.min(clock.getDelta(), .05));
    controls.update(); renderer.render(scene, camera);
});

window.__camp = { scene, camera, controls, chestHigh, wallTop, renderer, gate, ram, gateState };
