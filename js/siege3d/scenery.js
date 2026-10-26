// ==================== siege3d 美术层（第一轮）====================
// 纯视觉：草地质感 CanvasTexture、草丛 InstancedMesh、营寨帐篷与飘旗、
// 外围山川河流树林。不读/写任何 battle/ 模拟状态，不 import 逻辑文件。
// 所有随机用固定种子，确定性可复现。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { board } from '../board.js';
import { CAMP_LAYOUT as L } from './layout.js';
import { campBounds } from './walls.js';


// 外围带宽（与 buildSurroundings 的 SIDE 一致）
const SURROUND_SIDE = 80;

// 西侧河道（世界坐标）：中心线随 Z 弯曲、宽度随 Z 起伏。
// 水面与树林避让共用同一套函数，避免树长进河里。
const riverAxisAt = z => {
    const t = (z + board.H / 2 + SURROUND_SIDE) / (board.H + SURROUND_SIDE * 2);
    return -board.W / 2 - 35 + Math.sin(t * Math.PI * 3) * 3;
};
const riverHalfWidthAt = z => {
    const t = (z + board.H / 2 + SURROUND_SIDE) / (board.H + SURROUND_SIDE * 2);
    // 原宽 2~6，共加宽 10 倍后取半宽（全宽 10~30，最东岸仍在战场西界 -35 之外）
    return (4 + Math.sin(t * Math.PI * 2.5) * 2) * 5;
};
const inRiver = (x, z, margin = 2.5) =>
    Math.abs(x - riverAxisAt(z)) < riverHalfWidthAt(z) + margin;

// ---------- 确定性 mulberry32 ----------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ============================================================================
// 步骤 1 · 草地质感 CanvasTexture
// ============================================================================
export function buildGrassTexture(size = 1024) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;

    // 主色保持 #6f7d4c；噪点只做 ±6% 明暗细节，整体亮度与改动前一致。
    const BASE = [0x6f, 0x7d, 0x4c];

    const hash = (x, y, s = 0) => {
        let h = (Math.imul(x + s, 374761393) + Math.imul(y + s, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    // 周期性格点噪声：格点按 P 取模，贴图 8×8 平铺时四边无缝
    const pnoise = (x, y, P, s = 0) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        const fx = x - xi, fy = y - yi;
        const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
        const wrap = (a, b) => hash(((a % P) + P) % P, ((b % P) + P) % P, s);
        const a = wrap(xi, yi), b = wrap(xi + 1, yi);
        const c = wrap(xi, yi + 1), d = wrap(xi + 1, yi + 1);
        return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const tx = x / size, ty = y / size;
            const n = pnoise(tx * 16, ty * 16, 16, 0) * 0.5 +
                pnoise(tx * 40, ty * 40, 40, 7) * 0.32 +
                pnoise(tx * 96, ty * 96, 96, 13) * 0.18;
            // 亮度因子严格锁在 0.94~1.06，绝不整体压暗
            const grain = (hash(x, y, 12345) - 0.5) * 0.02;
            const k = Math.max(0.94, Math.min(1.06, 1 + (n - 0.5) * 0.12 + grain));

            const i = (y * size + x) * 4;
            data[i] = BASE[0] * k;
            data[i + 1] = BASE[1] * k;
            data[i + 2] = BASE[2] * k;
            data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 8);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// ============================================================================
// 步骤 1 · 草丛 InstancedMesh
// ============================================================================
export function buildGrassPatches(cap = 6000) {
    const CAMP = campBounds();
    const group = new THREE.Group();
    // 三片交叉细长三角片的顶点（XY 平面，底面 y=0）
    const botColor = new THREE.Color('#6b7a3f');
    const topColor = new THREE.Color('#8c9a55');

    const bot = [0, 0.32];
    const top = [0, 0.32];

    // 简化：单一 YZ 平面的草片 + 旋转副本
    function makeBlade() {
        const g = new THREE.BufferGeometry();
        const v = new Float32Array([
            0, 0, 0,   0.008, 0.006, 0,   -0.008, 0.006, 0,   // 底部短三角
            0, 0.32, 0,  0.016, 0.04, 0,   -0.016, 0.04, 0,     // 上部
            0, 0, 0,   0.016, 0.04, 0,    0.008, 0.006, 0,     // 连接面
            0, 0, 0,  -0.016, 0.04, 0,   -0.008, 0.006, 0,
        ]);
        g.setAttribute('position', new THREE.BufferAttribute(v, 3));
        g.setIndex([0, 1, 3, 0, 3, 2, 3, 4, 5, 3, 5, 6]);
        g.computeVertexNormals();
        // 顶点色
        const pos = g.attributes.position;
        const c = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            const y = pos.getY(i);
            const t = Math.min(1, y / 0.32);
            const col = botColor.clone().lerp(topColor, t);
            c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
        }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        return g;
    }
    const blade1 = makeBlade();
    const blade2 = blade1.clone().rotateY(Math.PI / 3);
    const blade3 = blade1.clone().rotateY(-Math.PI / 3);
    const grassGeo = mergeGeometries([blade1, blade2, blade3]);
    blade1.dispose(); blade2.dispose(); blade3.dispose();
    grassGeo.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, transparent: false, depthWrite: true
    });
    const mesh = new THREE.InstancedMesh(grassGeo, mat, cap);
    mesh.count = 0; mesh.frustumCulled = true;
    mesh.receiveShadow = true; mesh.castShadow = false;

    const rng = mulberry32(198765);
    const dummy = new THREE.Object3D();
    let slot = 0;

    const half = L.halfSize + L.wallThickness;
    // 寨门前 3 格避让区（从营寨边界向南）
    const gateCx = CAMP.cx;
    const gateClearY = CAMP.cy + half + 3;

    while (slot < cap) {
        const gx = rng() * board.W;
        const gy = rng() * board.H;
        // 避让营寨内
        if (gx > CAMP.cx - half && gx < CAMP.cx + half && gy > CAMP.cy - half && gy < CAMP.cy + half) continue;
        // 避让寨门前区域（门前 3 格）
        if (gx > gateCx - 3 && gx < gateCx + 3 && gy > CAMP.cy + half - 1 && gy < gateClearY) continue;

        const h = 0.18 + rng() * 0.14;
        const rollY = rng() * Math.PI * 2;
        const leanX = (rng() - 0.5) * 0.1;
        const leanZ = (rng() - 0.5) * 0.1;
        dummy.position.set(gx - board.W / 2, 0, gy - board.H / 2);
        dummy.rotation.set(leanX, rollY, leanZ);
        dummy.scale.setScalar(h / 0.32);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot++, dummy.matrix);
    }
    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    return group;
}

