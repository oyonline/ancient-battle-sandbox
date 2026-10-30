import globalTest from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { prepareFootTemplate, prepareCavalryTemplate, createModelFacade } from '../js/three-spike/model-skin.js';
import { SAMPLE_HZ, bakeAnimations, clipSample, sampleBone, createAnimationState, createGpuCrowd, createGpuCavalry, sampleMount, createCrowdMaterial } from '../js/three-spike/gpu-crowd.js';

const paths = { infantry: 'sword-standard/infantry', pikeman: 'pike-standard/spear', archer: 'archer-standard/archer' };
const assets = new Map();
for (const [kind, path] of Object.entries(paths)) {
    const bytes = await readFile(new URL(`../prototypes/model-gallery/assets/october/${path}-rigged.glb`, import.meta.url));
    assets.set(kind, await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ''));
}
globalThis.ProgressEvent ||= class ProgressEvent {};
const mountedAssets = { infantry: assets.get('infantry') };
for (const [key, file] of [['rider', 'october/cavalry-standard/cavalry-rigged.glb'], ['horse', 'horse/Horse.gltf'], ['white', 'horse/Horse_White.gltf']]) {
    const bytes = await readFile(new URL(`../prototypes/model-gallery/assets/${file}`, import.meta.url));
    mountedAssets[key] = await new GLTFLoader().parseAsync(file.endsWith('.gltf') ? bytes.toString() : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}
for (const [kind, asset] of assets) {
const test = (name, fn) => globalTest(`${kind}: ${name}`, fn);
const template = prepareFootTemplate(asset), reference = clone(template.root);
const atlas = bakeAnimations(template, 8);
const unit = new THREE.Group(); unit.position.set(-7, 2.3, 9); unit.rotation.y = .71; unit.add(reference);
unit.updateMatrixWorld(true);
let skin; reference.traverse(o => { if (o.isSkinnedMesh) skin = o; });
const instance = unit.matrixWorld.clone().multiply(atlas.modelMatrix);
const gpuNormalMatrix = new THREE.Matrix3().getNormalMatrix(instance);
const mixer = new THREE.AnimationMixer(reference);

test('120 Hz atlas includes both endpoints, five whitelisted clips and an independent CPU copy', t => {
    assert.equal(SAMPLE_HZ, 120);
    assert.equal(atlas.boneCount, kind === 'archer' ? 19 : 18);
    assert.deepEqual([...atlas.clips.keys()], ['Idle', 'Walk', 'Attack', 'Hit', 'Death']);
    for (const meta of atlas.clips.values()) {
        assert.equal(meta.frames, Math.ceil(meta.duration * 120) + 1);
        assert.equal(meta.loop, ['Idle', 'Walk'].includes(meta.name));
        assert.equal(clipSample({ ...meta, loop: false }, meta.duration)[2], meta.frames - 1);
    }
    const scale = new THREE.Vector3().setFromMatrixScale(atlas.modelMatrix);
    assert.ok(scale.x > 0);
    assert.ok(Math.abs(scale.x - scale.y) < 1e-9 && Math.abs(scale.x - scale.z) < 1e-9,
        `modelMatrix must have uniform scale: ${scale.toArray()}`);
    assert.equal(atlas.texture.type, THREE.FloatType);
    assert.equal(atlas.texture.minFilter, THREE.NearestFilter);
    assert.equal(atlas.texture.generateMipmaps, false);
    assert.notEqual(atlas.data, atlas.texture.image.data);
    assert.deepEqual(atlas.data, atlas.texture.image.data);
    assert.equal(atlas.texture.image.width, atlas.width);
    assert.equal(atlas.texture.image.height, atlas.rows + 8);
    assert.equal(atlas.data.byteLength, atlas.width * (atlas.rows + 8) * 4 * Float32Array.BYTES_PER_ELEMENT);
    t.diagnostic(JSON.stringify({ sampleHz: SAMPLE_HZ, width: atlas.width, bakedRows: atlas.rows,
        height: atlas.texture.image.height, bytes: atlas.data.byteLength,
        clips: [...atlas.clips.values()].map(({ name, duration, frames }) => ({ name, duration, frames })) }));
});

// Reference positions come from three's own CPU skinning. Normals use the exact
// native skinnormal_vertex formula followed by the old mesh's normal matrix.
// All vertices, a translated/rotated unit and the actual 1.15 m holder are covered.
const times = Object.fromEntries([...atlas.clips].map(([name, meta]) => [name,
    [0, .0173, meta.duration * .2713, meta.duration * .5117, meta.duration * .8319,
        meta.duration - 1 / 240, meta.duration - .0001, meta.duration, meta.duration + .0001, meta.duration + .1131]]));
// Scan the ENTIRE native Attack clip; a turning point must be interior.
let attackPeak;
{
    const meta = atlas.clips.get('Attack');
    const attack = mixer.clipAction(meta.clip).reset().setLoop(THREE.LoopOnce, 1);
    attack.clampWhenFinished = true; attack.play(); mixer.setTime(0); unit.updateMatrixWorld(true);
    const rest = Array.from({ length: skin.geometry.attributes.position.count }, (_, v) => skin.getVertexPosition(v, new THREE.Vector3()));
    const p = new THREE.Vector3(); let maxDisplacement = -1, peakStep = -1;
    const steps = Math.ceil(meta.duration * 240);
    for (let step = 0; step <= steps; step++) {
        const time = Math.min(step / 240, meta.duration);
        attack.reset().play(); mixer.setTime(time); unit.updateMatrixWorld(true);
        for (let v = 0; v < rest.length; v++) {
            const displacement = skin.getVertexPosition(v, p).distanceToSquared(rest[v]);
            if (displacement > maxDisplacement) { maxDisplacement = displacement; attackPeak = time; peakStep = step; }
        }
    }
    assert.ok(peakStep > 0 && peakStep < steps, `${kind} Attack peak must be interior: ${attackPeak}/${meta.duration}`);
    mixer.stopAllAction();
    times.Attack.push(attackPeak - 1 / 240, attackPeak, attackPeak + 1 / 240, attackPeak + .0031);
}
for (const [name, samples] of Object.entries(times)) test(`${name}: world positions < 0.01 m and native normal directions < 2 degrees`, t => {
    const meta = atlas.clips.get(name), geometry = skin.geometry;
    const position = new THREE.Vector3(), gpuPosition = new THREE.Vector3(), normal = new THREE.Vector3(), gpuNormal = new THREE.Vector3();
    const gpuBones = [], nativeBones = [], bone = new THREE.Matrix4(), nativeSkin = new THREE.Matrix4(), gpuSkin = new THREE.Matrix4();
    let maxError = 0, errorVertex = -1, errorTime = 0, maxAngle = 0, normalVertex = -1, normalTime = 0;
    mixer.stopAllAction();
    const action = mixer.clipAction(meta.clip).reset().setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    for (const time of samples) {
        const localTime = meta.loop ? time % meta.duration : Math.min(meta.duration, time);
        // setTime resets action.time, but does not unpause a previously clamped action.
        action.reset().play();
        mixer.setTime(localTime); unit.updateMatrixWorld(true);
        const descriptor = clipSample(meta, time);
        for (let i = 0; i < atlas.boneCount; i++) {
            gpuBones[i] = sampleBone(atlas, descriptor, i);
            nativeBones[i] = new THREE.Matrix4().multiplyMatrices(skin.skeleton.bones[i].matrixWorld, skin.skeleton.boneInverses[i]);
        }
        const nativeNormalMatrix = new THREE.Matrix3().getNormalMatrix(skin.matrixWorld);
        for (let v = 0; v < geometry.attributes.position.count; v++) {
            gpuSkin.elements.fill(0); nativeSkin.elements.fill(0);
            for (let k = 0; k < 4; k++) {
                const index = geometry.attributes.skinIndex.getComponent(v, k), weight = geometry.attributes.skinWeight.getComponent(v, k);
                for (let e = 0; e < 16; e++) {
                    gpuSkin.elements[e] += gpuBones[index].elements[e] * weight;
                    nativeSkin.elements[e] += nativeBones[index].elements[e] * weight;
                }
            }
            gpuSkin.premultiply(atlas.bindMatrixInverse).multiply(atlas.bindMatrix);
            nativeSkin.premultiply(skin.bindMatrixInverse).multiply(skin.bindMatrix);
            skin.getVertexPosition(v, position); position.applyMatrix4(skin.matrixWorld);
            gpuPosition.fromBufferAttribute(geometry.attributes.position, v).applyMatrix4(gpuSkin).applyMatrix4(instance);
            const error = position.distanceTo(gpuPosition);
            if (error > maxError) { maxError = error; errorVertex = v; errorTime = time; }
            bone.copy(nativeSkin);
            normal.fromBufferAttribute(geometry.attributes.normal, v).applyMatrix3(new THREE.Matrix3().setFromMatrix4(bone)).applyMatrix3(nativeNormalMatrix).normalize();
            gpuNormal.fromBufferAttribute(geometry.attributes.normal, v).applyMatrix3(new THREE.Matrix3().setFromMatrix4(gpuSkin)).applyMatrix3(gpuNormalMatrix).normalize();
            const angle = THREE.MathUtils.radToDeg(normal.angleTo(gpuNormal));
            if (angle > maxAngle) { maxAngle = angle; normalVertex = v; normalTime = time; }
        }
    }
    t.diagnostic(JSON.stringify({ kind, name, attackPeak: name === 'Attack' ? attackPeak : undefined, samples: samples.length, vertices: geometry.attributes.position.count, maxError, errorVertex, errorTime, maxAngle, normalVertex, normalTime }));
    assert.ok(maxError < .01, `${name} position ${maxError} at v${errorVertex}, t${errorTime}`);
    assert.ok(maxAngle < 2, `${name} normal ${maxAngle} at v${normalVertex}, t${normalTime}`);
});

test('cloth identity survives merging and GPU team colors use the legacy linear swatches', () => {
    const mask = atlas.geometry.attributes.clothMask, colors = atlas.geometry.attributes.color;
    const red = prepareFootTemplate(asset, 0xc4553f), blue = prepareFootTemplate(asset, 0x7fb0e0);
    let redSkin, blueSkin; red.root.traverse(o => { if (o.isSkinnedMesh) redSkin = o; }); blue.root.traverse(o => { if (o.isSkinnedMesh) blueSkin = o; });
    const redColor = new THREE.Color(0xc4553f), blueColor = new THREE.Color(0x7fb0e0);
    assert.ok(mask.array.some(v => v === 1)); assert.ok(mask.array.some(v => v === 0));
    for (let v = 0; v < mask.count; v++) for (let k = 0; k < 3; k++) {
        const original = colors.getComponent(v, k);
        assert.ok(Math.abs(redSkin.geometry.attributes.color.getComponent(v, k) - (mask.getX(v) ? redColor.toArray()[k] : original)) < 1e-6);
        assert.ok(Math.abs(blueSkin.geometry.attributes.color.getComponent(v, k) - (mask.getX(v) ? blueColor.toArray()[k] : original)) < 1e-6);
    }
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader };
    const material = createCrowdMaterial(atlas, { red: 0xc4553f, blue: 0x7fb0e0 }); material.onBeforeCompile(shader);
    assert.match(shader.vertexShader, /texelFetch/); assert.match(shader.vertexShader, /attribute vec4 skinIndex/);
    assert.match(shader.vertexShader, /#include <defaultnormal_vertex>/); assert.match(shader.vertexShader, /#include <project_vertex>/);
    assert.equal(shader.uniforms.crowdRed.value.getHex(), 0xc4553f);
});

test('priority, one-shot unlock, interruption snapshots and clamped Death', () => {
    const anim = createAnimationState(atlas, atlas.rows, 0);
    anim.event('Attack', .2); anim.event('Hit', .24); anim.event('Attack', .25);
    assert.equal(anim.state.name, 'Hit');
    const before = structuredClone(anim.parameters(.28)), old = new THREE.Matrix4(), current = new THREE.Matrix4();
    const expected = [];
    for (let b = 0; b < atlas.boneCount; b++) {
        sampleBone(atlas, before.a, b, old); sampleBone(atlas, before.b, b, current);
        expected.push(old.elements.map((x, i) => x * (1 - before.blend) + current.elements[i] * before.blend));
    }
    anim.event('Hit', .28);
    assert.equal(anim.state.start, .28);
    const after = structuredClone(anim.parameters(.28)); assert.equal(after.blend, 0);
    for (let b = 0; b < atlas.boneCount; b++) {
        const actual = sampleBone(atlas, after.a, b).elements;
        actual.forEach((x, i) => assert.ok(Math.abs(x - expected[b][i]) < 1e-5));
    }
    anim.update(1, true); assert.equal(anim.state.name, 'Walk');
    anim.event('Death', 1.1); anim.event('Hit', 1.2); anim.event('Attack', 1.3);
    assert.equal(anim.state.name, 'Death');
    const end = structuredClone(anim.update(9, true)); assert.equal(end.b[2], atlas.clips.get('Death').frames - 1);
    assert.deepEqual(anim.update(10, true), end);
});

test('one batch, lunge deduplication, pause and terminal presentation clock', () => {
    const units = [{ id: 1, type: kind, team: 'red', gx: 33, gy: 34, hp: 100 },
        { id: 2, type: kind, team: 'blue', gx: 36, gy: 35, hp: 100 }];
    const scene = new THREE.Scene(), crowd = createGpuCrowd({ template: prepareFootTemplate(asset), scene, units,
        kind, cap: { [kind]: 8 }, teamColors: { red: 0xc4553f, blue: 0x7fb0e0 }, groundH: () => 0, shadowsEnabled: false });
    const u = units[0];
    u._lungeUntil = -100; crowd.sync(u, .4, 500); // wall-clock expiry is irrelevant
    assert.equal(crowd.live.get(1).animation.state.name, 'Attack');
    crowd.sync(u, .4, 600); assert.equal(crowd.live.get(1).animation.state.start, .5);
    crowd.update(600, 60); const paused = crowd.mesh.geometry.attributes.aClipB.array.slice();
    crowd.update(600, 60, { dt: 1, paused: true }); assert.deepEqual(crowd.mesh.geometry.attributes.aClipB.array, paused);
    u.hp = 70; u._lungeUntil++; crowd.sync(u, .4, 650); assert.equal(crowd.live.get(1).animation.state.name, 'Hit');
    crowd.kill(u, .7, 800); crowd.update(800, 60, { dt: .5, battleOver: true, paused: true });
    assert.equal(crowd.dead[0].animation.parameters(.8).b[2], 0);
    crowd.update(800, 60, { dt: 2, battleOver: true });
    const deathSlot = crowd.live.size, deathFrame = crowd.mesh.geometry.attributes.aClipB.getZ(deathSlot);
    assert.equal(deathFrame, crowd.atlas.clips.get('Death').frames - 1);
    crowd.sync(u, .4, 1000); assert.equal(crowd.live.size, 1); assert.equal(crowd.mesh.count, 2);
    assert.equal(crowd.mesh.isSkinnedMesh, undefined);
    assert.equal(crowd.diagnostics.drawCalls, 1);
    crowd.mesh.visible = false; crowd.update(800, 60); assert.equal(crowd.diagnostics.drawCalls, 0);
    assert.equal(crowd.diagnostics.resurrections, 0); assert.equal(crowd.mesh.material.length, undefined);
});


test('interruption queues one RGBA row; zero-blend events reuse the source without writes', () => {
    const local = bakeAnimations(prepareFootTemplate(asset), 1);
    const anim = createAnimationState(local, local.rows);
    anim.event('Attack', .2);
    const source = anim.parameters(.2).a.slice(), version = local.texture.version;
    anim.event('Hit', .2);
    assert.deepEqual(anim.parameters(.2).a, source);
    assert.equal(local.texture.version, version);
    assert.deepEqual(local.texture.updateRanges, []);
    const baked = local.texture.image.data.slice(0, local.rows * local.width * 4);
    anim.event('Hit', .24);
    assert.deepEqual(local.texture.updateRanges, [{ start: local.rows * local.width * 4, count: local.width * 4 }]);
    assert.equal(local.texture.version, version + 1);
    assert.deepEqual(local.texture.image.data.subarray(0, baked.length), baked);
    assert.deepEqual(local.texture.image.data.subarray(baked.length), local.data.subarray(baked.length));
    const snapshot = local.texture.image.data.slice();
    anim.event('Death', .24);
    assert.deepEqual(local.texture.image.data, snapshot);
    assert.equal(local.texture.version, version + 1);
});

test('facade measures zero legacy infantry pools/channels and visible crowd meshes', async () => {
    const units = [{ id: 1, type: kind, team: 'red', gx: 35, gy: 35, hp: 100 },
        { id: 2, type: kind, team: 'blue', gx: 36, gy: 35, hp: 100 }];
    const facade = await createModelFacade({ gpu: true, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
        units, cap: { [kind]: 2 }, teamColors: { red: 0xc4553f, blue: 0x7fb0e0 }, groundH: () => 0,
        prepared: { templates: new Map([[`gpu-${kind}`, prepareFootTemplate(asset)]]),
            diagnostics: { pool: {}, resurrections: 0, skippedMixerUpdates: 0, frame: 0, active: 0, corpses: 0 } } });
    assert.ok(facade.gpuCrowds.has(kind), 'GPU facade must initialize successfully');
    const gpu = facade.gpuCrowds.get(kind);
    assert.equal([...facade.legacy.pools.keys()].filter(key => key.endsWith(`-${kind}`)).length, 0);
    assert.equal([...facade.legacy.live.values(), ...facade.legacy.dead].filter(e => e.kind === kind).length, 0);
    assert.equal(gpu.diagnostics.mixers, 0);
    assert.equal(facade.diagnostics.gpuMixers, 0);
    facade.update(0, 60);
    assert.equal(gpu.diagnostics.drawCalls, 2);
    gpu.group.children.find(o => o !== gpu.mesh).visible = false;
    facade.update(0, 60); assert.equal(gpu.diagnostics.drawCalls, 1);
    gpu.group.visible = false;
    facade.update(0, 60); assert.equal(gpu.diagnostics.drawCalls, 0);
    gpu.group.visible = true;
    facade.update(0, 60, { dt: .5, battleOver: true });
    facade.kill(units[0], 0, 0);
    facade.update(0, 60, { dt: 0, battleOver: true });
    assert.equal(gpu.mesh.geometry.attributes.aClipB.getZ(1), 0);
    facade.update(0, 60, { dt: .05, battleOver: true });
    assert.ok(Math.abs(gpu.mesh.geometry.attributes.aClipB.getZ(1) - 6) < 1e-5);
    facade.kill(units[1], 0, 0);
    facade.update(0, 60, { dt: 0, battleOver: true });
    assert.equal(gpu.mesh.geometry.attributes.aClipB.getZ(1), 0);
    assert.ok(Math.abs(gpu.mesh.geometry.attributes.aClipB.getZ(0) - 6) < 1e-5);
});

}

function mixedFixture() {
    const templates = new Map(), cap = { infantry: 2, pikeman: 2, archer: 2, cavalry: 2 }, units = [];
    for (const [kind, asset] of assets) {
        templates.set(`gpu-${kind}`, prepareFootTemplate(asset));
        for (const team of ['red', 'blue']) templates.set(`${team}-${kind}`, prepareFootTemplate(asset, team === 'red' ? 0xc4553f : 0x7fb0e0));
    }
    templates.set('gpu-cavalry', prepareCavalryTemplate(mountedAssets));
    for (const team of ['red', 'blue']) {
        const mounted = prepareCavalryTemplate(mountedAssets), root = mounted.horses[team].assembly;
        mounted.rider.root.name = 'SpikeCharacter'; mounted.horses[team].root.name = 'SpikeHorse';
        // Blue owns a distinct native rider below its saddle.
        root.getObjectByName('BattleSaddle').children[0].children[0].name = 'SpikeCharacter';
        templates.set(`${team}-cavalry`, { root, clips: mounted.rider.clips, horseClips: mounted.horses[team].clips });
    }
    for (const type of Object.keys(cap)) for (const team of ['red', 'blue']) {
        units.push({ id: units.length, type, team, gx: 33 + units.length, gy: 35, hp: 100 });
    }
    return { gpu: true, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), units, cap,
        teamColors: { red: 0xc4553f, blue: 0x7fb0e0 }, groundH: () => 0, shadowsEnabled: false,
        prepared: { templates, diagnostics: { pool: {}, resurrections: 0, skippedMixerUpdates: 0, frame: 0, active: 0, corpses: 0 } } };
}

