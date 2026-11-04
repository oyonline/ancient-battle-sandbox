import * as THREE from 'three';

const TEAM = { red: '#c0392b', blue: '#2e6fd0' };

// All animation state belongs to the view, never to simulation units.
export class BattleView {
    constructor(world, groundHeight, updateOwners) {
        this.world = world;
        this.groundHeight = groundHeight;
        this.updateOwners = updateOwners;
        this.root = new THREE.Group();
        world.add(this.root);
        this.poses = new Map();
        this.attacks = new Map();
        this.batches = new Map();
        this.corpses = [];
        this.buildings = new Map();
        this.shapes = new Map();
        this.dummy = new THREE.Object3D();
        this.arrowGeometry = new THREE.BufferGeometry();
        this.arrowMaterial = new THREE.LineBasicMaterial({ color: '#f2e6c8' });
        this.arrows = new THREE.LineSegments(this.arrowGeometry, this.arrowMaterial);
        this.arrows.frustumCulled = false;
        this.root.add(this.arrows);
        this.hud = document.querySelector('#battle-hud');
        this.banner = document.querySelector('#victory');
        this.banner.hidden = true;
    }

    parts(type, team) {
        const key = `${type}:${team}`;
        if (this.shapes.has(key)) return this.shapes.get(key);
        const color = new THREE.Color(TEAM[team] || '#555555');
        if (type === 'worker') color.multiplyScalar(1.35);
        const parts = [];
        const add = (geometry, tint, x, y, z, rotation = 0) => {
            const pose = new THREE.Object3D();
            pose.position.set(x, y, z);
            pose.rotation.x = rotation;
            pose.updateMatrix();
            parts.push({ geometry, color: new THREE.Color(tint), matrix: pose.matrix.clone() });
        };
        if (type === 'cavalry') {
            add(new THREE.BoxGeometry(0.6, 0.8, 1.6), '#5a3d28', 0, 0.6, 0);
            add(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 10), color, 0, 1.45, 0);
            add(new THREE.SphereGeometry(0.25, 10, 8), '#e8d2b0', 0, 2.15, 0);
        } else {
            const height = type === 'archer' ? 1.2 : 1.4;
            add(new THREE.CylinderGeometry(0.35, 0.35, height, 10), color, 0, height / 2, 0);
            add(new THREE.SphereGeometry(0.25, 10, 8), '#e8d2b0', 0, height + 0.25, 0);
            if (type === 'pikeman') add(new THREE.BoxGeometry(0.08, 0.08, 2.6), '#6b4a2b', 0.4, 1.45, 0.7, -Math.PI / 3);
            if (type === 'archer') add(new THREE.TorusGeometry(0.35, 0.045, 6, 16, Math.PI), '#6b4a2b', 0, 0.9, -0.4);
            if (type === 'medic') add(new THREE.BoxGeometry(0.3, 0.3, 0.3), '#ffffff', 0, 2.05, 0);
        }
        this.shapes.set(key, parts);
        return parts;
    }

    attack(unit, now) { this.attacks.set(unit.id, now); }

    recordCorpse(unit, now) {
        const pose = this.poses.get(unit.id);
        const group = new THREE.Group();
        group.position.set(unit.gx - 130, this.groundHeight(unit.gx, unit.gy) + 0.4, unit.gy - 90);
        group.rotation.y = pose?.heading ?? (unit.team === 'red' ? Math.PI / 2 : -Math.PI / 2);
        // Local +Z is the forward axis; tip the whole body sideways around it.
        const body = new THREE.Group();
        body.rotation.z = Math.PI / 2;
        for (const part of this.parts(unit.type, unit.team)) {
            const material = new THREE.MeshLambertMaterial({ color: part.color.clone().multiplyScalar(0.5), transparent: true });
            const mesh = new THREE.Mesh(part.geometry, material);
            mesh.applyMatrix4(part.matrix);
            body.add(mesh);
        }
        group.add(body);
        this.root.add(group);
        this.corpses.push({ group, start: now });
        if (this.corpses.length > 300) this.removeCorpse(this.corpses.shift());
    }

    removeCorpse(corpse) {
        this.root.remove(corpse.group);
        corpse.group.traverse(object => object.material?.dispose());
    }

    victory(winner) {
        this.banner.textContent = winner === 'red' ? '红方胜' : winner === 'blue' ? '蓝方胜' : '平局';
        this.banner.hidden = false;
    }

    sync(scene, now, dt) {
        const groups = new Map(), present = new Set();
        for (const unit of scene.units) {
            if (unit.dead || unit.withdrawn) continue;
            present.add(unit.id);
            let pose = this.poses.get(unit.id);
            if (!pose) {
                pose = { x: unit.gx, z: unit.gy, heading: unit.team === 'red' ? Math.PI / 2 : -Math.PI / 2 };
                this.poses.set(unit.id, pose);
            }
            const dx = unit.gx - pose.x, dz = unit.gy - pose.z;
            if (Math.hypot(dx, dz) > 0.00001) {
                const target = Math.atan2(dx, dz);
                const turn = Math.atan2(Math.sin(target - pose.heading), Math.cos(target - pose.heading));
                pose.heading += turn * (1 - Math.exp(-dt * 14));
            }
            pose.x = unit.gx; pose.z = unit.gy;
            const attack = this.attacks.get(unit.id);
            const progress = attack === undefined ? 1 : (now - attack) / 220;
            const lunge = progress >= 0 && progress < 1 ? Math.sin(progress * Math.PI) * 0.4 : 0;
            if (progress >= 1) this.attacks.delete(unit.id);
            this.dummy.position.set(unit.gx - 130 + Math.sin(pose.heading) * lunge,
                this.groundHeight(unit.gx, unit.gy), unit.gy - 90 + Math.cos(pose.heading) * lunge);
            this.dummy.rotation.set(0, pose.heading, 0);
            this.dummy.updateMatrix();
            const key = `${unit.type}:${unit.team}`;
            if (!groups.has(key)) groups.set(key, { type: unit.type, team: unit.team, matrices: [] });
            groups.get(key).matrices.push(this.dummy.matrix.clone());
        }
        for (const id of this.poses.keys()) if (!present.has(id)) { this.poses.delete(id); this.attacks.delete(id); }
        for (const batch of this.batches.values()) for (const mesh of batch.meshes) mesh.count = 0;
        for (const [key, group] of groups) {
            let batch = this.batches.get(key);
            const parts = this.parts(group.type, group.team), count = group.matrices.length;
            if (!batch || batch.capacity < count) {
                if (batch) for (const mesh of batch.meshes) { this.root.remove(mesh); mesh.dispose(); mesh.material.dispose(); }
                const capacity = Math.max(32, count * 2);
                batch = { capacity, meshes: parts.map(part => {
                    const mesh = new THREE.InstancedMesh(part.geometry, new THREE.MeshLambertMaterial({ color: part.color }), capacity);
                    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
                    mesh.frustumCulled = false;
                    this.root.add(mesh);
                    return mesh;
                }) };
                this.batches.set(key, batch);
            }
            batch.meshes.forEach((mesh, p) => {
                mesh.count = count;
                group.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(matrix, parts[p].matrix)));
                mesh.instanceMatrix.needsUpdate = true;
            });
        }
        this.corpses = this.corpses.filter(corpse => {
            const age = now - corpse.start;
            if (age >= 8000) { this.removeCorpse(corpse); return false; }
            corpse.group.traverse(object => { if (object.material) object.material.opacity = Math.min(1, (8000 - age) / 1000); });
            return true;
        });
        this.syncArrows(scene.arrows);
        this.syncBuildings(scene.territory?.camps.buildings || []);
        this.updateOwners(scene.flags);
        const seconds = Math.floor(scene.simulationTime / 1000);
        const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
        const owned = team => scene.flags.filter(flag => flag.owner === team).length;
        const hud = `开战 ${time} · <span class="red">红方 ${scene.redAlive} 人</span> · 占 ${owned('red')} 处 · <span class="blue">蓝方 ${scene.blueAlive} 人</span> · 占 ${owned('blue')} 处`;
        if (this.hud.innerHTML !== hud) this.hud.innerHTML = hud;
    }

    syncArrows(arrows) {
        let attribute = this.arrowGeometry.getAttribute('position');
        if (!attribute || attribute.count < arrows.length * 2) {
            attribute = new THREE.BufferAttribute(new Float32Array(Math.max(32, arrows.length * 2) * 3), 3);
            this.arrowGeometry.setAttribute('position', attribute);
        }
        const direction = new THREE.Vector3();
        arrows.forEach((arrow, i) => {
            const p = THREE.MathUtils.clamp(arrow.t / arrow.dur, 0, 1);
            const gx = THREE.MathUtils.lerp(arrow.sx, arrow.tx, p), gy = THREE.MathUtils.lerp(arrow.sy, arrow.ty, p);
            const y = this.groundHeight(gx, gy) + 12 * p * (1 - p);
            direction.set(arrow.tx - arrow.sx, 12 * (1 - 2 * p), arrow.ty - arrow.sy).normalize().multiplyScalar(0.6);
            attribute.setXYZ(i * 2, gx - 130 - direction.x, y - direction.y, gy - 90 - direction.z);
            attribute.setXYZ(i * 2 + 1, gx - 130 + direction.x, y + direction.y, gy - 90 + direction.z);
        });
        attribute.needsUpdate = true;
        this.arrowGeometry.setDrawRange(0, arrows.length * 2);
    }

    syncBuildings(buildings) {
        const present = new Set();
        for (const building of buildings) {
            if (building.dead) continue;
            present.add(building.id);
            let mesh = this.buildings.get(building.id);
            const tower = building.type === 'tower', height = tower ? 5 : 1.5;
            if (!mesh) {
                mesh = new THREE.Mesh(new THREE.BoxGeometry(tower ? 1.6 : 3, height, tower ? 1.6 : 3),
                    new THREE.MeshLambertMaterial());
                this.root.add(mesh);
                this.buildings.set(building.id, mesh);
            }
            mesh.material.color.set(TEAM[building.team] || '#555555');
            mesh.position.set(building.gx - 130, this.groundHeight(building.gx, building.gy) + height / 2, building.gy - 90);
        }
        for (const [id, mesh] of this.buildings) if (!present.has(id)) {
            this.root.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); this.buildings.delete(id);
        }
    }

    dispose() {
        this.world.remove(this.root);
        this.root.traverse(object => {
            object.material?.dispose();
            if (object.isInstancedMesh) object.dispose();
        });
        for (const parts of this.shapes.values()) for (const part of parts) part.geometry.dispose();
        for (const mesh of this.buildings.values()) mesh.geometry.dispose();
        this.arrowGeometry.dispose();
        this.poses.clear(); this.attacks.clear(); this.batches.clear();
        this.corpses.length = 0; this.buildings.clear(); this.shapes.clear();
    }
}
