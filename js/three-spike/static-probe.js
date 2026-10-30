// G0: bind-pose geometry only. No skeletons, mixers, or simulation state ownership.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { mergePrimitives, splitRider } from './model-skin.js';

const BASE = '/prototypes/model-gallery/assets/';
const PATHS = {
    infantry: 'october/sword-standard/infantry-rigged.glb',
    pikeman: 'october/pike-standard/spear-rigged.glb',
    archer: 'october/archer-standard/archer-rigged.glb',
    rider: 'october/cavalry-standard/cavalry-rigged.glb',
    horse: 'horse/Horse.gltf', white: 'horse/Horse_White.gltf'
};

function bindGeometry(root, teamColor) {
    mergePrimitives(root, teamColor);
    let mesh;
    root.traverse(o => { if (o.isSkinnedMesh) mesh = o; });
    // Raw positions are the bind pose; bake mesh-space ancestors, never evaluate skinning.
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometry.deleteAttribute('skinIndex'); geometry.deleteAttribute('skinWeight');
    geometry.computeBoundingBox();
    const hips = root.getObjectByName('Hips')?.getWorldPosition(new THREE.Vector3());
    const box = geometry.boundingBox;
    geometry.userData.hipHeight = hips ? hips.y - box.min.y : 0;
    const shoulder = root.getObjectByName('Torso3');
    geometry.userData.shoulderHeight = shoulder ? shoulder.getWorldPosition(new THREE.Vector3()).y - box.min.y : 0;
    geometry.translate(-(hips?.x ?? (box.min.x + box.max.x) / 2), -box.min.y, -(hips?.z ?? (box.min.z + box.max.z) / 2));
    geometry.computeBoundingBox();
    return geometry;
}
function height(geometry) {
    geometry.computeBoundingBox();
    return geometry.boundingBox.max.y - geometry.boundingBox.min.y;
}

export async function createStaticProbe({ scene, units, teamColors, groundH, shadowsEnabled, box = false, soldierGeo }) {
    const loader = new GLTFLoader();
    const assets = box ? null : Object.fromEntries(await Promise.all(Object.entries(PATHS).map(async ([key, path]) =>
        [key, (await loader.loadAsync(BASE + path)).scene])));
    if (assets) splitRider(assets.rider);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const group = new THREE.Group(); group.name = 'SpikeStaticProbe';
    const batches = new Map(), diagnostics = [];
    function add(team, kind, piece, geometry) {
        const capacity = units.filter(u => u.team === team && u.type === kind && !u.dead && u.hp > 0).length;
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.name = `${team}-${piece}`; mesh.count = 0; mesh.frustumCulled = false;
        mesh.castShadow = !!shadowsEnabled;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (box) { const color = new THREE.Color(teamColors[team]); for (let i = 0; i < capacity; i++) mesh.setColorAt(i, color); }
        group.add(mesh);
        const row = { team, kind, piece, vertices: geometry.attributes.position.count, instances: capacity,
            estimatedVertices: geometry.attributes.position.count * capacity };
        diagnostics.push(row);
        const key = `${team}-${kind}`;
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push({ mesh, row, cursor: 0 });
    }
    const humanHeight = assets ? height(bindGeometry(clone(assets.infantry))) : 0;
    for (const team of ['red', 'blue']) for (const kind of ['infantry', 'pikeman', 'archer', 'cavalry']) {
        if (box) { add(team, kind, kind, soldierGeo(kind)); continue; }
        if (kind !== 'cavalry') {
            const geometry = bindGeometry(clone(assets[kind]), teamColors[team]);
            const scale = 1.15 / height(geometry);
            geometry.scale(scale, scale, scale);
            add(team, kind, kind, geometry);
        } else {
            const horseRoot = clone(assets[team === 'red' ? 'horse' : 'white']);
            const horse = bindGeometry(horseRoot), riderRoot = clone(assets.rider);
            const rider = bindGeometry(riderRoot, teamColors[team]);
            const horseScale = 1.45 / (horse.userData.shoulderHeight || height(horse));
            if (!(horseScale > 0 && Number.isFinite(horseScale))) throw new Error('静态马肩高无效');
            horse.scale(horseScale, horseScale, horseScale);
            const riderScale = 1.595 / humanHeight;
            // Approximate seated hip placement, keeping every vertex in its bind pose.
            rider.scale(riderScale, riderScale, riderScale);
            rider.translate(0, height(horse) * .72 + .12 * riderScale - rider.userData.hipHeight * riderScale, -.12);
            horse.computeBoundingBox(); rider.computeBoundingBox();
            const box = horse.boundingBox.clone().union(rider.boundingBox), scale = 1.85 / (box.max.y - box.min.y);
            for (const geometry of [horse, rider]) { geometry.translate(0, -box.min.y, 0); geometry.scale(scale, scale, scale); }
            add(team, kind, 'horse', horse); add(team, kind, 'rider', rider);
        }
    }
    scene.add(group);
    const transform = new THREE.Object3D();
    console.table(diagnostics);
    return {
        group, diagnostics,
        begin() { for (const parts of batches.values()) for (const batch of parts) batch.cursor = 0; },
        sync(u, heading) {
            if (u.dead || u.hp <= 0) return;
            transform.position.set(u.gx - 35, groundH(u.gx, u.gy), u.gy - 35);
            transform.rotation.set(0, heading, 0); transform.updateMatrix();
            for (const batch of batches.get(`${u.team}-${u.type}`) || []) {
                if (batch.cursor >= batch.mesh.instanceMatrix.count) throw new Error('静态实例容量不足');
                batch.mesh.setMatrixAt(batch.cursor++, transform.matrix);
            }
        },
        end() {
            for (const parts of batches.values()) for (const batch of parts) {
                batch.mesh.count = batch.cursor; batch.mesh.instanceMatrix.needsUpdate = true;
            }
        },
        get estimatedVertices() {
            let total = 0;
            for (const parts of batches.values()) for (const { mesh, row } of parts) total += mesh.count * row.vertices;
            return total;
        }
    };
}

// Five seconds of completed frames; timestamps prune idle gaps even between frames.
export function createProbeStats() {
    const frames = [];
    function recent(now) { while (frames.length && frames[0].now <= now - 5000) frames.shift(); return frames; }
    return {
        record(now, frameMs, perf) { frames.push({ now, frameMs, ...perf }); recent(now); },
        read(scene, renderer) {
            const samples = recent(performance.now()), sorted = samples.map(f => f.frameMs).sort((a, b) => a - b);
            const average = key => samples.length ? samples.reduce((sum, f) => sum + f[key], 0) / samples.length : 0;
            return { fps: average('frameMs') > 0 ? 1000 / average('frameMs') : 0,
                p95FrameMs: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] || 0,
                simMs: average('simMs'), syncMs: average('syncMs'), drawMs: average('renderMs'),
                alive: { red: scene?.redAlive || 0, blue: scene?.blueAlive || 0 }, simTime: scene?.simulationTime || 0,
                triangles: renderer.info.render.triangles, calls: renderer.info.render.calls };
        }
    };
}
