import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// 与规则侧 TERRITORY.W/H 一致；连续坐标不额外加半格。
const W = 260, H = 180;
const position = (gx, gy, height = 0) => new THREE.Vector3(gx - W / 2, height, gy - H / 2);
const viewport = document.querySelector('#viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101a23');
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewport.append(renderer.domElement);

const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: '#243b40' }));
plane.name = 'map-plane';
plane.rotation.x = -Math.PI / 2;
scene.add(plane);

const gridPoints = [];
for (let gx = 0; gx <= W; gx += 20) gridPoints.push(position(gx, 0, 0.02), position(gx, H, 0.02));
for (let gy = 0; gy <= H; gy += 20) gridPoints.push(position(0, gy, 0.02), position(W, gy, 0.02));
scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPoints), new THREE.LineBasicMaterial({ color: '#4c696c' })));
const boundary = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => position(x, y, 0.04))),
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
    sprite.position.copy(position(gx, gy, 0.3));
    sprite.scale.set(width, width * canvas.height / canvas.width, 1);
    scene.add(sprite);
}

function marker(name, gx, gy, color, radius) {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 24), new THREE.MeshBasicMaterial({ color }));
    mesh.name = name;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(position(gx, gy, 0.1));
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
    new THREE.BufferGeometry().setFromPoints([position(0.5, 0.5, 0.12), position(18, 27, 0.12)]),
    new THREE.LineBasicMaterial({ color: '#ff85bb' })
));
const xArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), position(20, 151, 0.2), 40, '#ffc565', 4, 2);
const yArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), position(232, 25, 0.2), 36, '#8ec8ee', 4, 2);
scene.add(xArrow, yArrow);
label('+gx → 东', 40, 140);
label('+gy · 南', 229, 69);
const scale = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([position(185, 153, 0.1), position(205, 153, 0.1)]),
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
    const viewHeight = Math.max(H / Math.SQRT2 + 35, (W + 50) / aspect);
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

export { scene, camera, controls };
