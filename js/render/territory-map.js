// Territory presentation reuses the terrain atlas; layout stays in simulation.
import { TerrainMaterialsRenderer, intersectBakeRegion } from './terrain-materials.js';
import { bankDistance, bankAppearance, sampleBankWeight } from './terrain-naturalness.js';
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
        if (!this.riverFlow || !this.waterField || this.scene.terrainLoading || now - this.flowAt < 100) return;
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

    paintRiver(ctx, _material, _geometry, _at, region) {
        const field = this.waterField;
        const clipped=intersectBakeRegion(region,{x1:field.x1,y1:field.y1,x2:field.x1+field.cols*field.step,y2:field.y1+field.rows*field.step});
        if (!clipped) return;
        const width=(clipped.x2-clipped.x1)*PIXELS,height=(clipped.y2-clipped.y1)*PIXELS;
        const offsetX=(clipped.x1-region.x1)*PIXELS,offsetY=(clipped.y1-region.y1)*PIXELS;
        const patch=ctx.getImageData(offsetX,offsetY,width,height),data=patch.data;
        for (let py = 0; py < height; py += 2) for (let px = 0; px < width; px += 2) {
            const gx=clipped.x1+(px+1)/PIXELS,gy=clipped.y1+(py+1)/PIXELS;
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
        ctx.putImageData(patch,offsetX,offsetY);
    }

    exteriorIntersects(x,y,width,height) {
        const cx=board.W/2;
        const points=[[cx-6,-100],[cx+6,-100],[cx-6,-10],[cx+6,-10]].map(([gx,gy])=>this.scene.groundPoint(gx,gy));
        return Math.max(...points.map(p=>p.x))>=x && Math.min(...points.map(p=>p.x))<=x+width &&
            Math.max(...points.map(p=>p.y))>=y && Math.min(...points.map(p=>p.y))<=y+height;
    }

    paintBridges(ctx, geometry) {
        // The meadow bake extends outside the playable board. Continue the
        // upstream water beyond that bake so its northern end cannot look like
        // a canal cut off in the middle of the surrounding grass. Every point
        // here has gy < 0; the playable shoreline and blockers stay untouched.
        // One continuous UV plane avoids seams between projected strip quads.
        const x1 = board.W / 2 - 6, y1 = -100;
        let exterior=this.exteriorWater;
        if (!exterior) {
        exterior=document.createElement('canvas');
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
        this.exteriorWater=exterior;
        }
        const origin = this.scene.groundPoint(x1,y1);
        ctx.save();
        ctx.transform(TW/2/PIXELS,TH/2/PIXELS,-TW/2/PIXELS,TH/2/PIXELS,origin.x,origin.y);
        ctx.drawImage(exterior,0,0); ctx.restore();
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
                const offsets=[[0,0],[-3.5,3.5],[3.5,3.5]];
                return offsets.some(([dx,dy])=>{
                    const p=this.scene.groundPoint(site.gx+dx,site.gy+dy);
                    return Math.hypot((prop.x-p.x)/60,(prop.y-p.y)/30)<3.3;
                });
            });
            if (near && prop.texture.key === 'terrain/props') { prop.destroy(); return false; }
            return true;
        });
        for (const site of sites) this.drawLandmark(site);
    }

    paintCamp() {
        // Actual home fortifications are rendered by CampsRenderer.
    }

    drawLandmark(site) {
        const c=document.createElement('canvas');c.width=144;c.height=90;
        const ctx=c.getContext('2d'),foot=72;
        ctx.fillStyle='rgba(29,36,22,.18)';ctx.beginPath();ctx.ellipse(72,foot+2,40,10,0,0,Math.PI*2);ctx.fill();
        // Unoccupied objectives use signposts and resource piles, never fake
        // arrow towers or storehouses that could be confused with real buildings.
        ctx.strokeStyle='#665a40';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(91,70);ctx.lineTo(91,27);ctx.stroke();
        ctx.fillStyle='#c2af82';ctx.fillRect(72,29,38,12);
        ctx.strokeStyle='#73654b';ctx.lineWidth=1.5;ctx.strokeRect(72,29,38,12);
        if (site.role==='forest') {
            for (let i=0;i<4;i++) {
                const x=32+i*8,y=65+i*2;
                ctx.strokeStyle='#6b593d';ctx.lineWidth=7;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+27,y-13);ctx.stroke();
                ctx.fillStyle='#c6b080';ctx.beginPath();ctx.ellipse(x,y,3.5,3.5,0,0,Math.PI*2);ctx.fill();
            }
        } else {
            for (const [x,y,r] of [[46,65,11],[59,65,9],[52,55,8]]) {
                ctx.fillStyle=site.role==='ford'?'#92968a':'#a19a7f';
                ctx.beginPath();ctx.ellipse(x,y,r,r*0.65,-0.2,0,Math.PI*2);ctx.fill();
                ctx.strokeStyle='#6e705f';ctx.lineWidth=1;ctx.stroke();
            }
        }
        const key=`territory-site-${site.siteId}`;
        if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
        this.scene.textures.addCanvas(key,c);
        const gx=site.gx+(site.gx>board.W/2?7:-7),gy=site.gy+7,p=this.scene.groundPoint(gx,gy);
        const prop=this.scene.add.image(p.x,p.y,key).setOrigin(0.5,foot/c.height).setDepth((gx+gy)*100+40);
        this.scene.terrainProps.push(prop);
    }
}