globalTest('mixed facade isolates all three rigs, routes attacks/deaths and routes cavalry without any legacy entries', async () => {
    const options = mixedFixture(), facade = await createModelFacade(options);
    assert.deepEqual([...facade.gpuCrowds.keys()], [...assets.keys(), 'cavalry']);
    assert.equal(facade.gpu, facade.gpuCrowds.get('infantry'));
    assert.equal(facade.legacy.pools.size, 0); assert.equal(facade.legacy.live.size, 0); assert.equal(facade.legacy.dead.length, 0);
    const attackSources = new Map();
    for (const u of options.units) {
        u._lungeUntil = 220;
        facade.sync(u, .7, 0, 500);
        const entry = facade.gpuCrowds.get(u.type)?.live.get(u.id);
        if (entry) {
            assert.equal(entry.animation.state.name, 'Attack');
            assert.equal(entry.animation.state.start, .5);
            attackSources.set(u.type, entry.animation);
        }
    }
    assert.equal(new Set([...facade.gpuCrowds.values()].map(c => c.atlas.texture)).size, 4);
    facade.update(600, 60);
    assert.equal(facade.diagnostics.active, 8);
    assert.equal(facade.diagnostics.gpu.drawCalls, 6);
    assert.equal(facade.diagnostics.gpuMixers, 0);
    for (const u of options.units) {
        u.dead = true; u.hp = 0;
        facade.kill(u, .8, 650);
        facade.sync(u, .8, 900, 900);
    }
    facade.update(650, 60, { dt: 2, battleOver: true });
    for (const [kind, crowd] of facade.gpuCrowds) {
        assert.equal(facade.isGpuKind(kind), true);
        assert.equal(crowd.live.size, 0); assert.equal(crowd.dead.length, 2);
        assert.equal(crowd.mesh.count, 2); assert.equal(crowd.diagnostics.drawCalls, kind === 'cavalry' ? 3 : 1);
        assert.equal(crowd.mesh.geometry.attributes.aClipB.getZ(0), crowd.atlas.clips.get('Death').frames - 1);
        assert.equal(crowd.diagnostics.mixers, 0);
        assert.equal(facade.diagnostics.gpu.byKind[kind], crowd.diagnostics);
    }
    assert.equal(facade.isGpuKind('cavalry'), true);
    assert.equal(facade.diagnostics.resurrections, 0);
    assert.equal(facade.diagnostics.active, 0); assert.equal(facade.diagnostics.corpses, 8);
});