// ============================================================================
// 步骤 2 · 营寨帐篷 + 飘旗
// ============================================================================
export function buildCampTents(siege) {
    const CAMP = campBounds();
    const group = new THREE.Group();
    const rng = mulberry32(77777);
    const clothMat = new THREE.MeshStandardMaterial({ color: '#c9c2ac', roughness: 1 });
    const roofMat = new THREE.MeshStandardMaterial({ color: '#e6e0cc', roughness: 1 });
    const trimMat = new THREE.MeshStandardMaterial({ color: '#6f6353', roughness: 1 });
    const poleMat = new THREE.MeshStandardMaterial({ color: '#6e4f2e', roughness: 1 });

    // 避让区域
    const avoidRects = [];
    if (siege?.platforms) {
        for (const p of siege.platforms) {
            avoidRects.push({
                x1: p.x1 - L.towerClearance - 0.8, x2: p.x2 + L.towerClearance + 0.8,
                y1: p.y1 - L.towerClearance - 0.8, y2: p.y2 + L.towerClearance + 0.8
            });
        }
    }
    const half = L.halfSize;
    const gateHalf = L.gateWidth / 2;
    avoidRects.push({
        x1: CAMP.cx - gateHalf - 1.5, x2: CAMP.cx + gateHalf + 1.5,
        y1: CAMP.cy + half - 1.5, y2: CAMP.cy + half + 1
    });

    function avoid(gx, gy, r) {
        for (const rect of avoidRects) {
            if (gx + r > rect.x1 && gx - r < rect.x2 && gy + r > rect.y1 && gy - r < rect.y2) return true;
        }
        return false;
    }

    // 扎营布局：预备队方阵钉死在 x 30.1~39.9 × y 34.4~39.6（见 siege-defense.js
    // 的 reservePosts），地面弓手站在墙内 2 格线，因此小帐篷只能落在北半区
    // y 28~34 的净空带里：两排四列、沿中轴镜像，门（山墙）朝南正对中军。
    const tentRows = [CAMP.cy - 5.8, CAMP.cy - 2.4];
    const westCols = [CAMP.cx - 5.4, CAMP.cx - 3.3];
    const tentPairs = [];
    for (const gy of tentRows) for (const gx of westCols)
        tentPairs.push({ w: { gx, gy }, e: { gx: 2 * CAMP.cx - gx, gy } });
    const tentLocs = tentPairs.filter(p => !avoid(p.w.gx, p.w.gy, .9) && !avoid(p.e.gx, p.e.gy, .9));

    // 中军大帐：开敞式帅棚——四角立柱 + 深色挑檐 + 四坡尖顶，无帐身。
    // 预备队方阵北面三排（gy 34.4~35.9）正落在棚内，封闭帐身会穿模；
    // 凉棚让"中军听令"的画面成立，夺旗点也一眼可辨。
    function buildCommandTent(gx, gy) {
        const tent = new THREE.Group();
        const eaveMat = new THREE.MeshStandardMaterial({ color: '#7a4a38', roughness: 1 });
        const add = (geo, mat, x, y, z, rotY = 0) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x, y, z); m.rotation.y = rotY;
            m.castShadow = true; m.receiveShadow = true;
            tent.add(m); return m;
        };
        // 四角立柱（加高到 1.9，士兵在柱间穿行不碰头）
        for (const [px, pz] of [[-.85, -.85], [.85, -.85], [-.85, .85], [.85, .85]])
            add(new THREE.BoxGeometry(0.08, 1.9, 0.08), poleMat, px, 0.95, pz);
        // 深色挑檐
        add(new THREE.CylinderGeometry(1.02, 1.22, 0.16, 4, 1), eaveMat, 0, 1.98, 0, Math.PI / 4);
        // 四坡尖顶 + 顶杆宝珠
        add(new THREE.ConeGeometry(1.05, 0.85, 4), eaveMat, 0, 2.485, 0, Math.PI / 4);
        add(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), poleMat, 0, 3.03, 0);
        add(new THREE.SphereGeometry(0.08, 8, 6), eaveMat, 0, 3.31, 0);
        tent.position.set(gx - board.W / 2, 0, gy - board.H / 2);
        return tent;
    }

    group.add(buildCommandTent(CAMP.cx, CAMP.cy));

    // ---- 小帐篷模板 ----
    // 帆布墙 + 双坡顶 + 两端山墙 + 门帘 + 地布 + 脊杆/立杆/拉绳/地钉。
    // 按材质合并成 3 份几何，8 顶帐篷共用，共 24 个 draw call。
    function buildTentTemplate() {
        const hw = .7, hd = .78, wallH = .45, apexY = 1.25;
        const buckets = new Map();
        const bucket = mat => {
            if (!buckets.has(mat)) buckets.set(mat, { quads: [], prims: [] });
            return buckets.get(mat);
        };
        const tri = (out, a, b, c) => out.push(...a, ...b, ...c);
        const quad = (out, a, b, c, d) => { tri(out, a, b, c); tri(out, a, c, d); };
        // 合并要求属性一致：去掉 uv，统一成非索引几何。
        const prep = geo => { geo.deleteAttribute('uv'); return geo.index ? geo.toNonIndexed() : geo; };
        const prim = (mat, geo, pos = [0, 0, 0], rot = null) => {
            const m = new THREE.Matrix4();
            if (rot) m.makeRotationFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0));
            m.setPosition(pos[0], pos[1], pos[2]);
            bucket(mat).prims.push(prep(geo.applyMatrix4(m)));
        };
        const strut = (mat, a, b, r) => {
            const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
            const dir = new THREE.Vector3().subVectors(vb, va);
            const geo = new THREE.CylinderGeometry(r, r, dir.length(), 5, 1);
            const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
            const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
            m.setPosition(va.add(vb).multiplyScalar(.5));
            bucket(mat).prims.push(prep(geo.applyMatrix4(m)));
        };

        // 帆布墙与两端五边形山墙（法线朝外）
        const cloth = bucket(clothMat).quads;
        quad(cloth, [-hw, 0, -hd], [-hw, 0, hd], [-hw, wallH, hd], [-hw, wallH, -hd]);
        quad(cloth, [hw, 0, hd], [hw, 0, -hd], [hw, wallH, -hd], [hw, wallH, hd]);
        tri(cloth, [-hw, 0, -hd], [-hw, wallH, -hd], [0, apexY, -hd]);
        tri(cloth, [-hw, 0, -hd], [0, apexY, -hd], [hw, wallH, -hd]);
        tri(cloth, [-hw, 0, -hd], [hw, wallH, -hd], [hw, 0, -hd]);
        tri(cloth, [-hw, 0, hd], [hw, 0, hd], [hw, wallH, hd]);
        tri(cloth, [-hw, 0, hd], [hw, wallH, hd], [0, apexY, hd]);
        tri(cloth, [-hw, 0, hd], [0, apexY, hd], [-hw, wallH, hd]);
        // 双坡屋顶单独用更亮的帆布，并向四面出挑 5cm，形成檐口阴影线
        const roof = bucket(roofMat).quads;
        const ex = hw + .05, ez = hd + .05, ey = wallH - .02;
        quad(roof, [-ex, ey, -ez], [-ex, ey, ez], [0, apexY, ez], [0, apexY, -ez]);
        quad(roof, [ex, ey, ez], [ex, ey, -ez], [0, apexY, -ez], [0, apexY, ez]);

        // 门帘：开在 +Z 山墙，帐篷朝向营内街道
        const dk = bucket(trimMat).quads;
        quad(dk, [-.28, 0, hd + .012], [.28, 0, hd + .012], [.28, .95, hd + .012], [-.28, .95, hd + .012]);
        // 地布：贴地一圈深色帆布，压住帐脚
        prim(trimMat, new THREE.PlaneGeometry(2 * hw + .34, 2 * hd + .3).rotateX(-Math.PI / 2), [0, .02, 0]);

        // 脊杆（两端出头）、两片山墙立杆、四根拉绳与地钉
        prim(poleMat, new THREE.CylinderGeometry(.035, .035, 2 * hd + .26, 6).rotateX(Math.PI / 2), [0, apexY, 0]);
        for (const z of [-hd, hd]) prim(poleMat, new THREE.BoxGeometry(.06, apexY, .06), [0, apexY / 2, z]);
        for (const z of [-hd, hd]) for (const sx of [-1, 1]) {
            const out = Math.sign(z);
            const top = [0, apexY - .06, z + out * .12];
            const foot = [sx * .62, .02, z + out * .52];
            strut(poleMat, top, foot, .012);
            prim(poleMat, new THREE.BoxGeometry(.07, .12, .07), [foot[0], .06, foot[2]]);
        }

        const parts = [];
        for (const [mat, b] of buckets) {
            const geos = b.prims.slice();
            if (b.quads.length) {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.Float32BufferAttribute(b.quads, 3));
                g.computeVertexNormals();
                geos.push(g);
            }
            parts.push({ geo: mergeGeometries(geos, false), mat });
        }
        return parts;
    }

    const tentParts = buildTentTemplate();
    const addSmallTent = (gx, gy, rotY, s) => {
        const tent = new THREE.Group();
        for (const { geo, mat } of tentParts) {
            const mesh = new THREE.Mesh(geo, mat);
            mesh.castShadow = true; mesh.receiveShadow = true;
            tent.add(mesh);
        }
        tent.position.set(gx - board.W / 2, 0, gy - board.H / 2);
        tent.rotation.y = rotY;
        tent.scale.setScalar(s);
        group.add(tent);
    };
    // 两组帐篷都让山墙朝向相机（+Z），屋脊沿南北向，远看就是三角帐形；
    // 每对共用一组种子扰动并镜像，保持左右视觉一致。
    for (const { w, e } of tentLocs) {
        const jx = (rng() - .5) * .28, jy = (rng() - .5) * .28;
        const jr = (rng() - .5) * .07, s = .95 + rng() * .1;
        addSmallTent(w.gx + jx, w.gy + jy, jr, s);
        addSmallTent(e.gx - jx, e.gy + jy, -jr, s);
    }

    return group;
}

