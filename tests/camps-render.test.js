import test from 'node:test';
import assert from 'node:assert/strict';
import { CampRenderer, towerCrewOffset } from '../js/render/camps.js';
import { ScarLayer } from '../js/render/scars.js';
import { footProfile, animAlignProfile } from '../js/render/sprites.js';
import { makeScene, addUnit } from './battle-harness.js';
import { Terrain } from '../js/terrain.js';
import { TERRITORY } from '../js/battle/economy.js';

function renderScene() {
    const objects=[],textures=new Set();
    const object=()=>{
        const o={x:0,y:0,destroyed:false,text:'',draws:[],clears:0};
        for(const method of ['setOrigin','setScale','setDepth','setVisible','setAlpha','lineStyle','lineBetween','fillStyle','fillEllipse','fillRect','fillPoints','strokePoints','strokeEllipse'])
            o[method]=function(...args){if(method==='setVisible')this.visible=args[0];if(method==='setDepth')this.depth=args[0];return this;};
        o.setPosition=function(x,y){this.x=x;this.y=y;return this;};
        o.setText=function(text){this.text=text;return this;};
        o.clear=function(){this.clears++;return this;};
        o.generateTexture=(key)=>{textures.add(key);};
        o.destroy=function(){this.destroyed=true;};
        o.draw=function(item,x,y){this.draws.push({item,x,y});return this;};
        objects.push(o);return o;
    };
    const add={graphics:()=>object(),image:(x,y)=>object().setPosition(x,y),text:(x,y,text)=>object().setPosition(x,y).setText(text),
        renderTexture:(x,y,width,height)=>Object.assign(object().setPosition(x,y),{width,height})};
    return {objects,textures:{exists:key=>textures.has(key)},add,make:{graphics:()=>object()},battleOptions:{territory:true},
        groundPoint:(gx,gy)=>({x:(gx-gy)*32+2000,y:(gx+gy)*16+120})};
}
const building=(type='camp')=>({id:`${type}:red:home`,type,team:'red',siteId:'home',gx:12,gy:20,
    hp:100,maxHp:100,progress:1,complete:true,dead:false,garrisonIds:[],garrisonHeight:82});

test('毁塔后真实续建的新对象接管显示与拾取，不复用旧废墟对象', () => {
    const scene = makeScene();
    scene.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING }, 'custom', 'custom', {},
        { territory: true, terrain: 'territory', territoryAI: false });
    const camps = scene.territory.camps;
    camps.createBuilding('red', 'camp', 0, true);
    const old = camps.createBuilding('red', 'tower', 0, true);
    scene.render.camps.update();
    const priorView = scene.render.camps.views.get(old.id);
    camps.damageBuilding(old, old.hp * 2, scene.units.find(u => u.team === 'blue'));   // 桥头工事减伤：给足伤害
    scene.territory.econ.treasury.red = 1000;
    const worker = scene.units.find(u => u.team === 'red' && u.type === 'worker');
    assert.equal(camps.requestBuild('red', worker.id, 'tower', 0), true);
    const rebuilt = camps.getBuilding(old.id);
    assert.notEqual(rebuilt, old);
    scene.render.camps.update();
    const view = scene.render.camps.views.get(rebuilt.id);
    assert.equal(view.building, rebuilt);
    assert.ok(priorView.image.destroyed);
    assert.equal(old.renderBounds, undefined);
    assert.ok(rebuilt.renderBounds);
    assert.equal(scene.render.camps.pick(view.p.x, view.p.y - 100), rebuilt);
    scene.render.camps.update();
    assert.equal(scene.render.camps.views.get(rebuilt.id), view, '后续帧不重复重建视图');
});

test('真实营寨有独立寨墙与塔，未变化帧不重建；施工、废墟与模式清理反映模拟状态',()=>{
    const scene=renderScene(),camp=building(),tower={...building('tower'),gx:14};
    scene.territory={camps:{buildings:[camp,tower]}};
    const renderer=new CampRenderer(scene);renderer.update();
    assert.equal(renderer.views.size,2);
    const cv=renderer.views.get(camp.id),tv=renderer.views.get(tower.id);
    assert.ok(cv.parts.length>12,'营寨是帐房和四面木栏组成的空间，不能退化成标记');
    assert.match(tv.label.text,/0\/4/,'空塔明确显示无驻军');
    const created=scene.objects.length,clears=cv.status.clears;
    renderer.update();assert.equal(scene.objects.length,created);assert.equal(cv.status.clears,clears);
    tower.complete=false;tower.progress=0.45;renderer.update();assert.match(tv.label.text,/施工 45%/);
    tower.dead=true;renderer.update();assert.equal(tv.image.visible,false);assert.equal(tv.rubble.visible,true);
    assert.notEqual(renderer.pick(tv.p.x,tv.p.y-82),tower,'废墟不再作为可驻守建筑拾取');
    scene.battleOptions.territory=false;renderer.update();
    assert.equal(renderer.views.size,0);assert.ok(tv.status.destroyed);assert.equal(camp.renderBounds,undefined);
});