for (const failedKind of [...assets.keys(), 'cavalry']) globalTest(`${failedKind} GPU initialization failure rolls back every crowd and uses all legacy pools`, async t => {
    const options = mixedFixture(), disposed = [];
    const broken = options.prepared.templates.get(`gpu-${failedKind}`);
    (failedKind === 'cavalry' ? broken.rider : broken).clips = [];
    const initTexture = [];
    // Exercise actual per-kind construction/disposal, with a minimal renderer
    // adapter to observe atlas lifetimes (no GPU/shader result is claimed here).
    const renderer = { capabilities: { isWebGL2: true, maxTextureSize: 16384 },
        getContext: () => ({ MAX_VERTEX_TEXTURE_IMAGE_UNITS: 1, NO_ERROR: 0, getParameter: () => 16, getError: () => 0 }),
        initTexture(texture) { initTexture.push(texture); texture.addEventListener('dispose', () => disposed.push(texture)); },
        debug: {}, compile() {}, properties: { get: () => ({ currentProgram: { getUniforms() {} } }) } };
    const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
    const fallback = await createModelFacade({ ...options, renderer });
    assert.equal(fallback.gpuCrowds, undefined);
    assert.equal(fallback.live.size, 8);
    assert.equal(fallback.pools.size, 8);
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /整体退回旧模型路径/);
    assert.equal(initTexture.length, failedKind === 'cavalry' ? 5 : [...assets.keys()].indexOf(failedKind));
    // Cavalry disposes its partially built batches before facade rollback. Compare
    // texture identities/counts without serializing megabytes on a mismatch.
    assert.equal(disposed.length, initTexture.length);
    for (const texture of new Set(initTexture)) assert.equal(disposed.filter(t => t === texture).length,
        initTexture.filter(t => t === texture).length, 'every initialized atlas must be disposed');
    assert.deepEqual(options.scene.children, [fallback.group]);
    fallback.update(100, 60);
    assert.equal(fallback.diagnostics.resurrections, 0);
});

