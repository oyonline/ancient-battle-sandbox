// Territory presentation reuses the terrain atlas; layout stays in simulation.
import { TerrainMaterialsRenderer } from './terrain-materials.js';
import { buildBankField, bankDistance, bankAppearance, sampleBankWeight } from './terrain-naturalness.js';
import { sampleWaterField } from './terrain-boundaries.js';
import { territoryLayout } from '../territory-map.js';
import { Terrain } from '../terrain.js';
import { board } from '../board.js';
import { TW, TH } from './metrics.js';

const PIXELS = 32;
const clamp = n => Math.max(0, Math.min(1, n));
const hash = (a, b) => Terrain._hash2(a, b);
function riverColor(gx, gy, depth, shallow, variation) {
    const d = clamp(depth * (1 - shallow * 2));
    const reflection = Math.sin(gy * 1.1 + gx * 0.32) * 2 + variation * 5;
    return [111 + reflection - d * 68, 139 + reflection - d * 44, 116 + reflection - d * 28];
}

// Short longitudinal glints travel in grid coordinates, then get projected.
// Sample the entire stroke: no glint may cross a bank or paint over the bridge.
export function riverFlowMark(field, index, time) {
    const gx = board.W / 2 + (hash(index, 39) - 0.5) * 7;
    const span = field.rows * field.step - 4;
    const gy = field.y1 + 2 + ((hash(index, 67) * span - time * 0.00012) % span + span) % span;
    const length = 0.4 + hash(index, 91) * 0.4;
    for (let dy = 0; dy <= length + 0.1; dy += 0.1) {
        const y = gy - Math.min(dy, length), kind = sampleWaterField(field, gx, y).kind;
        if ((kind !== 1 && kind !== 2) || bankDistance(field, gx, y) < 0.4 ||
            !['water', 'shallow'].includes(Terrain.surface('territory', gx, y))) return null;
    }
    return { gx, gy, length, alpha: 0.09 + hash(index, 13) * 0.085 };
}

export class TerritoryMapRenderer extends TerrainMaterialsRenderer {
    draw() {
        super.draw();
        this.riverFlow = this.scene.add.graphics().setDepth(1);
        this.flowAt = -Infinity;
        this.updateRiverFlow(0);
    }

    clearGround() {
        this.riverFlow?.destroy(); this.riverFlow = null;
        super.clearGround();
    }

    updateRiverFlow(now) {
        if (!this.riverFlow || now - this.flowAt < 100) return;
        this.flowAt = now;
        const g = this.riverFlow;
        g.clear();
        for (let i = 0; i < 56; i++) {
            const mark = riverFlowMark(this.waterField, i, now);
            if (!mark) continue;
            const a = this.scene.groundPoint(mark.gx, mark.gy);
            const b = this.scene.groundPoint(mark.gx, mark.gy - mark.length);
            g.lineStyle(1.8, 0xc8d9bd, mark.alpha);
            g.lineBetween(a.x, a.y, b.x, b.y);
        }
    }

    paintRiver(ctx, _material, geometry, at) {
        const field = buildBankField(geometry);
        this.waterField = field;
        const width = field.cols * field.step * PIXELS, height = field.rows * field.step * PIXELS;
        const patch = ctx.getImageData(at(field.x1), at(field.y1), width, height), data = patch.data;
        for (let py = 0; py < height; py += 2) for (let px = 0; px < width; px += 2) {
            const gx = field.x1 + (px + 1) / PIXELS, gy = field.y1 + (py + 1) / PIXELS;
            const kind = sampleWaterField(field, gx, gy).kind;
            const n = Terrain._vnoise(Math.abs(gx - board.W / 2) * 0.5 + 9, gy * 0.24);
            const look = bankAppearance(kind, bankDistance(field, gx, gy), n,
                sampleBankWeight(field, field.shallowWeight, gx, gy));
            if (!kind && look.shore < 0.005) continue;
            // Quiet, broad reflections replace the repeating bright ripple tile.
            // Shallow sediment and deep olive-blue blend continuously by bank distance.
            const water = riverColor(gx, gy, look.depth, look.shallow, n);
            for (let oy = 0; oy < 2 && py + oy < height; oy++) for (let ox = 0; ox < 2 && px + ox < width; ox++) {
                const i = ((py + oy) * width + px + ox) * 4;
                const grain = hash(Math.floor(gx * 47) + ox, Math.floor(gy * 47) + oy);
                for (let c = 0; c < 3; c++) {
                    const mud = [108, 104, 73][c] + grain * 15;
                    const bank = data[i + c] + (mud - data[i + c]) * look.shore * 0.45;
                    data[i + c] = bank + (water[c] + (grain - 0.5) * 3 - bank) * look.water;
                }
            }
        }
        ctx.putImageData(patch, at(field.x1), at(field.y1));
    }

