// Playable camps use the simulation's buildings, never decorative towers.
import { garrisonStatusLabel, pendingGarrisonCounts, CAMP_RULES } from '../battle/camps.js';
// Static timberwork is baked once; only construction, health and crew labels update.
export const TOWER_DECK_HEIGHT = 82;
const TEAM = { red: 0xc94d3d, blue: 0x437bae };
const TIMBER = 0x785535;

function makeGraphics(scene) { return scene.make?.graphics({ add: false }) || scene.add.graphics(); }

function polygon(g, points, color, outline = 0x493820) {
    const p = points.map(([x, y]) => ({ x, y }));
    g.fillStyle(color, 1); g.fillPoints(p, true);
    g.lineStyle(1.4, outline, 1); g.strokePoints(p, true, true);
}

function bake(scene, key, width, height, draw) {
    if (scene.textures.exists(key)) return;
    const g = makeGraphics(scene);
    draw(g); g.generateTexture(key, width, height); g.destroy();
}

export function ensureCampTextures(scene) {
    for (const team of ['red', 'blue']) {
        bake(scene, `camp-hall-${team}`, 240, 200, g => {
            g.fillStyle(0x162016, 0.27); g.fillEllipse(123, 160, 183, 52);
            polygon(g, [[48,117],[121,151],[193,116],[120,82]], 0x9f8960);
            polygon(g, [[48,117],[121,151],[121,97],[48,66]], 0x846044);
            polygon(g, [[121,151],[193,116],[193,66],[121,97]], 0x60472f);
            // A steep canvas roof over a timber hall, with a visible open doorway.
            polygon(g, [[35,68],[116,25],[126,53],[121,103]], 0xd2be8b);
            polygon(g, [[116,25],[205,65],[121,103]], 0xab976b);
            g.lineStyle(2, 0xe9d9aa, 0.8);
            for (let i=0;i<5;i++) g.lineBetween(48+i*14,62-i*7,61+i*12,77+i*5);
            g.lineStyle(2.5, 0x4c3825, 0.8);
            for (let y=83;y<115;y+=9) g.lineBetween(50,y,117,y+31);
            polygon(g, [[145,127],[172,114],[172,77],[145,91]], 0x292b1d);
            g.lineStyle(3, 0xb69a68, 1); g.lineBetween(144,128,144,91); g.lineBetween(173,114,173,77);
            g.lineStyle(3, 0x745638, 1); g.lineBetween(116,26,116,5);
            polygon(g, [[116,5],[145,12],[116,19]], TEAM[team]);
            // Supply crates, water barrel and a small cook fire make this a working camp.
            polygon(g, [[50,144],[68,152],[86,144],[68,136]], 0xc2a273);
            polygon(g, [[50,144],[68,152],[68,170],[50,161]], 0x816243);
            polygon(g, [[68,152],[86,144],[86,162],[68,170]], 0x62472f);
            g.fillStyle(0x725439,1); g.fillEllipse(184,150,21,27);
            g.lineStyle(2,0xc6b08a,1); g.strokeEllipse(184,143,20,10);
            g.lineBetween(176,155,191,155);
        });
        bake(scene, `camp-tower-${team}`, 160, 184, g => {
            g.fillStyle(0x162016,0.3); g.fillEllipse(83,158,96,31);
            // Four legs and diagonal braces support an open shooting platform.
            for (const [x,y] of [[48,145],[80,162],[112,145],[80,129]]) {
                g.lineStyle(9,0x493823,1); g.lineBetween(x,y,x,y-TOWER_DECK_HEIGHT);
                g.lineStyle(3,0xb58c59,1); g.lineBetween(x-2,y,x-2,y-TOWER_DECK_HEIGHT);
            }
            g.lineStyle(5,TIMBER,1); g.lineBetween(49,140,78,84); g.lineBetween(79,155,112,68);
            polygon(g, [[44,75],[80,57],[116,75],[80,93]], 0xbf9d66);
            polygon(g, [[44,75],[80,93],[80,100],[44,82]], 0x735035);
            polygon(g, [[80,93],[116,75],[116,82],[80,100]], 0x533c29);
            g.lineStyle(1.5,0x8d693d,1);
            for (let i=0;i<6;i++) g.lineBetween(48+i*6,73-i*3,82+i*5,90-i*3);
            // Back parapets, with open front embrasures for the real archers.
            for (const [x,y] of [[46,73],[61,65],[80,55],[98,65],[114,73]]) {
                g.lineStyle(4,0x8b633e,1); g.lineBetween(x,y,x,y-18);
            }
            g.lineStyle(4,0xc5a273,1); g.lineBetween(46,56,80,38); g.lineBetween(80,38,114,56);
            g.lineStyle(3,0x65472d,1); g.lineBetween(113,68,113,23);
            polygon(g, [[113,23],[136,30],[113,37]],TEAM[team]);
            // A ladder remains visible under the platform.
            g.lineStyle(3,0xd0af78,1); g.lineBetween(88,157,98,95); g.lineBetween(100,151,110,89);
            for (let i=0;i<8;i++) g.lineBetween(89+i*1.25,153-i*7.5,101+i*1.25,147-i*7.5);
        });
        // 医帐：白帆布行军帐篷，门口红十字幡——伤兵收容点的可读标识。
        bake(scene, `camp-tent-${team}`, 170, 150, g => {
            g.fillStyle(0x162016,0.28); g.fillEllipse(85,128,108,34);
            polygon(g, [[16,124],[85,140],[154,124],[85,110]], 0x8a815d);
            // 帐体：两页白帆布拼缝，右页压暗模拟受光面。
            polygon(g, [[18,122],[84,30],[84,136]], 0xe8e2cf);
            polygon(g, [[84,30],[150,122],[84,136]], 0xcfc8b2);
            g.lineStyle(2.5,0xa89f86,1); g.lineBetween(84,32,84,136);
            // 帐篷门帘半掀，露出内部担架与药柜一角。
            polygon(g, [[68,124],[84,96],[100,124],[84,132]], 0x6b6353);
            polygon(g, [[62,124],[74,104],[78,124]], 0xd9d2bb);
            // 帐顶桩绳
            g.lineStyle(2.5,0x9b8f74,1);
            g.lineBetween(84,30,40,118); g.lineBetween(84,30,128,118);
            g.lineStyle(4,0x74563a,1); g.lineBetween(84,28,84,10);
            // 红十字幡：队伍色旗面 + 白十字，父女对打时一眼可辨敌我医帐。
            polygon(g, [[84,10],[122,18],[84,26]], TEAM[team]);
            g.fillStyle(0xffffff,1);
            g.fillRect(96,12,4,11); g.fillRect(92,16,12,4);
            // 门口药箱
            polygon(g, [[120,132],[138,140],[152,132],[136,124]], 0xb98f60);
            g.fillStyle(0xffffff,1); g.fillRect(133,131,7,7);
            g.fillStyle(0xc0392b,1); g.fillRect(135,133,3,3); g.fillRect(134.5,132.5,2,5); g.fillRect(133.5,133.5,4,2);
        });
    }
    for (const direction of ['x','y']) bake(scene, `camp-wall-${direction}`, 80, 98, g => {
        const sign = direction === 'x' ? 1 : -1;
        for (let i=0;i<7;i++) {
            const x=10+i*9, y=70+sign*(i-3)*4.5;
            polygon(g,[[x-4,y],[x+4,y],[x+4,y-34],[x,y-42],[x-4,y-34]],i%2 ? 0x9f784b : 0x87603c);
            g.lineStyle(1,0xd3b080,0.7);g.lineBetween(x-2,y-4,x-2,y-31);
        }
        g.lineStyle(4,0x60462c,1);g.lineBetween(8,57-sign*13.5,66,57+sign*15);
        g.lineStyle(3,0xb89969,1);g.lineBetween(8,46-sign*13.5,66,46+sign*15);
    });
    bake(scene, 'camp-rubble', 200, 120, g => {
        g.fillStyle(0x28261b,0.23);g.fillEllipse(100,84,172,55);
        for(let i=0;i<12;i++) {
            const x=33+(i*37)%133,y=63+(i*19)%35;
            polygon(g,[[x-16,y-7],[x+22,y+9],[x+18,y+15],[x-19,y]],i%2?0x685039:0x96734b);
        }
        g.lineStyle(6,0x493b29,1);g.lineBetween(69,79,58,38);g.lineBetween(142,87,145,50);
    });
}

