// Optional presentation layer. Owns no simulation state or simulation random numbers.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BASE = (import.meta.env?.BASE_URL ?? '/') + 'assets/units/real/';
const PATHS = {
    infantry: 'october/sword-standard/infantry-rigged.glb',
    pikeman: 'october/pike-standard/spear-rigged.glb',
    archer: 'october/archer-standard/archer-rigged.glb',
    rider: 'october/cavalry-standard/cavalry-rigged.glb',
    horse: 'horse/Horse.gltf', white: 'horse/Horse_White.gltf'
};
const FADE = .15;
const GPU_KINDS = ['infantry', 'pikeman', 'archer', 'cavalry'];
// GLTFLoader sanitizes e.g. UpperArm.L to UpperArmL before binding tracks.
const isRiderBone = name => /^(Hips|Spine|Chest|Neck|Head|(?:UpperArm|Forearm|Hand|Thigh|Shin|Foot)[._]?[LR])$/.test(name);
const trackBone = track => THREE.PropertyBinding.parseTrackName(track.name).nodeName;
const bounds = root => { root.updateMatrixWorld(true); return new THREE.Box3().setFromObject(root, true); };

// These untextured glTF primitives have the same mesh space and joint palette.
// Keep the first mesh/rig in place so animation bindings and inverse binds survive.
export function mergePrimitives(root, teamColor) {
    root.updateMatrixWorld(true);
    const meshes = [], parts = [];
    root.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
    const first = meshes[0];
    if (!first) throw new Error('合并模型缺少 SkinnedMesh');
    let before = 0;
    for (const mesh of meshes) {
        if (!mesh.matrixWorld.equals(first.matrixWorld) || !mesh.bindMatrix.equals(first.bindMatrix) ||
            mesh.skeleton.bones.length !== first.skeleton.bones.length ||
            mesh.skeleton.bones.some((bone, i) => bone !== first.skeleton.bones[i] ||
                !mesh.skeleton.boneInverses[i].equals(first.skeleton.boneInverses[i]))) {
            throw new Error('合并 primitive 的网格空间或骨架绑定不一致');
        }
        const source = mesh.geometry, materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const groups = Array.isArray(mesh.material) ? source.groups : [{ start: 0, count: source.index?.count ?? source.attributes.position.count, materialIndex: 0 }];
        for (const group of groups) {
            const material = materials[group.materialIndex];
            if (material.map) throw new Error('纯色 primitive 合并不支持贴图');
            const selected = [];
            for (let i = group.start; i < group.start + group.count; i++) selected.push(source.index ? source.index.getX(i) : i);
            const geometry = compactGeometry(source, selected);
            // glTF baseColorFactor and GLTFLoader material.color are already linear.
            // setHex converts the sRGB team swatch to linear; do not convert twice.
            const cloth = /team_cloth|ivory linen tabard/i.test(material.name);
            geometry.setAttribute('clothMask', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count).fill(cloth ? 1 : 0), 1));
            const color = teamColor !== undefined && cloth
                ? new THREE.Color(teamColor) : material.color;
            const colors = new Float32Array(geometry.attributes.position.count * 3);
            for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            // All rendering now uses vertex colors; UVs/tangents are unnecessary.
            for (const name of Object.keys(geometry.attributes)) {
                if (!['position', 'normal', 'skinIndex', 'skinWeight', 'color', 'clothMask'].includes(name)) geometry.deleteAttribute(name);
            }
            parts.push(geometry); before++;
        }
    }
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!geometry) throw new Error('primitive 几何属性不兼容');
    first.geometry = geometry;
    first.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    first.boundingBox = first.boundingSphere = null;
    for (const mesh of meshes.slice(1)) mesh.removeFromParent();
    return { before, after: 1, vertices: geometry.attributes.position.count };
}

function compactGeometry(source, selected) {
    const geometry = new THREE.BufferGeometry(), remap = new Map(), vertices = [];
    const indices = selected.map(old => {
        if (!remap.has(old)) { remap.set(old, vertices.length); vertices.push(old); }
        return remap.get(old);
    });
    for (const [name, attribute] of Object.entries(source.attributes)) {
        const array = new attribute.array.constructor(vertices.length * attribute.itemSize);
        for (let i = 0; i < vertices.length; i++) for (let j = 0; j < attribute.itemSize; j++) {
            array[i * attribute.itemSize + j] = attribute.array[vertices[i] * attribute.itemSize + j];
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized));
    }
    geometry.setIndex(indices);
    return geometry;
}

