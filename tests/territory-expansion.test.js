import test from 'node:test';
import assert from 'node:assert/strict';
import { board } from '../js/board.js';
import { TERRITORY } from '../js/battle/economy.js';
import { Terrain } from '../js/terrain.js';
import { TerrainNavigation } from '../js/navigation.js';
import { territoryLayout } from '../js/territory-map.js';
import { terrainBakeRegion } from '../js/render/terrain-materials.js';
import { refreshWorldMetrics, VIEW_W, VIEW_H } from '../js/render/metrics.js';

function onMap(run) {
    const before={...board};Object.assign(board,{W:TERRITORY.W,H:TERRITORY.H,MARGIN:5});refreshWorldMetrics();
    try { run(); } finally {Object.assign(board,before);refreshWorldMetrics();}
}

test('expanded territory has four times the area, preserves the five original indices, and adds six neutral paired sites',()=>onMap(()=>{
    assert.equal(board.W,260);assert.equal(board.H,180);
    assert.equal(board.W*board.H,130*90*4);
    const sites=territoryLayout(board.W,board.H).sites;
    assert.equal(sites.length,11);
    assert.deepEqual(sites.slice(0,5).map(s=>s.name),['西桥头','西林口','中央高地','东桥头','东林口']);
    assert.deepEqual(sites.slice(0,5).map(s=>s.owner),['red','red',null,'blue','blue']);
    assert.deepEqual(sites.map(s=>s.siteId),Array.from({length:11},(_,i)=>i));
    for (const [left,right] of [[0,3],[1,4],[5,6],[7,8],[9,10]]) {
        assert.equal(sites[left].gx+sites[right].gx,board.W);
        assert.equal(sites[left].gy,sites[right].gy);
    }
    for (const site of sites.slice(5)) {assert.equal(site.owner,null);assert.equal(site.progress,0);}
}));

test('all eleven sites and their capture rings are reachable from both homes for infantry and cavalry',()=>onMap(()=>{
    const sites=territoryLayout(board.W,board.H).sites;
    const nav=new TerrainNavigation({battleOptions:{terrain:'territory'}});
    for (const radius of [0.36,0.7]) for (const team of ['red','blue']) {
        const home={gx:team==='red'?8:board.W-8,gy:board.H/2,team};
        for (const site of sites) {
            assert.equal(Terrain.walkable('territory',site.gx,site.gy,radius),true,site.name);
            for (let i=0;i<8;i++) {
                const a=i*Math.PI/4;
                assert.equal(Terrain.walkable('territory',site.gx+Math.cos(a)*2.8,site.gy+Math.sin(a)*2.8,radius),true,`${site.name} capture ring`);
            }
            const path=Terrain.segmentClear('territory',home.gx,home.gy,site.gx,site.gy,radius)?[site]:nav.plan(home,site,radius);
            assert.ok(path.length,`${team} can reach ${site.name}`);
            let last=home;
            for (const p of path) {
                assert.equal(Terrain.segmentClear('territory',last.gx,last.gy,p.gx,p.gy,radius),true,`${site.name} route segment`);
                last=p;
            }
        }
    }
}));

test('new north ridges provide real elevated firing positions and visible route geometry remains traversable',()=>onMap(()=>{
    const {sites,routes}=territoryLayout(board.W,board.H);
    for (const site of sites.slice(5,7)) {
        assert.ok(Terrain.height('territory',site.gx,site.gy)>Terrain.height('territory',site.gx,site.gy+13)+0.8);
    }
    for (const route of routes) for (let i=1;i<route.length;i++) {
        assert.equal(Terrain.segmentClear('territory',...route[i-1],...route[i],0.7),true,`visible route ${i} matches passable terrain`);
    }
}));

test('world chunk source canvases stay bounded while retaining the original material resolution',()=>onMap(()=>{
    let peak=0,count=0;
    for (let y=0;y<VIEW_H;y+=1024) for (let x=0;x<VIEW_W;x+=1024) {
        const r=terrainBakeRegion(x,y,Math.min(1024,VIEW_W-x),Math.min(1024,VIEW_H-y));
        if (r.x2<=r.x1 || r.y2<=r.y1) continue;
        const pixels=(r.x2-r.x1)*32*(r.y2-r.y1)*32;
        peak=Math.max(peak,pixels);count++;
    }
    assert.ok(count>40,'large world uses many finite chunks');
    assert.ok(peak<4_000_000,`largest 32px/cell source plane ${peak} pixels`);
    assert.ok(peak<(board.W+32)*(board.H+32)*32*32/10,'no whole-map source bake');
}));
