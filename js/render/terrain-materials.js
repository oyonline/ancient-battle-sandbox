// Material baking is view-only: all surfaces, heights and blockers come from Terrain.
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { VIEW_W, VIEW_H, makeNoise } from './metrics.js';
import { buildBankField, bankDistance, bankAppearance, sampleBankWeight, slopeAppearance, rockPlacements } from './terrain-naturalness.js';

const MATERIAL_KEY = 'terrain/materials';
const PROP_KEY = 'terrain/props';
const ROCK_KEY = 'terrain/rocks-v2';
const PIXELS = 32;
const MARGIN = 16;
const CHUNK = 1024;
const MATERIAL_TILE = 192;
const noise = makeNoise(73);
const hash = (x, y) => Terrain._hash2(Math.round(x * 101), Math.round(y * 101));

function canvas(width, height) {
    const value = document.createElement('canvas');
    value.width = width; value.height = height;
    // Keep every temporary bake surface on the CPU, including the source plane.
    // Mixing a GPU source canvas with a CPU target would read back every small patch.
    value.getContext('2d', { willReadFrequently: true });
    return value;
}

function polygon(ctx, points) {
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.closePath();
}

// Crop frames at runtime rather than maintaining six duplicate image files.
function materialPatterns(ctx, source) {
    return Array.from({ length: 6 }, (_, index) => {
        const tile = canvas(MATERIAL_TILE, MATERIAL_TILE);
        tile.getContext('2d').drawImage(source, index % 3 * source.width / 3,
            Math.floor(index / 3) * source.height / 2, source.width / 3, source.height / 2,
            0, 0, tile.width, tile.height);
        return ctx.createPattern(tile, 'repeat');
    });
}

function paintTriangle(ctx, source, sx, sy, points, origin, xAxis, yAxis) {
    const center = { x: points.reduce((n,p)=>n+p.x,0)/3, y: points.reduce((n,p)=>n+p.y,0)/3 };
    ctx.save();
    // Shared edges overlap by a fraction of a world pixel to prevent antialias cracks.
    polygon(ctx, points.map(p => {
        const dx=p.x-center.x, dy=p.y-center.y, distance=Math.hypot(dx,dy);
        return {x:p.x+dx/distance*0.35,y:p.y+dy/distance*0.35};
    }));
    ctx.clip();
    ctx.transform(xAxis.x/PIXELS,xAxis.y/PIXELS,yAxis.x/PIXELS,yAxis.y/PIXELS,origin.x,origin.y);
    ctx.drawImage(source,sx,sy,PIXELS+0.5,PIXELS+0.5,0,0,PIXELS+0.5,PIXELS+0.5);
    ctx.restore();
}

export class TerrainMaterialsRenderer {
    constructor(scene) { this.scene = scene; this.chunkKeys = []; }

    available() {
        return this.scene.textures.exists(MATERIAL_KEY) && this.scene.textures.exists(PROP_KEY);
    }

    clearGround() {
        if (!this.chunkKeys.length) return;
        this.scene.groundImage?.destroy(true);
        this.scene.groundImage = null;
        this.chunkKeys.forEach(key => this.scene.textures.remove(key));
        this.chunkKeys = [];
    }

