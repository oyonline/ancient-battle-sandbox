import * as THREE from 'three';
import { contactShadows } from './model-skin.js';

export const SAMPLE_HZ = 120;
export const FADE_SECONDS = .15;
const CLIPS = ['Idle', 'Walk', 'Attack', 'Hit', 'Death'];
const ONCE = new Set(['Attack', 'Hit', 'Death']);
const ATTRIBUTES = ['aClipA', 'aClipB', 'aBlend', 'aTeam'];
const TEAMS = ['red', 'blue'];
const EMPTY_PRESENTATION = Object.freeze({});

// One RGBA row per pose, four texels per bone. S is relative to the holder,
// before its normalization scale; instanceMatrix restores the full mesh world pose.
export function bakeAnimations(template, snapshotRows = 0) {
    const { root } = template;
    root.updateMatrixWorld(true);
    let skin;
    root.traverse(o => { if (o.isSkinnedMesh && !skin) skin = o; });
    if (!skin) throw new Error('GPU template requires a SkinnedMesh');
    const width = skin.skeleton.bones.length * 4, clips = new Map();
    let rows = 0;
    for (const name of template.clipNames || CLIPS) {
        const clip = template.clips.find(c => c.name === name);
        if (!clip?.tracks.length || !(clip.duration > 0)) throw new Error(`GPU missing clip ${name}`);
        const frames = Math.ceil(clip.duration * SAMPLE_HZ) + 1;
        clips.set(name, { name, start: rows, frames, duration: clip.duration, loop: !(template.once || ONCE).has(name), clip });
        rows += frames;
    }
    const modelMatrix = skin.matrixWorld.clone();
    const rootInverse = root.matrixWorld.clone().invert();
    const meshInRoot = rootInverse.clone().multiply(modelMatrix);
    const data = new Float32Array(width * (rows + snapshotRows) * 4);
    // Bone world transform in horse model-root space, explicitly NOT inverse-bind S.
    const mountData = template.mountBone ? new Float32Array((rows + snapshotRows) * 16) : null;
    const mixer = new THREE.AnimationMixer(root), matrix = new THREE.Matrix4();
    for (const meta of clips.values()) {
        mixer.stopAllAction();
        const action = mixer.clipAction(meta.clip).reset().setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true; action.play();
        for (let frame = 0; frame < meta.frames; frame++) {
            mixer.setTime(Math.min(frame / SAMPLE_HZ, meta.duration));
            root.updateMatrixWorld(true);
            if (mountData) {
                matrix.multiplyMatrices(rootInverse, template.mountBone.matrixWorld);
                // sampleMount restores a rigid frame; scaled mount bones would lose
                // intentional scale there, so reject the atlas and use facade fallback.
                const e = matrix.elements;
                for (const column of [0, 4, 8]) {
                    const length = Math.hypot(e[column], e[column + 1], e[column + 2]);
                    if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-3) {
                        mixer.stopAllAction(); mixer.uncacheRoot(root);
                        throw new Error(`GPU mount scale must be unit: ${meta.name} frame ${frame} column ${column / 4}: ${length}`);
                    }
                }
                matrix.toArray(mountData, (meta.start + frame) * 16);
            }
            for (let bone = 0; bone < skin.skeleton.bones.length; bone++) {
                matrix.multiplyMatrices(rootInverse, skin.skeleton.bones[bone].matrixWorld)
                    .multiply(skin.skeleton.boneInverses[bone]);
                matrix.toArray(data, ((meta.start + frame) * width + bone * 4) * 4);
            }
        }
    }
    mixer.stopAllAction(); mixer.uncacheRoot(root);
    const texture = new THREE.DataTexture(data.slice(), width, rows + snapshotRows, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false; texture.needsUpdate = true;
    return { data, mountData, boneNames: skin.skeleton.bones.map(b => b.name),
        boneInverses: skin.skeleton.boneInverses.map(m => m.clone()), rootMatrix: root.matrixWorld.clone(), meshInRoot: meshInRoot.clone(), texture, width, rows, clips, boneCount: skin.skeleton.bones.length,
        geometry: skin.geometry, modelMatrix, bindMatrix: skin.bindMatrix.clone(), bindMatrixInverse: meshInRoot.invert() };
}

