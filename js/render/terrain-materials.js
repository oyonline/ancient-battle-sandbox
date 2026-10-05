// Material baking is view-only: all surfaces, heights and blockers come from Terrain.
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { VIEW_W, VIEW_H, OX, OY, TW, TH, makeNoise } from './metrics.js';
import { buildBankFieldSteps, bankDistance, bankAppearance, sampleBankWeight, slopeAppearance, rockPlacements } from './terrain-naturalness.js';
import { FrameJob, prioritizeChunks } from './frame-job.js';

const MATERIAL_KEY = 'terrain/materials';
const PROP_KEY = 'terrain/props';
const ROCK_KEY = 'terrain/rocks-v2';
const PIXELS = 32;
const MARGIN = 16;
const CHUNK = 512;
const MATERIAL_TILE = 192;
const noise = makeNoise(73);
const materialFrames = new WeakMap();
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
    let frames = materialFrames.get(source);
    if (!frames) {
        frames = Array.from({ length: 6 }, (_, index) => {
            const tile = canvas(MATERIAL_TILE, MATERIAL_TILE);
            tile.getContext('2d').drawImage(source, index % 3 * source.width / 3,
                Math.floor(index / 3) * source.height / 2, source.width / 3, source.height / 2,
                0, 0, tile.width, tile.height);
            return tile;
        });
        materialFrames.set(source, frames);
    }
    return frames.map(tile => ctx.createPattern(tile, 'repeat'));
}

// The source UV plane is baked only for the cells visible in one world chunk.
// Extra rows cover height displacement and antialiased cell edges without
// changing the 32px material detail or the 64×32 world projection.
export function terrainBakeRegion(x, y, width, height) {
    const corners = [[x,y],[x+width,y],[x,y+height],[x+width,y+height]].map(([sx,sy]) => {
        const a = (sx - OX) / (TW / 2), b = (sy - OY) / (TH / 2);
        return { gx: (a + b) / 2, gy: (b - a) / 2 };
    });
    return {
        x1: Math.max(-MARGIN, Math.floor(Math.min(...corners.map(p => p.gx))) - 2),
        y1: Math.max(-MARGIN, Math.floor(Math.min(...corners.map(p => p.gy))) - 2),
        x2: Math.min(board.W + MARGIN, Math.ceil(Math.max(...corners.map(p => p.gx))) + 8),
        y2: Math.min(board.H + MARGIN, Math.ceil(Math.max(...corners.map(p => p.gy))) + 8)
    };
}