// Retain the full source rig (including static ancestors) and its inverse bind matrices.
// Only the rider triangles and rider animation tracks survive; the old horse never renders.
export function splitRider(root) {
    let total = 0, retained = 0;
    const meshes = [];
    root.traverse(mesh => { if (mesh.isSkinnedMesh) meshes.push(mesh); });
    for (const mesh of meshes) {
        const geometry = mesh.geometry, weights = geometry.attributes.skinWeight, joints = geometry.attributes.skinIndex;
        if (!weights || !joints) throw new Error('骑兵网格缺少 skinWeight/skinIndex');
        const rider = new Uint8Array(weights.count);
        for (let v = 0; v < weights.count; v++) {
            let dominant = 0;
            for (let k = 1; k < 4; k++) if (weights.getComponent(v, k) > weights.getComponent(v, dominant)) dominant = k;
            rider[v] = isRiderBone(mesh.skeleton.bones[joints.getComponent(v, dominant)]?.name || '') ? 1 : 0;
        }
        const index = geometry.index, selected = [], count = index?.count ?? weights.count;
        for (let i = 0; i < count; i += 3) {
            const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
            total++;
            if (rider[a] && rider[b] && rider[c]) { selected.push(a, b, c); retained++; }
        }
        if (selected.length) mesh.geometry = compactGeometry(geometry, selected);
        else mesh.removeFromParent();
    }
    const ratio = total ? retained / total : 0;
    if (ratio < .15 || ratio > .9) {
        const error = new Error(`骑手拆分比例异常：${retained}/${total} = ${(ratio * 100).toFixed(2)}%`);
        error.riderStats = { retained, total, ratio }; throw error;
    }
    return { retained, total, ratio };
}

function clipsFor(animations, riderOnly = false) {
    return animations.map(source => {
        const tracks = source.tracks.filter(t => !riderOnly || isRiderBone(trackBone(t))).map(t => {
            // Root motion is presentation-only: never let an asset move away from its grid position.
            if (/^root$/i.test(trackBone(t)) && /\.position$/.test(t.name)) {
                const track = t.clone();
                for (let i = 0; i < track.values.length; i += 3) {
                    track.values[i] = track.values[0]; track.values[i + 2] = track.values[2];
                }
                return track;
            }
            return t;
        });
        return new THREE.AnimationClip(source.name, source.duration, tracks);
    });
}
function requireClips(clips, names) {
    for (const name of names) if (!clips.some(c => c.name === name && c.tracks.length)) throw new Error(`模型缺少动作 ${name}`);
}
function pose(root, clips, name = 'Idle') {
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(clips.find(c => c.name === name)).play(); mixer.update(0);
    // Let this temporary mixer be collected. stop/uncache would restore the bind pose.
    root.updateMatrixWorld(true);
}
function scaled(root, height, shoulder = false) {
    const box = bounds(root), holder = new THREE.Group();
    const reference = shoulder ? root.getObjectByName('Torso3').getWorldPosition(new THREE.Vector3()).y - box.min.y : box.max.y - box.min.y;
    if (!(reference > 0)) throw new Error('模型高度无效');
    holder.add(root); holder.scale.setScalar(height / reference);
    // Center on the body rather than the tip of an asymmetrical sword or spear.
    const hips = root.getObjectByName('Hips')?.getWorldPosition(new THREE.Vector3());
    root.position.x -= hips?.x ?? (box.min.x + box.max.x) / 2;
    root.position.z -= shoulder ? (box.min.z + box.max.z) / 2 : hips?.z ?? 0;
    root.position.y -= box.min.y;
    holder.updateMatrixWorld(true);
    return holder;
}

