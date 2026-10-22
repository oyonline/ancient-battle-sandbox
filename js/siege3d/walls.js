import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DynamicBlockers } from '../terrain.js';
import { board } from '../board.js';

export function campBounds() {
    const cx = board.W / 2, cy = board.H / 2;
    return { cx, cy, x1: cx - 7, y1: cy - 7, x2: cx + 7, y2: cy + 7 };
}

export function queueCampWalls(scene) {
    const { cx, cy, x1, y1, x2, y2 } = campBounds(), t = .3;
    scene.dynamicBlockers = new DynamicBlockers();
    const add = (id, ax, ay, bx, by, kind = 'wall') =>
        scene.dynamicBlockers.requestAdd(id, { x1: ax, y1: ay, x2: bx, y2: by, kind });
    // 内边长 14，墙向外延展；横墙覆盖竖墙端点，四角闭合。
    add('north-west', x1 - t, y1 - t, cx, y1);
    add('north-east', cx, y1 - t, x2 + t, y1);
    add('west-north', x1 - t, y1, x1, cy);
    add('west-south', x1 - t, cy, x1, y2);
    add('east-north', x2, y1, x2 + t, cy);
    add('east-south', x2, cy, x2 + t, y2);
    add('south-west', x1 - t, y2, cx - 1.2, y2 + t);
    add('south-east', cx + 1.2, y2, x2 + t, y2 + t);
    add('south-gate', cx - 1.2, y2, cx + 1.2, y2 + t, 'gate');
}

// 所有视觉几何均消费动态层矩形；坐标换算与千人对冲页一致：棋盘中心 → 世界原点。
export function buildCampVisuals(rects) {
    const group = new THREE.Group();
    group.name = 'siege-camp';
    const walls = rects.filter(r => r.kind === 'wall');
    if (!walls.length) return group;
    const west = Math.min(...rects.map(r => r.x1)), east = Math.max(...rects.map(r => r.x2));
    const north = Math.min(...rects.map(r => r.y1)), south = Math.max(...rects.map(r => r.y2));
    const cx = (west + east) / 2, cy = (north + south) / 2;
    const wood = new THREE.MeshStandardMaterial({ color: '#8a6b42', roughness: 1 });
    const brace = new THREE.MeshStandardMaterial({ color: '#785535', roughness: 1 });
    const post = new THREE.MeshStandardMaterial({ color: '#5a4128', roughness: 1 });
    const at = (object, gx, y, gy) => object.position.set(gx - board.W / 2, y, gy - board.H / 2);
    const box = (w, h, d, gx, y, gy, material) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
        at(mesh, gx, y, gy); mesh.castShadow = mesh.receiveShadow = true;
        group.add(mesh); return mesh;
    };
    const shaft = new THREE.BoxGeometry(.16, 1.63, .16).translate(0, 1.63 / 2, 0);
    const tip = new THREE.ConeGeometry(.16 / Math.sqrt(2), .12, 4)
        .rotateY(Math.PI / 4).translate(0, 1.69, 0);
    const stakeGeometry = mergeGeometries([shaft, tip]);
    shaft.dispose(); tip.dispose();
    const stakes = [];
    for (const r of walls) {
        const horizontal = r.x2 - r.x1 > r.y2 - r.y1;
        const length = horizontal ? r.x2 - r.x1 : r.y2 - r.y1;
        const mx = (r.x1 + r.x2) / 2, my = (r.y1 + r.y2) / 2;
        const count = Math.floor(length / .25) + 1;
        // 居中排桩，中心间隔严格为 .25；段端余量小于半个间距。
        for (let i = 0; i < count; i++) {
            const along = (i - (count - 1) / 2) * .25;
            stakes.push([mx + (horizontal ? along : 0), my + (horizontal ? 0 : along)]);
        }
        const thickness = horizontal ? r.y2 - r.y1 : r.x2 - r.x1;
        for (const height of [.55, 1.35]) {
            if (horizontal) box(length, .12, .08, mx, height, my + Math.sign(cy - my) * (thickness / 2 + .04), brace);
            else box(.08, .12, length, mx + Math.sign(cx - mx) * (thickness / 2 + .04), height, my, brace);
        }
    }
    const mesh = new THREE.InstancedMesh(stakeGeometry, wood, stakes.length);
    mesh.name = 'palisade-stakes'; mesh.castShadow = mesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    stakes.forEach(([gx, gy], i) => { at(dummy, gx, 0, gy); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); });
    mesh.instanceMatrix.needsUpdate = true; group.add(mesh);
    for (const r of rects.filter(r => r.kind === 'gate')) {
        const width = r.x2 - r.x1, my = (r.y1 + r.y2) / 2;
        for (const fraction of [.25, .75]) box(width / 2, 2, .12, r.x1 + width * fraction, 1, my, brace);
        for (const x of [r.x1 - .13, r.x2 + .13]) box(.26, 2.4, .26, x, 1.2, my, post);
    }
    // 内缘也由矩形反推，避免地面与碰撞墙出现两份布局。
    const vertical = walls.filter(r => r.x2 - r.x1 < r.y2 - r.y1);
    const horizontal = walls.filter(r => r.x2 - r.x1 > r.y2 - r.y1);
    const innerWest = Math.max(...vertical.filter(r => r.x1 < cx).map(r => r.x2));
    const innerEast = Math.min(...vertical.filter(r => r.x1 > cx).map(r => r.x1));
    const innerNorth = Math.max(...horizontal.filter(r => r.y1 < cy).map(r => r.y2));
    const innerSouth = Math.min(...horizontal.filter(r => r.y1 > cy).map(r => r.y1));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(innerEast - innerWest, innerSouth - innerNorth).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: '#6a7448', roughness: 1 }));
    at(floor, cx, .015, cy); floor.receiveShadow = true; group.add(floor);
    return group;
}

export function disposeCampVisuals(group) {
    if (!group) return;
    group.removeFromParent();
    const materials = new Set();
    group.traverse(object => {
        object.geometry?.dispose();
        if (object.material) materials.add(object.material);
        if (object.isInstancedMesh) object.dispose();
    });
    materials.forEach(material => material.dispose());
}
