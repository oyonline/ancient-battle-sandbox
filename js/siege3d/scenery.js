// ==================== siege3d 美术层（第一轮）====================
// 纯视觉：草地质感 CanvasTexture、草丛 InstancedMesh、营寨帐篷与飘旗、
// 外围山川河流树林。不读/写任何 battle/ 模拟状态，不 import 逻辑文件。
// 所有随机用固定种子，确定性可复现。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { board } from '../board.js';
import { CAMP_LAYOUT as L } from './layout.js';

const WORLD = { W: board.W, H: board.H };
const CAMP = { cx: WORLD.W / 2, cy: WORLD.H / 2 };

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
        const gx = rng() * WORLD.W;
        const gy = rng() * WORLD.H;
        // 避让营寨内
        if (gx > CAMP.cx - half && gx < CAMP.cx + half && gy > CAMP.cy - half && gy < CAMP.cy + half) continue;
        // 避让寨门前区域（门前 3 格）
        if (gx > gateCx - 3 && gx < gateCx + 3 && gy > CAMP.cy + half - 1 && gy < gateClearY) continue;

        const h = 0.18 + rng() * 0.14;
        const rollY = rng() * Math.PI * 2;
        const leanX = (rng() - 0.5) * 0.1;
        const leanZ = (rng() - 0.5) * 0.1;
        dummy.position.set(gx - WORLD.W / 2, 0, gy - WORLD.H / 2);
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
    const tentRows = [29.2, 32.6];
    const westCols = [29.6, 31.7];
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
        tent.position.set(gx - WORLD.W / 2, 0, gy - WORLD.H / 2);
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
        tent.position.set(gx - WORLD.W / 2, 0, gy - WORLD.H / 2);
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
    const geo = new THREE.PlaneGeometry(1.0, 0.7, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x387bdd, roughness: 0.8, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    // 旗面沿 +Z 展开（默认相机在 +Z 侧，正对旗面），左缘贴旗杆；
    // 再向 +Z 让 0.03，遮住 walls.js 里旧的那块静态旗板（本期不允许改 walls.js）。
    const worldX = CAMP.cx - WORLD.W / 2 + 0.5;
    const worldZ = CAMP.cy - WORLD.H / 2 + 0.03;
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
    const SIDE = 80;              // 外围带宽（世界单位）
    const HX = WORLD.W / 2;       // 战场半宽 = 35
    const HZ = WORLD.H / 2;       // 战场半高 = 35
    const TILE = WORLD.W / 8;     // 与战场地面 8×8 平铺同尺度：8.75 单位/瓦片

    // 外围地面：四块与战场边界严丝合缝的边框，不与战场地面重叠。
    // 旧版是一块 230×230 的大平面压在战场平面上（同为 y=0）——深度冲突正是横向浅色条带的来源。
    const outerTex = grassTexture.clone();
    outerTex.repeat.set(1, 1);
    outerTex.needsUpdate = true;
    const extMat = new THREE.MeshStandardMaterial({
        map: outerTex, roughness: 1, color: 0xe6e6e6   // 比战场暗约 10%
    });
    function strip(x1, x2, z1, z2) {
        const geo = new THREE.PlaneGeometry(x2 - x1, z2 - z1, 1, 1);
        geo.rotateX(-Math.PI / 2);
        geo.translate((x1 + x2) / 2, 0, (z1 + z2) / 2);
        // 世界尺度 UV：与战场地面同为 8.75 单位/瓦片，接缝处纹理连续
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

    // ---- 河流（西侧外围，弯曲）----
    const riverRng = mulberry32(998877);
    const riverMat = new THREE.MeshStandardMaterial({
        color: 0x4f7f8a, transparent: true, opacity: 0.85, roughness: 0.4, metalness: 0.1
    });
    const bankMat = new THREE.MeshStandardMaterial({ color: 0x8a8370, roughness: 1 });
    const riverGroup = new THREE.Group();
    const riverSegments = 50;
    const segLen = (WORLD.H + SIDE * 2) / riverSegments;
    const riverCenterX = -WORLD.W / 2 - 16;
    for (let i = 0; i < riverSegments; i++) {
        const t = i / riverSegments;
        const zCenter = -WORLD.H / 2 - SIDE + segLen * (i + 0.5);
        const curve = Math.sin(t * Math.PI * 3) * 3;
        const width = 4 + Math.sin(t * Math.PI * 2.5) * 2;
        const waterSeg = new THREE.Mesh(
            new THREE.BoxGeometry(width, 0.02, segLen * 1.1), riverMat);
        waterSeg.position.set(riverCenterX + curve, 0.01, zCenter);
        waterSeg.receiveShadow = true;
        riverGroup.add(waterSeg);
        // 碎石岸
        const bank = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.025, segLen * 1.1), bankMat);
        bank.position.set(riverCenterX + curve + width / 2 + 0.35, 0.015, zCenter);
        bank.receiveShadow = true;
        riverGroup.add(bank);
        const bank2 = bank.clone();
        bank2.position.x = riverCenterX + curve - width / 2 - 0.35;
        riverGroup.add(bank2);
    }
    group.add(riverGroup);

    // ---- 远山（北侧 + 东侧）----
    const mountainRng = mulberry32(33333);
    const mountainMatBody = new THREE.MeshStandardMaterial({ color: 0x7a7f6a, flatShading: true, roughness: 1 });

    const mountainGroup = new THREE.Group();
    // 北侧
    for (let i = 0; i < 8; i++) {
        const gx = (i / 7 - 0.5) * WORLD.W + (mountainRng() - 0.5) * 4;
        const gz = -WORLD.H / 2 - 15 - mountainRng() * 20;
        const h = 8 + mountainRng() * 14;
        const r = 4 + mountainRng() * 3;
        const cones = [
            new THREE.ConeGeometry(r * 1.1, h * 0.6, 5).translate(0, h * 0.3, 0),
            new THREE.ConeGeometry(r * 0.7, h * 0.5, 6).translate(0, h * 0.6, 0),
            new THREE.ConeGeometry(r * 0.35, h * 0.35, 4).translate(0, h * 0.82, 0),
        ];
        const merged = mergeGeometries(cones);
        cones.forEach(c => c.dispose());
        merged.translate(gx, 0, gz);
        merged.rotateY(mountainRng() * Math.PI * 2);
        const m = new THREE.Mesh(merged, mountainMatBody);
        m.castShadow = true; m.receiveShadow = true;
        mountainGroup.add(m);
    }
    // 东侧
    for (let i = 0; i < 6; i++) {
        const gx = WORLD.W / 2 + 15 + mountainRng() * 20;
        const gz = (i / 5 - 0.5) * WORLD.H + (mountainRng() - 0.5) * 4;
        const h = 8 + mountainRng() * 10;
        const r = 3.5 + mountainRng() * 2.5;
        const cones = [
            new THREE.ConeGeometry(r * 1.1, h * 0.6, 5).translate(0, h * 0.3, 0),
            new THREE.ConeGeometry(r * 0.7, h * 0.5, 6).translate(0, h * 0.6, 0),
            new THREE.ConeGeometry(r * 0.35, h * 0.35, 4).translate(0, h * 0.82, 0),
        ];
        const merged = mergeGeometries(cones);
        cones.forEach(c => c.dispose());
        merged.translate(gx, 0, gz);
        merged.rotateY(mountainRng() * Math.PI * 2);
        const m = new THREE.Mesh(merged, mountainMatBody);
        m.castShadow = true; m.receiveShadow = true;
        mountainGroup.add(m);
    }
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

    // 只在战场 70×70 之外的外围带取点：距战场边 2~60，以南侧 + 西侧为主。
    // 旧版在 gx/gy ∈ [0,70] 的战场坐标里撒点，等于把 1500 棵树全种进了战场——本函数已彻底改为外圈采样。
    const HX = WORLD.W / 2, HZ = WORLD.H / 2;
    const NEAR = 2, FAR = 60;
    const RIVER_X1 = -60, RIVER_X2 = -42;   // 西侧河道 + 两岸（世界坐标），树林不得覆盖
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
    // 南侧带：z ∈ [HZ+2, HZ+60]，x 覆盖整个外围宽度
    for (let i = 0; i < SOUTH_TREES * 12 && slot < SOUTH_TREES; i++) {
        const x = -HX - FAR + rng() * (WORLD.W + FAR * 2);
        const z = HZ + NEAR + rng() * (FAR - NEAR);
        place(x, z);
    }
    // 西侧带：x ∈ [-(HX+60), -(HX+2)]，z ∈ [-45, HZ+60]（避开北侧山体），避开河道
    const westEnd = SOUTH_TREES;
    for (let i = 0; i < WEST_TREES * 12 && slot < westEnd + WEST_TREES; i++) {
        const x = -(HX + NEAR) - rng() * (FAR - NEAR);
        const z = -45 + rng() * (HZ + FAR + 45);
        if (x > RIVER_X1 && x < RIVER_X2) continue;
        place(x, z);
    }
    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    return { group };
}