function mount(horse, horseClips, rider, riderClips, humanHeight, hipName, diagnostics, team) {
    pose(horse, horseClips); pose(rider, riderClips);
    const shoulderHeight = 1.45, riderHeight = shoulderHeight * 1.1;
    const horseHolder = scaled(horse, shoulderHeight, true), riderHolder = new THREE.Group();
    riderHolder.add(rider); riderHolder.scale.setScalar(riderHeight / humanHeight);
    riderHolder.updateMatrixWorld(true);
    riderHolder.position.sub(rider.getObjectByName(hipName).getWorldPosition(new THREE.Vector3()));
    const holder = new THREE.Group(); holder.add(horseHolder); holder.updateMatrixWorld(true);
    const bone = horse.getObjectByName('Torso2') || horse.getObjectByName('Torso');
    if (!bone) throw new Error('Quaternius 马缺少 Torso2/Torso 挂点');
    const saddle = new THREE.Group(); saddle.name = 'BattleSaddle';
    // Find the actual back surface in the posed, shoulder-normalized horse.
    // Hips are slightly above the underside of the rider's seated pelvis.
    const seat = new THREE.Vector3(0, 0, -.12);
    const ray = new THREE.Raycaster(new THREE.Vector3(seat.x, 4, seat.z), new THREE.Vector3(0, -1, 0));
    const surface = ray.intersectObject(horseHolder, true)[0];
    if (!surface) throw new Error('Quaternius 马背坐高测量失败');
    seat.y = surface.point.y + (hipName === 'Hips' ? .12 * riderHolder.scale.x : .08);
    saddle.position.copy(bone.worldToLocal(seat.clone()));
    saddle.quaternion.copy(bone.getWorldQuaternion(new THREE.Quaternion()).invert());
    const scale = bone.getWorldScale(new THREE.Vector3());
    saddle.scale.set(1 / scale.x, 1 / scale.y, 1 / scale.z);
    bone.add(saddle); saddle.add(riderHolder);
    const box = bounds(holder), assemblyScale = 1.85 / (box.max.y - box.min.y);
    const normalized = new THREE.Group(); normalized.scale.setScalar(assemblyScale); normalized.add(holder);
    holder.position.y -= box.min.y;
    diagnostics.mounted[team] = { bone: bone.name, seat: seat.toArray(), riderScale: riderHolder.scale.x,
        assemblyScale, riderHeight, shoulderHeight, riderShoulderRatio: riderHeight / shoulderHeight,
        backHeight: surface.point.y, height: bounds(normalized).getSize(new THREE.Vector3()).y, yawCorrection: 0,
        ...(hipName === 'pelvis' ? { thighSplay: [.7, -.7] } : {}) };
    return normalized;
}

function channel(root, clips) {
    return { mixer: new THREE.AnimationMixer(root), clips: new Map(clips.map(c => [c.name, c])), action: null,
        name: '', locked: false, fading: [] };
}
function play(channel, name, once, phase, force = false) {
    if (!force && channel.name === name) return;
    const previous = channel.action, next = channel.mixer.clipAction(channel.clips.get(name));
    next.stopFading().reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once; next.play();
    if (!once) next.time = phase * next.getClip().duration;
    if (previous && previous !== next) {
        previous.crossFadeTo(next, FADE, false);
        channel.fading.push({ action: previous, until: channel.mixer.time + FADE });
    }
    channel.action = next; channel.name = name; channel.locked = once;
}
function advance(channel, dt, desired, phase, dead) {
    if (!dead && (!channel.locked || channel.action.paused)) play(channel, desired, false, phase);
    if (dead && channel.action.paused && !channel.fading.length) return;
    channel.mixer.update(dt);
    channel.fading = channel.fading.filter(f => {
        if (f.action === channel.action) return false;
        if (channel.mixer.time < f.until) return true;
        f.action.stop(); return false;
    });
}

export function contactShadows(capacity) {
    const size = 64, pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const radiusSq = ((x + .5) / size * 2 - 1) ** 2 + ((y + .5) / size * 2 - 1) ** 2;
        pixels[(y * size + x) * 4 + 3] = Math.round(95 * Math.max(0, 1 - radiusSq) ** 2);
    }
    const map = new THREE.DataTexture(pixels, size, size);
    map.magFilter = map.minFilter = THREE.LinearFilter; map.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false });
    const geometry = new THREE.PlaneGeometry(2, 2); geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = 'SpikeContactShadows'; mesh.count = 0; mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
}

// Shared preparation is also used by the GPU facade; never create unit mixers here.
export function prepareFootTemplate(asset, teamColor) {
    const character = clone(asset.scene), clips = clipsFor(asset.animations);
    requireClips(clips, ['Idle', 'Walk', 'Attack', 'Hit', 'Death']);
    const primitives = mergePrimitives(character, teamColor);
    pose(character, clips);
    const root = scaled(character, 1.15);
    character.name = 'SpikeCharacter';
    return { root, clips, primitives };
}