const cavalryTemplate = prepareCavalryTemplate(mountedAssets);
const cavalry = createGpuCavalry({ template: cavalryTemplate, units: [], cap: { cavalry: 4 }, scene: new THREE.Scene(),
    teamColors: { red: 0xc4553f, blue: 0x7fb0e0 }, groundH: () => 0, shadowsEnabled: false });
const skinOf = root => root.getObjectByProperty('isSkinnedMesh', true);
const nativeMounted = prepareCavalryTemplate(mountedAssets), nativeHorse = nativeMounted.horses.red;
const nativeRider = nativeMounted.rider, horseSkin = skinOf(nativeHorse.root), riderSkin = skinOf(nativeRider.root);
const horseMixer = new THREE.AnimationMixer(nativeHorse.root), riderMixer = new THREE.AnimationMixer(nativeRider.root);
const mountedUnit = new THREE.Group(); mountedUnit.position.set(-7, 2.3, 9); mountedUnit.rotation.y = .71; mountedUnit.add(nativeHorse.assembly);
mountedUnit.updateMatrixWorld(true);
function nativePose(mixer, atlas, p) {
    mixer.stopAllAction();
    const combined = new Map();
    // Reference times are the requested seconds, independent of clipSample's frame
    // mapping. This catches shortened final intervals, wrap and clamp mistakes.
    for (const { name, seconds, weight } of p.reference) {
        if (!weight) continue;
        const meta = atlas.clips.get(name);
        const time = meta.loop ? ((seconds % meta.duration) + meta.duration) % meta.duration
            : THREE.MathUtils.clamp(seconds, 0, meta.duration);
        const previous = combined.get(name);
        if (previous) previous.weight += weight;
        else combined.set(name, { meta, time, weight });
    }
    for (const { meta, time, weight } of combined.values()) {
        const action = mixer.clipAction(meta.clip).reset().setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true; action.setEffectiveWeight(weight).play(); action.time = time;
    }
    mixer.update(0);
}
const single = (atlas, name, time) => { const b = clipSample(atlas.clips.get(name), time); return { a: b, b, blend: 1, reference: [{ name, seconds: time, weight: 1 }] }; };
function riderPrefix(horse, hp) {
    return mountedUnit.matrixWorld.clone().multiply(horse.rootMatrix).multiply(sampleMount(horse.atlas, hp))
        .multiply(horse.saddleMatrix).multiply(horse.riderMatrix);
}

globalTest('cavalry assets: 50/34 bones, rider-only tracks, three meshes and verified shared horse atlas', t => {
    assert.equal(cavalry.horses.red.atlas.boneCount, 50); assert.equal(cavalry.rider.atlas.boneCount, 34);
    assert.equal(cavalry.rider.atlas.geometry.attributes.position.count, 7519);
    assert.equal(cavalry.diagnostics.sharedHorseAtlas, true);
    assert.equal(cavalry.horses.red.atlas, cavalry.horses.blue.atlas);
    assert.ok(cavalry.horses.red.atlas.mountData instanceof Float32Array);
    assert.equal(cavalry.group.children.filter(o => o.isInstancedMesh && o.name !== 'SpikeContactShadows').length, 3);
    assert.ok(nativeRider.clips.every(c => c.tracks.every(track => !/Horse|Torso|Leg|Tail/.test(track.name))));
    t.diagnostic(JSON.stringify({ sharedHorseAtlas: cavalry.diagnostics.sharedHorseAtlas, horse: [...cavalry.horses.red.atlas.clips.values()].map(({ name, duration }) => ({ name, duration })), rider: [...cavalry.rider.atlas.clips.values()].map(({ name, duration }) => ({ name, duration })) }));
});

