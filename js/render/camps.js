// Playable camps use the simulation's buildings, never decorative towers.
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
    if (!unit.garrisonTowerId) return null;
    const tower = camps?.getBuilding?.(unit.garrisonTowerId) ||
        camps?.buildings?.find(b => b.id === unit.garrisonTowerId);
    if (!tower || tower.dead || !tower.complete) return null;
    const slot = Math.max(0, tower.garrisonIds.indexOf(unit.id));
    // 驻帐医师站在帐篷门口地面（低高度、贴地深度），不上箭塔的 82px 平台。
    const offsets = tower.type === 'tent' ? [[-15, -2], [14, -2]] : [[-13,-3],[12,-3],[-2,6],[0,-10]];
    const [x, y] = offsets[slot % offsets.length];
    const height = unit.garrisonHeight ?? tower.garrisonHeight ?? TOWER_DECK_HEIGHT;
    return { x, y: y - height, depth: tower.type === 'tent' ? 20 : 80 };
}

export class CampRenderer {
    constructor(scene) { this.scene=scene;this.views=new Map();this.system=null; }

    update() {
        const system=this.scene.territory?.camps;
        if (!system || !this.scene.battleOptions?.territory) { if(this.views.size)this.reset(); return; }
        if (this.system!==system) {this.reset();this.system=system;ensureCampTextures(this.scene);}
        const present=new Set();
        // A rebuilt structure reuses its command id; only its latest object owns the view.
        const latest = new Map(system.buildings.map(building => [building.id, building]));
        for (const building of latest.values()) {
            present.add(building.id);
            let view=this.views.get(building.id);
            if (view && view.building !== building) { this.destroyView(view); view = null; }
            if(!view) {view=this.create(building);this.views.set(building.id,view);}
            this.updateView(building,view);
        }
        for(const [id,view] of this.views) if(!present.has(id)) {this.destroyView(view);this.views.delete(id);}
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
        const label=scene.add.text(p.x,p.y-(tower?141:tent?110:131), '',
            {fontSize:'13px',fontFamily:'sans-serif',color:'#f8edcc',stroke:'#302c20',strokeThickness:3})
            .setOrigin(0.5,1).setDepth(depth+171);
        const half=tower?74:tent?68:home?190:151,height=tower?147:tent?132:143;
        building.renderBounds={x:p.x-half,y:p.y-height,width:half*2,height:height+(tower?24:tent?20:79)};
        return {building,parts,image,rubble,scaffold,status,label,p,signature:null};
    }

    updateView(building,view) {
        const stage=Math.round((building.progress||0)*20),health=Math.ceil(building.hp||0);
        const count=building.garrisonIds?.length||0;
        const signature=`${stage}:${health}:${count}:${building.dead}:${building.complete}:${building.paused}`;
        if(signature===view.signature)return;
        view.signature=signature;
        for(const part of view.parts) part.setVisible(!building.dead);
        view.rubble.setVisible(!!building.dead);
        const g=view.scaffold;g.clear();view.status.clear();
        if(building.dead) {view.label.setText('废墟');return;}
        const tower=building.type==='tower',tent=building.type==='tent',home=building.siteId==='home';
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
            view.label.setText(tower?`箭塔 ${count}/${building.capacity||4}`
                :tent?`医帐 医师${count}/${building.capacity||2}`
                :home?'大本营':'前线营寨');
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
        view.scaffold.destroy();view.status.destroy();view.label.destroy();
        delete view.building.renderBounds;
    }
    reset() {for(const view of this.views.values())this.destroyView(view);this.views.clear();this.system=null;}
    destroy() {this.reset();}
}

// Civilian walk sheets are generated at the same 156px source height as foot troops.
// A straw hat, plain tunic and a wooden-handled shovel replace armour and weapons.
export function ensureWorkerTextures(scene) {
    if(!scene.textures.createCanvas)return; // Drawing-free simulation harness.
    for(const team of ['red','blue']) {
        for(const clip of ['walk','build','attack']) {
            const key=`assets/units/anim/${team}_worker_${clip}`;
            if(scene.textures.exists(key))continue;
            const texture=scene.textures.createCanvas(key,158*4,156),ctx=texture.getContext();
            for(let frame=0;frame<4;frame++) {
                drawWorker(ctx,frame*158,frame,clip,team);
                texture.add(frame,0,frame*158,0,158,156);
            }
            texture.refresh();
        }
        const key=`units/${team}_worker`;
        if(!scene.textures.exists(key)) {
            const texture=scene.textures.createCanvas(key,158,156);
            drawWorker(texture.getContext(),0,0,'walk',team);texture.refresh();
        }
        for(const clip of ['walk','build','attack']) {
            const key=`assets/units/anim/${team}_worker_${clip}`;
            if(scene.anims.exists(key))continue;
            scene.anims.create({key,frames:scene.anims.generateFrameNumbers(key,{start:0,end:3}),frameRate:clip==='walk'?9:8,repeat:clip==='attack'?0:-1});
        }
    }
}

