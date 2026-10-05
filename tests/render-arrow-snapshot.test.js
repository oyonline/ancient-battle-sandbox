import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectsRenderer } from '../js/render/fx.js';

test('驻塔加成在箭矢发射时快照，出塔或改攻击不追改在途箭',t=>{
    const previous=globalThis.Snd;t.after(()=>{globalThis.Snd=previous;});globalThis.Snd={play(){}};
    const scene={arrows:[],simulationTime:1234,terrainHeight:()=>0};
    const renderer=new EffectsRenderer(scene);
    const from={gx:5,gy:5,team:'red',type:'archer',typeData:{atk:26}};
    const target={gx:8,gy:5};
    renderer.fireArrow(from,target,{rawAttack:31.2});
    from.typeData.atk=1;
    assert.equal(scene.arrows[0].dmg,31.2);assert.equal(scene.arrows[0].firedAt,1234);
    renderer.fireArrow(from,target);assert.equal(scene.arrows[1].dmg,1);
});