    paintBridges(ctx, geometry) {
        // The meadow bake extends outside the playable board. Continue the
        // upstream water beyond that bake so its northern end cannot look like
        // a canal cut off in the middle of the surrounding grass. Every point
        // here has gy < 0; the playable shoreline and blockers stay untouched.
        // One continuous UV plane avoids seams between projected strip quads.
        const x1 = board.W / 2 - 6, y1 = -100;
        const exterior = document.createElement('canvas');
        exterior.width = 12 * PIXELS; exterior.height = 90 * PIXELS;
        const e = exterior.getContext('2d'), patch = e.createImageData(exterior.width, exterior.height);
        for (let py = 0; py < exterior.height; py += 2) for (let px = 0; px < exterior.width; px += 2) {
            const gx = x1 + (px + 1) / PIXELS, gy = y1 + (py + 1) / PIXELS;
            const half = 3.55 + Math.sin((gy + 7) * 0.29) * 0.6 + Math.cos(gy * 0.53) * 0.3;
            const distance = half - Math.abs(gx - board.W / 2);
            if (distance <= 0) continue;
            const n = Terrain._vnoise(Math.abs(gx - board.W / 2) * 0.5 + 9, gy * 0.24);
            const look = bankAppearance(1, distance, n), color = riverColor(gx, gy, look.depth, 0, n);
            for (let oy=0;oy<2;oy++) for (let ox=0;ox<2;ox++) {
                const i = ((py+oy)*exterior.width+px+ox)*4;
                for (let c=0;c<3;c++) patch.data[i+c] = color[c];
                patch.data[i+3] = look.water * clamp(distance / 0.18) * clamp((-10-gy)/2) * 255;
            }
        }
        e.putImageData(patch,0,0);
        const origin = this.scene.groundPoint(x1,y1);
        ctx.save();
        ctx.transform(TW/2/PIXELS,TH/2/PIXELS,-TW/2/PIXELS,TH/2/PIXELS,origin.x,origin.y);
        ctx.drawImage(exterior,0,0); ctx.restore();
        exterior.width = exterior.height = 1;
        super.paintBridges(ctx, geometry);
    }