    draw() {
        const started = performance.now();
        const scene = this.scene, geometry = Terrain.geometry('territory');
        const plane = this.paintMaterials(geometry);
        // This is a one-off CPU bake. Thousands of clipped GPU-canvas operations
        // can stall texture upload; only the completed chunks are sent to WebGL.
        const ground = canvas(VIEW_W, VIEW_H), ctx = ground.getContext('2d', { willReadFrequently: true });
        // Land continues beyond the playable area; the board no longer floats in an ocean.
        ctx.fillStyle = materialPatterns(ctx, scene.textures.get(MATERIAL_KEY).getSourceImage())[0];
        ctx.fillRect(0, 0, ground.width, ground.height);
        // Continuous source UVs avoid tile seams. Both triangles use all four actual
        // groundPoint heights, including curved hill cells that aren't planar.
        for (let gy = -MARGIN; gy < board.H + MARGIN; gy++) {
            for (let gx = -MARGIN; gx < board.W + MARGIN; gx++) {
                const a = scene.groundPoint(gx, gy), b = scene.groundPoint(gx + 1, gy);
                const c = scene.groundPoint(gx + 1, gy + 1), d = scene.groundPoint(gx, gy + 1);
                // Directional light is baked continuously into the source plane.
                // Per-cell lighting would reveal a checkerboard on a curved slope.
                const sx=(gx+MARGIN)*PIXELS,sy=(gy+MARGIN)*PIXELS;
                if (Math.abs(c.y - (b.y + d.y - a.y)) <= 0.15) {
                    // Near-planar cells need no clip. Error stays below a world pixel fraction.
                    ctx.save();
                    ctx.transform((b.x-a.x)/PIXELS,(b.y-a.y)/PIXELS,(d.x-a.x)/PIXELS,(d.y-a.y)/PIXELS,a.x,a.y);
                    ctx.drawImage(plane,sx,sy,PIXELS+0.5,PIXELS+0.5,0,0,PIXELS+0.5,PIXELS+0.5);
                    ctx.restore();
                } else {
                    paintTriangle(ctx,plane,sx,sy,[a,b,d],a,{x:b.x-a.x,y:b.y-a.y},{x:d.x-a.x,y:d.y-a.y});
                    paintTriangle(ctx,plane,sx,sy,[b,c,d],{x:b.x+d.x-c.x,y:b.y+d.y-c.y},
                        {x:c.x-d.x,y:c.y-d.y},{x:c.x-b.x,y:c.y-b.y});
                }
            }
        }
        plane.width = plane.height = 1;
        this.paintBridges(ctx, geometry);
        this.paintCamp(ctx);
        this.drawProps(geometry, ctx);
        this.clearGround();
        scene.groundImage?.destroy();
        if (scene.textures.exists('groundTex')) scene.textures.remove('groundTex');
        // Small textures permit camera culling and avoid a GPU-size-dependent mega texture.
        const group = scene.add.group();
        for (let y = 0; y < ground.height; y += CHUNK) for (let x = 0; x < ground.width; x += CHUNK) {
            const part = canvas(Math.min(CHUNK, ground.width - x), Math.min(CHUNK, ground.height - y));
            part.getContext('2d').drawImage(ground, x, y, part.width, part.height, 0, 0, part.width, part.height);
            const key = `terrain-ground-${this.chunkKeys.length}`;
            scene.textures.addImage(key, part);
            this.chunkKeys.push(key);
            group.add(scene.add.image(x, y, key).setOrigin(0, 0).setDepth(0));
        }
        ground.width = ground.height = 1;
        scene.groundImage = group;
        scene._groundTerrain = 'territory';
        scene.terrainLabel?.destroy(); scene.terrainLabel = null;
        scene.terrainVisualStats = { bakeMs: Math.round(performance.now() - started),
            chunks: this.chunkKeys.length, props: scene.terrainProps.length };
    }

    paintMaterials(geometry) {
        const plane = canvas((board.W + MARGIN * 2) * PIXELS, (board.H + MARGIN * 2) * PIXELS);
        const ctx = plane.getContext('2d');
        const patterns = materialPatterns(ctx, this.scene.textures.get(MATERIAL_KEY).getSourceImage());
        const at = value => (value + MARGIN) * PIXELS;
        ctx.fillStyle = patterns[0]; ctx.fillRect(0, 0, plane.width, plane.height);
        // Broad, softly feathered dry patches vary the meadow without drawing a tile grid.
        for (let y = -MARGIN; y < board.H + MARGIN; y += 4) {
            for (let x = -MARGIN; x < board.W + MARGIN; x += 4) {
                const ax = Math.abs(x - board.W / 2), n = noise(ax * 0.12, y * 0.12);
                if (n < 0.48) continue;
                const radius = (2.5 + hash(ax, y) * 4) * PIXELS;
                const gradient = ctx.createRadialGradient(at(x), at(y), 0, at(x), at(y), radius);
                gradient.addColorStop(0, `rgba(199,179,99,${(n - 0.4) * 0.45})`);
                gradient.addColorStop(1, 'rgba(199,179,99,0)');
                ctx.fillStyle = gradient; ctx.fillRect(at(x) - radius, at(y) - radius, radius * 2, radius * 2);
            }
        }
        this.paintRelief(ctx, patterns, at);
        this.paintRoads(ctx, patterns[2], at);
        // Forest-floor material follows the real irregular forest mask.
        for (const zone of geometry.zones.filter(zone => zone.kind === 'forest')) {
            for (let y = zone.y1; y < zone.y2; y += 0.5) for (let x = zone.x1; x < zone.x2; x += 0.5) {
                const density = Terrain.blobField(zone, x + 0.25, y + 0.25);
                if (density <= Terrain.FOREST_EDGE) continue;
                ctx.globalAlpha = Math.min(0.6, (density - Terrain.FOREST_EDGE) * 0.8);
                ctx.fillStyle = patterns[3]; ctx.fillRect(at(x), at(y), PIXELS / 2 + 0.1, PIXELS / 2 + 0.1);
                ctx.globalAlpha = 0.15; ctx.fillStyle = '#23391e';
                ctx.fillRect(at(x), at(y), PIXELS / 2 + 0.1, PIXELS / 2 + 0.1);
            }
        }
        ctx.globalAlpha = 1;
        this.paintRiver(ctx, patterns[4], geometry, at);
        this.paintRockFootprint(ctx, patterns[5], geometry, at);
        return plane;
    }

