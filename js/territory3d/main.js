import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setBoardSize } from '../board.js';
import { Terrain } from '../terrain.js';

// 与规则侧 TERRITORY.W/H 一致；连续坐标不额外加半格。
const W = 260, H = 180;
const VERTICAL = 4;
setBoardSize(W, H);
const groundHeight = (gx, gy) => Terrain.height('territory', gx, gy) * VERTICAL;
const groundPosition = (gx, gy, offset) => position(gx, gy, groundHeight(gx, gy) + offset);
const position = (gx, gy, height = 0) => new THREE.Vector3(gx - W / 2, height, gy - H / 2);
const viewport = document.querySelector('#viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101a23');
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewport.append(renderer.domElement);

const landGeometry = new THREE.PlaneGeometry(W, H, W, H);
const vertices = landGeometry.getAttribute('position');
const colors = [];
const surfaceColors = {
    grass: '#6f8f4e', forest: '#2f5d34', rock: '#8b8478',
    water: '#7a7f86', bridge: '#7a7f86', shallow: '#7a7f86'
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
scene.add(new THREE.HemisphereLight('#dfe8ef', '#2a2f26', 1.1));
const sunlight = new THREE.DirectionalLight('#fff4e0', 1.4);
sunlight.position.set(-120, 200, -80);
scene.add(sunlight);

// 每条线按不超过一格的步长贴面，保留 R1 的网格间距。
function groundPath(x1, y1, x2, y2, offset) {
    const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)));
    return Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        return groundPosition(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, offset);
    });
}
const gridPoints = [];
function gridLine(x1, y1, x2, y2) {
    const points = groundPath(x1, y1, x2, y2, 0.08);
    for (let i = 1; i < points.length; i++) gridPoints.push(points[i - 1], points[i]);
}
for (let gx = 0; gx <= W; gx += 20) gridLine(gx, 0, gx, H);
for (let gy = 0; gy <= H; gy += 20) gridLine(0, gy, W, gy);
scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPoints), new THREE.LineBasicMaterial({ color: '#4c696c' })));
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
scene.add(boundary);

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
    scene.add(sprite);
}

function marker(name, gx, gy, color, radius) {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), new THREE.MeshBasicMaterial({ color }));
    mesh.name = name;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(groundPosition(gx, gy, 0.15));
    scene.add(mesh);
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
scene.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(groundPath(0.5, 0.5, 18, 27, 0.08)),
    new THREE.LineBasicMaterial({ color: '#ff85bb' })
));
function groundArrow(x1, y1, x2, y2, color) {
    const points = groundPath(x1, y1, x2, y2, 0.3);
    const tip = points.at(-1), beforeTip = points.at(-2);
    const direction = tip.clone().sub(beforeTip).normalize();
    const arrow = new THREE.ArrowHelper(direction, tip.clone().addScaledVector(direction, -4), 4, color, 4, 2);
    arrow.line.visible = false;
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color })), arrow);
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
scene.add(scale);
label('20 格 / 世界单位', 195, 140, 54);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableRotate = false;
controls.screenSpacePanning = false;
controls.minZoom = 0.5;
controls.maxZoom = 12;
controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
controls.touches.ONE = THREE.TOUCH.PAN;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
controls.addEventListener('change', render);

function render() {
    renderer.render(scene, camera);
}

function resize() {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const aspect = width / Math.max(height, 1);
    const viewHeight = Math.max(H / Math.SQRT2 + 43, (W + 50) / aspect);
    camera.left = -viewHeight * aspect / 2;
    camera.right = viewHeight * aspect / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    render();
}

function resetView() {
    controls.target.set(0, 0, 0);
    camera.position.set(0, 240, 240);
    camera.zoom = 1;
    camera.lookAt(controls.target);
    controls.update();
    resize();
}

document.querySelector('#reset').addEventListener('click', resetView);
window.addEventListener('resize', resize);
resetView();

export { scene, camera, controls, land };