// Attribute time is in fractional sample-frame units. The shortened final interval
// is mapped here, so both CPU snapshots and GLSL interpolate the very same frames.
export function clipSample(meta, seconds, target = [0, 0, 0]) {
    const time = meta.loop ? ((seconds % meta.duration) + meta.duration) % meta.duration
        : THREE.MathUtils.clamp(seconds, 0, meta.duration);
    const penultimate = meta.frames - 2, finalStart = penultimate / SAMPLE_HZ;
    const frame = time >= finalStart
        ? penultimate + (time - finalStart) / (meta.duration - finalStart)
        : time * SAMPLE_HZ;
    target[0] = meta.start; target[1] = meta.frames; target[2] = Math.min(meta.frames - 1, Math.max(0, frame));
    return target;
}

export function sampleBone(atlas, sample, bone, target = new THREE.Matrix4()) {
    const frame = Math.floor(sample[2]), next = Math.min(frame + 1, sample[1] - 1), alpha = sample[2] - frame;
    const a = ((sample[0] + frame) * atlas.width + bone * 4) * 4;
    const b = ((sample[0] + next) * atlas.width + bone * 4) * 4;
    for (let i = 0; i < 16; i++) target.elements[i] = atlas.data[a + i] * (1 - alpha) + atlas.data[b + i] * alpha;
    return target;
}

export function createCrowdMaterial(atlas, teamColors) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    material.customProgramCacheKey = () => 'spike-gpu-crowd-v1';
    material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, {
            crowdAtlas: { value: atlas.texture }, crowdBind: { value: atlas.bindMatrix },
            crowdBindInverse: { value: atlas.bindMatrixInverse },
            crowdRed: { value: new THREE.Color(teamColors.red) }, crowdBlue: { value: new THREE.Color(teamColors.blue) }
        });
        shader.vertexShader = shader.vertexShader
            .replace('#include <skinning_pars_vertex>', `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute float clothMask;
attribute vec3 aClipA;
attribute vec3 aClipB;
attribute float aBlend;
attribute float aTeam;
uniform sampler2D crowdAtlas;
uniform mat4 crowdBind;
uniform mat4 crowdBindInverse;
uniform vec3 crowdRed;
uniform vec3 crowdBlue;
mat4 crowdBone(float bone, vec3 clip) {
    int x = int(bone) * 4;
    int f = int(floor(clip.z));
    int rowA = int(clip.x) + f;
    int rowB = int(clip.x) + min(f + 1, int(clip.y) - 1);
    float t = fract(clip.z);
    return mat4(
        mix(texelFetch(crowdAtlas, ivec2(x, rowA), 0), texelFetch(crowdAtlas, ivec2(x, rowB), 0), t),
        mix(texelFetch(crowdAtlas, ivec2(x+1, rowA), 0), texelFetch(crowdAtlas, ivec2(x+1, rowB), 0), t),
        mix(texelFetch(crowdAtlas, ivec2(x+2, rowA), 0), texelFetch(crowdAtlas, ivec2(x+2, rowB), 0), t),
        mix(texelFetch(crowdAtlas, ivec2(x+3, rowA), 0), texelFetch(crowdAtlas, ivec2(x+3, rowB), 0), t));
}
mat4 crowdPose(vec3 clip) {
    return skinWeight.x * crowdBone(skinIndex.x, clip)
         + skinWeight.y * crowdBone(skinIndex.y, clip)
         + skinWeight.z * crowdBone(skinIndex.z, clip)
         + skinWeight.w * crowdBone(skinIndex.w, clip);
}`)
            .replace('#include <color_vertex>', `#include <color_vertex>
    vColor.xyz = mix(vColor.xyz, mix(crowdRed, crowdBlue, aTeam), clothMask);`)
            .replace('#include <skinbase_vertex>', `
    mat4 crowdMixedPose;
    if (aBlend >= 0.999) crowdMixedPose = crowdPose(aClipB);
    else if (aBlend <= 0.001) crowdMixedPose = crowdPose(aClipA);
    else crowdMixedPose = crowdPose(aClipA) * (1.0 - aBlend) + crowdPose(aClipB) * aBlend;
    mat4 crowdSkin = crowdBindInverse * crowdMixedPose * crowdBind;`)
            .replace('#include <skinnormal_vertex>', 'objectNormal = (crowdSkin * vec4(objectNormal, 0.0)).xyz;')
            .replace('#include <skinning_vertex>', 'transformed = (crowdSkin * vec4(transformed, 1.0)).xyz;');
    };
    return material;
}