for (const channel of ['horse', 'rider']) for (const meta of (channel === 'horse' ? cavalry.horses.red.atlas : cavalry.rider.atlas).clips.values()) {
    globalTest(`mounted ${channel} ${meta.name}: native hierarchy world vertices/normals`, t => {
        const atlas = channel === 'horse' ? cavalry.horses.red.atlas : cavalry.rider.atlas, skin = channel === 'horse' ? horseSkin : riderSkin;
        const samples = [0, .0173, .1731 * meta.duration, .4137 * meta.duration, .7319 * meta.duration,
            meta.duration - 1 / 240, meta.duration - .0001, meta.duration, meta.duration + .0001];
        // Scan native local bone excursions over the whole clip for its turning region.
        const mixer = channel === 'horse' ? horseMixer : riderMixer;
        let peak = 0, peakStep = -1, excursion = -1;
        const steps = Math.ceil(meta.duration * 240);
        nativePose(mixer, atlas, single(atlas, meta.name, 0)); mountedUnit.updateMatrixWorld(true);
        const rest = skin.skeleton.bones.map(b => b.getWorldPosition(new THREE.Vector3()));
        for (let step = 0; step <= steps; step++) {
            const time = Math.min(step / 240, meta.duration);
            nativePose(mixer, atlas, single(atlas, meta.name, time)); mountedUnit.updateMatrixWorld(true);
            const distance = skin.skeleton.bones.reduce((n, b, i) => n + b.getWorldPosition(new THREE.Vector3()).distanceToSquared(rest[i]), 0);
            if (distance > excursion) { excursion = distance; peak = time; peakStep = step; }
        }
        if (['Attack', 'Hit', 'Death'].includes(meta.name)) {
            assert.ok(peakStep > 0 && peakStep < steps, `${channel} ${meta.name} peak must be interior: ${peak}/${meta.duration}`);
        }
        // Walk/Charge are cyclic gaits: total bone excursion from t=0 can peak
        // at a clip boundary, so an endpoint does not invalidate their scan.
        const endpointExemption = ['Walk', 'Charge'].includes(meta.name) && (peakStep === 0 || peakStep === steps)
            ? 'cyclic gait excursion from the initial pose may peak at the clip boundary' : undefined;
        samples.push(Math.max(0, peak - 1 / 240), peak, Math.min(meta.duration, peak + .0031));
        let maxError = 0, maxAngle = 0, errorTime = 0;
        const geom = skin.geometry, p = new THREE.Vector3(), q = new THREE.Vector3(), n = new THREE.Vector3(), gn = new THREE.Vector3();
        for (const time of samples) {
            const hp = single(cavalry.horses.red.atlas, channel === 'horse' ? meta.name : 'Gallop', time);
            const rp = single(cavalry.rider.atlas, channel === 'rider' ? meta.name : 'Idle', time);
            nativePose(horseMixer, cavalry.horses.red.atlas, hp); nativePose(riderMixer, cavalry.rider.atlas, rp); mountedUnit.updateMatrixWorld(true);
            const instance = channel === 'horse' ? mountedUnit.matrixWorld.clone().multiply(cavalry.horses.red.modelMatrix)
                : riderPrefix(cavalry.horses.red, hp).multiply(atlas.meshInRoot);
            const bones = Array.from({ length: atlas.boneCount }, (_, b) => sampleBone(atlas, (channel === 'horse' ? hp : rp).b, b));
            const nativeBones = skin.skeleton.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skin.skeleton.boneInverses[i]));
            const gpuSkin = new THREE.Matrix4(), nativeSkin = new THREE.Matrix4();
            const nm = new THREE.Matrix3().getNormalMatrix(skin.matrixWorld), gm = new THREE.Matrix3().getNormalMatrix(instance);
            for (let v = 0; v < geom.attributes.position.count; v++) {
                gpuSkin.elements.fill(0); nativeSkin.elements.fill(0);
                for (let k = 0; k < 4; k++) {
                    const b = geom.attributes.skinIndex.getComponent(v, k), w = geom.attributes.skinWeight.getComponent(v, k);
                    for (let e = 0; e < 16; e++) { gpuSkin.elements[e] += bones[b].elements[e] * w; nativeSkin.elements[e] += nativeBones[b].elements[e] * w; }
                }
                gpuSkin.premultiply(atlas.bindMatrixInverse).multiply(atlas.bindMatrix);
                nativeSkin.premultiply(skin.bindMatrixInverse).multiply(skin.bindMatrix);
                skin.getVertexPosition(v, p).applyMatrix4(skin.matrixWorld);
                q.fromBufferAttribute(geom.attributes.position, v).applyMatrix4(gpuSkin).applyMatrix4(instance);
                const error = p.distanceTo(q); if (error > maxError) { maxError = error; errorTime = time; }
                n.fromBufferAttribute(geom.attributes.normal, v).applyMatrix3(new THREE.Matrix3().setFromMatrix4(nativeSkin)).applyMatrix3(nm).normalize();
                gn.fromBufferAttribute(geom.attributes.normal, v).applyMatrix3(new THREE.Matrix3().setFromMatrix4(gpuSkin)).applyMatrix3(gm).normalize();
                maxAngle = Math.max(maxAngle, THREE.MathUtils.radToDeg(n.angleTo(gn)));
            }
        }
        t.diagnostic(JSON.stringify({ channel, name: meta.name, samples: samples.length, peak, peakStep, steps, endpointExemption, maxError, errorTime, maxAngle }));
        assert.ok(maxError < .01, `position ${maxError} at ${errorTime}`); assert.ok(maxAngle < 2, `normal ${maxAngle}`);
    });
}

