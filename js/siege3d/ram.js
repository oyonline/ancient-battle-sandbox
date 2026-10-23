import * as THREE from 'three';
import { board } from '../board.js';

// Local front is -Z, facing the south gate; simulation positions remain grid coordinates.
export function buildRamVisual() {
    const group = new THREE.Group();
    group.name = 'siege-ram';
    const timber = new THREE.MeshStandardMaterial({ color: '#785535', roughness: 1 });
    const iron = new THREE.MeshStandardMaterial({ color: '#5a5448', roughness: .7 });
    const wheel = new THREE.MeshStandardMaterial({ color: '#5a4128', roughness: 1 });
    const roof = new THREE.MeshStandardMaterial({ color: '#8a6b42', roughness: 1 });
    const add = (parent, geometry, material, x, y, z) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true;
        parent.add(mesh); return mesh;
    };
    const box = (w, h, d, x, y, z) => add(group, new THREE.BoxGeometry(w, h, d), timber, x, y, z);
    const log = new THREE.Group(); log.name = 'ram-log'; group.add(log);
    add(log, new THREE.CylinderGeometry(.16, .16, 2.6, 12).rotateX(Math.PI / 2), timber, 0, .85, 0);
    add(log, new THREE.CylinderGeometry(.2, .2, .3, 12).rotateX(Math.PI / 2), iron, 0, .85, -1.3);
    for (const side of [-1, 1]) {
        box(.12, .14, 2.3, side * .46, .6, 0);
        for (const end of [-1, 1]) {
            box(.1, 1.35, .1, side * .46, 1.05, end * .95);
            add(group, new THREE.CylinderGeometry(.3, .3, .12, 12).rotateZ(Math.PI / 2),
                wheel, side * .56, .3, end * .95);
        }
        // Two sloped panels: total horizontal footprint 1.4 × 2.8.
        const panel = add(group, new THREE.BoxGeometry(Math.hypot(.7, .3), .08, 2.8), roof,
            side * .35, 1.85, 0);
        panel.rotation.z = -side * Math.atan2(.3, .7);
    }
    for (const end of [-1, 1]) box(1.06, .14, .14, 0, .6, end);
    group.userData.log = log;
    return group;
}

export function updateRamVisual(group, ram, now, groundHeight = 0) {
    group.position.set(ram.gx - board.W / 2, groundHeight, ram.gy - board.H / 2);
    const elapsed = ram.lastHitAt === null ? Infinity : now - ram.lastHitAt;
    // 300 ms: draw back .4, thrust forward, settle. Pausing freezes the simulation clock.
    const t = Math.max(0, elapsed) / 300;
    group.userData.log.position.z = t >= 1 ? 0 : t < .5 ? .4 * t * 2 : .4 * (2 - t * 2);
}
