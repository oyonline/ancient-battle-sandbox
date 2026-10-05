import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAxeTextures, axePortraitDataUrl } from '../js/render/axe-textures.js';

test('斧兵纹理生成兼容无绘图模拟环境',()=>{
    assert.doesNotThrow(()=>ensureAxeTextures({textures:{}}));
    assert.equal(axePortraitDataUrl('red'),'');
});

test('斧兵红蓝黑拥有完整独立动画帧，重复开局不重复注册',()=>{
    const textures=new Map(),anims=new Map();
    const colors=new Set();
    const ctx=new Proxy({}, {get:()=>()=>{},set(target,key,value){if(key==='fillStyle') colors.add(value);target[key]=value;return true;}});
    const scene={textures:{exists:key=>textures.has(key),createCanvas(key,width,height){
        const texture={width,height,frames:[],getContext:()=>ctx,refresh(){},add(frame,source,x,y,w,h){this.frames.push({frame,x,y,w,h});}};
        textures.set(key,texture);return texture;
    }},anims:{exists:key=>anims.has(key),generateFrameNumbers:()=>[0,1,2,3],create:def=>anims.set(def.key,def)}};
    ensureAxeTextures(scene);ensureAxeTextures(scene);
    assert.equal(textures.size,9);assert.equal(anims.size,6);
    for(const team of ['red','blue','black']) {
        assert.ok(textures.has(`units/${team}_axe`));
        for(const clip of ['walk','attack']) {
            const key=`assets/units/anim/${team}_axe_${clip}`;
            const texture=textures.get(key);assert.equal(texture.width,158*4);assert.equal(texture.height,156);
            assert.deepEqual(texture.frames.map(f=>f.frame),[0,1,2,3]);
            assert.equal(anims.get(key).repeat,clip==='walk'?-1:0);
        }
    }
    for(const color of ['#bd5143','#487fc0','#55535b','#eef1df']) assert.ok(colors.has(color));
});

test('大厅画像在非绘图DOM或不可用2D上下文中安全回退',t=>{
    const previous=globalThis.document;t.after(()=>{globalThis.document=previous;});
    globalThis.document={createElement:()=>({})};assert.equal(axePortraitDataUrl('red'),'');
    globalThis.document={createElement:()=>({getContext:()=>null,toDataURL(){throw new Error('不得导出不可用画布');}})};
    assert.equal(axePortraitDataUrl('blue'),'');
});
