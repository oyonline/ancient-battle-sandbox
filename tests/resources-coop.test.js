import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, Terrain } from './battle-harness.js';
import { board } from '../js/board.js';
import { homePosition, territoryLayout } from '../js/territory-map.js';
import { battleProjection, NetBattle } from '../js/net/lockstep.js';

function setup(coop = false, side = 'red') {
    const s = makeScene();
    s.deployUnits({ worker: 1 }, { worker: 1 }, 'custom','custom',{},
        { territory:true, terrain:'territory', coop, black:coop ? {worker:1}:undefined, territoryAI:false, net:true, mySide:side });
    s.battleStarted=true; s.territory.autoBuy.black=false;
    return s;
}
function drive(s,w,n=1) {
    for(let i=0;i<n;i++){s.simulationTime+=1000/60;s.rebuildSpatial();s.territory.camps.updateUnit(w,s.simulationTime,1/60);s.flushBattleActions();}
}
test('真实部署和同尺寸模式切换保留合作布局，基地/采集点/援军一致',()=>{
    const s=setup();
    for(const coop of [true,false,true]) {
        s.deployUnits({worker:1},{worker:1},'custom','custom',{}, {territory:true,terrain:'territory',coop,black:coop?{worker:1}:undefined,territoryAI:false});
        assert.equal(s.battleOptions.coop,coop);
        for(const team of s.activeTeams){
            const expected=homePosition(team,board.W,board.H,coop),base=s.territory.camps.getBuilding(`camp:${team}:home`);
            assert.equal(base.gx,expected.gx);assert.ok(Math.abs(base.gy-expected.gy)<4);
            const w=s.units.find(u=>u.team===team && u.type==='worker');assert.ok(Math.hypot(w.gx-expected.gx,w.gy-expected.gy)<4);
            const n=s.spawnTerritoryUnit(team,'infantry');assert.ok(Math.hypot(n.gx-expected.gx,n.gy-expected.gy)<12);
            assert.ok(s.territory.resources.nodes.some(n=>Math.hypot(n.gx-expected.gx,n.gy-expected.gy)<16));
        }
    }
    const layout=territoryLayout(board.W,board.H,true);
    for(const route of layout.routes) for(let i=1;i<route.length;i++) {
        const [x,y]=route[i-1],[xx,yy]=route[i];
        assert.ok(Terrain.segmentClear('territory',x,y,xx,yy),`route ${x},${y} → ${xx},${yy}`);
    }
});
test('采集只增加携带量，回基地才交付；换令保留货物且不能重复入账',()=>{
    const s=setup(),r=s.territory.resources,w=s.units[0],n=r.nodes[0],cash=s.territory.econ.treasury.red;
    assert.equal(s.applyNetCommand({k:'worker-gather',side:'blue',worker:w.id,resource:n.id}),false);
    assert.equal(s.applyNetCommand({k:'worker-gather',side:'red',worker:w.id,resource:n.id}),true);
    w.gx=n.gx;w.gy=n.gy;drive(s,w,150);
    assert.ok(w.cargo>9);assert.equal(s.territory.econ.treasury.red,cash);
    const cargo=w.cargo;
    assert.equal(s.applyNetCommand({k:'worker-move',side:'red',worker:w.id,gx:n.gx+3,gy:n.gy}),true);assert.equal(w.cargo,cargo);
    assert.equal(s.applyNetCommand({k:'worker-deliver',side:'red',worker:w.id}),true);
    const home=r.home('red');w.gx=home.gx;w.gy=home.gy;drive(s,w);
    assert.equal(w.cargo,0);assert.equal(s.territory.econ.treasury.red,cash+cargo);
    drive(s,w,20);assert.equal(s.territory.econ.treasury.red,cash+cargo);
});
test('资源枯竭运回尾货，死亡和基地毁坏不能凭空交付',()=>{
    const s=setup(),r=s.territory.resources,w=s.units[0],n=r.nodes[0];n.remaining=1;
    r.orderGather('red',w.id,n.id);w.gx=n.gx;w.gy=n.gy;drive(s,w,20);
    assert.equal(n.remaining,0);assert.ok(Math.abs(w.cargo-1)<1e-9);
    const home=r.home('red'),cash=s.territory.econ.treasury.red;w.gx=home.gx;w.gy=home.gy;
    w.dead=true;drive(s,w);assert.equal(s.territory.econ.treasury.red,cash);
    w.dead=false;home.dead=true;drive(s,w);assert.equal(s.territory.econ.treasury.red,cash);assert.ok(Math.abs(w.cargo-1)<1e-9);
});
test('合作仅摧毁电脑主基地即胜，残兵箭塔军费和队列不阻止；基地毁后禁止出兵',()=>{
    const s=setup(true),base=s.territory.camps.getBuilding('camp:black:home');
    assert.equal(s.territory.recruit.enqueue('black','infantry'),true);
    base.dead=true;s.territory.recruit.update();
    assert.deepEqual(s.territory.recruit.queues.black,[]);
    assert.equal(s.territory.recruit.enqueue('black','infantry'),false);
    s.checkWin();assert.equal(s.battleOver,true);assert.equal(s.winner,'red');
});
test('双端真实锁步采集交付一致，资源与货物进入哈希',()=>{
    const scenes=[setup(false,'red'),setup(false,'blue')];
    for(const s of scenes) {const w=s.units[0],n=s.territory.resources.nodes[0];w.gx=n.gx;w.gy=n.gy;}
    const deliver=p=>scenes.forEach(s=>s.net.handle(p));
    for(const s of scenes)s.net=new NetBattle(s,{send:deliver});
    for(const s of scenes)s.net.start();
    scenes[0].net.lockstep.act({k:'worker-gather',side:'red',worker:scenes[0].units[0].id,resource:0});
    let deliveries=0;
    for(let turn=0;turn<1800;turn++)for(const s of scenes){
        assert.ok(s.net.lockstep.canStep());for(const c of s.net.lockstep.takeCommands())assert.equal(s.applyNetCommand(c),true);
        const old=s.units[0].cargo || 0;s.simulationTime+=1000/60;s.stepBattle(1/60);s.net.onTurnDone();
        if(old>0 && s.units[0].cargo===0)deliveries++;
        if(s===scenes[1])assert.equal(battleProjection(scenes[0]),battleProjection(s));
    }
    assert.ok(deliveries>=2,'每端都必须真实交付');
    const s=scenes[0],baseline=battleProjection(s);s.units[0].cargo+=1;assert.notEqual(battleProjection(s),baseline);s.units[0].cargo-=1;
    s.territory.resources.nodes[0].remaining-=1;assert.notEqual(battleProjection(s),baseline);
});
