import * as THREE from 'three';
import { board } from '../board.js';
import { H_WORLD } from './deployment.js';

const LADDER_TOP_WORLD = 1.75 + .15;
export const climberWorldHeight = climb => climb.progress * LADDER_TOP_WORLD;

export function buildSiegeVisuals(siege) {
    const group = new THREE.Group();
    group.name = 'siege-platforms';
    const plank = new THREE.MeshStandardMaterial({ color: '#8a6b42', roughness: 1 });
    const brace = new THREE.MeshStandardMaterial({ color: '#785535', roughness: 1 });
    const post = new THREE.MeshStandardMaterial({ color: '#5a4128', roughness: 1 });
    const box = (w, h, d, x, y, z, material) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
        mesh.position.set(x - board.W / 2, y, z - board.H / 2);
        mesh.castShadow = mesh.receiveShadow = true;
        group.add(mesh);
    };
    for (const p of siege.platforms) {
        const x = (p.x1 + p.x2) / 2, z = (p.y1 + p.y2) / 2, h = p.height * H_WORLD;
        const w = p.x2 - p.x1, d = p.y2 - p.y1;
        if (p.kind === 'walkway') {
            const horizontal = w > d, length = horizontal ? w : d;
            const count = Math.ceil(length / .25), step = length / count;
            for (let i = 0; i < count; i++) {
                const along = -length / 2 + (i + .5) * step;
                box(horizontal ? step - .008 : w, .08, horizontal ? d : step - .008,
                    x + (horizontal ? along : 0), h - .04, z + (horizontal ? 0 : along), plank);
            }
            for (let along = -length / 2 + .5; along <= length / 2; along += 1) {
                box(.12, h - .08, .12, x + (horizontal ? along : 0), (h - .08) / 2,
                    z + (horizontal ? 0 : along), brace);
            }
        } else {
            box(w, .12, d, x, h - .06, z, brace);
            for (const dx of [-w / 2 + .11, w / 2 - .11]) for (const dz of [-d / 2 + .11, d / 2 - .11]) {
                box(.22, h, .22, x + dx, h / 2, z + dz, post);
                box(.06, .6, .06, x + dx, h + .3, z + dz, plank);
            }
            for (const dy of [.3, .57]) {
                for (const dz of [-d / 2 + .03, d / 2 - .03]) box(w, .06, .06, x, h + dy, z + dz, plank);
                for (const dx of [-w / 2 + .03, w / 2 - .03]) box(.06, .06, d, x + dx, h + dy, z, plank);
            }
            // Decorative vertical ladder on the inward/east side.
            for (const dz of [-.22, .22]) box(.06, h + .15, .06, p.x2 + .1, (h + .15) / 2, z + dz, plank);
            for (let y = .2; y < h; y += .3) box(.06, .06, .5, p.x2 + .1, y, z, brace);
        }
    }
    for (const ladder of siege.ladders ?? []) {
        const foot = new THREE.Vector3(ladder.foot.gx - board.W / 2, 0, ladder.foot.gy - board.H / 2);
        const top = new THREE.Vector3(ladder.top.gx - board.W / 2, LADDER_TOP_WORLD, ladder.top.gy - board.H / 2);
        const along = top.clone().sub(foot), length = along.length();
        along.normalize();
        const across = new THREE.Vector3(along.z, 0, -along.x).normalize();
        const beam = (a, b, width, material) => {
            const direction = b.clone().sub(a);
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, direction.length(), width), material);
            mesh.position.copy(a).add(b).multiplyScalar(.5);
            mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.name = `${ladder.id}-${width === .08 ? 'rail' : 'rung'}`;
            group.add(mesh);
        };
        for (const side of [-.25, .25]) {
            const offset = across.clone().multiplyScalar(side);
            beam(foot.clone().add(offset), top.clone().add(offset), .08, brace);
        }
        for (let distance = .3; distance < length; distance += .3) {
            const center = foot.clone().addScaledVector(along, distance);
            beam(center.clone().addScaledVector(across, -.25), center.clone().addScaledVector(across, .25), .05, plank);
        }
    }
    return group;
}
