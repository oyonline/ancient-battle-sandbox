import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { territoryLayout, homePosition } from '../territory-map.js';
import { setBoardSize } from '../board.js';
import { Terrain } from '../terrain.js';
import { CavalryAI } from '../units.js';
import { TERRITORY } from '../battle/economy.js';
import { SITE_TRAITS, siteWeight } from '../battle/site-traits.js';
import { stepBattle, SIMULATION_STEP_MS } from '../battle/core.js';
import { BattleView } from './battle-view.js';

// game.js needs Phaser only for its base class; all 2D drawing is stubbed below.
globalThis.Phaser = { Scene: class {} };
globalThis.Snd = null;
globalThis.UI = { onBattleEnd() {} };
const { IsoBattleScene } = await import('../game.js');

// 与规则侧 TERRITORY.W/H 一致；连续坐标不额外加半格。
const W = 260, H = 180;
const VERTICAL = 5;
setBoardSize(W, H);
const groundHeight = (gx, gy) => Terrain.height('territory', gx, gy) * VERTICAL;
const groundPosition = (gx, gy, offset) => position(gx, gy, groundHeight(gx, gy) + offset);
const position = (gx, gy, height = 0) => new THREE.Vector3(gx - W / 2, height, gy - H / 2);
const viewport = document.querySelector('#viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101a23');
const camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewport.append(renderer.domElement);

const landGeometry = new THREE.PlaneGeometry(W, H, W, H);
const vertices = landGeometry.getAttribute('position');
const colors = [];
const surfaceColors = {
    grass: '#6f8f4e', forest: '#2f5d34', rock: '#8b8478',
    water: '#3f78a8', bridge: '#8a6a46', shallow: '#7fb0c4'
};
for (let i = 0; i < vertices.count; i++) {
    const gx = i % (W + 1), gy = Math.floor(i / (W + 1));
    const height = Terrain.height('territory', gx, gy);
    const point = groundPosition(gx, gy, 0);
    vertices.setXYZ(i, point.x, point.y, point.z);
    const color = new THREE.Color(surfaceColors[Terrain.surface('territory', gx, gy)]);
    color.multiplyScalar(0.78 + 0.22 * THREE.MathUtils.clamp((height + 0.5) / 3.6, 0, 1));
    colors.push(color.r, color.g, color.b);
}
landGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
landGeometry.computeVertexNormals();
const land = new THREE.Mesh(landGeometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
land.name = 'land';
scene.add(land);
scene.add(new THREE.HemisphereLight('#dfe8ef', '#2a2f26', 0.9));
const sunlight = new THREE.DirectionalLight('#fff4e0', 1.8);
sunlight.position.set(-160, 140, -60);
scene.add(sunlight);

// 每条线按不超过一格的步长贴面，保留 R1 的网格间距。
function groundPath(x1, y1, x2, y2, offset) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    return Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        return groundPosition(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, offset);
    });
}
const { sites, routes } = territoryLayout(W, H);
const roadMaterials = [];
for (const route of routes) {
    const points = [];
    for (let i = 1; i < route.length; i++) {
        const segment = groundPath(...route[i - 1], ...route[i], 0.15);
        points.push(...(i === 1 ? segment : segment.slice(1)));
    }
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap(point => point.toArray()));
    const material = new LineMaterial({ color: '#e2cf9a', linewidth: 3, transparent: true, opacity: 0.7 });
    roadMaterials.push(material);
    const road = new Line2(geometry, material);
    road.name = 'territory-road';
    scene.add(road);
}