// 医师行走帧：白袍 + 药箱 + 队伍色腰带，与民夫同一 156px 源高与画法骨架。
export function ensureMedicTextures(scene) {
    if(!scene.textures.createCanvas)return;
    for(const team of ['red','blue']) {
        for(const clip of ['walk','attack']) {
            const key=`assets/units/anim/${team}_medic_${clip}`;
            if(scene.textures.exists(key))continue;
            const texture=scene.textures.createCanvas(key,158*4,156),ctx=texture.getContext();
            for(let frame=0;frame<4;frame++) {
                drawMedic(ctx,frame*158,frame,clip,team);
                texture.add(frame,0,frame*158,0,158,156);
            }
            texture.refresh();
        }
        const key=`units/${team}_medic`;
        if(!scene.textures.exists(key)) {
            const texture=scene.textures.createCanvas(key,158,156);
            drawMedic(texture.getContext(),0,0,'walk',team);texture.refresh();
        }
        for(const clip of ['walk','attack']) {
            const key=`assets/units/anim/${team}_medic_${clip}`;
            if(scene.anims.exists(key))continue;
            scene.anims.create({key,frames:scene.anims.generateFrameNumbers(key,{start:0,end:3}),frameRate:9,repeat:-1});
        }
    }
}

function drawMedic(ctx,offset,frame,clip,team) {
    ctx.save();ctx.translate(offset,0);
    const step=clip==='walk'?[0,7,0,-7][frame]:0,arm=clip==='attack'?[0,-6,-12,0][frame]:step*0.4;
    const poly=(points,fill)=>{ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle='#3c3327';ctx.lineWidth=3;ctx.stroke();};
    poly([[64,95],[78,96],[73+step,136],[61+step,136]],'#5a5244');
    poly([[78,96],[92,95],[94-step,134],[81-step,134]],'#6d6454');
    poly([[59+step,134],[74+step,134],[76+step,142],[55+step,142]],'#443726');
    poly([[80-step,132],[95-step,132],[99-step,141],[79-step,141]],'#4e3c28');
    // 白袍长衫，下摆随步伐微摆
    poly([[59,61],[83,56],[103,68],[94,112],[61,112],[51,78]],'#e9e4d4');
    poly([[61,100],[95,100],[94,111],[60,111]],team==='red'?'#ad4f41':'#477baa');
    // 双臂：一手提药箱，一手随急救动作抬起
    poly([[90,65],[104,69],[110,88+arm],[101,97+arm],[91,80]],'#d8b48c');
    poly([[55,68],[63,77],[54,98-arm],[44,94-arm],[48,77]],'#c9a177');
    // 药箱（白底红十字）
    poly([[38,104+arm*0.4],[58,110+arm*0.4],[58,126+arm*0.4],[38,122+arm*0.4]],'#b98f60');
    ctx.fillStyle='#ffffff';ctx.fillRect(44,111+arm*0.4,9,9);
    ctx.fillStyle='#c0392b';ctx.fillRect(47.5,112.5+arm*0.4,3,6);ctx.fillRect(45.5,114.5+arm*0.4,7,3);
    // 头部 + 白色布巾（医师辨识）
    ctx.fillStyle='#caab84';ctx.beginPath();ctx.ellipse(77,47,15,18,0,0,Math.PI*2);ctx.fill();
    poly([[48,38],[68,22],[86,22],[108,40],[98,47],[60,46]],'#f2eee1');
    ctx.strokeStyle='#b8b09a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(52,39);ctx.lineTo(102,42);ctx.stroke();
    ctx.fillStyle='#403729';ctx.fillRect(86,48,3,3);
    ctx.restore();
}

function drawWorker(ctx,offset,frame,clip,team) {
    ctx.save();ctx.translate(offset,0);
    const step=clip==='walk'?[0,7,0,-7][frame]:0,arm=clip!=='walk'?[0,-7,-13,0][frame]:step*0.4;
    const poly=(points,fill)=>{ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle='#3c3327';ctx.lineWidth=3;ctx.stroke();};
    poly([[64,95],[78,96],[73+step,136],[61+step,136]],'#645640');
    poly([[78,96],[92,95],[94-step,134],[81-step,134]],'#776953');
    poly([[59+step,134],[74+step,134],[76+step,142],[55+step,142]],'#443726');
    poly([[80-step,132],[95-step,132],[99-step,141],[79-step,141]],'#4e3c28');
    poly([[59,61],[83,56],[103,68],[94,109],[61,109],[51,78]],'#b3a68b');
    poly([[61,98],[95,98],[94,108],[60,108]],team==='red'?'#ad4f41':'#477baa');
    poly([[90,65],[104,69],[112,91+arm],[103,100+arm],[91,80]],'#d1ae88');
    poly([[55,68],[63,77],[54,101-arm],[43,97-arm],[48,77]],'#c5a178');
    // The shovel rests over the shoulder; its broad dull blade is not a spear tip.
    ctx.strokeStyle='#795d39';ctx.lineWidth=6;ctx.beginPath();ctx.moveTo(37,115+arm);ctx.lineTo(105,37+arm);ctx.stroke();
    poly([[98,32+arm],[106,26+arm],[121,36+arm],[113,49+arm],[105,48+arm]],'#88867a');
    ctx.fillStyle='#caab84';ctx.beginPath();ctx.ellipse(77,47,15,18,0,0,Math.PI*2);ctx.fill();
    poly([[48,37],[68,22],[86,22],[110,39],[98,46],[61,45]],'#c8ae70');
    ctx.strokeStyle='#92794b';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(53,38);ctx.lineTo(102,41);ctx.stroke();
    ctx.fillStyle='#403729';ctx.fillRect(86,48,3,3);
    ctx.restore();
}