for (const team of ['red', 'blue']) globalTest(`mounted ${team} Hips: displayed-horse consistency, steady native accuracy and fade native report`, async t => {
    const nativeMounted = prepareCavalryTemplate(mountedAssets), nativeHorse = nativeMounted.horses[team];
    const nativeRider = { root: nativeHorse.assembly.getObjectByName('BattleSaddle').children[0].children[0] };
    const riderSkin = skinOf(nativeRider.root);
    const horseMixer = new THREE.AnimationMixer(nativeHorse.root), riderMixer = new THREE.AnimationMixer(nativeRider.root);
    const mountedUnit = new THREE.Group(); mountedUnit.position.set(-7, 2.3, 9); mountedUnit.rotation.y = .71;
    mountedUnit.add(nativeHorse.assembly); mountedUnit.updateMatrixWorld(true);
    const horse = cavalry.horses[team], ha = horse.atlas, ra = cavalry.rider.atlas;
    const hips = riderSkin.skeleton.bones.findIndex(b => b.name === 'Hips');
    const inverseBind = riderSkin.skeleton.boneInverses[hips].clone().invert();
    const mountBone = ha.boneNames.indexOf(nativeHorse.mountBone.name);
    assert.ok(mountBone >= 0, 'saddle parent must be a GPU horse bone');
    const mountBind = ha.boneInverses[mountBone].clone().invert();
    const consistency = { samples: 0, maxError: 0, at: null };
    const steadyNative = { samples: 0, maxError: 0, at: null };
    const fadeNative = { samples: 0, maxError: 0, at: null };
    function record(result, actual, expected, label, time) {
        const error = actual.distanceTo(expected);
        assert.ok(Number.isFinite(error), `non-finite Hips error: ${label} at ${time}`);
        result.samples++;
        if (result.at === null || error > result.maxError) {
            result.maxError = error; result.at = { label, time };
        }
    }
    function blendedBone(atlas, p, bone) {
        const a = sampleBone(atlas, p.a, bone), b = sampleBone(atlas, p.b, bone);
        for (let i = 0; i < 16; i++) a.elements[i] = a.elements[i] * (1 - p.blend) + b.elements[i] * p.blend;
        return a;
    }
    function compare(hp, rp, label, time) {
        nativePose(horseMixer, ha, hp); nativePose(riderMixer, ra, rp); mountedUnit.updateMatrixWorld(true);
        const nativeHips = nativeRider.root.getObjectByName('Hips').getWorldPosition(new THREE.Vector3());
        const localHips = new THREE.Vector3().setFromMatrixPosition(blendedBone(ra, rp, hips).multiply(inverseBind));
        const actual = localHips.clone().applyMatrix4(riderPrefix(horse, hp));
        // Independently reconstruct the displayed horse's saddle from its shader
        // skin matrices, using the SAME descriptors, frame lerps and fade weight.
        // Do not use sampleMount here: its rigid-frame correction is under test.
        const displayedSaddle = mountedUnit.matrixWorld.clone().multiply(horse.rootMatrix)
            .multiply(blendedBone(ha, hp, mountBone).multiply(mountBind)).multiply(horse.saddleMatrix);
        const expected = localHips.clone().applyMatrix4(horse.riderMatrix).applyMatrix4(displayedSaddle);
        record(consistency, actual, expected, label, time);
        const fading = (hp.blend > 0 && hp.blend < 1) || (rp.blend > 0 && rp.blend < 1);
        record(fading ? fadeNative : steadyNative, actual, nativeHips, label, time);
    }
    const combinations = [...ha.clips.keys()].flatMap(h => [...ra.clips.keys()].map(r => [h, r]));
    for (const [h, r] of combinations) {
        const duration = Math.max(ha.clips.get(h).duration, ra.clips.get(r).duration);
        for (let step = 0; step <= Math.ceil(duration * 120); step++) {
            const time = step / 120; compare(single(ha, h, time), single(ra, r, time), `${h}/${r}`, time);
        }
    }
    function fade(atlas, from, to, time) {
        if (from === to) return single(atlas, to, .371 + time);
        return { a: clipSample(atlas.clips.get(from), .371 + time), b: clipSample(atlas.clips.get(to), time), blend: time / .15,
            reference: [{ name: from, seconds: .371 + time, weight: 1 - time / .15 }, { name: to, seconds: time, weight: time / .15 }] };
    }
    const excluded = [];
    let reachableTransitions = 0;
    for (const [h0, r0] of combinations) for (const [h1, r1] of combinations) {
        const label = `${h0}/${r0}->${h1}/${r1}`;
        // Death is terminal for the entire mounted unit: neither channel can
        // change once either source channel is Death. Identical states stay valid.
        if ((h0 === 'Death' || r0 === 'Death') && (h0 !== h1 || r0 !== r1)) {
            excluded.push(label); continue;
        }
        reachableTransitions++;
        for (let step = 0; step <= 18; step++) {
            const time = step / 120;
            compare(fade(ha, h0, h1, time), fade(ra, r0, r1, time), label, time);
        }
    }
    t.diagnostic(JSON.stringify({ combinations: combinations.length, reachableTransitions, excludedCount: excluded.length, excluded }));
    await t.test('consistency with displayed horse: Hips < 0.02 m', t => {
        t.diagnostic(JSON.stringify(consistency));
        assert.ok(consistency.maxError < .02, `Hips ${consistency.maxError}: ${JSON.stringify(consistency.at)}`);
    });
    await t.test('steady poses vs native hierarchy: Hips < 0.02 m', t => {
        t.diagnostic(JSON.stringify(steadyNative));
        assert.ok(steadyNative.maxError < .02, `Hips ${steadyNative.maxError}: ${JSON.stringify(steadyNative.at)}`);
    });
    await t.test('fade poses vs native hierarchy: report only', t => {
        t.diagnostic(JSON.stringify(fadeNative));
        assert.ok(fadeNative.samples > 0, 'reachable fades must be scanned');
    });
});

globalTest('mount baking rejects scaled bones and facade falls back as a whole', async t => {
    const options = mixedFixture(), template = options.prepared.templates.get('gpu-cavalry');
    const horse = template.horses.blue;
    const idle = horse.clips.find(c => c.name === 'Idle');
    idle.tracks.push(new THREE.VectorKeyframeTrack(`${horse.mountBone.name}.scale`, [0, idle.duration], [1.02, 1, 1, 1.02, 1, 1]));
    assert.throws(() => bakeAnimations(horse), /GPU mount scale must be unit: Idle frame 0 column 0/);
    const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
    const facade = await createModelFacade(options);
    assert.equal(facade.gpuCrowds, undefined);
    assert.equal(facade.live.size, 8);
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /整体退回旧模型路径/);
    t.diagnostic('injected mount scale=1.02 rejected; whole-facade legacy fallback observed');
});

