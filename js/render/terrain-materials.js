// Material baking is view-only: all surfaces, heights and blockers come from Terrain.
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { VIEW_W, VIEW_H, makeNoise } from './metrics.js';
import { buildWaterField } from './terrain-boundaries.js';

const MATERIAL_KEY = 'terrain/materials';
const PROP_KEY = 'terrain/props';
const PIXELS = 32;
const MARGIN = 16;
const CHUNK = 1024;
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
        const tile = canvas(192, 192);
        tile.getContext('2d').drawImage(source, index % 3 * source.width / 3,
            Math.floor(index / 3) * source.height / 2, source.width / 3, source.height / 2,
            0, 0, tile.width, tile.height);
        return ctx.createPattern(tile, 'repeat');
    });
}

function paintTriangle(ctx, source, sx, sy, points, origin, xAxis, yAxis, light) {
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
    ctx.fillStyle=light>0?'#ffedb5':'#182b23';ctx.globalAlpha=Math.min(0.3,Math.abs(light));
    ctx.fillRect(0,0,PIXELS+0.5,PIXELS+0.5);ctx.restore();
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
                const dx = scene.terrainHeight(gx + 0.5, gy) - scene.terrainHeight(gx - 0.5, gy);
                const dy = scene.terrainHeight(gx, gy + 0.5) - scene.terrainHeight(gx, gy - 0.5);
                const light = dx * 0.32 + dy * 0.23;
                const sx=(gx+MARGIN)*PIXELS,sy=(gy+MARGIN)*PIXELS;
                if (Math.abs(c.y - (b.y + d.y - a.y)) <= 0.15) {
                    // Near-planar cells need no clip. Error stays below a world pixel fraction.
                    ctx.save();
                    ctx.transform((b.x-a.x)/PIXELS,(b.y-a.y)/PIXELS,(d.x-a.x)/PIXELS,(d.y-a.y)/PIXELS,a.x,a.y);
                    ctx.drawImage(plane,sx,sy,PIXELS+0.5,PIXELS+0.5,0,0,PIXELS+0.5,PIXELS+0.5);
                    ctx.fillStyle=light>0?'#ffedb5':'#182b23';ctx.globalAlpha=Math.min(0.3,Math.abs(light));
                    ctx.fillRect(0,0,PIXELS+0.5,PIXELS+0.5);ctx.restore();
                } else {
                    paintTriangle(ctx,plane,sx,sy,[a,b,d],a,{x:b.x-a.x,y:b.y-a.y},{x:d.x-a.x,y:d.y-a.y},light);
                    paintTriangle(ctx,plane,sx,sy,[b,c,d],{x:b.x+d.x-c.x,y:b.y+d.y-c.y},
                        {x:c.x-d.x,y:c.y-d.y},{x:c.x-b.x,y:c.y-b.y},light);
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
        const field = buildWaterField(geometry);
        for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) {
            const i = row * field.cols + col, kind = field.kinds[i];
            const x = field.x1 + col * field.step, y = field.y1 + row * field.step;
            const size = PIXELS * field.step + 0.1;
            if (!kind) {
                const nearby = [i - 1, i + 1, i - field.cols, i + field.cols]
                    .some(j => j >= 0 && j < field.kinds.length && field.kinds[j]);
                if (nearby) {
                    ctx.globalAlpha = 0.38; ctx.fillStyle = patterns[3];
                    ctx.fillRect(at(x), at(y), size, size); ctx.globalAlpha = 1;
                }
                continue;
            }
            // Distance is to the UNION shore, never the edge of an individual river strip.
            ctx.fillStyle = patterns[4]; ctx.fillRect(at(x), at(y), size, size);
            const depth = Math.min(1, field.distance[i] / 2.4);
            ctx.globalAlpha = kind === 2 ? 0.64 : (1 - depth) * 0.52;
            ctx.fillStyle = kind === 2 ? '#a2b09a' : '#849e80';
            ctx.fillRect(at(x), at(y), size, size); ctx.globalAlpha = 1;
        }
        for (const rock of geometry.blockers.filter(block => block.kind === 'rock')) {
            ctx.fillStyle = patterns[5];
            ctx.fillRect(at(rock.x1), at(rock.y1), (rock.x2 - rock.x1) * PIXELS, (rock.y2 - rock.y1) * PIXELS);
        }
        return plane;
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
        // Cliff modules sit on the actual rock mask; no decorative wall changes walkability.
        const placed=new Set();
        for (const block of geometry.blockers.filter(block=>block.kind==='rock')) {
            const y=block.y2-0.5;
            for (let x=block.x1+0.4;x<block.x2;x+=2.4) {
                const key=`${Math.round(x/2.4)},${y}`;
                if (placed.has(key)) continue; placed.add(key);
                place(x,y,5,117+hash(x,y)*14,x>board.W/2);
                if (hash(x,y)>0.55) place(x,block.y1+1,5,58,x>board.W/2);
            }
        }
        for (const zone of geometry.zones.filter(zone=>zone.kind==='shallow')) {
            for (const y of [zone.y1-0.2,zone.y2+0.2]) {
                place((zone.x1+zone.x2)/2,y,4,55);
            }
        }
    }
}
