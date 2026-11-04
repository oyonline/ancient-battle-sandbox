import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { territoryLayout, homePosition } from '../territory-map.js';
import { setBoardSize } from '../board.js';
import { Terrain } from '../terrain.js';

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

const placeLabels = [];
function placeLabel(text, gx, gy, owner, pixelHeight, offset, home = false) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = owner === 'red' ? `rgba(150,40,30,${home ? 0.95 : 0.85})`
        : owner === 'blue' ? `rgba(30,70,150,${home ? 0.95 : 0.85})` : 'rgba(20,28,32,0.78)';
    ctx.beginPath();
    ctx.roundRect(0, 0, 512, 128, 16);
    ctx.fill();
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeText(text, 256, 64);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, 256, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false }));
    sprite.name = text;
    sprite.renderOrder = 10;
    sprite.userData.pixelHeight = pixelHeight;
    sprite.position.copy(groundPosition(gx, gy, offset));
    scene.add(sprite);
    placeLabels.push(sprite);
    return sprite;
}
for (const site of sites) {
    const sprite = placeLabel(site.name, site.gx, site.gy, site.owner, 22, site.name === '中央高地' ? 10 : 7);
    if (site.name === '西渡口') sprite.position.x -= 14;
    if (site.name === '东渡口') sprite.position.x += 14;
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
    placeLabel(owner === 'red' ? '红方大本营' : '蓝方大本营', gx, gy, owner, 30, 20, true);
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
controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
controls.touches.ONE = THREE.TOUCH.PAN;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

function render() {
    requestAnimationFrame(render);
    controls.update();
    renderer.render(scene, camera);
}

function resetView() {
    // 清除阻尼余量，再固定复位姿态；zoom 只负责按窗口适配全图。
    controls.enableDamping = false;
    controls.update();
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
        const halfWidth = sprite.userData.pixelHeight * 4 / Math.max(width, 1);
        extent = Math.max(extent, Math.abs(projected.x) * 0.96 / Math.max(0.96 - halfWidth, 0.01),
            Math.abs(projected.y) * 0.96 / Math.max(0.96 - halfHeight, 0.01));
    }
    camera.zoom = 0.96 / extent;
    camera.updateProjectionMatrix();
    for (const sprite of placeLabels) {
        // Three 的非衰减 Sprite 仍经过投影矩阵；抵消 FOV 与 zoom，保持 CSS 像素高度。
        const scaleY = sprite.userData.pixelHeight * 2 / (Math.max(height, 1) * camera.projectionMatrix.elements[5]);
        const scaleX = sprite.userData.pixelHeight * 4 * 2 / (Math.max(width, 1) * camera.projectionMatrix.elements[0]);
        sprite.scale.set(scaleX, scaleY, 1);
    }
}

function resize() {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    camera.aspect = width / Math.max(height, 1);
    renderer.setSize(width, height);
    for (const material of roadMaterials) material.resolution.set(width, height);
    resetView();
}

document.querySelector('#debug-toggle').addEventListener('change', event => {
    debugGroup.visible = event.target.checked;
});
document.querySelector('#reset').addEventListener('click', resetView);
window.addEventListener('resize', resize);
resize();
render();

export { scene, camera, controls, land };