globalTest('mounted runtime wiring: horse batch descriptors drive rider matrices in steady, fade and snapshot poses', t => {
    const options = mixedFixture(), units = options.units.filter(u => u.type === 'cavalry');
    const crowd = createGpuCavalry({ ...options, units, template: options.prepared.templates.get('gpu-cavalry') });
    const maxima = {};
    try {
        function check(label, now) {
            crowd.update(now, 60);
            let maxError = 0;
            for (const [riderSlot, u] of units.entries()) {
                const horse = crowd.horses[u.team], mesh = horse.batch.mesh, attrs = mesh.geometry.attributes;
                const a = [attrs.aClipA.getX(0), attrs.aClipA.getY(0), attrs.aClipA.getZ(0)];
                const b = [attrs.aClipB.getX(0), attrs.aClipB.getY(0), attrs.aClipB.getZ(0)];
                const blend = attrs.aBlend.getX(0);
                if (label === 'steady') assert.equal(blend, 1);
                else assert.ok(blend > 0 && blend < 1, `${label} must be inside a fade`);
                if (label === 'snapshot') { assert.ok(a[0] >= horse.atlas.rows); assert.equal(a[1], 1); }
                else assert.ok(a[0] < horse.atlas.rows);
                // Read the actual uploaded descriptors. Rebuild the frame directly
                // from CPU rows, without animation.parameters or sampleMount.
                function frame(d) {
                    const i = Math.floor(d[2]), j = Math.min(i + 1, d[1] - 1), f = d[2] - i;
                    return Array.from({ length: 16 }, (_, k) =>
                        horse.atlas.mountData[(d[0] + i) * 16 + k] * (1 - f) + horse.atlas.mountData[(d[0] + j) * 16 + k] * f);
                }
                const fa = frame(a), fb = frame(b);
                const mount = new THREE.Matrix4().fromArray(fa.map((v, k) => v * (1 - blend) + fb[k] * blend));
                const x = new THREE.Vector3().setFromMatrixColumn(mount, 0).normalize();
                const y = new THREE.Vector3().setFromMatrixColumn(mount, 1);
                y.addScaledVector(x, -y.dot(x)).normalize();
                const z = new THREE.Vector3().crossVectors(x, y).normalize();
                x.toArray(mount.elements, 0); y.toArray(mount.elements, 4); z.toArray(mount.elements, 8);
                const expected = new THREE.Matrix4(); mesh.getMatrixAt(0, expected);
                expected.multiply(horse.modelMatrix.clone().invert()).multiply(horse.rootMatrix).multiply(mount)
                    .multiply(horse.saddleMatrix).multiply(horse.riderMatrix).multiply(crowd.rider.atlas.meshInRoot);
                const actual = new THREE.Matrix4(); crowd.mesh.getMatrixAt(riderSlot, actual);
                maxError = Math.max(maxError, ...actual.elements.map((v, k) => Math.abs(v - expected.elements[k])));
            }
            maxima[label] = maxError;
            assert.ok(maxError < 1e-5, `${label} runtime rider matrix error ${maxError}`);
        }
        check('steady', 200);
        for (const u of units) { u.hp--; crowd.sync(u, .71, 300); }
        check('fade', 350);
        for (const u of units) { u.hp--; crowd.sync(u, .71, 380); }
        check('snapshot', 400);
        t.diagnostic(JSON.stringify({ maxMatrixElementError: maxima }));
    } finally { crowd.dispose(); }
});

globalTest('cavalry shared events, charge threshold, snapshots, pause and individual corpse endBase', () => {
    const options = mixedFixture(), u = options.units.find(u => u.type === 'cavalry'), v = options.units.at(-1);
    const crowd = createGpuCavalry({ ...options, template: options.prepared.templates.get('gpu-cavalry'), units: [u, v] });
    const e = crowd.live.get(u.id);
    u.moving = true; u.state = 'charge'; crowd.sync(u, .4, 100); crowd.update(100, 60);
    assert.equal(e.animation.state.name, 'Charge'); assert.equal(e.horseAnimation.state.name, 'Gallop');
    u.state = 'idle'; u.velX = 4.6; crowd.sync(u, .4, 200); crowd.update(200, 60); assert.equal(e.animation.state.name, 'Charge');
    u._lungeUntil = -1; crowd.sync(u, .4, 300); assert.equal(e.animation.state.name, 'Attack'); assert.equal(e.horseAnimation.state.name, 'Gallop');
    u.hp--; crowd.sync(u, .4, 340); assert.equal(e.animation.state.name, 'Hit'); assert.equal(e.horseAnimation.state.name, 'Idle_HitReact1');
    const hp = e.horseAnimation.parameters(.38), expected = sampleMount(crowd.horses[u.team].atlas, hp, new THREE.Matrix4(), false);
    u.hp--; crowd.sync(u, .4, 380);
    const snapshot = sampleMount(crowd.horses[u.team].atlas, e.horseAnimation.parameters(.38), new THREE.Matrix4(), false);
    snapshot.elements.forEach((x, i) => assert.ok(Math.abs(x - expected.elements[i]) < 1e-5));
    crowd.kill(u, .4, 400); crowd.update(400, 60, { dt: .2, battleOver: true });
    const matrices = crowd.mesh.instanceMatrix.array.slice(); crowd.update(400, 60, { dt: 1, paused: true, battleOver: true });
    assert.deepEqual(crowd.mesh.instanceMatrix.array, matrices);
    crowd.kill(v, .4, 400); assert.equal(crowd.dead[1].endBase, .2);
    crowd.update(400, 60, { dt: 5, battleOver: true });
    for (const entry of crowd.dead) {
        assert.equal(entry.animation.state.name, 'Death'); assert.equal(entry.horseAnimation.state.name, 'Death');
    }
    assert.equal(crowd.mesh.geometry.attributes.aClipB.getZ(0), crowd.atlas.clips.get('Death').frames - 1);
    assert.equal(crowd.horses[u.team].batch.mesh.geometry.attributes.aClipB.getZ(0), crowd.horses[u.team].atlas.clips.get('Death').frames - 1);
    assert.equal(crowd.diagnostics.modelDrawCalls, 3); assert.equal(crowd.diagnostics.resurrections, 0);
    crowd.dispose();
});


for (const stage of ['initialization', 'preparation']) globalTest(`GPU ${stage} fallback reuses the six parsed GLTF assets without another loader call`, async t => {
    const options = mixedFixture(); delete options.prepared;
    let loads = 0;
    t.mock.method(GLTFLoader.prototype, 'loadAsync', async url => {
        loads++;
        if (url.endsWith('/Horse.gltf')) return mountedAssets.horse;
        if (url.endsWith('/Horse_White.gltf')) return mountedAssets.white;
        if (url.endsWith('/cavalry-rigged.glb')) return mountedAssets.rider;
        for (const [kind, path] of Object.entries(paths)) if (url.endsWith(`/${path.split('/').at(-1)}-rigged.glb`)) return assets.get(kind);
        throw new Error(`unexpected download: ${url}`);
    });
    const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
    if (stage === 'preparation') {
        const scene = assets.get('infantry').scene, original = scene.clone;
        let injected = false;
        t.mock.method(scene, 'clone', function (...args) {
            if (!injected) { injected = true; throw new Error('injected GPU template preparation failure'); }
            return original.apply(this, args);
        });
    }
    const renderer = { capabilities: { isWebGL2: false }, getContext: () => ({}) };
    const fallback = await createModelFacade({ ...options, renderer });
    assert.equal(loads, 6, 'whole-facade fallback must not download GLTFs twice');
    assert.equal(fallback.gpuCrowds, undefined);
    assert.equal(fallback.live.size, 8);
    assert.equal(fallback.pools.size, 8, 'missing legacy templates are rebuilt from the parsed assets');
    assert.equal(errors.length, 1);
    if (stage === 'preparation') assert.match(errors[0][1].message, /injected GPU template preparation failure/);
});