export function intersectBakeRegion(region, bounds) {
    const clipped = { x1: Math.max(region.x1, bounds.x1), y1: Math.max(region.y1, bounds.y1),
        x2: Math.min(region.x2, bounds.x2), y2: Math.min(region.y2, bounds.y2) };
    return clipped.x2 > clipped.x1 && clipped.y2 > clipped.y1 ? clipped : null;
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
        this.bakeJob?.cancel();
        this.bakeJob = null;
        this.reliefField = null;
        this.exteriorWater = null;
        this.groundShadows = [];
        this.scene.terrainLoading = false;
        this.updateLoadingUI();
        if (!this.chunkKeys.length && !this.scene.groundImage) return;
        this.scene.groundImage?.destroy(true);
        this.scene.groundImage = null;
        this.chunkKeys.forEach(key => this.scene.textures.remove(key));
        this.chunkKeys = [];
    }

    draw() {
        const scene = this.scene;
        this.clearGround();
        scene.terrainLoading = true;
        scene.terrainVisualStats = { progress: 0, chunks: 0, bakeMs: 0 };
        // Set the destination now: another same-map deployment must not restart the job.
        scene._groundTerrain = 'territory';
        this.bakeJob = new FrameJob(this.bake());
        this.updateLoadingUI();
    }

    updateBake() {
        if (!this.bakeJob || this.bakeJob.done) return;
        this.bakeJob.update();
        this.scene.terrainVisualStats.bakeMs = Math.round(this.bakeJob.workMs);
        if (this.bakeJob.done) {
            this.scene.terrainLoading = false;
            if (typeof UI !== 'undefined') UI.syncControls?.();
        }
        this.updateLoadingUI();
    }

    updateLoadingUI() {
        if (typeof document === 'undefined') return;
        const panel = document.getElementById('terrain-loading');
        if (!panel) return;
        panel.hidden = !this.scene.terrainLoading;
        const progress = document.getElementById('terrain-loading-progress');
        if (progress) {
            const percent = Math.floor((this.scene.terrainVisualStats?.progress || 0) * 100);
            if (progress.textContent !== `${percent}%`) progress.textContent = `${percent}%`;
        }
    }

    *bake() {
        const scene = this.scene;
        const geometry = Terrain.geometry('territory');
        scene.groundImage?.destroy();
        if (scene.textures.exists('groundTex')) scene.textures.remove('groundTex');
        this.waterField = yield* buildBankFieldSteps(geometry);
        this.reliefField = null; this.exteriorWater = null;
        const rocks=geometry.blockers.filter(block=>block.kind==='rock');
        this.rockField = yield* buildBankFieldSteps({ blockers: rocks.map(block => ({ ...block, kind: 'water' })) });
        this.groundShadows = [];
        this.drawProps(geometry, null);
        const group = scene.add.group();
        scene.groundImage = group;
        yield;
        // A repeated small grass frame supplies the distant land without baking
        // transparent corners into another map-sized CPU/GPU canvas.
        const material=scene.textures.get(MATERIAL_KEY),source=material.getSourceImage();
        if (!material.has('distant-grass')) material.add('distant-grass',0,0,0,source.width/3,source.height/2);
        group.add(scene.add.tileSprite(0,0,512,512,MATERIAL_KEY,'distant-grass')
            .setOrigin(0).setDepth(-1).setDisplaySize(VIEW_W,VIEW_H).setTileScale(512/VIEW_W,512/VIEW_H));
        // Relief used to be computed in one long first-tile call. Yield between rows.
        yield* this.prepareRelief();
        const camera = scene.cameras.main;
        const center = camera.getWorldPoint(camera.width / 2, camera.height / 2);
        const chunks = prioritizeChunks(VIEW_W, VIEW_H, CHUNK, center);
        let maxSourcePixels = 0, visited = 0;
        for (const { x, y, width, height } of chunks) {
            scene.terrainVisualStats.progress = 0.2 + 0.8 * visited++ / chunks.length;
            yield;
            const region = terrainBakeRegion(x, y, width, height);
            if (region.x2 <= region.x1 || region.y2 <= region.y1) continue;
            const cells = [];
            for (let gy = region.y1; gy < region.y2; gy++) for (let gx = region.x1; gx < region.x2; gx++) {
                const a = scene.groundPoint(gx, gy), b = scene.groundPoint(gx + 1, gy);
                const c = scene.groundPoint(gx + 1, gy + 1), d = scene.groundPoint(gx, gy + 1);
                if (Math.max(a.x,b.x,c.x,d.x) < x - 1 || Math.min(a.x,b.x,c.x,d.x) > x + width + 1 ||
                    Math.max(a.y,b.y,c.y,d.y) < y - 1 || Math.min(a.y,b.y,c.y,d.y) > y + height + 1) continue;
                cells.push({gx,gy,a,b,c,d});
            }
            if (!cells.length && !this.exteriorIntersects(x,y,width,height)) continue;
            const plane = cells.length ? this.paintMaterials(geometry,region) : null;
            if (plane) maxSourcePixels=Math.max(maxSourcePixels,plane.width*plane.height);
            const part = canvas(width, height), ctx = part.getContext('2d');
            ctx.translate(-x, -y);
            for (const {gx,gy,a,b,c,d} of cells) {
                const sx=(gx-region.x1)*PIXELS, sy=(gy-region.y1)*PIXELS;
                if (Math.abs(c.y - (b.y + d.y - a.y)) <= 0.15) {
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
            if (plane) plane.width=plane.height=1;
            this.paintBridges(ctx, geometry);
            this.paintCamp(ctx);
            for (const shadow of this.groundShadows) {
                if (shadow.x + shadow.radius < x || shadow.x - shadow.radius > x + width ||
                    shadow.y + shadow.radius * shadow.sy < y || shadow.y - shadow.radius * shadow.sy > y + height) continue;
                this.paintShadow(ctx, shadow);
            }
            const key = `terrain-ground-${this.chunkKeys.length}`;
            scene.textures.addImage(key, part);
            this.chunkKeys.push(key);
            group.add(scene.add.image(x, y, key).setOrigin(0, 0).setDepth(0));
        }
        if (this.exteriorWater) this.exteriorWater.width = this.exteriorWater.height = 1;
        this.exteriorWater = null; this.reliefField = null; this.groundShadows = [];
        scene.groundImage = group;
        scene._groundTerrain = 'territory';
        scene.terrainLabel?.destroy(); scene.terrainLabel = null;
        scene.terrainVisualStats = { progress: 1, bakeMs: 0,
            chunks: this.chunkKeys.length, props: scene.terrainProps.length, maxSourcePixels,
            maxTemporaryCanvasPixels: maxSourcePixels + CHUNK * CHUNK };
    }

    exteriorIntersects() { return false; }

    *prepareRelief() {
        const field = { x1: 0, y1: 0, step: 0.5, cols: board.W * 2 + 2, rows: board.H * 2 + 2 };
        const weights = ['dry', 'earth', 'stone', 'light'].map(() => new Float32Array(field.cols * field.rows));
        for (let row = 0; row < field.rows; row++) {
            for (let col = 0; col < field.cols; col++) {
                const x = (col + 0.5) * field.step, y = (row + 0.5) * field.step;
                const pose = slopeAppearance('territory', x, y, noise(Math.abs(x - board.W / 2) * 0.8 + 9, y * 0.8));
                const i = row * field.cols + col;
                weights[0][i] = pose.dry; weights[1][i] = pose.earth;
                weights[2][i] = pose.stone; weights[3][i] = pose.light;
            }
            if (row % 4 === 3) {
                this.scene.terrainVisualStats.progress = 0.2 * row / field.rows;
                yield;
            }
        }
        this.reliefField = { field, weights };
    }

    paintShadow(ctx, shadow) {
        ctx.save(); ctx.translate(shadow.x,shadow.y); ctx.scale(1,shadow.sy);
        const shade = ctx.createRadialGradient(0,0,0,0,0,shadow.radius);
        shade.addColorStop(0,shadow.color); shade.addColorStop(1,'rgba(24,30,16,0)');
        ctx.fillStyle = shade;
        ctx.fillRect(-shadow.radius,-shadow.radius,shadow.radius*2,shadow.radius*2);
        ctx.restore();
    }

    paintMaterials(geometry, region) {
        const plane = canvas((region.x2-region.x1)*PIXELS,(region.y2-region.y1)*PIXELS);
        const ctx = plane.getContext('2d');
        ctx.translate(-region.x1*PIXELS,-region.y1*PIXELS);
        const patterns = materialPatterns(ctx, this.scene.textures.get(MATERIAL_KEY).getSourceImage());
        const at = value => value * PIXELS;
        ctx.fillStyle = patterns[0]; ctx.fillRect(at(region.x1),at(region.y1),plane.width,plane.height);
        // Lower meadow micro-contrast so units and objectives lead the eye.
        ctx.fillStyle = 'rgba(94,111,57,0.25)';
        ctx.fillRect(at(region.x1), at(region.y1), plane.width, plane.height);
        // Broad, softly feathered dry patches vary the meadow without drawing a tile grid.
        for (let y = Math.floor((region.y1-8)/4)*4; y < region.y2+8; y += 4) {
            for (let x = Math.floor((region.x1-8)/4)*4; x < region.x2+8; x += 4) {
                const ax = Math.abs(x - board.W / 2), n = noise(ax * 0.12, y * 0.12);
                if (n < 0.48) continue;
                const radius = (2.5 + hash(ax, y) * 4) * PIXELS;
                const gradient = ctx.createRadialGradient(at(x), at(y), 0, at(x), at(y), radius);
                gradient.addColorStop(0, `rgba(199,179,99,${(n - 0.4) * 0.45})`);
                gradient.addColorStop(1, 'rgba(199,179,99,0)');
                ctx.fillStyle = gradient; ctx.fillRect(at(x) - radius, at(y) - radius, radius * 2, radius * 2);
            }
        }
        this.paintRelief(ctx, patterns, at, region);
        this.paintRoads(ctx, patterns[2], at);
        // Forest-floor material follows the real irregular forest mask.
        for (const zone of geometry.zones.filter(zone => zone.kind === 'forest')) {
            for (let y = Math.max(zone.y1,region.y1); y < Math.min(zone.y2,region.y2); y += 0.5) for (let x = Math.max(zone.x1,region.x1); x < Math.min(zone.x2,region.x2); x += 0.5) {
                const density = Terrain.blobField(zone, x + 0.25, y + 0.25);
                if (density <= Terrain.FOREST_EDGE) continue;
                ctx.globalAlpha = Math.min(0.6, (density - Terrain.FOREST_EDGE) * 0.8);
                ctx.fillStyle = patterns[3]; ctx.fillRect(at(x), at(y), PIXELS / 2 + 0.1, PIXELS / 2 + 0.1);
                ctx.globalAlpha = 0.15; ctx.fillStyle = '#23391e';
                ctx.fillRect(at(x), at(y), PIXELS / 2 + 0.1, PIXELS / 2 + 0.1);
            }
        }
        ctx.globalAlpha = 1;
        this.paintRiver(ctx, patterns[4], geometry, at, region);
        this.paintRockFootprint(ctx, patterns[5], geometry, at, region);
        return plane;
    }

    paintRelief(ctx, patterns, at, region) {
        const clipped = intersectBakeRegion(region,{x1:1,y1:1,x2:board.W-1,y2:board.H-1});
        if (!clipped) return;
        if (!this.reliefField) {
            // Direct isolated paint callers can still prepare the same field.
            for (const _ of this.prepareRelief()) { /* normal bake prepares it incrementally */ }
        }
        const {field,weights}=this.reliefField;
        const tile=canvas(MATERIAL_TILE,MATERIAL_TILE),t=tile.getContext('2d');
        const materials=[patterns[1],patterns[2],patterns[5]].map(pattern => {
            t.fillStyle=pattern;t.fillRect(0,0,MATERIAL_TILE,MATERIAL_TILE);
            return t.getImageData(0,0,MATERIAL_TILE,MATERIAL_TILE).data;
        });
        const width=(clipped.x2-clipped.x1)*PIXELS,height=(clipped.y2-clipped.y1)*PIXELS;
        const offsetX=(clipped.x1-region.x1)*PIXELS,offsetY=(clipped.y1-region.y1)*PIXELS;
        const patch=ctx.getImageData(offsetX,offsetY,width,height),data=patch.data;
        for (let py=0;py<height;py+=2) for (let px=0;px<width;px+=2) {
            const x=clipped.x1+(px+1)/PIXELS,y=clipped.y1+(py+1)/PIXELS;
            const dry=sampleBankWeight(field,weights[0],x,y),earth=sampleBankWeight(field,weights[1],x,y);
            const stone=sampleBankWeight(field,weights[2],x,y),light=sampleBankWeight(field,weights[3],x,y);
            if (Math.abs(light)<0.003 && dry<0.003 && earth<0.003) continue;
            for (let oy=0;oy<2;oy++) for (let ox=0;ox<2;ox++) {
                const i=((py+oy)*width+px+ox)*4;
                // UVs remain global even when neighboring chunks start on different cells.
                const uv=(((at(clipped.y1)+py+oy)%MATERIAL_TILE)*MATERIAL_TILE+(at(clipped.x1)+px+ox)%MATERIAL_TILE)*4;
                for (let c=0;c<3;c++) {
                    let value=data[i+c];
                    value+=(materials[0][uv+c]-value)*dry;
                    value+=(materials[1][uv+c]-value)*earth;
                    value+=(materials[2][uv+c]-value)*stone;
                    const shade=light>0?[235,221,157][c]:[31,44,36][c];
                    data[i+c]=value+(shade-value)*Math.abs(light)*0.85;
                }
            }
        }
        ctx.putImageData(patch,offsetX,offsetY);tile.width=tile.height=1;
    }

    paintRiver(ctx, material, geometry, at, region) {
        const field = this.waterField;
        const clipped=intersectBakeRegion(region,{x1:field.x1,y1:field.y1,x2:field.x1+field.cols*field.step,y2:field.y1+field.rows*field.step});
        if (!clipped) return;
        const size=(clipped.x2-clipped.x1)*PIXELS,height=(clipped.y2-clipped.y1)*PIXELS;
        const water = canvas(size, height), w = water.getContext('2d');
        w.translate(-at(clipped.x1), -at(clipped.y1));
        w.fillStyle = material; w.fillRect(at(clipped.x1),at(clipped.y1),size,height);
        const source = w.getImageData(0, 0, size, height).data;
        const ox=(clipped.x1-region.x1)*PIXELS,oy=(clipped.y1-region.y1)*PIXELS;
        const patch=ctx.getImageData(ox,oy,size,height),data=patch.data;
        // Two source pixels are one world pixel after projection. Continuous UVs
        // and signed shore distance replace the old half-grid rectangular bands.
        for (let py = 0; py < height; py += 2) for (let px = 0; px < size; px += 2) {
            const gx=clipped.x1+(px+1)/PIXELS,gy=clipped.y1+(py+1)/PIXELS;
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
        ctx.putImageData(patch,ox,oy);water.width=water.height=1;
    }

    paintRockFootprint(ctx, material, geometry, at, region) {
        const field=this.rockField;
        if (!field.cols) return;
        const clipped=intersectBakeRegion(region,{x1:field.x1,y1:field.y1,x2:field.x1+field.cols*field.step,y2:field.y1+field.rows*field.step});
        if (!clipped) return;
        const rock=canvas((clipped.x2-clipped.x1)*PIXELS,(clipped.y2-clipped.y1)*PIXELS),r=rock.getContext('2d');
        r.translate(-at(clipped.x1),-at(clipped.y1));r.fillStyle=material;
        r.fillRect(at(clipped.x1),at(clipped.y1),rock.width,rock.height); r.setTransform(1, 0, 0, 1, 0, 0);
        const patch = r.getImageData(0, 0, rock.width, rock.height);
        for (let y = 0; y < rock.height; y++) for (let x = 0; x < rock.width; x++) {
            const gx=clipped.x1+x/PIXELS,gy=clipped.y1+y/PIXELS;
            const d = bankDistance(field, gx, gy), n = noise(gx * 1.6, gy * 1.6);
            const alpha = Math.max(0, Math.min(1, (d + 0.7 + n * 0.45) / 1.4));
            patch.data[(y * rock.width + x) * 4 + 3] = Math.round(alpha * 210);
        }
        r.putImageData(patch, 0, 0); ctx.drawImage(rock,at(clipped.x1),at(clipped.y1)); rock.width = rock.height = 1;
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
            const shadow={x:p.x+width*0.45,y:p.y+width*0.18,radius:width,sy:0.42,color:'rgba(24,30,16,.35)'};
            if (ground) this.paintShadow(ground,shadow); else this.groundShadows.push(shadow);
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
            const shadow={x:p.x+width*0.15,y:p.y+3,radius:width*0.48,sy:0.3,color:'rgba(27,30,23,.48)'};
            if (ground) this.paintShadow(ground,shadow); else this.groundShadows.push(shadow);
            const sprite = scene.add.image(p.x, p.y, ROCK_KEY, `rock-${rock.frame}`)
                .setOrigin(0.5, 0.91).setScale(scale).setDepth((rock.x + rock.y) * 100 + 40);
            scene.terrainProps.push(sprite);
        }
    }
}