// A crew's grid position stays at its tower. These offsets never enter simulation.
export function towerCrewOffset(unit, camps) {
    // 营寨守军站在寨墙垛口上：只抬到墙顶（28px），不算高台；横向不偏，纵向压在墙体之上。
    if (unit.wallGuardId) {
        const camp = camps?.getBuilding?.(unit.wallGuardId) ||
            camps?.buildings?.find(b => b.id === unit.wallGuardId);
        if (!camp || camp.dead || !camp.complete) return null;
        return { x: 0, y: -(unit.garrisonHeight || 28), depth: 0 };
    }
    if (!unit.garrisonTowerId) return null;
    const tower = camps?.getBuilding?.(unit.garrisonTowerId) ||
        camps?.buildings?.find(b => b.id === unit.garrisonTowerId);
    if (!tower || tower.dead || !tower.complete) return null;
    const slot = Math.max(0, tower.garrisonIds.indexOf(unit.id));
    // 驻帐军医站在帐篷门口地面（低高度、贴地深度），不上箭塔的 82px 平台。
    const offsets = tower.type === 'tent' ? [[-15, -2], [14, -2]] : [[-13,-3],[12,-3],[-2,6],[0,-10]];
    const [x, y] = offsets[slot % offsets.length];
    const height = unit.garrisonHeight ?? tower.garrisonHeight ?? TOWER_DECK_HEIGHT;
    return { x, y: y - height, depth: tower.type === 'tent' ? 20 : 80 };
}