// 大帐飘旗（顶点正弦平移）——返回 { mesh, update } 对象
export function createTentFlag() {
    const CAMP = campBounds();
    const geo = new THREE.PlaneGeometry(1.0, 0.7, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x387bdd, roughness: 0.8, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    // 旗面沿 +Z 展开（默认相机在 +Z 侧，正对旗面），左缘贴旗杆；
    // 再向 +Z 让 0.03，遮住 walls.js 里旧的那块静态旗板（本期不允许改 walls.js）。
    const worldX = CAMP.cx - board.W / 2 + 0.5;
    const worldZ = CAMP.cy - board.H / 2 + 0.03;
    mesh.position.set(worldX, 3.0, worldZ);

    // 缓存原始顶点
    const pos = geo.attributes.position;
    const origZ = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) origZ[i] = pos.getZ(i);

    function update(t) {
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            // 贴杆的左缘几乎不动，自由端摆幅最大
            const amp = 0.35 + (x + 0.5);
            const sway = Math.sin(t * 2.0 + x * 2.4 + y * 2.0) * 0.05 * amp;
            const flutter = Math.cos(t * 3.6 + x * 5.0 + y * 4.0) * 0.02 * amp;
            pos.setZ(i, origZ[i] + sway + flutter);
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();
    }
    return { mesh, update };
}