// No mixers or clones survive in this state machine. Interrupted fades use one
// reserved atlas row per slot to preserve the exact current mixed matrix pose.
export function createAnimationState(atlas, snapshotRow, time = 0, phase = 0, phaseIsFraction = false) {
    const state = { name: 'Idle', start: time, phase: phaseIsFraction ? phase * atlas.clips.get('Idle').duration : phase, previous: null, fadeStart: time, dead: false };
    const a = new THREE.Matrix4(), b = new THREE.Matrix4();
    // Descriptors are borrowed frame buffers; transitions copy persistent snapshots.
    const result = { a: [0, 0, 0], b: [0, 0, 0], blend: 1 };
    function sample(source, now, target) {
        if (!source.snapshot) return clipSample(atlas.clips.get(source.name), now - source.start + source.phase, target);
        target[0] = source.snapshot[0]; target[1] = source.snapshot[1]; target[2] = source.snapshot[2];
        return target;
    }
    function parameters(now) {
        sample(state, now, result.b);
        result.blend = state.previous ? THREE.MathUtils.clamp((now - state.fadeStart) / FADE_SECONDS, 0, 1) : 1;
        sample(state.previous && result.blend < 1 ? state.previous : state, now, result.a);
        return result;
    }
    function transition(name, now, force = false) {
        if (state.dead || (!force && state.name === name)) return;
        const p = parameters(now);
        let previous = { name: state.name, start: state.start, phase: state.phase };
        if (state.previous && p.blend === 0) {
            previous = { snapshot: p.a.slice() };
        } else if (state.previous && p.blend < 1) {
            for (let bone = 0; bone < atlas.boneCount; bone++) {
                sampleBone(atlas, p.a, bone, a); sampleBone(atlas, p.b, bone, b);
                const offset = (snapshotRow * atlas.width + bone * 4) * 4;
                for (let i = 0; i < 16; i++) atlas.data[offset + i] = a.elements[i] * (1 - p.blend) + b.elements[i] * p.blend;
            }
            if (atlas.mountData) {
                sampleMount(atlas, p, a, false).toArray(atlas.mountData, snapshotRow * 16);
            }
            const start = snapshotRow * atlas.width * 4, end = start + atlas.width * 4;
            atlas.texture.image.data.set(atlas.data.subarray(start, end), start);
            atlas.texture.addUpdateRange(start, atlas.width * 4);
            // r180 uploads only these ranges and clears them after upload.
            atlas.texture.needsUpdate = true;
            previous = { snapshot: [snapshotRow, 1, 0] };
        }
        state.previous = previous; state.name = name; state.start = now;
        state.phase = !atlas.clips.get(name).loop ? 0 : phaseIsFraction ? phase * atlas.clips.get(name).duration : phase;
        state.fadeStart = now; state.dead = name === 'Death';
    }
    function settle(now, moving) {
        if (state.dead) return;
        if (!atlas.clips.get(state.name).loop && now - state.start < atlas.clips.get(state.name).duration) return;
        transition(typeof moving === 'string' ? moving : moving ? 'Walk' : 'Idle', now);
    }
    return {
        state, parameters,
        update(now, moving) { settle(now, moving); return parameters(now); },
        event(name, now, moving = false) {
            settle(now, moving);
            if (state.dead || (name === 'Attack' && (state.name === 'Hit' || state.name === 'Attack'))) return;
            transition(name, now, true);
        }
    };
}