export class CampRenderer {
    constructor(scene) { this.scene=scene;this.views=new Map();this.system=null;this._armed=undefined; }

    update() {
        const system=this.scene.territory?.camps;
        if (!system || !this.scene.battleOptions?.territory) { if(this.views.size)this.reset(); return; }
        if (this.system!==system) {this.reset();this.system=system;ensureCampTextures(this.scene);}
        this.updateResources();
        const present=new Set();
        // A rebuilt structure reuses its command id; only its latest object owns the view.
        const latest = new Map(system.buildings.map(building => [building.id, building]));
        this._armed=undefined;   // 本端选择每帧最多读一次，未变化的帧不重复扫描
        this._armedMelee=undefined;
        // 在途预约同样每帧只扫一次单位表；没有完工箭塔/营寨的帧完全不付这份成本。
        let reservations=null;
        for (const building of latest.values()) {
            if ((building.type==='tower'||building.type==='camp') && building.complete && !building.dead) { reservations=this.pendingReservations(); break; }
        }
        for (const building of latest.values()) {
            present.add(building.id);
            let view=this.views.get(building.id);
            if (view && view.building !== building) { this.destroyView(view); view = null; }
            if(!view) {view=this.create(building);this.views.set(building.id,view);}
            this.updateView(building,view,reservations);
        }
        for(const [id,view] of this.views) if(!present.has(id)) {this.destroyView(view);this.views.delete(id);}
    }