// Build the very same measured saddle hierarchy as legacy, before extracting GPU
// spaces. No unit clones/mixers survive preparation. Team tint stays in clothMask.
export function prepareCavalryTemplate(assets, diagnostics = { mounted: {} }) {
    const rider = clone(assets.rider.scene);
    splitRider(rider);
    const riderClips = clipsFor(assets.rider.animations, true);
    requireClips(riderClips, ['Idle', 'Walk', 'Charge', 'Attack', 'Hit', 'Death']);
    const foot = clone(assets.infantry.scene);
    pose(foot, clipsFor(assets.infantry.animations));
    const humanHeight = bounds(foot).getSize(new THREE.Vector3()).y;
    const horses = {};
    let riderTemplate;
    for (const team of ['red', 'blue']) {
        const asset = assets[team === 'red' ? 'horse' : 'white'];
        const horse = clone(asset.scene), character = clone(rider);
        const horseClips = clipsFor(asset.animations);
        mergePrimitives(horse); mergePrimitives(character);
        const assembly = mount(horse, horseClips, character, riderClips, humanHeight, 'Hips', diagnostics, team);
        assembly.updateMatrixWorld(true);
        const saddle = assembly.getObjectByName('BattleSaddle');
        const riderHolder = character.parent;
        horses[team] = { root: horse, clips: horseClips,
            clipNames: ['Idle', 'Walk', 'Gallop', 'Idle_HitReact1', 'Death'],
            once: new Set(['Idle_HitReact1', 'Death']), mountBone: saddle.parent,
            saddleMatrix: saddle.matrix.clone(),
            riderMatrix: riderHolder.matrix.clone().multiply(character.matrix) };
        if (!riderTemplate) riderTemplate = { root: character, clips: riderClips,
            clipNames: ['Idle', 'Walk', 'Charge', 'Attack', 'Hit', 'Death'] };
        // Keep the assembled template reachable for independent native hierarchy tests.
        horses[team].assembly = assembly;
    }
    return { horses, rider: riderTemplate };
}

async function loadModelAssets() {
    const loader = new GLTFLoader();
    return Object.fromEntries(await Promise.all(Object.entries(PATHS).map(async ([key, path]) => [key, await loader.loadAsync(BASE + path)])));
}

export async function prepareModelTemplates({ cap, teamColors, gpuKinds = [], assets: loadedAssets }) {
    const assets = loadedAssets || await loadModelAssets();
    const diagnostics = { rider: null, primitives: {}, mounted: {}, heights: {}, pool: {}, resurrections: 0, skippedMixerUpdates: 0, frame: 0, active: 0, corpses: 0 };
    const rider = clone(assets.rider.scene), hipName = 'Hips';
    diagnostics.rider = splitRider(rider);
    const riderClips = clipsFor(assets.rider.animations, true);
    requireClips(riderClips, ['Idle', 'Walk', 'Charge', 'Attack', 'Hit', 'Death']);
    const footClips = Object.fromEntries(['infantry', 'pikeman', 'archer'].map(kind => [kind, clipsFor(assets[kind].animations)]));
    for (const clips of Object.values(footClips)) requireClips(clips, ['Idle', 'Walk', 'Attack', 'Hit', 'Death']);
    pose(assets.infantry.scene, footClips.infantry);
    const humanHeight = bounds(assets.infantry.scene).getSize(new THREE.Vector3()).y;
    const templates = new Map();
    for (const kind of gpuKinds) templates.set(`gpu-${kind}`, kind === 'cavalry'
        ? prepareCavalryTemplate(assets, diagnostics) : prepareFootTemplate(assets[kind]));
    for (const kind of Object.keys(cap)) for (const team of ['red', 'blue']) {
        if (gpuKinds.includes(kind)) continue;
        let root, character, horse, clips, horseClips;
        if (kind === 'cavalry') {
            character = clone(rider); clips = riderClips;
            const asset = assets[team === 'red' ? 'horse' : 'white'];
            horse = clone(asset.scene); horseClips = clipsFor(asset.animations);
            requireClips(horseClips, ['Idle', 'Walk', 'Gallop', 'Idle_HitReact1', 'Death']);
            diagnostics.primitives[`${team}-horse`] = mergePrimitives(horse);
            diagnostics.primitives[`${team}-rider`] = mergePrimitives(character, teamColors[team]);
            root = mount(horse, horseClips, character, clips, humanHeight, hipName, diagnostics, team);
        } else {
            const template = prepareFootTemplate(assets[kind], teamColors[team]);
            root = template.root; clips = template.clips; character = root.getObjectByName('SpikeCharacter');
            diagnostics.primitives[`${team}-${kind}`] = template.primitives;
        }
        character.name = 'SpikeCharacter'; if (horse) horse.name = 'SpikeHorse';
        diagnostics.heights[`${team}-${kind}`] = bounds(root).getSize(new THREE.Vector3()).y;
        templates.set(`${team}-${kind}`, { root, clips, horseClips });
    }
    return { templates, diagnostics, assets };
}

