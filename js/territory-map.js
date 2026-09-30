// Shared layout: objective positions, collision geometry and visible routes agree.
// Keep the five objective indices stable for orders and network commands.
export function territoryLayout(W, H) {
    const cx = W / 2, cy = H / 2;
    const bridgeY = Math.round(H * 2 / 9);
    const bridge = { x1: cx - 6, x2: cx + 6, y1: bridgeY - 3, y2: bridgeY + 3, kind: 'bridge' };
    const upperX = cx - 12, woodX = Math.round(W * 0.404), woodY = Math.round(H * 0.722);
    const sites = [
        { gx: upperX, gy: bridgeY, name: '西桥头', role: 'bridge', benefit: '上翼过河通道', owner: 'red', progress: 1 },
        { gx: woodX, gy: woodY, name: '西林口', role: 'forest', benefit: '下翼侧路入口', owner: 'red', progress: 1 },
        { gx: cx, gy: cy, name: '中央高地', role: 'hill', benefit: '弓兵居高俯射', owner: null, progress: 0 },
        { gx: W - upperX, gy: bridgeY, name: '东桥头', role: 'bridge', benefit: '上翼过河通道', owner: 'blue', progress: -1 },
        { gx: W - woodX, gy: woodY, name: '东林口', role: 'forest', benefit: '下翼侧路入口', owner: 'blue', progress: -1 }
    ];
    // The upper route crosses the bridge; the middle route skirts the river's
    // southern ford and climbs the hill; the lower route runs through woodland.
    const routes = [
        [[7, cy], [24, cy - 10], [upperX, bridgeY], [W - upperX, bridgeY], [W - 24, cy - 10], [W - 7, cy]],
        [[7, cy], [cx - 18, cy + 1], [cx, cy], [cx + 18, cy + 1], [W - 7, cy]],
        [[7, cy], [24, woodY - 2], [woodX, woodY], [cx, woodY + 5], [W - woodX, woodY], [W - 24, woodY - 2], [W - 7, cy]]
    ];
    return { bridge, sites, routes, fordY: bridgeY + 14 };
}

export function territoryGeometry(W, H) {
    const rect = (x1, y1, x2, y2, kind) => ({ x1, y1, x2, y2, kind });
    const { bridge, fordY } = territoryLayout(W, H), cx = W / 2;
    const water = [];
    // Fine, overlapping strips close the strict-contains seams. Both banks use
    // the same width, preserving x -> W-x symmetry in simulation and navigation.
    for (let y = -12; y < fordY - 2; y += 0.5) {
        if (y >= bridge.y1 && y < bridge.y2) continue;
        const width = 3.55 + Math.sin((y + 7) * 0.29) * 0.6 + Math.cos(y * 0.53) * 0.3;
        // Half-grid banks avoid enum sampling exactly on a half-open outer edge.
        const half = Math.round(width * 2) / 2;
        const y1 = y === bridge.y2 ? y : y - 0.01;
        const y2 = y + 0.5 === bridge.y1 ? bridge.y1 : Math.min(fordY - 2, y + 0.51);
        const last = water[water.length - 1];
        if (last && last.x1 === cx - half && last.y2 >= y1) last.y2 = y2;
        else water.push(rect(cx - half, y1, cx + half, y2, 'water'));
    }
    const leftRocks = [];
    for (let x = Math.round(W * 0.33); x < Math.round(W * 0.44); x += 3) {
        const y1 = Math.round(H * 0.90) + (leftRocks.length % 2);
        leftRocks.push(rect(x, y1, Math.min(Math.round(W * 0.44), x + 4), H - 1, 'rock'));
    }
    const forest = (x1, x2) => ({ x1, x2, y1: Math.round(H * 0.70), y2: Math.round(H * 0.88), kind: 'forest', blob: 'generic' });
    return {
        blockers: [...water, ...leftRocks, ...leftRocks.map(r => rect(W - r.x2, r.y1, W - r.x1, r.y2, 'rock'))],
        zones: [bridge,
            rect(cx - 3.5, fordY - 2, cx + 3.5, fordY, 'shallow'),
            rect(cx - 2.5, fordY - 0.01, cx + 2.5, fordY + 1.5, 'shallow'),
            rect(cx - 1.5, fordY + 1.49, cx + 1.5, fordY + 2.5, 'shallow'),
            rect(cx - 0.5, fordY + 2.49, cx + 0.5, fordY + 3.5, 'shallow'),
            forest(Math.round(W * 0.31), Math.round(W * 0.44)),
            forest(Math.round(W * 0.56), Math.round(W * 0.69))],
        defense: null
    };
}