    updateResources() {
        this.resourceViews ||= new Map();
        for (const node of this.scene.territory.resources?.nodes || []) {
            let view = this.resourceViews.get(node.id);
            const p = this.scene.groundPoint(node.gx,node.gy);
            if (!view) {
                const g = this.scene.add.graphics().setDepth((node.gx+node.gy)*100+40);
                polygon(g,[[p.x-22,p.y-6],[p.x,p.y+5],[p.x+22,p.y-6],[p.x,p.y-17]],0x7c6537);
                polygon(g,[[p.x-22,p.y-6],[p.x,p.y+5],[p.x,p.y-16],[p.x-22,p.y-27]],0xaa813b);
                polygon(g,[[p.x,p.y+5],[p.x+22,p.y-6],[p.x+22,p.y-27],[p.x,p.y-16]],0x805d2b);
                polygon(g,[[p.x-22,p.y-27],[p.x,p.y-16],[p.x+22,p.y-27],[p.x,p.y-38]],0xd7b65c);
                g.lineStyle(3,0x5a4828,1);g.lineBetween(p.x-10,p.y-32,p.x+11,p.y-21);g.lineBetween(p.x+11,p.y-21,p.x+11,p.y-1);
                const label = this.scene.add.text(p.x,p.y-42,'',{fontSize:'13px',color:'#ffe1a0',backgroundColor:'#28291ddd'}).setOrigin(.5,1).setDepth((node.gx+node.gy)*100+60);
                view={g,label,node};this.resourceViews.set(node.id,view);
            }
            view.g.setAlpha(node.remaining > 0 ? 1 : .25);
            view.label.setText(node.remaining > 0 ? `物资 ${Math.ceil(node.remaining)}` : '物资已采完');
        }
    }
    pickResource(x,y) {
        return (this.scene.territory?.resources?.nodes || []).find(n => {
            const p=this.scene.groundPoint(n.gx,n.gy);
            return n.remaining>0 && Math.abs(x-p.x)<40 && Math.abs(y-p.y+15)<40;
        });
    }

    create(building) {
        const scene=this.scene,p=scene.groundPoint(building.gx,building.gy),parts=[];
        const depth=(building.gx+building.gy)*100;
        const home=building.siteId==='home',tower=building.type==='tower',tent=building.type==='tent';
        const image=scene.add.image(p.x,p.y,`camp-${tower?'tower':tent?'tent':'hall'}-${building.team}`)
            .setOrigin(0.5,tower?158/184:tent?136/150:160/200).setDepth(depth+30);
        if(!tower) image.setScale(home?1.12:0.88);
        if(tent) image.setScale(0.95);
        parts.push(image);
        if(!tower && !tent) {
            const r=home?3.5:2.65;
            for(const side of [-1,1]) for(let offset=-r+0.6;offset<r;offset+=1.2) {
                for(const dir of ['x','y']) {
                    // Leave a real-looking front gate, facing the field rather than sealing the yard.
                    if(side===1 && dir==='x' && Math.abs(offset)<1.2) continue;
                    const gx=building.gx+(dir==='x'?offset:side*r),gy=building.gy+(dir==='x'?side*r:offset);
                    const q=scene.groundPoint(gx,gy);
                    parts.push(scene.add.image(q.x,q.y,`camp-wall-${dir}`).setOrigin(0.5,70/98)
                        .setDepth((gx+gy)*100+24));
                }
            }
        }
        const rubble=scene.add.image(p.x,p.y,'camp-rubble').setOrigin(0.5,84/120).setDepth(depth+16).setVisible(false);
        parts.push(rubble);
        const scaffold=scene.add.graphics().setPosition(p.x,p.y).setDepth(depth+35);
        const status=scene.add.graphics().setPosition(p.x,p.y).setDepth(depth+170);
        // 可驻军提示必须留在建筑自己的深度带（塔身之下、废墟之上）：
        // 固定深度的世界覆盖层（11980–12125）在本图会被 gx+gy 更大的建筑整体遮住。
        const highlight=scene.add.graphics().setPosition(p.x,p.y).setDepth(depth+20);
        const label=scene.add.text(p.x,p.y-(tower?141:tent?110:131), '',
            {fontSize:'13px',fontFamily:'sans-serif',color:'#f8edcc',stroke:'#302c20',strokeThickness:3})
            .setOrigin(0.5,1).setDepth(depth+171);
        const half=tower?74:tent?68:home?190:151,height=tower?147:tent?132:143;
        building.renderBounds={x:p.x-half,y:p.y-height,width:half*2,height:height+(tower?24:tent?20:79)};
        return {building,parts,image,rubble,scaffold,status,highlight,label,p,signature:null};
    }