export async function createModelSkin({ scene, camera, units, cap, teamColors, groundH, shadowsEnabled = true, prepared, assets }) {
    // GPU preparation deliberately omits legacy templates. Rebuild only when needed,
    // from the parsed assets retained by that preparation, without another download.
    if (prepared?.assets && units.some(u => !prepared.templates.has(`${u.team}-${u.type}`))) {
        prepared = await prepareModelTemplates({ cap, teamColors, assets: prepared.assets });
    }
    const { templates, diagnostics } = prepared || await prepareModelTemplates({ cap, teamColors, assets });
    const group = new THREE.Group(); group.name = 'SpikeModelSkins';
    const pools = new Map(), live = new Map(), dead = [], counts = {};
    for (const u of units) counts[`${u.team}-${u.type}`] = (counts[`${u.team}-${u.type}`] || 0) + 1;
    for (const [key, count] of Object.entries(counts)) {
        const kind = key.slice(key.indexOf('-') + 1), template = templates.get(key), pool = [];
        const otherTeam = key.startsWith('red-') ? 'blue' : 'red';
        if (count + (counts[`${otherTeam}-${kind}`] || 0) > cap[kind]) throw new Error(`${kind} 模型对象池超过 CAP`);
        for (let i = 0; i < count; i++) {
            const root = clone(template.root), meshes = [], skeletons = new Map();
            root.visible = false;
            // GLTF primitives share a rig. SkeletonUtils clones each primitive's Skeleton;
            // collapse identical joint palettes back to one per character/horse per unit.
            root.traverse(o => {
                if (!o.isMesh) return;
                if (o.isSkinnedMesh) {
                    const key = o.skeleton.bones.map(b => b.uuid).join(',');
                    if (skeletons.has(key)) o.skeleton = skeletons.get(key);
                    else skeletons.set(key, o.skeleton);
                }
                o.castShadow = false; o.receiveShadow = false;
                // Fixed conservative local bounds: animation/death must not be culled by bind-pose bounds.
                if (o.isSkinnedMesh) { o.computeBoundingSphere(); o.boundingSphere.radius *= 3; }
                meshes.push(o);
            });
            const visual = channel(root.getObjectByName('SpikeCharacter'), template.clips);
            const horseRoot = root.getObjectByName('SpikeHorse');
            const equine = horseRoot ? channel(horseRoot, template.horseClips) : null;
            pool.push({ root, meshes, visual, equine, kind, team: key.split('-')[0], phase: Math.random(), pending: 0, dead: false, lastLunge: 0 });
            group.add(root);
        }
        pools.set(key, pool); diagnostics.pool[key] = count;
    }
    const shadows = contactShadows(shadowsEnabled ? units.length : 0), shadowTransform = new THREE.Object3D();
    shadows.visible = shadowsEnabled;
    group.add(shadows); scene.add(group);
    let poolExhaustionReported = false;
    function acquire(u) {
        const key = `${u.team}-${u.type}`, pool = pools.get(key);
        const entry = pool?.pop();
        if (!entry) {
            if (!poolExhaustionReported) {
                console.error(`[spike-models] 模型对象池耗尽：${key}`);
                poolExhaustionReported = true;
            }
            return null;
        }
        if (entry.dead) diagnostics.resurrections++;
        entry.dead = false; entry.pending = 0; entry.hp = u.hp; entry.lastLunge = 0;
        entry.root.visible = true; entry.root.position.set(u.gx - 35, groundH(u.gx, u.gy), u.gy - 35);
        for (const c of [entry.visual, entry.equine]) if (c) {
            c.mixer.stopAllAction(); c.name = ''; c.action = null; c.locked = false; c.fading = [];
            play(c, 'Idle', false, entry.phase);
        }
        live.set(u.id, entry); return entry;
    }
    // Pre-bind while the simulation is still at deployment: no clones/loads during battle.
    for (const u of units) acquire(u);
    let lastSimulationTime = null, endOffset = 0;
    const api = {
        diagnostics, pools, live, dead, group, shadows,
        sync(u, heading, now) {
            if (u.dead || u.hp <= 0) return;
            const entry = live.get(u.id) || acquire(u);
            if (!entry) return;
            entry.root.position.set(u.gx - 35, groundH(u.gx, u.gy), u.gy - 35);
            entry.root.rotation.set(0, heading, 0); // both selected assets face +Z
            const hit = u.hp < entry.hp, attack = u._lungeUntil > now && u._lungeUntil > entry.lastLunge;
            entry.hp = u.hp; entry.lastLunge = u._lungeUntil || 0;
            entry.moving = !!u.moving;
            entry.charge = u.moving && (u.state === 'charge' || u.state === 'pierce' || Math.hypot(u.velX || 0, u.velY || 0) > 4.5);
            if (hit || (attack && !entry.visual.locked)) {
                play(entry.visual, hit ? 'Hit' : 'Attack', true, entry.phase, true);
                if (entry.equine && hit) play(entry.equine, 'Idle_HitReact1', true, entry.phase, true);
            }
        },
        kill(u, heading) {
            const entry = live.get(u.id);
            if (!entry) return;
            entry.root.position.set(u.gx - 35, groundH(u.gx, u.gy), u.gy - 35);
            entry.root.rotation.set(0, heading, 0);
            live.delete(u.id); entry.dead = true; entry.pending = 0;
            play(entry.visual, 'Death', true, entry.phase, true);
            if (entry.equine) play(entry.equine, 'Death', true, entry.phase, true);
            dead.push(entry);
            // FIFO corpse recycling, using the same CAP as the original corpse renderer.
            if (dead.filter(e => e.kind === u.type).length > cap[u.type]) {
                const i = dead.findIndex(e => e.kind === u.type), oldest = dead.splice(i, 1)[0];
                oldest.dead = false; oldest.root.visible = false; pools.get(`${oldest.team}-${oldest.kind}`).push(oldest);
            }
        },
        update(simulationTime, fps, presentation) {
            if (presentation?.battleOver && !presentation.paused) endOffset += presentation.dt || 0;
            const now = simulationTime / 1000 + endOffset;
            const dt = presentation?.paused || lastSimulationTime === null ? 0 : Math.max(0, now - lastSimulationTime);
            lastSimulationTime = now;
            diagnostics.frame++; diagnostics.active = live.size; diagnostics.corpses = dead.length;
            const total = live.size + dead.length;
            let shadowCount = 0;
            function updateEntry(entry) {
                const distanceSq = entry.root.position.distanceToSquared(camera.position);
                if (shadowsEnabled) {
                    const { x, z } = entry.root.position;
                    shadowTransform.position.set(x, groundH(x + 35, z + 35) + .02, z);
                    shadowTransform.rotation.set(0, entry.root.rotation.y, 0);
                    shadowTransform.scale.set(entry.equine ? .65 : .42, 1, entry.equine ? 1 : .42);
                    shadowTransform.updateMatrix(); shadows.setMatrixAt(shadowCount++, shadowTransform.matrix);
                }
                // Keep an odd half-rate frame pending through pause, rather than
                // applying it on the next render while the simulation clock is frozen.
                if (dt === 0) return;
                entry.pending += dt;
                // Alternate phases spread CPU load; accumulated simulated time prevents slow motion.
                if ((distanceSq > 4900 || total > 600) && (diagnostics.frame + (entry.phase < .5 ? 0 : 1)) % 2) {
                    diagnostics.skippedMixerUpdates++; return;
                }
                const elapsed = entry.pending; entry.pending = 0;
                const locomotion = entry.moving ? entry.charge && entry.equine ? 'Charge' : 'Walk' : 'Idle';
                advance(entry.visual, elapsed, locomotion, entry.phase, entry.dead);
                if (entry.equine) advance(entry.equine, elapsed, entry.moving ? entry.charge ? 'Gallop' : 'Walk' : 'Idle', entry.phase, entry.dead);
            }
            for (const entry of live.values()) updateEntry(entry);
            for (const entry of dead) updateEntry(entry);
            shadows.count = shadowCount;
            if (shadowsEnabled) shadows.instanceMatrix.needsUpdate = true;
        }
    };
    console.info('[spike-models] 骑手拆分 / 坐姿 / 尺度 / 对象池', diagnostics);
    return api;
}

