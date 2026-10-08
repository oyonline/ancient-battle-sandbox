import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MANIFEST } from '../js/manifest.js';
import { FOOT } from '../js/render/sprites.js';

const expected={axe:['walk','attack'],worker:['walk','build','attack','carry'],medic:['walk','heal','attack']};
function pngSize(file){const b=readFileSync(new URL('../public/assets/'+file,import.meta.url));assert.equal(b.subarray(1,4).toString(),'PNG');return [b.readUInt32BE(16),b.readUInt32BE(20)];}
test('新增三兵红蓝黑使用完整透明PNG图集，所有注册帧尺寸与实际文件一致',()=>{
 for(const [type,clips] of Object.entries(expected))for(const team of ['red','blue','black']){
  const unit=MANIFEST.units[`${team}_${type}`];assert.ok(unit);
  assert.deepEqual(pngSize(unit.file),[unit.w,unit.h]);
  for(const clip of clips){const a=MANIFEST.anims[`${team}_${type}`][clip];assert.ok(a);assert.equal(a.frames,4);assert.deepEqual(pngSize('units/'+a.file),[a.fw*a.frames,a.fh]);}
 }
});
test('新兵脚底匹配打包锚点，全动作共用按行走身体测得的缩放比例',()=>{
 const metadata=JSON.parse(readFileSync(new URL('../tools/unit-art-v3/packing.json',import.meta.url)));
 for(const type of Object.keys(expected)){
  const m=metadata[type];assert.ok(m.scale>0&&m.scale<1);
  assert.equal(FOOT[type].pad,m.frameSize-m.ground);
  assert.ok(m.walkBodyHeights.every(h=>Math.abs(h*m.scale-m.bodyHeight)<5));
  for(const a of Object.values(MANIFEST.anims[`red_${type}`]))assert.equal(a.fh,m.frameSize);
 }
});
test('三阵营只换队伍颜色，保留相同PNG帧条尺寸',()=>{
 for(const [type,clips] of Object.entries(expected))for(const clip of clips){
  const files=['red','blue','black'].map(team=>readFileSync(new URL('../public/assets/units/'+MANIFEST.anims[`${team}_${type}`][clip].file,import.meta.url)));
  assert.notDeepEqual(files[0],files[1]);assert.notDeepEqual(files[0],files[2]);
 }
});

test('真实spawn与动画查找对黑方三新兵使用自身位图，不再复用蓝方染色',async()=>{
 const {makeScene}=await import('./battle-harness.js');
 const scene=makeScene(),create=scene.add.sprite;
 scene.add.sprite=(x,y,key)=>{const sprite=create(x,y);sprite.loadedKey=key;return sprite;};
 for(const type of Object.keys(expected)){
  const u=scene.spawnUnit('black',type,20,20);
  assert.equal(u.spr.loadedKey,`units/black_${type}`);assert.equal(u.baseTint,null);
  for(const clip of expected[type])assert.equal(scene.render.units.unitAnimKey(u,clip),`assets/units/anim/black_${type}_${clip}`);
 }
});