test('塔内四名弓手分别立在真实平台，离塔或塔毁恢复地面，槽位不改模拟坐标',()=>{
    const tower=building('tower');tower.garrisonIds=[1,2,3,4];
    const system={buildings:[tower],getBuilding:id=>id===tower.id?tower:null};
    const units=tower.garrisonIds.map(id=>({id,gx:12,gy:20,garrisonTowerId:tower.id,garrisonHeight:82}));
    const offsets=units.map(unit=>towerCrewOffset(unit,system));
    assert.equal(new Set(offsets.map(o=>`${o.x},${o.y}`)).size,4);
    assert.ok(offsets.every(o=>o.y<-70),'驻军脚底必须抬到木平台');
    assert.ok(units.every(u=>u.gx===12&&u.gy===20),'槽位仅表现，不改变锁步坐标');
    tower.dead=true;assert.equal(towerCrewOffset(units[0],system),null);
    delete units[0].garrisonTowerId;assert.equal(towerCrewOffset(units[0],system),null);
    assert.ok(footProfile('worker').pad>=0);assert.equal(animAlignProfile('worker').walk.length,4);
});

test('尸体跨留痕块边界完整盖印，原精灵位置不变，远处血迹不分配途经整图',()=>{
    const scene=renderScene(),layer=new ScarLayer(scene,1024);
    const corpse={x:1020,y:600,getBounds:()=>({x:1000,y:560,width:55,height:65})};
    layer.draw(corpse);
    assert.equal(layer.tiles.size,2,'跨x边界分两块盖印');
    assert.equal(layer.tiles.get('0,0').draws[0].x,1020);
    assert.equal(layer.tiles.get('1,0').draws[0].x,-4);
    assert.equal(corpse.x,1020,'盖印不移动真实尸体');
    const graphics={x:0,y:0};
    layer.draw(graphics,[{x:100,y:100,width:20,height:10},{x:14300,y:6600,width:20,height:10}]);
    assert.equal(layer.tiles.size,3,'稀疏血迹只触达3块，不烘焙15360像素全图');
    const tiles=[...layer.tiles.values()];layer.clear();
    assert.ok(tiles.every(t=>t.destroyed));assert.equal(layer.tiles.size,0);
    layer.draw(corpse);assert.equal(layer.tiles.size,2,'清局后留痕可重新使用');layer.destroy();
});

test('驻守弓手真实精灵/箭口抬至平台，箭击建筑只走建筑伤害，不喷血或击退建筑',()=>{
    const scene=makeScene();scene.hpGfx=scene.arrowGfx;scene.lowFX=true;
    const archer=addUnit(scene,'red','archer'),tower={...building('tower'),gx:archer.gx,gy:archer.gy,garrisonIds:[archer.id]};
    const target={...building('camp'),id:'camp:blue:home',team:'blue',gx:archer.gx+5,gy:archer.gy,
        isBuilding:true,scene,battleId:scene.battleId,typeData:{def:0}};
    let buildingDamage=0,blood=0;
    scene.territory={camps:{buildings:[tower,target],getBuilding:id=>[tower,target].find(b=>b.id===id),
        damageBuilding:(b,amount)=>{buildingDamage+=amount;b.hp-=amount;return amount;}}};
    archer.garrisonTowerId=tower.id;archer.garrisonHeight=82;
    scene.render.units.syncOne(archer,0,null);
    const ground=scene.groundPoint(archer.gx,archer.gy);
    assert.ok(Math.abs(archer.spr.y-(ground.y-85+archer.footDy))<1.1,'真实脚底跟随第一平台槽位，允许既有站姿素材对齐的0.9px补正');
    assert.equal(archer.shadow.visible,false,'塔内弓手不留下地面队伍圈');
    scene.bloodBurst=()=>blood++;
    scene.render.fx.fireArrow(archer,target);
    assert.equal(scene.arrows[0].sourceHeight,scene.terrainHeight(archer.gx,archer.gy)+82/Terrain.HEIGHT_SCALE);
    assert.equal(scene.arrows[0].sourceOffsetX,-13,'真实箭源跟随站位槽');
    scene.render.fx.updateArrows(1,1000);
    assert.ok(buildingDamage>0,'真正结算建筑生命值');assert.equal(scene.arrows.length,0);assert.equal(blood,0);
    assert.doesNotThrow(()=>scene.render.fx.meleeImpact(archer,target),'建筑没有lunge，也不能当活人受击');
    delete archer.garrisonTowerId;archer.garrisonHeight=0;scene.render.units.syncOne(archer,1,null);
    assert.ok(Math.abs(archer.spr.y-(ground.y+archer.footDy))<1.1);assert.equal(archer.shadow.visible,true);
});

test('民夫施工工具动作仅在真实施工时播放，停工、完工立即回站姿，不制造攻击',()=>{
    const scene=makeScene();scene.hpGfx=scene.arrowGfx;
    const worker=addUnit(scene,'red','worker');
    const site={id:'camp:red:0',dead:false,complete:false,paused:false,workerId:worker.id};
    worker.workerTask={kind:'build',buildingId:site.id};worker.moving=false;
    let played='';worker.spr.play=key=>played=key;
    scene.territory={camps:{getBuilding:id=>id===site.id?site:null}};
    let attackCalls=0;scene.playAttackAnim=()=>attackCalls++;
    scene.render.units.syncOne(worker,0,null);
    assert.equal(worker.animState,'build');assert.match(played,/_worker_build$/);
    site.paused=true;scene.render.units.syncOne(worker,1,null);assert.equal(worker.animState,'idle');
    site.paused=false;site.complete=true;scene.render.units.syncOne(worker,2,null);
    assert.equal(worker.animState,'idle');assert.equal(attackCalls,0,'工具动作不触发攻击、伤害或音效');
});