globalTest('crowd shader evaluates only the selected endpoint pose and blends interior poses', () => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader };
    const material = createCrowdMaterial(cavalry.rider.atlas, { red: 0xc4553f, blue: 0x7fb0e0 });
    try {
        material.onBeforeCompile(shader);
        const body = shader.vertexShader.slice(shader.vertexShader.indexOf('mat4 crowdMixedPose;'),
            shader.vertexShader.indexOf('mat4 crowdSkin =')).replace('mat4 crowdMixedPose;', 'let crowdMixedPose;');
        // Execute the shader's branch itself with scalar stand-ins for the matrices.
        // This also checks that the unused pose is never evaluated at an endpoint.
        for (const blend of [0, .0005, .001, .0011, .5, .9989, .999, .9995, 1]) {
            const calls = [];
            const result = runInNewContext(`${body}\ncrowdMixedPose`, {
                aBlend: blend, aClipA: 'A', aClipB: 'B',
                crowdPose(clip) { calls.push(clip); return clip === 'A' ? 2 : 6; }
            });
            assert.equal(result, blend >= .999 ? 6 : blend <= .001 ? 2 : 2 * (1 - blend) + 6 * blend);
            assert.deepEqual(calls, blend >= .999 ? ['B'] : blend <= .001 ? ['A'] : ['A', 'B']);
        }
    } finally { material.dispose(); }
});

for (const kind of [...assets.keys(), 'cavalry']) globalTest(`${kind} shader failure identifies the GPU kind`, async t => {
    const options = mixedFixture(); options.cap = { [kind]: 2 }; options.units = options.units.filter(u => u.type === kind);
    const renderer = { capabilities: { isWebGL2: true, maxTextureSize: 16384 },
        getContext: () => ({ MAX_VERTEX_TEXTURE_IMAGE_UNITS: 1, NO_ERROR: 0, getParameter: () => 16, getError: () => 0 }),
        initTexture() {}, debug: {}, compile() { this.debug.onShaderError(); },
        properties: { get: () => ({ currentProgram: { getUniforms() {} } }) } };
    const errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
    const fallback = await createModelFacade({ ...options, renderer });
    assert.equal(fallback.gpuCrowds, undefined);
    assert.equal(errors[0][1].message, `GPU ${kind} shader compilation failed`);
    assert.equal(renderer.debug.onShaderError, undefined);
});

globalTest('all GPU kinds keep living loops moving after battleOver, reuse descriptors and freeze on pause', async () => {
    const options = mixedFixture(), facade = await createModelFacade(options);
    for (const u of options.units) { u.moving = true; facade.sync(u, .4, 0, 1000); }
    facade.update(1000, 60);
    const records = [];
    for (const crowd of facade.gpuCrowds.values()) {
        const entry = crowd.live.values().next().value;
        for (const animation of [entry.animation, entry.horseAnimation].filter(Boolean)) {
            const p = animation.parameters(1);
            records.push({ animation, p, a: p.a, b: p.b });
        }
    }
    const meshes = [...facade.gpuCrowds.values()].flatMap(crowd => crowd.horses
        ? [crowd.mesh, crowd.horses.red.batch.mesh, crowd.horses.blue.batch.mesh] : [crowd.mesh]);
    const before = meshes.map(mesh => mesh.geometry.attributes.aClipB.array.slice());
    facade.update(1000, 60, { dt: .137, battleOver: true });
    meshes.forEach((mesh, i) => assert.notDeepEqual(mesh.geometry.attributes.aClipB.array, before[i], mesh.name));
    for (const { animation, p, a, b } of records) {
        assert.equal(animation.parameters(1.137), p);
        assert.equal(p.a, a); assert.equal(p.b, b);
        assert.ok(['Walk', 'Charge', 'Gallop'].includes(animation.state.name));
    }
    const frozen = meshes.map(mesh => ({ matrix: mesh.instanceMatrix.array.slice(),
        a: mesh.geometry.attributes.aClipA.array.slice(), b: mesh.geometry.attributes.aClipB.array.slice(),
        blend: mesh.geometry.attributes.aBlend.array.slice() }));
    facade.update(1000, 60, { dt: 1, battleOver: true, paused: true });
    meshes.forEach((mesh, i) => {
        assert.deepEqual(mesh.instanceMatrix.array, frozen[i].matrix);
        assert.deepEqual(mesh.geometry.attributes.aClipA.array, frozen[i].a);
        assert.deepEqual(mesh.geometry.attributes.aClipB.array, frozen[i].b);
        assert.deepEqual(mesh.geometry.attributes.aBlend.array, frozen[i].blend);
    });
    facade.update(1000, 60, { dt: .131, battleOver: true });
    meshes.forEach((mesh, i) => assert.notDeepEqual(mesh.geometry.attributes.aClipB.array, frozen[i].b));
    for (const crowd of facade.gpuCrowds.values()) crowd.dispose();
});

globalTest('legacy models also advance living loops after battleOver and freeze while paused', async () => {
    const options = mixedFixture(), facade = await createModelFacade({ ...options, gpu: false });
    facade.update(1000, 60);
    const entry = facade.live.values().next().value, time = entry.visual.mixer.time;
    facade.update(1000, 60, { dt: .2, battleOver: true });
    assert.ok(Math.abs(entry.visual.mixer.time - time - .2) < 1e-9);
    const frozen = entry.visual.mixer.time;
    facade.update(1000, 60, { dt: 1, battleOver: true, paused: true });
    assert.equal(entry.visual.mixer.time, frozen);
});

globalTest('perfRun samples completed frames, simulation advance and existing speed controls', async () => {
    const source = await readFile(new URL('../js/three-spike/main.js', import.meta.url), 'utf8');
    const hook = source.slice(source.indexOf('const perfRuns = new Set();'), source.indexOf('// ---------------- 主循环 ----------------'));
    let now = 1000, timer, clicked;
    const scene = { simulationTime: 1000, redAlive: 3, blueAlive: 4, gameSpeed: 1 };
    const renderer = { info: { render: { calls: 6 } } };
    const api = runInNewContext(`${hook}\n({ perfRun, recordPerfFrame, perfRuns })`, {
        performance: { now: () => now }, scene, renderer,
        $: id => ({ click() { clicked = id; scene.gameSpeed = Number(id.at(-1)); } }),
        setTimeout(fn, delay) { timer = { fn, delay }; }
    });
    await assert.rejects(api.perfRun({ seconds: 0 }), /seconds/);
    await assert.rejects(api.perfRun({ seconds: 1, speed: 3 }), /speed/);
    const pending = api.perfRun({ seconds: .1, speed: 2 });
    assert.equal(clicked, 'btn-s2'); assert.equal(scene.gameSpeed, 2); assert.equal(timer.delay, 100);
    for (const time of [1010, 1020, 1080, 1100]) { now = time; api.recordPerfFrame(now); }
    scene.simulationTime += 200; timer.fn();
    const result = await pending;
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { fps: 40, p50FrameMs: 10, p95FrameMs: 60,
        longFrames: 1, simAdvance: .2, wallSeconds: .1, ratio: 2, calls: 6, alive: { red: 3, blue: 4 } });
    assert.equal(api.perfRuns.size, 0);
    const empty = api.perfRun({ seconds: .1 }); now += 100; timer.fn();
    const idle = await empty;
    assert.equal(idle.fps, 0); assert.equal(idle.p95FrameMs, 0); assert.equal(idle.simAdvance, 0);
    assert.match(source, /if \(perfRuns.size\) recordPerfFrame\(performance.now\(\)\)/);
    assert.match(source, /window\.__spike = \{ perfRun,/);
});