export function createGpuCrowd({ kind = 'infantry', template, scene, units, cap, teamColors, groundH, shadowsEnabled = true, renderer, camera }) {
    const capacity = cap[kind];
    if (!Number.isInteger(capacity) || capacity < 0 || units.length > capacity) throw new Error(`GPU ${kind} exceeds CAP`);
    let atlas, mesh, shadows, material, geometry;
    const label = kind[0].toUpperCase() + kind.slice(1);
    const group = new THREE.Group(); group.name = `SpikeGpu${label}`;
    try {
        atlas = bakeAnimations(template, capacity);
        geometry = atlas.geometry.clone(); material = createCrowdMaterial(atlas, teamColors);
        for (const [name, size] of [['aClipA', 3], ['aClipB', 3], ['aBlend', 1], ['aTeam', 1]]) {
            geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage));
        }
        mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.name = `SpikeGpu${label}Batch`; mesh.count = 0; mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); group.add(mesh);
        shadows = contactShadows(shadowsEnabled ? capacity : 0);
        shadows.visible = shadowsEnabled; group.add(shadows); scene.add(group);
        validateGpuBatch(atlas, mesh, { renderer, camera, scene }, kind, group);
    } catch (error) {
        group.removeFromParent(); atlas?.texture.dispose(); geometry?.dispose(); material?.dispose(); mesh?.dispose();
        if (shadows) { shadows.geometry.dispose(); shadows.material.map.dispose(); shadows.material.dispose(); shadows.dispose(); }
        throw error;
    }
    const live = new Map(), dead = [];
    const diagnostics = { active: 0, corpses: 0, resurrections: 0, drawCalls: 0,
        bakedRows: atlas.rows, atlasBytes: atlas.data.byteLength, frame: 0 };
    for (const [slot, u] of units.entries()) {
        live.set(u.id, { id: u.id, slot, team: u.team, hp: u.hp, lastLunge: u._lungeUntil || 0, moving: false,
            x: u.gx - 35, y: groundH(u.gx, u.gy), z: u.gy - 35, heading: u.team === 'red' ? Math.PI / 2 : -Math.PI / 2,
            animation: createAnimationState(atlas, atlas.rows + slot, 0, Math.random() * atlas.clips.get('Idle').duration) });
    }
    const transform = new THREE.Object3D(), matrix = new THREE.Matrix4();
    let endOffset = 0, cursor = 0, frameTime = 0;
    function write(e, corpse) {
        const p = e.animation.update(frameTime + endOffset - (corpse ? e.endBase : 0), e.moving);
        geometry.attributes.aClipA.setXYZ(cursor, p.a[0], p.a[1], p.a[2]); geometry.attributes.aClipB.setXYZ(cursor, p.b[0], p.b[1], p.b[2]);
        geometry.attributes.aBlend.setX(cursor, p.blend); geometry.attributes.aTeam.setX(cursor, e.team === 'blue' ? 1 : 0);
        transform.position.set(e.x, e.y, e.z); transform.rotation.set(0, e.heading, 0); transform.scale.setScalar(1); transform.updateMatrix();
        matrix.multiplyMatrices(transform.matrix, atlas.modelMatrix); mesh.setMatrixAt(cursor, matrix);
        if (shadowsEnabled) {
            transform.position.y += .02; transform.scale.set(.42, 1, .42); transform.updateMatrix();
            shadows.setMatrixAt(cursor, transform.matrix);
        }
        cursor++;
    }
    const countDrawCall = o => { if (o.isMesh && o.count > 0) diagnostics.drawCalls++; };
    return {
        kind, atlas, mesh, group, live, dead, diagnostics,
        dispose() {
            group.removeFromParent(); atlas.texture.dispose(); geometry.dispose(); material.dispose(); mesh.dispose();
            shadows.geometry.dispose(); shadows.material.map.dispose(); shadows.material.dispose(); shadows.dispose();
        },
        sync(u, heading, simulationTime) {
            const e = live.get(u.id);
            if (!e || u.dead || u.hp <= 0) return;
            const now = simulationTime / 1000;
            e.x = u.gx - 35; e.y = groundH(u.gx, u.gy); e.z = u.gy - 35; e.heading = heading; e.moving = !!u.moving;
            const hit = u.hp < e.hp, lunge = u._lungeUntil || 0, attack = lunge !== e.lastLunge && lunge !== 0;
            e.hp = u.hp; e.lastLunge = lunge;
            if (hit) e.animation.event('Hit', now, e.moving);
            else if (attack) e.animation.event('Attack', now, e.moving);
        },
        kill(u, heading, simulationTime) {
            const e = live.get(u.id);
            if (!e) return;
            live.delete(u.id); e.endBase = endOffset;
            e.x = u.gx - 35; e.y = groundH(u.gx, u.gy); e.z = u.gy - 35; e.heading = heading;
            e.animation.event('Death', simulationTime / 1000); dead.push(e);
        },
        update(simulationTime, fps, { dt = 0, paused = false, battleOver = false } = EMPTY_PRESENTATION) {
            if (battleOver && !paused) endOffset += dt;
            cursor = 0; frameTime = simulationTime / 1000;
            for (const e of live.values()) write(e, false);
            for (const e of dead) write(e, true);
            mesh.count = cursor; mesh.instanceMatrix.needsUpdate = true;
            for (const name of ATTRIBUTES) geometry.attributes[name].needsUpdate = true;
            shadows.count = shadowsEnabled ? cursor : 0; if (shadowsEnabled) shadows.instanceMatrix.needsUpdate = true;
            diagnostics.drawCalls = 0;
            group.traverseVisible(countDrawCall);
            diagnostics.active = live.size; diagnostics.corpses = dead.length; diagnostics.frame++;
        }
    };
}

