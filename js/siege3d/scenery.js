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

    const BASE = [0x6f, 0x7d, 0x4c];
    const DARK = [0x5d, 0x6b, 0x3e];
    const LIGHT = [0x83, 0x90, 0x5a];
    const DIRT = [0x8a, 0x7d, 0x55];

    const hash = (x, y, s = 0) => {
        let h = (Math.imul(x + s, 374761393) + Math.imul(y + s, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const vnoise = (x, y, s = 0) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        const fx = x - xi, fy = y - yi;
        const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
        const a = hash(xi, yi, s), b = hash(xi + 1, yi, s);
        const c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
        return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n1 = vnoise(x * 0.02, y * 0.02, 0);
            const n2 = vnoise(x * 0.06, y * 0.06, 7) * 0.6;
            const n3 = vnoise(x * 0.15, y * 0.15, 13) * 0.3;
            const n = n1 + n2 + n3;
            const dirtMask = vnoise(x * 0.04 + 50, y * 0.04 + 30, 99);

            let r = BASE[0], g = BASE[1], b = BASE[2];
            if (dirtMask > 0.82) {
                r = DIRT[0]; g = DIRT[1]; b = DIRT[2];
            } else {
                const t = (n - 0.6) * 3;
                if (t > 0) {
                    r += (LIGHT[0] - BASE[0]) * t;
                    g += (LIGHT[1] - BASE[1]) * t;
                    b += (LIGHT[2] - BASE[2]) * t;
                } else {
                    const s = Math.max(0, -t);
                    r += (DARK[0] - BASE[0]) * s;
                    g += (DARK[1] - BASE[1]) * s;
                    b += (DARK[2] - BASE[2]) * s;
                }
            }
            const detail = hash(x, y, 12345);
            const d = (detail - 0.5) * 14;
            r = Math.max(0, Math.min(255, r + d));
            g = Math.max(0, Math.min(255, g + d));
            b = Math.max(0, Math.min(255, b + d));

            const i = (y * size + x) * 4;
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
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
    const tentMatBig = new THREE.MeshStandardMaterial({ color: '#e8e2cf', roughness: 1 });
    const tentMatSmall = new THREE.MeshStandardMaterial({ color: '#cfc8b2', roughness: 1 });
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

    const interior = half - 1.0;
    const tentLocs = [];
    for (let i = 0; i < 200 && tentLocs.length < 7; i++) {
        const gx = CAMP.cx + (rng() - 0.5) * interior * 1.8;
        const gy = CAMP.cy + (rng() - 0.5) * interior * 1.8;
        if (avoid(gx, gy, 1.2)) continue;
        if (tentLocs.some(t => Math.hypot(t.gx - gx, t.gy - gy) < 1.8)) continue;
        tentLocs.push({ gx, gy });
    }

    // 把中央也加进去（大帐，覆盖夺旗圈）
    tentLocs.push({ gx: CAMP.cx, gy: CAMP.cy, big: true });

    for (const t of tentLocs) {
        const isBig = !!t.big;
        const sx = isBig ? 1.5 : 1;
        const sz = isBig ? 1.5 : 1;
        const h = isBig ? 2.2 : 1.5;

        const shape = new THREE.Shape();
        shape.moveTo(-sx, 0); shape.lineTo(0, h * 0.6); shape.lineTo(sx, 0);
        const extrude = new THREE.ExtrudeGeometry(shape, { depth: sz * 2, bevelEnabled: false });
        extrude.rotateX(-Math.PI / 2);
        extrude.translate(0, 0, -sz);

        const tent = new THREE.Mesh(extrude, isBig ? tentMatBig : tentMatSmall);
        tent.position.set(t.gx - WORLD.W / 2, 0, t.gy - WORLD.H / 2);
        tent.rotation.y = rng() * Math.PI * 2;
        tent.castShadow = true; tent.receiveShadow = true;
        group.add(tent);

        const pole = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), poleMat);
        pole.position.set(t.gx - WORLD.W / 2, h / 2, t.gy - WORLD.H / 2);
        pole.castShadow = true;
        group.add(pole);
    }

    return group;
}

// 大帐飘旗（顶点正弦平移）——返回 { mesh, update } 对象
export function createTentFlag() {
    const geo = new THREE.PlaneGeometry(1.2, 0.7, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x387bdd, roughness: 0.8, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    // 放在营寨中心、旗杆顶端（world 坐标 ≈ board.W/2, 2.2, board.H/2）
    const worldX = CAMP.cx - WORLD.W / 2 + 0.25;
    const worldZ = CAMP.cy - WORLD.H / 2;
    mesh.position.set(worldX, 2.2, worldZ);
    mesh.rotation.y = Math.PI / 2;

    // 缓存原始顶点
    const pos = geo.attributes.position;
    const origZ = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) origZ[i] = pos.getZ(i);

    function update(t) {
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            const sway = Math.sin(t * 2.0 + y * 3.0) * 0.04 * (0.5 + Math.abs(x) * 0.6);
            const flutter = Math.cos(t * 3.5 + y * 5.0) * 0.02;
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
    const SIDE = 80;

    // 外围地面（略暗一点的同材质）
    const extGeo = new THREE.PlaneGeometry(WORLD.W + SIDE * 2, WORLD.H + SIDE * 2, 1, 1);
    extGeo.rotateX(-Math.PI / 2);
    const extMat = new THREE.MeshStandardMaterial({
        map: grassTexture, roughness: 1, color: 0xb0b09e
    });
    const extGround = new THREE.Mesh(extGeo, extMat);
    extGround.receiveShadow = true;
    group.add(extGround);

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
    mesh.castShadow = true; mesh.frustumCulled = true;
    group.add(mesh);

    // 分布：南侧 (gy > 50) + 西侧 (gx < 20)，避开河道 (gx 27-43, gy 12-58)
    let slot = 0;
    for (let i = 0; i < maxInstances * 20 && slot < maxInstances; i++) {
        const gx = rng() * WORLD.W;
        const gy = rng() * WORLD.H;
        // 主战场 + 营寨禁区
        if (Math.hypot(gx - CAMP.cx, gy - CAMP.cy) < 18) continue;
        // 河道禁区
        if (gx > 27 && gx < 43 && gy > 12 && gy < 58) continue;
        // 南侧或西侧
        if (gy <= 50 && gx >= 20) continue;

        const scaleY = (1.8 + rng() * 1.4) / 2.2;
        dummy.position.set(gx - WORLD.W / 2, 0, gy - WORLD.H / 2);
        dummy.rotation.set((rng() - 0.5) * 0.06, rng() * Math.PI * 2, (rng() - 0.5) * 0.06);
        dummy.scale.setScalar(0.8 + rng() * 0.5);
        dummy.scale.y *= scaleY;
        dummy.updateMatrix();
        mesh.setMatrixAt(slot++, dummy.matrix);
    }
    mesh.count = slot;
    mesh.instanceMatrix.needsUpdate = true;
    return { group };
}