    // 本端阵营：联机取 netMySide，单机/旧场景退回部署时的 mySide，最后才是恒红的默认。
    get side() { return this.scene.netMySide || this.scene.battleOptions?.mySide || 'red'; }

    // 在途预约计数：每个渲染帧只扫一次单位表，塔读数按 id 查 O(1)
    // （逐塔调用 reserved() 会退化成"塔数 × 单位数"，随规模放大）。
    pendingReservations() {
        const counts=this._pending??(this._pending=new Map());
        counts.clear();
        if(this.scene.units) for(const [id,n] of pendingGarrisonCounts(this.scene.units)) counts.set(id,n);
        return counts;
    }

    // 驻军读数：读数格式由模拟层的 garrisonStatusLabel 统一给出（单一口径，渲染不另写一套）。
    // 在途人数来自本帧一次性算好的预约表，绝不在这里逐塔回查模拟（那会退化成塔数 × 单位数）。
    garrisonStatusOf(building,pending) {
        const inside=building.garrisonIds?.length||0;
        const capacity=building.capacity||4;
        const inTransit=pending?.get(building.id)??0;
        return garrisonStatusLabel(inside,inside+inTransit,capacity);
    }

    // 与 camp-controls.selectedTroops 同一口径：营队成员已排除驻塔者，单体选择同样过滤。
    selectionArmed() {
        const scene=this.scene,side=this.side,battalion=scene.selectedBattalion;
        const members=battalion?.team===side&&typeof battalion.aliveMembers==='function'?battalion.aliveMembers():null;
        if(members?.some(u=>u.type==='archer'&&!u.garrisonTowerId))return true;
        const unit=scene.unitInspector?.selected;
        return !!unit&&unit.team===side&&unit.type==='archer'&&!unit.dead&&!unit.withdrawn&&!unit.garrisonTowerId;
    }

    // 营寨上墙用的是近战兵：选中近战时营寨才高亮可驻。
    selectionArmedMelee() {
        const scene=this.scene,side=this.side,battalion=scene.selectedBattalion;
        const melee=u=>CAMP_RULES.WALL_GUARD_MELEE.includes(u.type)&&!u.wallGuardId&&!u.garrisonTowerId;
        const members=battalion?.team===side&&typeof battalion.aliveMembers==='function'?battalion.aliveMembers():null;
        if(members?.some(melee))return true;
        const unit=scene.unitInspector?.selected;
        return !!unit&&unit.team===side&&!unit.dead&&!unit.withdrawn&&melee(unit);
    }

    armed() { if(this._armed===undefined)this._armed=this.selectionArmed(); return this._armed; }
    armedMelee() { if(this._armedMelee===undefined)this._armedMelee=this.selectionArmedMelee(); return this._armedMelee; }

    // 静态高亮：只在状态变化时重画，不做逐帧呼吸/动画。
    drawHighlight(view,on) {
        const g=view.highlight;g.clear();
        if(!on)return;
        g.fillStyle(0xffe49a,0.16);g.fillEllipse(0,6,96,34);
        g.lineStyle(2.5,0xffd777,0.9);g.strokeEllipse(0,6,96,34);
        for(const [x,y] of [[-48,-2],[40,-2],[-48,16],[40,16]]) {g.fillStyle(0xffd777,0.9);g.fillRect(x,y,8,4);}
    }