const mountA = new THREE.Matrix4(), mountB = new THREE.Matrix4();
const mountX = new THREE.Vector3(), mountY = new THREE.Vector3(), mountZ = new THREE.Vector3();
function mountFrame(atlas, descriptor, target) {
    const frame = Math.floor(descriptor[2]), next = Math.min(frame + 1, descriptor[1] - 1), alpha = descriptor[2] - frame;
    const a = (descriptor[0] + frame) * 16, b = (descriptor[0] + next) * 16;
    for (let i = 0; i < 16; i++) target.elements[i] = atlas.mountData[a + i] * (1 - alpha) + atlas.mountData[b + i] * alpha;
    return target;
}
// Use the exact descriptors/blend sent to the horse shader, including snapshots.
// Rigid Torso2 has unit scale in these assets. Gram-Schmidt removes the shrink/shear
// of matrix interpolation during large Death/Hit fades; translation is untouched.
export function sampleMount(atlas, parameters, target = new THREE.Matrix4(), orthogonalize = true) {
    mountFrame(atlas, parameters.a, mountA); mountFrame(atlas, parameters.b, mountB);
    for (let i = 0; i < 16; i++) target.elements[i] = mountA.elements[i] * (1 - parameters.blend) + mountB.elements[i] * parameters.blend;
    if (orthogonalize) {
        mountX.setFromMatrixColumn(target, 0).normalize();
        mountY.setFromMatrixColumn(target, 1).addScaledVector(mountX, -mountY.dot(mountX)).normalize();
        mountZ.crossVectors(mountX, mountY).normalize();
        const e = target.elements;
        mountX.toArray(e, 0); mountY.toArray(e, 4); mountZ.toArray(e, 8);
    }
    return target;
}

// Keep capability, upload and deferred shader-link checks identical for every batch.
function validateGpuBatch(atlas, mesh, { renderer, camera, scene }, label, root = mesh) {
    if (!renderer) return;
    const gl = renderer.getContext();
    if (!renderer.capabilities.isWebGL2 || !gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) ||
        Math.max(atlas.width, atlas.texture.image.height) > renderer.capabilities.maxTextureSize) {
        throw new Error(`GPU ${label} float vertex atlas is unavailable`);
    }
    renderer.initTexture(atlas.texture);
    if (gl.getError() !== gl.NO_ERROR) throw new Error(`GPU ${label} float atlas upload failed`);
    let shaderError;
    const original = renderer.debug.onShaderError;
    renderer.debug.onShaderError = () => { shaderError = new Error(`GPU ${label} shader compilation failed`); };
    try {
        renderer.compile(root, camera, scene);
        // r180 defers link validation until first uniform/attribute access.
        renderer.properties.get(mesh.material).currentProgram.getUniforms();
    } finally { renderer.debug.onShaderError = original; }
    if (shaderError) throw shaderError;
}

function cavalryBatch(atlas, source, capacity, options, name) {
    const geometry = source.clone(), material = createCrowdMaterial(atlas, options.teamColors);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name; mesh.count = 0; mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const [key, size] of [['aClipA', 3], ['aClipB', 3], ['aBlend', 1], ['aTeam', 1]]) {
        geometry.setAttribute(key, new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage));
    }
    const dispose = () => { geometry.dispose(); material.dispose(); mesh.dispose(); };
    try {
        validateGpuBatch(atlas, mesh, options, 'cavalry');
    } catch (error) { dispose(); throw error; }
    return { mesh, dispose,
        write(slot, parameters, team, matrix) {
            geometry.attributes.aClipA.setXYZ(slot, parameters.a[0], parameters.a[1], parameters.a[2]); geometry.attributes.aClipB.setXYZ(slot, parameters.b[0], parameters.b[1], parameters.b[2]);
            geometry.attributes.aBlend.setX(slot, parameters.blend); geometry.attributes.aTeam.setX(slot, team === 'blue' ? 1 : 0);
            mesh.setMatrixAt(slot, matrix);
        },
        finish(count) {
            mesh.count = count; mesh.instanceMatrix.needsUpdate = true;
            for (const key of ATTRIBUTES) geometry.attributes[key].needsUpdate = true;
        }
    };
}