    paintRoads(ctx, material, at) {
        const { routes, sites } = territoryLayout(board.W, board.H);
        ctx.lineCap = ctx.lineJoin = 'round';
        for (const route of routes) {
            ctx.beginPath();
            route.forEach(([x, y], i) => i ? ctx.lineTo(at(x), at(y)) : ctx.moveTo(at(x), at(y)));
            for (const [width, alpha] of [[2.2, 0.06], [1.7, 0.13], [1.05, 0.7]]) {
                ctx.lineWidth = width * PIXELS; ctx.globalAlpha = alpha;
                ctx.strokeStyle = material; ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
        // Small cleared yards anchor each flag to a place people would occupy.
        for (const site of sites) {
            const r = 2.8 * PIXELS;
            const gradient = ctx.createRadialGradient(at(site.gx), at(site.gy), r * 0.4, at(site.gx), at(site.gy), r);
            gradient.addColorStop(0, 'rgba(181,162,110,.28)'); gradient.addColorStop(1, 'rgba(181,162,110,0)');
            ctx.fillStyle = gradient; ctx.fillRect(at(site.gx) - r, at(site.gy) - r, r * 2, r * 2);
        }
    }

    drawProps(geometry, ground) {
        super.drawProps(geometry, ground);
        const sites = territoryLayout(board.W, board.H).sites;
        // Clear only visual vegetation, preserving the actual woodland slow zone.
        this.scene.terrainProps = this.scene.terrainProps.filter(prop => {
            const near = sites.some(site => {
                const p = this.scene.groundPoint(site.gx, site.gy);
                return Math.hypot((prop.x - p.x) / 60, (prop.y - p.y) / 30) < 2.4;
            });
            if (near && prop.texture.key === 'terrain/props') { prop.destroy(); return false; }
            return true;
        });
        for (const site of sites) this.drawLandmark(site);
    }

    drawLandmark(site) {
        // These are scenery, never extra collision, spawning or combat bonuses.
        const c = document.createElement('canvas'); c.width = 176; c.height = 150;
        const ctx = c.getContext('2d'), cx = 88, foot = 127;
        const poly = (points, color) => {
            ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
            ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#514b35'; ctx.lineWidth = 1.4; ctx.stroke();
        };
        ctx.fillStyle = 'rgba(29,36,22,.24)'; ctx.beginPath(); ctx.ellipse(cx, foot + 3, 49, 14, 0, 0, Math.PI * 2); ctx.fill();
        if (site.role === 'hill') {
            poly([[55,109],[88,125],[122,108],[88,92]], '#939381');
            poly([[76,104],[90,110],[104,103],[104,63],[76,63]], '#766c4c');
            ctx.strokeStyle = '#c4b085'; ctx.lineWidth = 4;
            for (const x of [77,102]) { ctx.beginPath(); ctx.moveTo(x,105); ctx.lineTo(x,49); ctx.stroke(); }
            poly([[66,62],[88,47],[112,61],[90,74]], '#b8a175');
            poly([[64,57],[88,31],[114,56],[90,67]], '#77684d');
            ctx.strokeStyle = '#5b523e'; ctx.lineWidth = 2;
            for (let y = 77; y < 106; y += 7) { ctx.beginPath(); ctx.moveTo(84,y); ctx.lineTo(96,y); ctx.stroke(); }
        } else {
            const timber = site.role === 'forest';
            poly([[48,93],[86,112],[127,93],[127,67],[87,84],[48,67]], '#a58d63');
            poly([[48,93],[86,112],[86,84],[48,67]], '#80704f');
            poly([[43,67],[87,43],[133,65],[86,87]], timber ? '#79734b' : '#958568');
            ctx.strokeStyle = '#c0af86'; ctx.lineWidth = 1.3;
            for (let y = 78; y <= 94; y += 6) { ctx.beginPath(); ctx.moveTo(49,y); ctx.lineTo(82,y+16); ctx.stroke(); }
            ctx.fillStyle = '#4d4934'; ctx.fillRect(92,91,12,13);
            for (let i = 0; i < 3; i++) {
                const x = 40 + i * 11, y = 115 + i * 3;
                if (timber) {
                    ctx.strokeStyle = '#675a3f'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+26,y-12); ctx.stroke();
                    ctx.fillStyle = '#d2bc88'; ctx.beginPath(); ctx.ellipse(x,y,3,3,0,0,Math.PI*2); ctx.fill();
                } else poly([[x,y],[x+9,y+4],[x+17,y],[x+8,y-4]], '#bda574');
            }
        }
        const key = `territory-site-${site.role}-${site.gx}`;
        if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
        this.scene.textures.addCanvas(key, c);
        // Offset from the flag so the capture marker and approaching troops stay visible.
        const p = this.scene.groundPoint(site.gx - 1.8, site.gy + 1.9);
        const prop = this.scene.add.image(p.x, p.y, key).setOrigin(0.5, foot / c.height).setDepth((site.gx + site.gy + 0.1) * 100 + 40);
        this.scene.terrainProps.push(prop);
    }
}