// 只压缩展示文案；完整奖励、条件仍直接取 SITE_TRAITS。
const SITE_PHRASES = {
    ranch: '解锁骑兵', forest: '修建加快', bridge: '工事减伤',
    hill: '稳固军心', ford: '涉水加快', crossroad: '多收伤兵'
};
const placeLabels = [];
function placeLabel(text, gx, gy, owner, pixelHeight, offset, home = false, role = null) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = home ? 128 : 144;
    const ctx = canvas.getContext('2d');
    const phrase = home ? null : `${SITE_TRAITS[role].icon} ${SITE_PHRASES[role]}`;
    if (!home) {
        ctx.font = 'bold 60px system-ui, sans-serif';
        const titleWidth = ctx.measureText(text).width;
        ctx.font = 'bold 50px system-ui, sans-serif';
        canvas.width = Math.ceil(Math.max(titleWidth, ctx.measureText(phrase).width) + 48);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    function redraw(nextOwner) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = nextOwner === 'red' ? `rgba(150,40,30,${home ? 0.95 : 0.85})`
            : nextOwner === 'blue' ? `rgba(30,70,150,${home ? 0.95 : 0.85})` : 'rgba(20,28,32,0.78)';
        ctx.beginPath();
        ctx.roundRect(0, 0, canvas.width, canvas.height, 16);
        ctx.fill();
        ctx.font = `bold ${home ? 56 : 60}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.strokeText(text, canvas.width / 2, home ? 64 : 39);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, canvas.width / 2, home ? 64 : 39);
        if (!home) {
            ctx.font = 'bold 50px system-ui, sans-serif';
            ctx.fillStyle = '#ffe3a0';
            ctx.fillText(phrase, canvas.width / 2, 105);
        }
        texture.needsUpdate = true;
    }
    redraw(owner);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false }));
    sprite.name = text;
    sprite.renderOrder = 10;
    sprite.userData.pixelHeight = pixelHeight;
    sprite.userData.aspect = canvas.width / canvas.height;
    sprite.userData.owner = owner;
    sprite.userData.redraw = redraw;
    sprite.position.copy(groundPosition(gx, gy, offset));
    scene.add(sprite);
    placeLabels.push(sprite);
    return sprite;
}
for (const [index, site] of sites.entries()) {
    const labelOffset = site.name === '西桥头' ? 27 : site.name === '中央高地' ? 10 : 7;
    const sprite = placeLabel(site.name, site.gx, site.gy, site.owner, 28, labelOffset, false, site.role);
    sprite.userData.siteIndex = index;
    if (site.name === '西渡口') sprite.position.x -= 16;
    if (site.name === '东渡口') sprite.position.x += 16;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(1.6, 24), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    dot.rotation.x = -Math.PI / 2;
    dot.position.copy(groundPosition(site.gx, site.gy, 0.2));
    const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        dot.position, sprite.position.clone().add(new THREE.Vector3(0, -2.5, 0))
    ]), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6 }));
    scene.add(dot, stem);
}
for (const owner of ['red', 'blue']) {
    const { gx, gy } = homePosition(owner, W, H);
    placeLabel(owner === 'red' ? '红方大本营' : '蓝方大本营', gx, gy, owner, 24, 20, true);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 12, 12), new THREE.MeshLambertMaterial({ color: '#dddddd' }));
    pole.position.copy(groundPosition(gx, gy, 6));
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshLambertMaterial({
        color: owner === 'red' ? '#c0392b' : '#2e6fd0', side: THREE.DoubleSide
    }));
    flag.position.copy(groundPosition(gx, gy, 10)).add(new THREE.Vector3(3, 0, 0));
    scene.add(pole, flag);
}

const debugGroup = new THREE.Group();
debugGroup.name = 'coordinate-debug';
debugGroup.visible = false;
scene.add(debugGroup);
const gridPoints = [];
function gridLine(x1, y1, x2, y2) {
    const points = groundPath(x1, y1, x2, y2, 0.08);
    for (let i = 1; i < points.length; i++) gridPoints.push(points[i - 1], points[i]);
}
for (let gx = 0; gx <= W; gx += 20) gridLine(gx, 0, gx, H);
for (let gy = 0; gy <= H; gy += 20) gridLine(0, gy, W, gy);
debugGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPoints), new THREE.LineBasicMaterial({ color: '#4c696c' })));
const boundary = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
        ...groundPath(0, 0, W, 0, 0.08).slice(0, -1),
        ...groundPath(W, 0, W, H, 0.08).slice(0, -1),
        ...groundPath(W, H, 0, H, 0.08).slice(0, -1),
        ...groundPath(0, H, 0, 0, 0.08).slice(0, -1)
    ]),
    new THREE.LineBasicMaterial({ color: '#afc9c5' })
);
boundary.name = 'map-boundary';
debugGroup.add(boundary);

function label(text, gx, gy, width = 46) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#14252bee';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '36px system-ui, sans-serif';
    ctx.fillStyle = '#eff5ec';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.position.copy(groundPosition(gx, gy, 1.2));
    sprite.scale.set(width, width * canvas.height / canvas.width, 1);
    debugGroup.add(sprite);
}

function marker(name, gx, gy, color, radius) {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), new THREE.MeshBasicMaterial({ color }));
    mesh.name = name;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(groundPosition(gx, gy, 0.25));
    debugGroup.add(mesh);
}
marker('rule-center', 130, 90, '#ffc565', 1.5);
marker('rule-origin', 0, 0, '#afc9c5', 1.2);
marker('first-cell-center', 0.5, 0.5, '#ff85bb', 0.45);
label('中心 (130,90) → 世界 (0,0)', 130, 103, 70);
label('(0,0) · 西北原点角', 29, 8, 54);
label('(260,0)', 235, 8);
label('(0,180)', 25, 172);
label('(260,180)', 235, 172);
label('gy=0 · 北', 130, 8);
label('首格格心 (0.5,0.5)', 35, 31, 55);
debugGroup.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(groundPath(0.5, 0.5, 18, 27, 0.08)),
    new THREE.LineBasicMaterial({ color: '#ff85bb' })
));
function groundArrow(x1, y1, x2, y2, color) {
    const points = groundPath(x1, y1, x2, y2, 0.3);
    const tip = points.at(-1), beforeTip = points.at(-2);
    const direction = tip.clone().sub(beforeTip).normalize();
    const arrow = new THREE.ArrowHelper(direction, tip.clone().addScaledVector(direction, -4), 4, color, 4, 2);
    arrow.line.visible = false;
    debugGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color })), arrow);
}
groundArrow(20, 151, 60, 151, '#ffc565');
groundArrow(232, 25, 232, 61, '#8ec8ee');
label('+gx → 东', 40, 140);
label('+gy · 南', 229, 69);
const scale = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(groundPath(185, 153, 205, 153, 0.3)),
    new THREE.LineBasicMaterial({ color: '#eff5ec' })
);
scale.name = 'scale-20';
debugGroup.add(scale);
label('20 格 / 世界单位', 195, 140, 54);

const controls = new OrbitControls(camera, renderer.domElement);
controls.screenSpacePanning = false;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = 1.25;
controls.minDistance = 60;
controls.maxDistance = 520;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
// OrbitControls 在 pointerdown 时自动将 Ctrl/⌘ + PAN 切换为旋转。
controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
controls.touches.ONE = THREE.TOUCH.PAN;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

const rotationKeys = new Set();
const rotationAxis = new THREE.Vector3(0, 1, 0);
const rotationOffset = new THREE.Vector3();
let rotationTween = null;
function clearViewMotion() {
    rotationTween = null;
    // 消耗拖动的阻尼余量，避免按钮或键盘旋转改变距离、俯仰角。
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
}
function rotateView(angle) {
    rotationOffset.copy(camera.position).sub(controls.target).applyAxisAngle(rotationAxis, angle);
    camera.position.copy(controls.target).add(rotationOffset);
}
function turnView(angle) {
    const remaining = rotationTween ? rotationTween.angle - rotationTween.applied : 0;
    clearViewMotion();
    rotationTween = { angle: remaining + angle, applied: 0, start: performance.now() };
}
document.querySelector('#rotate-left').addEventListener('click', () => turnView(Math.PI / 4));
document.querySelector('#rotate-right').addEventListener('click', () => turnView(-Math.PI / 4));
window.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'q' && key !== 'e') return;
    if (!rotationKeys.has(key)) clearViewMotion();
    rotationKeys.add(key);
});
window.addEventListener('keyup', event => {
    const key = event.key.toLowerCase();
    if (key === 'meta' || key === 'control' || key === 'alt') rotationKeys.clear();
    else rotationKeys.delete(key);
});
window.addEventListener('blur', () => rotationKeys.clear());
controls.addEventListener('start', () => { rotationTween = null; });

let battle, battleView;
let lastFrame = performance.now();
let visualTime = 0;
function render(now) {
    requestAnimationFrame(render);
    const frameDelta = Math.max(0, now - lastFrame);
    const delta = Math.min(frameDelta, 50);
    lastFrame = now;
    if (battle.battleStarted && !battle.paused && !battle.battleOver) {
        battle.simulationAccumulator += delta * battle.gameSpeed;
        let steps = 0;
        while (battle.simulationAccumulator + 1e-7 >= SIMULATION_STEP_MS && !battle.battleOver && steps < 2) {
            battle.simulationAccumulator = Math.max(0, battle.simulationAccumulator - SIMULATION_STEP_MS);
            battle.simulationTime += SIMULATION_STEP_MS;
            stepBattle(battle, SIMULATION_STEP_MS / 1000);
            steps++;
        }
        if (steps === 2 && battle.simulationAccumulator > SIMULATION_STEP_MS) battle.simulationAccumulator = SIMULATION_STEP_MS;
    }
    if (!battle.paused) visualTime += delta;
    battleView.sync(battle, visualTime, battle.paused ? 0 : delta / 1000);
    const turnDirection = Number(rotationKeys.has('q')) - Number(rotationKeys.has('e'));
    if (turnDirection) {
        rotationTween = null;
        rotateView(turnDirection * Math.PI / 2 * frameDelta / 1000);
    } else if (rotationTween) {
        const t = Math.min((now - rotationTween.start) / 300, 1);
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const applied = rotationTween.angle * eased;
        rotateView(applied - rotationTween.applied);
        rotationTween.applied = applied;
        if (t === 1) rotationTween = null;
    }
    controls.update();
    renderer.render(scene, camera);
}

function resetView() {
    // 清除阻尼余量，再固定复位姿态；zoom 只负责按窗口适配全图。
    clearViewMotion();
    controls.target.set(0, 0, 10);
    camera.position.set(0, 190, 230);
    camera.zoom = 1;
    camera.lookAt(controls.target);
    controls.update();
    controls.enableDamping = true;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    let extent = 0;
    const projected = new THREE.Vector3();
    for (let i = 0; i < vertices.count; i++) {
        projected.fromBufferAttribute(vertices, i).project(camera);
        extent = Math.max(extent, Math.abs(projected.x), Math.abs(projected.y));
    }
    const { width, height } = renderer.domElement.getBoundingClientRect();
    for (const sprite of placeLabels) {
        projected.copy(sprite.position).project(camera);
        // 固定像素标签的半宽/半高转为 NDC，复位时预留屏幕边距。
        const halfHeight = sprite.userData.pixelHeight / Math.max(height, 1);
        const halfWidth = sprite.userData.pixelHeight * sprite.userData.aspect / Math.max(width, 1);
        extent = Math.max(extent, Math.abs(projected.x) * 0.96 / Math.max(0.96 - halfWidth, 0.01),
            Math.abs(projected.y) * 0.96 / Math.max(0.96 - halfHeight, 0.01));
    }
    camera.zoom = 0.96 / extent;
    camera.updateProjectionMatrix();
    scalePlaceLabels();
}

function scalePlaceLabels() {
    const { width, height } = renderer.domElement.getBoundingClientRect();
    for (const sprite of placeLabels) {
        // Three 的非衰减 Sprite 仍经过投影矩阵；抵消 FOV 与 zoom，保持 CSS 像素高度。
        const scaleY = sprite.userData.pixelHeight * 2 / (Math.max(height, 1) * camera.projectionMatrix.elements[5]);
        const scaleX = sprite.userData.pixelHeight * sprite.userData.aspect * 2 / (Math.max(width, 1) * camera.projectionMatrix.elements[0]);
        sprite.scale.set(scaleX, scaleY, 1);
    }
}

function resize() {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    for (const material of roadMaterials) material.resolution.set(width, height);
    scalePlaceLabels();
}

function displayObject() {
    return {
        destroyed: false, x: 0, y: 0,
        setOrigin() { return this; }, setScrollFactor() { return this; },
        setDepth() { return this; }, setVisible() { return this; }, setScale() { return this; },
        setFlipX() { return this; }, setTexture() { return this; }, setFrame() { return this; },
        setPosition() { return this; }, setAngle() { return this; }, setAlpha() { return this; },
        setText() { return this; }, setColor() { return this; }, setTint() { return this; },
        clearTint() { return this; }, anims: { stop() {} }, destroy() { this.destroyed = true; },
        clear() {}, lineStyle() {}, lineBetween() {}, fillStyle() {}, fillCircle() {}, fillRect() {},
        fillTriangle() {}, strokeTriangle() {}, fillPoints() {}, strokePoints() {}, fillEllipse() {}, strokeEllipse() {},
        beginPath() {}, arc() {}, strokePath() {}, strokeCircle() {}, generateTexture() {}
    };
}

const detailCard = document.querySelector('#site-detail');
const detailTitle = document.querySelector('#site-detail-title');
const detailOwner = document.querySelector('#site-detail-owner');
const detailLines = document.querySelector('#site-detail-lines');
const captureNotices = document.querySelector('#capture-notices');
let selectedSite = null;
let ownersInitialized = false;
const captureEffects = [];
const notices = [];
function closeDetail() {
    selectedSite = null;
    detailCard.hidden = true;
}
function showDetail() {
    const flag = battle?.flags[selectedSite];
    if (!flag) return;
    const trait = SITE_TRAITS[flag.role];
    detailTitle.textContent = `${trait.icon} ${flag.name}`;
    detailOwner.textContent = flag.owner === 'red' ? '红方' : flag.owner === 'blue' ? '蓝方' : '无主';
    detailOwner.style.color = ownerColor(flag.owner);
    detailLines.replaceChildren(...[
        `地形：${trait.terrain}`, `占领奖励：${trait.reward}`, `条件：${trait.condition}`,
        `另外：每秒 +${TERRITORY.FLAG_INCOME * siteWeight(flag.role)} 军费；分量越高，让对方票数掉得越快`
    ].map(text => {
        const line = document.createElement('div');
        line.textContent = text;
        return line;
    }));
    detailCard.hidden = false;
}
document.querySelector('#site-detail-close').addEventListener('click', closeDetail);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerStart = null;
renderer.domElement.addEventListener('pointerdown', event => {
    pointerStart = event.button === 0 && !event.ctrlKey && !event.metaKey
        ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
});
renderer.domElement.addEventListener('pointercancel', () => { pointerStart = null; });
renderer.domElement.addEventListener('pointerup', event => {
    const start = pointerStart;
    pointerStart = null;
    if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(placeLabels.filter(label => label.userData.siteIndex != null))[0];
    if (!hit) { closeDetail(); return; }
    selectedSite = hit.object.userData.siteIndex;
    showDetail();
});
function ownerColor(owner) {
    return owner === 'red' ? '#c0392b' : owner === 'blue' ? '#2e6fd0' : '#dddddd';
}
function removeHalo(effect) {
    scene.remove(effect.mesh);
    effect.mesh.geometry.dispose();
    effect.mesh.material.dispose();
}
function captureFeedback(flag, now) {
    const notice = document.createElement('div');
    notice.className = 'capture-notice';
    notice.style.color = ownerColor(flag.owner);
    notice.textContent = flag.owner == null ? `${flag.name} 失守，变为无主`
        : `${flag.owner === 'red' ? '红方' : '蓝方'}夺下${flag.name} → ${SITE_PHRASES[flag.role]}`;
    captureNotices.prepend(notice);
    notices.unshift({ element: notice, start: now });
    if (notices.length > 3) notices.pop().element.remove();
    const geometry = new THREE.RingGeometry(0.94, 1, 64);
    geometry.rotateX(-Math.PI / 2);
    const unitPositions = geometry.getAttribute('position').array.slice();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: ownerColor(flag.owner), transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false
    }));
    mesh.position.set(flag.gx - W / 2, 0, flag.gy - H / 2);
    mesh.frustumCulled = false;
    scene.add(mesh);
    captureEffects.push({ mesh, unitPositions, gx: flag.gx, gy: flag.gy, start: now });
}
function updateCaptureEffects(now) {
    for (let i = notices.length - 1; i >= 0; i--) {
        const age = now - notices[i].start;
        if (age >= 3400) { notices[i].element.remove(); notices.splice(i, 1); }
        else notices[i].element.style.opacity = String(Math.min(1, (3400 - age) / 400));
    }
    for (let i = captureEffects.length - 1; i >= 0; i--) {
        const effect = captureEffects[i], t = (now - effect.start) / 1200;
        if (t >= 1) { removeHalo(effect); captureEffects.splice(i, 1); continue; }
        const radius = 2 + 8 * t;
        const points = effect.mesh.geometry.getAttribute('position');
        for (let j = 0; j < points.count; j++) {
            const x = effect.unitPositions[j * 3] * radius, z = effect.unitPositions[j * 3 + 2] * radius;
            points.setXYZ(j, x, groundHeight(effect.gx + x, effect.gy + z) + 0.3, z);
        }
        points.needsUpdate = true;
        effect.mesh.material.opacity = 0.9 * (1 - t);
    }
}
function updateOwners(flags) {
    const now = performance.now();
    flags.forEach((flag, i) => {
        const label = placeLabels[i];
        if (label.userData.owner !== flag.owner) {
            label.userData.redraw(flag.owner);
            label.userData.owner = flag.owner;
            if (ownersInitialized) captureFeedback(flag, now);
            if (selectedSite === i) showDetail();
        }
    });
    ownersInitialized = true;
    updateCaptureEffects(now);
}

function startBattle() {
    closeDetail();
    ownersInitialized = false;
    for (const effect of captureEffects) removeHalo(effect);
    captureEffects.length = 0;
    notices.length = 0;
    captureNotices.replaceChildren();
    battleView?.dispose();
    battleView = new BattleView(scene, groundHeight, updateOwners);
    visualTime = 0;
    const view = battleView;
    const simulation = new IsoBattleScene();
    Object.assign(simulation, {
        units: [], arrows: [], bloods: [], bloodQueue: [], sgrid: new Map(), _aliveArr: [], nextId: 1,
        redAlive: 0, blueAlive: 0, blackAlive: 0, deadCount: 0,
        battleStarted: false, battleOver: false, paused: false, gameSpeed: 1,
        countdownTimers: [], countdownTexts: [], dyingUnits: new Set(),
        centroid: { red: { x: 0, y: 0 }, blue: { x: 0, y: 0 } },
        arrowGfx: displayObject(), spawnZoneGfx: displayObject(),
        cameras: { main: { width: 960, height: 720 } },
        cavalryAI: new CavalryAI(),
        add: { text: displayObject, image: displayObject, sprite: displayObject, graphics: displayObject },
        tweens: { killTweensOf() {}, add() {} }, anims: { globalTimeScale: 1 },
        textures: { exists: () => false },
        time: { delayedCall() { return { remove() {} }; } },
        showVictory(winner) { view.victory(winner); }
    });
    simulation.resetBattleData();
    simulation.render.world.drawSpawnZones = () => {};
    simulation.render.camps.update = () => {};
    // Preserve fireArrow/updateArrows: they create and resolve real simulation arrows.
    for (const name of ['meleeImpact', 'bloodBurst', 'addGroundBlood', 'addBloodPool', 'flushBloodQueue',
        'chargeDust', 'impactPuff', 'sparkBurst', 'slashArc', 'spawnOrderText', 'orderFlash',
        'drawTactics', 'drawFlags', 'stampCorpse', 'updateBloods']) simulation[name] = () => {};
    simulation.playAttackAnim = unit => view.attack(unit, visualTime);
    const realKill = simulation.killUnit;
    simulation.killUnit = function (unit, from) {
        view.recordCorpse(unit, visualTime, simulation.simulationTime);
        return realKill.call(this, unit, from);
    };
    simulation.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING },
        'custom', 'custom', {}, { territory: true, territoryAI: true, terrain: 'territory' });
    simulation.battleStarted = true;
    battle = simulation;
    window.__territory3d = {
        scene: simulation,
        get view() {
            return {
                azimuthDeg: THREE.MathUtils.radToDeg(controls.getAzimuthalAngle()),
                polarDeg: THREE.MathUtils.radToDeg(controls.getPolarAngle()),
                distance: controls.getDistance()
            };
        }
    };
    document.querySelector('#pause').textContent = '暂停';
    lastFrame = performance.now();
    view.sync(simulation, visualTime, 0);
    void view.loadModels(camera, renderer, simulation);
}

document.querySelector('#pause').addEventListener('click', event => {
    battle.paused = !battle.paused;
    event.currentTarget.textContent = battle.paused ? '继续' : '暂停';
});
document.querySelector('#restart').addEventListener('click', startBattle);

document.querySelector('#debug-toggle').addEventListener('change', event => {
    debugGroup.visible = event.target.checked;
});
document.querySelector('#reset').addEventListener('click', resetView);
window.addEventListener('resize', resize);
resize();
resetView();
startBattle();
requestAnimationFrame(render);

export { scene, camera, controls, land };