// ============================================================================
// 步骤 3 · 外围地面 + 山川 + 河流 + 树林
// ============================================================================
export function buildSurroundings(grassTexture) {
    const group = new THREE.Group();
    const SIDE = SURROUND_SIDE;   // 外围带宽（世界单位）
    const HX = board.W / 2;       // 战场实际半宽
    const HZ = board.H / 2;       // 战场实际半高
    const TILE = board.W / 8;     // 与战场地面 8×8 平铺同尺度：随棋盘尺寸变化

    // 外围地面：四块与战场边界严丝合缝的边框，不与战场地面重叠。
    // 旧版是一块 230×230 的大平面压在战场平面上（同为 y=0）——深度冲突正是横向浅色条带的来源。
    const outerTex = grassTexture.clone();
    outerTex.repeat.set(1, 1);
    outerTex.needsUpdate = true;
    const extMat = new THREE.MeshStandardMaterial({
        map: outerTex, roughness: 1   // 与战场地面同一贴图、同一亮度，内外无色差
    });
    function strip(x1, x2, z1, z2) {
        const geo = new THREE.PlaneGeometry(x2 - x1, z2 - z1, 1, 1);
        geo.rotateX(-Math.PI / 2);
        geo.translate((x1 + x2) / 2, 0, (z1 + z2) / 2);
        // 世界尺度 UV：与战场地面使用同一瓦片尺寸，接缝处纹理连续
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / TILE, pos.getZ(i) / TILE);
        uv.needsUpdate = true;
        const mesh = new THREE.Mesh(geo, extMat);
        mesh.receiveShadow = true;
        group.add(mesh);
    }
    strip(-HX - SIDE, HX + SIDE, -HZ - SIDE, -HZ);   // 北
    strip(-HX - SIDE, HX + SIDE, HZ, HZ + SIDE);     // 南
    strip(-HX - SIDE, -HX, -HZ, HZ);                 // 西
    strip(HX, HX + SIDE, -HZ, HZ);                   // 东

    // ---- 河流（西侧外围，弯曲；宽度为旧版 10 倍）----
    // 连续带状网格：两岸宽度随 Z 平滑变化，不再像分段箱体那样出现锯齿台阶。
    const riverMat = new THREE.MeshStandardMaterial({
        color: 0x4f7f8a, transparent: true, opacity: 0.85, roughness: 0.4, metalness: 0.1
    });
    const bankMat = new THREE.MeshStandardMaterial({ color: 0x8a8370, roughness: 1 });
    const riverGroup = new THREE.Group();

    // 生成一条沿 Z 延伸的带状网格；offset 为相对河心的左右边界偏移
    function riverRibbon(edgeFn, y) {
        const segs = 120;
        const z0 = -board.H / 2 - SIDE, z1 = board.H / 2 + SIDE;
        const pos = [];
        for (let i = 0; i < segs; i++) {
            const za = z0 + (z1 - z0) * (i / segs);
            const zb = z0 + (z1 - z0) * ((i + 1) / segs);
            const [ax1, ax2] = edgeFn(za);
            const [bx1, bx2] = edgeFn(zb);
            // 逆时针绕向（自上俯视 +Y 朝上）：A-C-B / B-C-D
            pos.push(ax1, y, za, bx1, y, zb, ax2, y, za);
            pos.push(ax2, y, za, bx1, y, zb, bx2, y, zb);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.computeVertexNormals();
        return geo;
    }

    const waterGeo = riverRibbon(z => {
        const a = riverAxisAt(z), h = riverHalfWidthAt(z);
        return [a - h, a + h];
    }, 0.01);
    const water = new THREE.Mesh(waterGeo, riverMat);
    water.receiveShadow = true;
    riverGroup.add(water);

    // 碎石岸：沿水线内外各 0.8 宽的连续窄带
    const BANK_W = 0.9;
    const westBank = new THREE.Mesh(riverRibbon(z => {
        const a = riverAxisAt(z), h = riverHalfWidthAt(z);
        return [a - h - BANK_W, a - h + 0.05];
    }, 0.02), bankMat);
    const eastBank = new THREE.Mesh(riverRibbon(z => {
        const a = riverAxisAt(z), h = riverHalfWidthAt(z);
        return [a + h - 0.05, a + h + BANK_W];
    }, 0.02), bankMat);
    westBank.receiveShadow = true; eastBank.receiveShadow = true;
    riverGroup.add(westBank, eastBank);
    group.add(riverGroup);

    // ---- 远山（北侧 + 东侧）----
    // 旧版用三层圆锥叠成山，与外圈树冠同为"多层锥"，隔着一层雾就像巨树。
    // 现在改为连续高度场山脊：数个峰沿脊线叠加成一块完整山体，四周边缘高度
    // 衰减到 0，山脚因此贴合地面，既没有独立锥体的悬空缝，也不会露出"尖塔阵"。
    // 山脚冷灰、山腰渐浅、峰顶积雪，从造型与色调上和树冠彻底分开。
    const mountainRng = mulberry32(33333);
    const mountainMat = new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: false, roughness: 1
    });
    // 空气透视：远山颜色向雾色靠拢，与场景雾（#b9c5ab）自然衔接
    const HAZE = new THREE.Color('#b9c5ab');
    const ROCK_LOW = new THREE.Color('#7d887a');
    const ROCK_MID = new THREE.Color('#aab4a5');
    const SNOW = new THREE.Color('#eff3ec');

    // 只依赖坐标的确定性抖动
    const hashSign = (x, y, z, salt) => {
        let h = Math.imul(Math.round(x * 71) ^ Math.round(y * 53) ^ Math.round(z * 97) ^ salt, 2246822519);
        h = Math.imul(h ^ (h >>> 13), 3266489917);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
    };
    // 平滑值噪声（格点哈希 + smoothstep 双线性插值）：给山体提供连续的岩脊起伏，
    // 而不是逐顶点白噪声那种"揉皱的纸"。只依赖坐标，换座/重演完全可复现。
    const smoothNoise = (x, z, freq, salt) => {
        const gx = x * freq, gz = z * freq;
        const ix = Math.floor(gx), iz = Math.floor(gz);
        const fx = gx - ix, fz = gz - iz;
        const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
        const h00 = hashSign(ix, 0, iz, salt), h10 = hashSign(ix + 1, 0, iz, salt);
        const h01 = hashSign(ix, 0, iz + 1, salt), h11 = hashSign(ix + 1, 0, iz + 1, salt);
        return (h00 * (1 - ux) + h10 * ux) * (1 - uz) + (h01 * (1 - ux) + h11 * ux) * uz;
    };

    const mountainGroup = new THREE.Group();
    // 一组山 = 一块连绵山体，整块只产生 1 个 draw call
    // axis='x' 生成东西向山脊（北侧），axis='z' 生成南北向山脊（东侧）
    function addRidge(cx, cz, spanX, spanZ, baseHeight, salt, axis = 'x') {
        // 网格分辨率决定山体的形体语言：24×7 只能撑出粗略折面，
        // 抬到 48×16 之后才有足够的起伏去承载沟壑与岩脊。
        const nx = 48, nz = 16;
        const spanAlong = axis === 'x' ? spanX : spanZ;
        // 峰数随山脊长度走：长脊用更多、更小的峰，脊线呈细碎锯齿而不是几个大圆包
        const count = Math.max(4, Math.min(9, Math.round(spanAlong / 8)));
        const peaks = [];
        for (let i = 0; i < count; i++) {
            const along = count > 1 ? i / (count - 1) - 0.5 : 0;
            const jitter = (mountainRng() - 0.5) * 0.08;
            peaks.push({
                x: axis === 'x' ? (along + jitter) * spanX * 0.9 : (mountainRng() - 0.5) * spanX * 0.35,
                z: axis === 'x' ? (mountainRng() - 0.5) * spanZ * 0.35 : (along + jitter) * spanZ * 0.9,
                // 两端压低、中间抬高，再叠随机，脊线不齐平
                h: baseHeight * (0.4 + mountainRng() * 0.72) * (1 - Math.abs(along) * 0.3),
                r: spanAlong * (0.17 + mountainRng() * 0.07)
            });
        }
        const grid = [];
        for (let iz = 0; iz < nz; iz++) {
            for (let ix = 0; ix < nx; ix++) {
                const u = ix / (nx - 1) - 0.5, v = iz / (nz - 1) - 0.5;
                const x = u * spanX, z = v * spanZ;
                let y = 0;
                for (const p of peaks) {
                    // 跨脊方向压缩 1.35 倍 → 山体拉成脊，同时保留足够的进深，
                    // 从高空看是"坡—脊—坡"的厚山体，而不是一堵竖立的岩墙
                    const d = axis === 'x'
                        ? Math.hypot(x - p.x, (z - p.z) * 1.35)
                        : Math.hypot((x - p.x) * 1.35, z - p.z);
                    // t^1.5：山脚宽缓、近顶急收，轮廓像真实山峰而不是圆丘
                    if (d < p.r) { const t = 1 - d / p.r; y += p.h * Math.pow(t, 1.5); }
                }
                // 四周边缘衰减到 0，山脚落地；再叠坐标抖动让轮廓不生硬。
                // 指数取 0.5 让山脚过渡更缓，相邻山脊的底部能连成一片
                const fu = Math.max(0, 1 - Math.abs(u) * 2), fv = Math.max(0, 1 - Math.abs(v) * 2);
                const edge = Math.pow(fu * fv, 0.5);
                // 三倍频平滑噪声：大尺度岩脊 + 中尺度沟壑 + 小尺度碎石。
                // 以 edge 加权，山脚处细节收敛到 0，不会把山脚顶起来悬空。
                const detail = (smoothNoise(x, z, 0.12, salt + 11) * 1.0 +
                    smoothNoise(x, z, 0.42, salt + 23) * 0.45 +
                    smoothNoise(x, z, 1.1, salt + 37) * 0.15) * baseHeight * 0.12 * edge;
                // 整体起伏用低频平滑噪声调制（逐顶点白噪声会在坡面上形成竖条状棱线）
                y = y * edge * (0.88 + smoothNoise(x, z, 0.25, salt) * 0.22) + detail;
                grid.push({ x, y: Math.max(0, y), z });
            }
        }
        // 归一化到目标高度，避免多峰叠加后过高
        const maxY = Math.max(...grid.map(p => p.y)) || 1;
        const scale = baseHeight / maxY;
        const positions = [], colors = [];
        const c = new THREE.Color();
        const rock = new THREE.Color();
        const pushVert = p => {
            // pow 0.8：轻微钝化峰顶，保留主轴脊线的形状
            const y = baseHeight * Math.pow(Math.min(1, (p.y * scale) / baseHeight), 0.8);
            positions.push(p.x, y, p.z);
            const t = y / baseHeight;
            // 雪线不再一刀切：0.72~1.0 之间平滑过渡，只有近峰顶残雪，山腰留岩石
            const s = Math.max(0, Math.min(1, (t - 0.72) / 0.28));
            rock.copy(ROCK_LOW).lerp(ROCK_MID, Math.min(1, t / 0.75));
            c.copy(rock).lerp(SNOW, s * s * (3 - 2 * s) * 0.95);
            // 岩面明暗微扰，避免整座山是一个纯色块
            c.multiplyScalar(0.94 + hashSign(p.x, 0, p.z, salt + 51) * 0.12);
            // 越远越淡：按山体到场地中心的水平距离掺入雾色
            const d = Math.hypot(cx + p.x, cz + p.z) - 45;
            c.lerp(HAZE, Math.max(0, Math.min(0.42, d / 260)));
            colors.push(c.r, c.g, c.b);
        };
        for (let iz = 0; iz < nz - 1; iz++) {
            for (let ix = 0; ix < nx - 1; ix++) {
                const a = grid[iz * nx + ix], b = grid[iz * nx + ix + 1];
                const d = grid[(iz + 1) * nx + ix], e = grid[(iz + 1) * nx + ix + 1];
                // 逆时针绕向，保证法线朝上
                pushVert(a); pushVert(d); pushVert(b);
                pushVert(b); pushVert(d); pushVert(e);
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geo.computeVertexNormals();
        geo.translate(cx, -0.3, cz);
        const m = new THREE.Mesh(geo, mountainMat);
        m.castShadow = true; m.receiveShadow = true;
        mountainGroup.add(m);
    }
    // 北侧：三道低矮长山脊（东西向），整体后退到雾里，只留一层剪影。
    // 中心线整体东移，避开西侧河道。
    for (let i = 0; i < 3; i++) {
        addRidge(
            8 + i * 28 + (mountainRng() - 0.5) * 8,
            -board.H / 2 - 45 - mountainRng() * 8,
            62 + mountainRng() * 14, 22,
            17 + mountainRng() * 7,
            1000 + i * 131, 'x'
        );
    }
    // 东侧：两道长山脊（南北向）
    for (let i = 0; i < 2; i++) {
        addRidge(
            board.W / 2 + 44 + mountainRng() * 8,
            (i - 0.5) * 40 + (mountainRng() - 0.5) * 8,
            22, 72 + mountainRng() * 10,
            15 + mountainRng() * 7,
            5000 + i * 149, 'z'
        );
    }
    // 远山背景带：北、东各一道超长低脊，把近处山脊连成环抱山脉，
    // 消除转角断口，同时给山脊背后补一层更淡的剪影
    addRidge(40, -board.H / 2 - 65, 150, 26, 13, 7000, 'x');
    addRidge(board.W / 2 + 65, 0, 24, 170, 11, 8000, 'z');
    group.add(mountainGroup);

    // ---- 外围小树林（南侧 + 西侧）----
    const forest = buildOutskirtsForest(1500);
    group.add(forest.group);

    return group;
}

function buildOutskirtsForest(maxInstances = 1500) {
    const group = new THREE.Group();
    const rng = mulberry32(556677);
    const dummy = new THREE.Object3D();

    const foliagePalette = ['#4e6b3a', '#557740', '#5d8045', '#6a8448'];
    const trunkCol = new THREE.Color('#6a4f2e');
    const foliageCols = foliagePalette.map(c => new THREE.Color(c));

    // 合并树模板：树干 + 3 层锥树冠
    const trunk = new THREE.CylinderGeometry(0.08, 0.12, 0.6, 6).translate(0, 0.3, 0);
    const cone1 = new THREE.ConeGeometry(0.55, 0.9, 8).translate(0, 0.95, 0);
    const cone2 = new THREE.ConeGeometry(0.45, 0.75, 8).translate(0, 1.4, 0);
    const cone3 = new THREE.ConeGeometry(0.3, 0.5, 8).translate(0, 1.75, 0);
    const treeGeo = mergeGeometries([trunk, cone1, cone2, cone3]);
    trunk.dispose(); cone1.dispose(); cone2.dispose(); cone3.dispose();

    // 顶点色（树干棕 / 树冠 4 种绿色）
    const pos = treeGeo.attributes.position;
    const colorsAttr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const c = y < 0.55 ? trunkCol : foliageCols[Math.floor(rng() * foliageCols.length)];
        colorsAttr[i * 3] = c.r; colorsAttr[i * 3 + 1] = c.g; colorsAttr[i * 3 + 2] = c.b;
    }
    treeGeo.setAttribute('color', new THREE.BufferAttribute(colorsAttr, 3));
    treeGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const mesh = new THREE.InstancedMesh(treeGeo, mat, maxInstances);
    mesh.name = 'outskirts-trees';
    mesh.castShadow = true; mesh.frustumCulled = true;
    group.add(mesh);

    // 只在实际战场之外的外围带取点：距战场边 2~60，以南侧 + 西侧为主。
    // 旧版在 gx/gy ∈ [0,70] 的战场坐标里撒点，等于把 1500 棵树全种进了战场——本函数已彻底改为外圈采样。
    const HX = board.W / 2, HZ = board.H / 2;
    const NEAR = 2, FAR = 60;
    const SOUTH_TREES = 900, WEST_TREES = maxInstances - 900;

    const place = (x, z) => {
        const scaleY = (1.8 + rng() * 1.4) / 2.2;
        dummy.position.set(x, 0, z);
        dummy.rotation.set((rng() - 0.5) * 0.06, rng() * Math.PI * 2, (rng() - 0.5) * 0.06);
        dummy.scale.setScalar(0.85 + rng() * 0.55);
        dummy.scale.y *= scaleY;
        dummy.updateMatrix();
        mesh.setMatrixAt(slot++, dummy.matrix);
    };

    let slot = 0;
    // 南侧带：z ∈ [HZ+2, HZ+60]，x 覆盖整个外围宽度（河流穿过的位置留空）
    for (let i = 0; i < SOUTH_TREES * 12 && slot < SOUTH_TREES; i++) {
        const x = -HX - FAR + rng() * (board.W + FAR * 2);
        const z = HZ + NEAR + rng() * (FAR - NEAR);
        if (inRiver(x, z)) continue;
        place(x, z);
    }
    // 西侧带：x ∈ [-(HX+60), -(HX+2)]，z ∈ [-HZ-10, HZ+60]（避开北侧山体与河道）
    const westEnd = SOUTH_TREES;
    for (let i = 0; i < WEST_TREES * 12 && slot < westEnd + WEST_TREES; i++) {
        const x = -(HX + NEAR) - rng() * (FAR - NEAR);
        const z = -HZ - 10 + rng() * (2 * HZ + FAR + 10);
        if (inRiver(x, z)) continue;
        place(x, z);
    }
    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    return { group };
}