// main owns only this facade. GPU kinds never enter the legacy pools/channels.
export async function createModelFacade(options) {
    if (!options.gpu) return createModelSkin(options);
    const gpuCrowds = new Map();
    let prepared = options.prepared;
    const assets = prepared?.assets || options.assets || (!prepared ? await loadModelAssets() : undefined);
    try {
        const gpuKinds = GPU_KINDS.filter(kind => options.cap[kind] > 0);
        prepared ||= await prepareModelTemplates({ ...options, gpuKinds, assets });
        const { createGpuCrowd, createGpuCavalry } = await import('./gpu-crowd.js');
        for (const kind of gpuKinds) {
            gpuCrowds.set(kind, (kind === 'cavalry' ? createGpuCavalry : createGpuCrowd)({ ...options, kind, template: prepared.templates.get(`gpu-${kind}`),
                units: options.units.filter(u => u.type === kind) }));
        }
        const legacyCap = Object.fromEntries(Object.entries(options.cap).filter(([kind]) => !gpuCrowds.has(kind)));
        const legacy = await createModelSkin({ ...options, prepared, cap: legacyCap,
            units: options.units.filter(u => !gpuCrowds.has(u.type)) });
        const group = new THREE.Group(); group.name = 'SpikeMixedModelSkins';
        group.add(legacy.group, ...[...gpuCrowds.values()].map(crowd => crowd.group)); options.scene.add(group);
        for (const [kind, crowd] of gpuCrowds) Object.defineProperty(crowd.diagnostics, 'mixers', {
            enumerable: true,
            get() {
                const entries = new Set([...legacy.live.values(), ...legacy.dead, ...[...legacy.pools.values()].flat()]);
                let count = 0;
                for (const entry of entries) if (entry.kind === kind) {
                    count += Number(!!entry.visual?.mixer) + Number(!!entry.equine?.mixer);
                }
                return count;
            }
        });
        const gpuDiagnostics = { byKind: Object.fromEntries([...gpuCrowds].map(([kind, crowd]) => [kind, crowd.diagnostics])) };
        for (const key of ['active', 'corpses', 'resurrections', 'drawCalls', 'mixers', 'bakedRows', 'atlasBytes']) {
            Object.defineProperty(gpuDiagnostics, key, { enumerable: true,
                get: () => [...gpuCrowds.values()].reduce((sum, crowd) => sum + crowd.diagnostics[key], 0) });
        }
        const diagnostics = { ...legacy.diagnostics, gpu: gpuDiagnostics,
            get gpuMixers() { return gpuDiagnostics.mixers; } };
        return {
            group, gpuCrowds, gpu: gpuCrowds.get('infantry'), legacy, diagnostics,
            isGpuKind: kind => gpuCrowds.has(kind),
            sync(u, heading, wallTime, simTime) {
                const crowd = gpuCrowds.get(u.type);
                if (crowd) crowd.sync(u, heading, simTime);
                else legacy.sync(u, heading, wallTime);
            },
            kill(u, heading, simTime) {
                const crowd = gpuCrowds.get(u.type);
                if (crowd) crowd.kill(u, heading, simTime);
                else legacy.kill(u, heading);
            },
            update(simTime, fps, presentation) {
                legacy.update(simTime, fps, presentation);
                for (const crowd of gpuCrowds.values()) crowd.update(simTime, fps, presentation);
                Object.assign(diagnostics, legacy.diagnostics);
                diagnostics.active += gpuDiagnostics.active; diagnostics.corpses += gpuDiagnostics.corpses;
                diagnostics.resurrections += gpuDiagnostics.resurrections;
            }
        };
    } catch (error) {
        for (const crowd of gpuCrowds.values()) crowd.dispose();
        // Production boot owns the block-soldier fallback and its HUD notice.
        if (options.fallbackToLegacy === false) throw error;
        console.error('[spike-gpu] 初始化失败，整体退回旧模型路径', error);
        return createModelSkin({ ...options, prepared, assets });
    }
}