    paintRelief(ctx, patterns, at) {
        // Interpolate low-frequency weights, then shade each pixel exactly once.
        // Overlapping dark brushes make a hill read as a crater and exceed the
        // intended shade budget; this also removes cell-shaped lighting seams.
        const field = { x1: 0, y1: 0, step: 0.5, cols: board.W * 2 + 2, rows: board.H * 2 + 2 };
        const weights = ['dry', 'earth', 'stone', 'light'].map(() => new Float32Array(field.cols * field.rows));
        for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) {
            const x = (col + 0.5) * field.step, y = (row + 0.5) * field.step;
            const pose = slopeAppearance('territory', x, y, noise(Math.abs(x - board.W / 2) * 0.8 + 9, y * 0.8));
            const i = row * field.cols + col;
            weights[0][i] = pose.dry; weights[1][i] = pose.earth; weights[2][i] = pose.stone; weights[3][i] = pose.light;
        }
        const tileW = MATERIAL_TILE, tileH = MATERIAL_TILE;
        const tile = canvas(tileW, tileH), t = tile.getContext('2d');
        const materials = [patterns[1], patterns[2], patterns[5]].map(pattern => {
            t.fillStyle = pattern; t.fillRect(0, 0, tileW, tileH);
            return t.getImageData(0, 0, tileW, tileH).data;
        });
        const width = (board.W - 2) * PIXELS, height = (board.H - 2) * PIXELS;
        const patch = ctx.getImageData(at(1), at(1), width, height), data = patch.data;
        for (let py = 0; py < height; py += 2) for (let px = 0; px < width; px += 2) {
            const x = 1 + (px + 1) / PIXELS, y = 1 + (py + 1) / PIXELS;
            const dry = sampleBankWeight(field, weights[0], x, y), earth = sampleBankWeight(field, weights[1], x, y);
            const stone = sampleBankWeight(field, weights[2], x, y), light = sampleBankWeight(field, weights[3], x, y);
            if (Math.abs(light) < 0.003 && dry < 0.003 && earth < 0.003) continue;
            for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
                const i = ((py + oy) * width + px + ox) * 4;
                const uv = (((at(1) + py + oy) % tileH) * tileW + (at(1) + px + ox) % tileW) * 4;
                for (let c = 0; c < 3; c++) {
                    let value = data[i + c];
                    value += (materials[0][uv + c] - value) * dry;
                    value += (materials[1][uv + c] - value) * earth;
                    value += (materials[2][uv + c] - value) * stone;
                    const shade = light > 0 ? [235, 221, 157][c] : [31, 44, 36][c];
                    data[i + c] = value + (shade - value) * Math.abs(light) * 0.85;
                }
            }
        }
        ctx.putImageData(patch, at(1), at(1)); tile.width = tile.height = 1;
    }

    paintRiver(ctx, material, geometry, at) {
        const field = buildBankField(geometry), size = field.cols * field.step * PIXELS;
        this.waterField = field;
        if (!size) return;
        const height = field.rows * field.step * PIXELS;
        const water = canvas(size, height), w = water.getContext('2d');
        w.translate(-at(field.x1), -at(field.y1));
        w.fillStyle = material; w.fillRect(at(field.x1), at(field.y1), size, height);
        const source = w.getImageData(0, 0, size, height).data;
        const patch = ctx.getImageData(at(field.x1), at(field.y1), size, height), data = patch.data;
        // Two source pixels are one world pixel after projection. Continuous UVs
        // and signed shore distance replace the old half-grid rectangular bands.
        for (let py = 0; py < height; py += 2) for (let px = 0; px < size; px += 2) {
            const gx = field.x1 + (px + 1) / PIXELS, gy = field.y1 + (py + 1) / PIXELS;
            const col = Math.floor((gx - field.x1) / field.step), row = Math.floor((gy - field.y1) / field.step);
            const kind = field.kinds[row * field.cols + col];
            const n = noise(Math.abs(gx - board.W / 2) * 0.9, gy * 0.9);
            const distance = bankDistance(field, gx, gy);
            const look = bankAppearance(kind, distance, n, sampleBankWeight(field, field.shallowWeight, gx, gy));
            if (!kind && look.shore < 0.005) continue;
            for (let oy = 0; oy < 2 && py + oy < height; oy++) for (let ox = 0; ox < 2 && px + ox < size; ox++) {
                const i = ((py + oy) * size + px + ox) * 4;
                // Underwater sand is visible at the edge; cool depth grows into
                // the centre. Shallows retain the same water texture, gently tinted.
                const tint = (1 - look.depth) * 0.53 + look.shallow;
                const sand = [132 + n * 17, 145 + n * 14, 108 + n * 12];
                for (let c = 0; c < 3; c++) {
                    const grain = hash(gx * 3 + ox, gy * 3 + oy);
                    const sediment = grain > 0.88 ? [151, 144, 110][c] : [93, 85, 57][c];
                    const wet = data[i + c] * 0.6 + sediment * 0.4;
                    const bank = data[i + c] + (wet - data[i + c]) * look.shore;
                    const blue = source[i + c] + (sand[c] - source[i + c]) * Math.min(0.82, tint);
                    data[i + c] = bank + (blue - bank) * look.water;
                }
            }
        }
        ctx.putImageData(patch, at(field.x1), at(field.y1)); water.width = water.height = 1;
    }

    paintRockFootprint(ctx, material, geometry, at) {
        const rocks = geometry.blockers.filter(block => block.kind === 'rock');
        const field = buildBankField({ blockers: rocks.map(block => ({ ...block, kind: 'water' })) });
        if (!field.cols) return;
        const rock = canvas(field.cols * field.step * PIXELS, field.rows * field.step * PIXELS), r = rock.getContext('2d');
        r.translate(-at(field.x1), -at(field.y1)); r.fillStyle = material;
        r.fillRect(at(field.x1), at(field.y1), rock.width, rock.height); r.setTransform(1, 0, 0, 1, 0, 0);
        const patch = r.getImageData(0, 0, rock.width, rock.height);
        for (let y = 0; y < rock.height; y++) for (let x = 0; x < rock.width; x++) {
            const gx = field.x1 + x / PIXELS, gy = field.y1 + y / PIXELS;
            const d = bankDistance(field, gx, gy), n = noise(gx * 1.6, gy * 1.6);
            const alpha = Math.max(0, Math.min(1, (d + 0.7 + n * 0.45) / 1.4));
            patch.data[(y * rock.width + x) * 4 + 3] = Math.round(alpha * 210);
        }
        r.putImageData(patch, 0, 0); ctx.drawImage(rock, at(field.x1), at(field.y1)); rock.width = rock.height = 1;
    }

    paintRoads(ctx, material, at) {
        const W = board.W;
        const routes = [[[8,36],[16,29],[25,24]], [[8,36],[20,48],[34,58]],
            [[25,24],[37,26],[50,34]], [[34,58],[41,45],[49,39]]];
        ctx.lineCap = ctx.lineJoin = 'round';
        for (const mirror of [false, true]) for (const route of routes) {
            const [a,b,c] = route.map(([x,y]) => [at(mirror ? W - x : x), at(y)]);
            ctx.beginPath(); ctx.moveTo(...a); ctx.quadraticCurveTo(...b, ...c);
            for (const [width,alpha] of [[2.1,0.06],[1.8,0.1],[1.5,0.16],[1.18,0.75]]) {
                ctx.lineWidth = width * PIXELS; ctx.globalAlpha = alpha;
                ctx.strokeStyle = material; ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    paintBridges(ctx, geometry) {
        const point = (x,y,lift=0) => { const p = this.scene.groundPoint(x,y); return {x:p.x,y:p.y-lift}; };
        for (const bridge of geometry.zones.filter(zone => zone.kind === 'bridge')) {
            polygon(ctx, [[bridge.x1,bridge.y1],[bridge.x2,bridge.y1],
                [bridge.x2,bridge.y2],[bridge.x1,bridge.y2]].map(([x,y]) => point(x,y,3)));
            ctx.fillStyle = '#a18556'; ctx.fill(); ctx.strokeStyle = '#4e432d'; ctx.lineWidth = 3; ctx.stroke();
            ctx.strokeStyle = '#655234'; ctx.lineWidth = 1.5;
            for (let x = bridge.x1; x < bridge.x2; x += 0.32) {
                const a = point(x,bridge.y1,3), b = point(x,bridge.y2,3);
                ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
            }
            for (const y of [bridge.y1,bridge.y2]) {
                const a = point(bridge.x1,y,14), b = point(bridge.x2,y,14);
                ctx.lineWidth = 4; ctx.strokeStyle = '#c3a477';
                ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
                for (let x = bridge.x1; x <= bridge.x2; x += 1) {
                    const p = point(x,y);
                    ctx.lineWidth = 3; ctx.strokeStyle = '#615037';
                    ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x,p.y-18); ctx.stroke();
                }
            }
        }
    }

    paintCamp(ctx) {
        for (const red of [true,false]) for (const y of [27,45]) {
            const p = this.scene.groundPoint(red ? 6.5 : board.W - 6.5,y);
            ctx.fillStyle = 'rgba(26,30,17,.28)';
            ctx.beginPath(); ctx.ellipse(p.x+7,p.y+3,30,10,0,0,Math.PI*2); ctx.fill();
            polygon(ctx,[{x:p.x-23,y:p.y},{x:p.x,y:p.y-33},{x:p.x+26,y:p.y}]);
            ctx.fillStyle = '#d5c6a3'; ctx.fill(); ctx.strokeStyle = '#75674d'; ctx.lineWidth=2;ctx.stroke();
            polygon(ctx,[{x:p.x-7,y:p.y},{x:p.x,y:p.y-18},{x:p.x+7,y:p.y}]);
            ctx.fillStyle = '#36362b';ctx.fill();
            ctx.fillStyle = red ? '#a94a3b' : '#446994'; ctx.fillRect(p.x-2,p.y-38,13,7);
        }
    }

    drawProps(geometry, ground) {
        const scene = this.scene, texture = scene.textures.get(PROP_KEY);
        // The generated trees need a taller first row to include their complete roots.
        const source = texture.getSourceImage(), w = source.width/3, split=source.height*620/1024;
        for (let i=0;i<6;i++) if (!texture.has(`prop-${i}`)) {
            texture.add(`prop-${i}`,0,i%3*w,i<3?0:split,w,i<3?split:source.height-split);
        }
        for (const prop of scene.terrainProps || []) prop.destroy();
        scene.terrainProps = [];
        const place = (x,y,frame,height,flip=false) => {
            const p = scene.groundPoint(x,y);
            const tree = frame < 3, h=tree?split:source.height-split;
            const width = height*(tree?0.27:frame===5?0.55:0.3);
            ground.save();
            ground.translate(p.x+width*0.45,p.y+width*0.18);
            ground.scale(1,0.42);
            const shade=ground.createRadialGradient(0,0,0,0,0,width);
            shade.addColorStop(0,'rgba(24,30,16,.35)'); shade.addColorStop(1,'rgba(24,30,16,0)');
            ground.fillStyle=shade;ground.fillRect(-width,-width,width*2,width*2);ground.restore();
            const sprite = scene.add.image(p.x,p.y,PROP_KEY,`prop-${frame}`)
                .setOrigin(0.5,tree?0.95:0.84).setScale(height/h).setFlipX(flip).setDepth((x+y)*100+40);
            scene.terrainProps.push(sprite);
        };
        // Jittered, dense woodland interiors and smaller trees along the true forest edge.
        for (const zone of geometry.zones.filter(zone=>zone.kind==='forest')) {
            for (let y=zone.y1+0.65;y<zone.y2;y+=1.35) for (let x=zone.x1+0.65;x<zone.x2;x+=1.35) {
                const n=hash(Math.abs(x-board.W/2),y);
                const tx=x+(n-0.5)*0.85, ty=y+(hash(y,x)-0.5)*0.85;
                if (!Terrain.contains(zone,tx,ty) || n<0.13) continue;
                const density=Terrain.blobField(zone,tx,ty);
                place(tx,ty,n>0.78?2:n>0.4?1:0,(density>0.65?150:108)+n*25,n>0.5);
                if (n>0.65) place(tx+0.45,ty+0.55,3,48);
            }
        }
        // Sparse clumps leave the deployment areas, roads and objective approaches readable.
        for (let i=0;i<85;i++) {
            const x=8+hash(i,97)*(board.W/2-14), y=5+hash(i,149)*(board.H-10);
            for (const tx of [x,board.W-x]) {
                if (Terrain.surface('territory',tx,y)!=='grass') continue;
                const nearHome=Math.min(tx,board.W-tx)<18 && Math.abs(y-board.H/2)<17;
                const nearHill=Math.hypot((tx-board.W/2)/15,(y-board.H/2)/12)<1;
                if (nearHome || nearHill) continue;
                place(tx,y,i%7===0?0:3,i%7===0?116:34+hash(i,48)*18,i%2===0);
            }
        }
        this.drawRocks(geometry, ground, place);
        for (const zone of geometry.zones.filter(zone=>zone.kind==='shallow')) {
            for (const y of [zone.y1-0.2,zone.y2+0.2]) {
                place((zone.x1+zone.x2)/2,y,4,55);
            }
        }
        // Reeds occur in sparse bank pockets, leaving the bridge and the real
        // land crossing open. Their irregular silhouettes break the strip edge.
        const field = this.waterField;
        for (let y = field.y1; y < field.y1 + field.rows * field.step; y += 0.85) {
            for (let x = field.x1; x < field.x1 + field.cols * field.step; x += 1.05) {
                const n = hash(Math.abs(x - board.W / 2), y + 67);
                if (n < 0.64) continue;
                const tx = x + (n - 0.5) * 0.65, ty = y + (hash(y, x) - 0.5) * 0.4;
                const d = bankDistance(field, tx, ty);
                if (d > -0.15 || d < -0.85 || Terrain.surface('territory', tx, ty) !== 'grass') continue;
                if (geometry.zones.some(b => b.kind === 'bridge' && tx > b.x1 - 1.2 && tx < b.x2 + 1.2)) continue;
                place(tx, ty, 4, 29 + n * 22);
            }
        }
    }

    drawRocks(geometry, ground, fallback) {
        const scene = this.scene;
        if (!scene.textures.exists(ROCK_KEY)) {
            for (const rock of rockPlacements(geometry)) fallback(rock.x, rock.y, 5, rock.height);
            return;
        }
        const texture = scene.textures.get(ROCK_KEY);
        // Trim atlas padding, preserving the six distinct silhouettes and their
        // ground baselines. No horizontal flip: sunlight stays upper-left.
        const frames = [[25,203,501,252], [562,156,415,304], [1012,247,508,212],
            [59,649,422,236], [561,717,413,170], [1052,754,441,123]];
        for (let i = 0; i < frames.length; i++) if (!texture.has(`rock-${i}`)) texture.add(`rock-${i}`, 0, ...frames[i]);
        for (const rock of rockPlacements(geometry)) {
            const p = scene.groundPoint(rock.x, rock.y), frame = texture.get(`rock-${rock.frame}`);
            const scale = rock.height / frame.height, width = frame.width * scale;
            ground.save(); ground.translate(p.x + width * 0.15, p.y + 3); ground.scale(1, 0.3);
            const shade = ground.createRadialGradient(0, 0, 0, 0, 0, width * 0.48);
            shade.addColorStop(0, 'rgba(27,30,23,.48)'); shade.addColorStop(1, 'rgba(27,30,23,0)');
            ground.fillStyle = shade; ground.fillRect(-width / 2, -width / 2, width, width); ground.restore();
            const sprite = scene.add.image(p.x, p.y, ROCK_KEY, `rock-${rock.frame}`)
                .setOrigin(0.5, 0.91).setScale(scale).setDepth((rock.x + rock.y) * 100 + 40);
            scene.terrainProps.push(sprite);
        }
    }
}