// Both horse variants have different geometry but identical joint transforms,
// inverse binds, tracks and normalization. Verify baked poses before sharing:
// an asset change automatically keeps separate atlases instead of assuming parity.
function sameHorseAtlas(a, b) {
    return a.boneCount === b.boneCount && a.rows === b.rows &&
        a.boneNames.every((name, i) => name === b.boneNames[i] && a.boneInverses[i].equals(b.boneInverses[i])) &&
        a.bindMatrix.equals(b.bindMatrix) && a.bindMatrixInverse.equals(b.bindMatrixInverse) &&
        [...a.clips.values()].every((meta, i) => {
            const other = [...b.clips.values()][i];
            return meta.name === other.name && meta.duration === other.duration && meta.frames === other.frames;
        }) && a.data.every((v, i) => v === b.data[i]) && a.mountData.every((v, i) => v === b.mountData[i]);
}

export function createGpuCavalry(options) {
    const { template, units, cap, groundH, scene, shadowsEnabled = true } = options, capacity = cap.cavalry;
    if (!Number.isInteger(capacity) || capacity < units.length || capacity < 0) throw new Error('GPU cavalry exceeds CAP');
    const group = new THREE.Group(); group.name = 'SpikeGpuCavalry';
    const atlases = new Set(), batches = [], horses = {};
    let rider, shadows;
    function dispose() {
        group.removeFromParent();
        for (const batch of batches) batch.dispose();
        for (const atlas of atlases) atlas.texture.dispose();
        if (shadows) { shadows.geometry.dispose(); shadows.material.map.dispose(); shadows.material.dispose(); shadows.dispose(); }
    }
    let sharedHorseAtlas = false;
    try {
        for (const team of TEAMS) {
            const source = template.horses[team];
            let atlas = bakeAnimations(source, capacity); atlases.add(atlas);
            const geometry = atlas.geometry, modelMatrix = atlas.modelMatrix.clone(), rootMatrix = atlas.rootMatrix.clone();
            if (team === 'blue' && sameHorseAtlas(horses.red.atlas, atlas)) {
                atlases.delete(atlas); atlas.texture.dispose(); atlas = horses.red.atlas; sharedHorseAtlas = true;
            }
            const batch = cavalryBatch(atlas, geometry, capacity, options, `SpikeGpuHorse-${team}`);
            batches.push(batch); group.add(batch.mesh);
            horses[team] = { atlas, batch, modelMatrix, rootMatrix, saddleMatrix: source.saddleMatrix, riderMatrix: source.riderMatrix };
        }
        const atlas = bakeAnimations(template.rider, capacity); atlases.add(atlas);
        const batch = cavalryBatch(atlas, atlas.geometry, capacity, options, 'SpikeGpuRider');
        batches.push(batch); group.add(batch.mesh); rider = { atlas, batch };
        shadows = contactShadows(shadowsEnabled ? capacity : 0); shadows.visible = shadowsEnabled; group.add(shadows);
        scene.add(group);
    } catch (error) { dispose(); throw error; }
    const live = new Map(), dead = [], transform = new THREE.Object3D(), matrix = new THREE.Matrix4(), mount = new THREE.Matrix4();
    let endOffset = 0;
    for (const [slot, u] of units.entries()) {
        const phase = Math.random(), horse = horses[u.team];
        live.set(u.id, { id: u.id, slot, team: u.team, hp: u.hp, lastLunge: u._lungeUntil || 0,
            x: u.gx - 35, y: groundH(u.gx, u.gy), z: u.gy - 35, heading: u.team === 'red' ? Math.PI / 2 : -Math.PI / 2,
            moving: false, charge: false,
            animation: createAnimationState(rider.atlas, rider.atlas.rows + slot, 0, phase, true),
            horseAnimation: createAnimationState(horse.atlas, horse.atlas.rows + slot, 0, phase, true) });
    }
    const diagnostics = { active: 0, corpses: 0, resurrections: 0, drawCalls: 0, modelDrawCalls: 0, frame: 0,
        sharedHorseAtlas, mountOrthogonalized: true, bakedRows: [...atlases].reduce((n, a) => n + a.rows, 0),
        atlasBytes: [...atlases].reduce((n, a) => n + a.data.byteLength + (a.mountData?.byteLength || 0), 0) };
    const gait = e => e.moving ? e.charge ? 'Charge' : 'Walk' : 'Idle';
    const horseGait = e => e.moving ? e.charge ? 'Gallop' : 'Walk' : 'Idle';
    let cursor = 0, frameTime = 0;
    const horseCounts = { red: 0, blue: 0 };
    function write(e, corpse) {
        const now = frameTime + endOffset - (corpse ? e.endBase : 0), horse = horses[e.team];
        // This ONE computation supplies both horse attributes and the CPU mount.
        const hp = e.horseAnimation.update(now, horseGait(e)), rp = e.animation.update(now, gait(e));
        transform.position.set(e.x, e.y, e.z); transform.rotation.set(0, e.heading, 0); transform.scale.setScalar(1); transform.updateMatrix();
        matrix.multiplyMatrices(transform.matrix, horse.modelMatrix);
        horse.batch.write(horseCounts[e.team]++, hp, e.team, matrix);
        sampleMount(horse.atlas, hp, mount);
        matrix.copy(transform.matrix).multiply(horse.rootMatrix).multiply(mount).multiply(horse.saddleMatrix)
            .multiply(horse.riderMatrix).multiply(rider.atlas.meshInRoot);
        rider.batch.write(cursor, rp, e.team, matrix);
        if (shadowsEnabled) {
            transform.position.y += .02; transform.scale.set(.65, 1, 1); transform.updateMatrix(); shadows.setMatrixAt(cursor, transform.matrix);
        }
        cursor++;
    }
    const countDrawCall = o => {
        if (o.isMesh && o.count > 0) { diagnostics.drawCalls++; if (o !== shadows) diagnostics.modelDrawCalls++; }
    };
    return {
        kind: 'cavalry', group, live, dead, horses, rider, atlas: rider.atlas, mesh: rider.batch.mesh, diagnostics, dispose,
        sync(u, heading, simulationTime) {
            const e = live.get(u.id); if (!e || u.dead || u.hp <= 0) return;
            const now = simulationTime / 1000;
            e.x = u.gx - 35; e.y = groundH(u.gx, u.gy); e.z = u.gy - 35; e.heading = heading; e.moving = !!u.moving;
            e.charge = e.moving && (u.state === 'charge' || u.state === 'pierce' || Math.hypot(u.velX || 0, u.velY || 0) > 4.5);
            const hit = u.hp < e.hp, lunge = u._lungeUntil || 0, attack = lunge !== 0 && lunge !== e.lastLunge;
            e.hp = u.hp; e.lastLunge = lunge;
            if (hit) {
                e.animation.event('Hit', now, gait(e)); e.horseAnimation.event('Idle_HitReact1', now, horseGait(e));
            } else if (attack) e.animation.event('Attack', now, gait(e));
        },
        kill(u, heading, simulationTime) {
            const e = live.get(u.id); if (!e) return;
            live.delete(u.id); e.endBase = endOffset;
            e.x = u.gx - 35; e.y = groundH(u.gx, u.gy); e.z = u.gy - 35; e.heading = heading;
            e.animation.event('Death', simulationTime / 1000); e.horseAnimation.event('Death', simulationTime / 1000); dead.push(e);
        },
        update(simulationTime, fps, { dt = 0, paused = false, battleOver = false } = EMPTY_PRESENTATION) {
            if (battleOver && !paused) endOffset += dt;
            cursor = 0; frameTime = simulationTime / 1000; horseCounts.red = horseCounts.blue = 0;
            for (const e of live.values()) write(e, false);
            for (const e of dead) write(e, true);
            rider.batch.finish(cursor);
            for (const team of TEAMS) horses[team].batch.finish(horseCounts[team]);
            shadows.count = shadowsEnabled ? cursor : 0; if (shadowsEnabled) shadows.instanceMatrix.needsUpdate = true;
            diagnostics.drawCalls = diagnostics.modelDrawCalls = 0;
            group.traverseVisible(countDrawCall);
            diagnostics.active = live.size; diagnostics.corpses = dead.length; diagnostics.frame++;
        }
    };
}