    updateView(building,view,reservations) {
        const stage=Math.round((building.progress||0)*20),health=Math.ceil(building.hp||0);
        const count=building.garrisonIds?.length||0;
        const tower=building.type==='tower',tent=building.type==='tent',home=building.siteId==='home';
        // 只有完工且在用的己方箭塔/营寨才需要读驻军/选择：读数变化必须进 signature，
        // 否则"弓手在路上"这类状态会被差异比较吞掉。
        const garrison=(tower||building.type==='camp')&&building.complete&&!building.dead?this.garrisonStatusOf(building,reservations):null;
        const highlight=!!garrison&&!garrison.full&&building.team===this.side&&(tower?this.armed():this.armedMelee());
        const signature=`${stage}:${health}:${count}:${garrison?garrison.reserved:0}:${building.dead}:${building.complete}:${building.paused}:${highlight?1:0}`;
        if(signature===view.signature)return;
        view.signature=signature;
        for(const part of view.parts) part.setVisible(!building.dead);
        view.rubble.setVisible(!!building.dead);
        const g=view.scaffold;g.clear();view.status.clear();
        this.drawHighlight(view,highlight);
        if(building.dead) {view.label.setText('废墟');return;}
        const h=tower?120:tent?86:home?119:100;
        if(!building.complete) {
            const progress=Math.max(0,Math.min(1,building.progress||0));
            for(const part of view.parts)if(part!==view.rubble)part.setAlpha(0.2+progress*0.8);
            g.lineStyle(3,0xc6a574,0.95);
            const w=tent?40:48;
            for(const x of [-w+5,w-5]) {g.lineBetween(x,10,x,-h);g.lineBetween(x,10,-x,-h);}
            for(let y=0;y>-h;y-=24)g.lineBetween(-w,y,w,y);
            this.bar(view.status,h+11,progress,0xdabb65);
            view.label.setText(`${tower?'箭塔':tent?'医帐':'营寨'} ${building.paused?'停工':'施工'} ${Math.floor(progress*100)}%`);
        } else {
            for(const part of view.parts) part.setAlpha(1);
            if(building.hp<building.maxHp)this.bar(view.status,h+11,building.hp/building.maxHp,TEAM[building.team]);
            // 完工箭塔/营寨标出"里面几人 / 共几人 / 还有几人在路上"，口径与模拟同一份读数。
            const crewLabel=(garrison?garrison.label:`${count}/${building.capacity||0}`).replace('（+','（');
            view.label.setText(tower?`箭塔 弓手 ${crewLabel}`
                :tent?`医帐 军医${count}/${building.capacity||2}`
                :building.type==='camp'?`${home?'大本营':'前线营寨'} 守军 ${crewLabel}`
                :'前线营寨');
        }
    }

    bar(g,height,ratio,color) {
        g.fillStyle(0x282419,0.9);g.fillRect(-35,-height,70,7);
        g.fillStyle(color,1);g.fillRect(-33,-height+2,66*Math.max(0,Math.min(1,ratio)),3);
    }

    pick(worldX,worldY) {
        let selected=null,depth=-Infinity;
        for(const view of this.views.values()) {
            const b=view.building,r=b.renderBounds;
            if(b.dead||worldX<r.x||worldX>r.x+r.width||worldY<r.y||worldY>r.y+r.height)continue;
            const d=b.gx+b.gy;
            if(d>depth) {selected=b;depth=d;}
        }
        return selected;
    }

    destroyView(view) {
        for(const part of view.parts)part.destroy();
        view.scaffold.destroy();view.status.destroy();view.highlight.destroy();view.label.destroy();
        delete view.building.renderBounds;
    }
    reset() {for(const view of this.resourceViews?.values() || []) {view.g.destroy();view.label.destroy();}this.resourceViews?.clear();for(const view of this.views.values())this.destroyView(view);this.views.clear();this.system=null;}
    destroy() {this.reset();}
}
