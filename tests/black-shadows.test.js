import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldRenderer } from '../js/render/world.js';
import { UNIT_TYPES } from '../js/units.js';
import { unitVisualDirections, shadowTextureKey } from '../js/render/sprites.js';

test('黑方所有兵种和骑兵方向拥有独立灰色队圈，重开局不重复生成',()=>{
    const textures=new Map();let color;
    const graphics=new Proxy({}, {get(target,key){
        if(key==='lineStyle') return (width,value)=>{color=value;};
        if(key==='generateTexture') return name=>textures.set(name,color);
        return ()=>{};
    }});
    const scene={textures:{exists:key=>textures.has(key)},make:{graphics:()=>graphics}};
    const renderer=new WorldRenderer(scene);renderer.makeShadowTextures();
    const before=textures.size;renderer.makeShadowTextures();assert.equal(textures.size,before);
    for(const type of Object.keys(UNIT_TYPES)) for(const direction of unitVisualDirections(type)) {
        const black=shadowTextureKey('black',type,direction),blue=shadowTextureKey('blue',type,direction);
        assert.notEqual(black,blue);assert.equal(textures.get(black),0x8a8a96);assert.equal(textures.get(blue),0x2f7bff);
    }
});
