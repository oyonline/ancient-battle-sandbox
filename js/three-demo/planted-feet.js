import { Vector3, Quaternion } from 'three';
// Bounded visual contact correction for this infantry rig; never moves its root.
export class PlantedFeet {
 constructor(model){this.legs=[];this.anchors=new Map();model.traverse(o=>{if(o.isSkinnedMesh&&this.legs.length===0){const find=n=>o.skeleton.bones.find(b=>b.name.replaceAll('.','')===n);for(const side of ['L','R'])this.legs.push({side,hip:find('Thigh'+side),knee:find('Shin'+side),foot:find('Foot'+side)});}});}
 clear(){this.anchors.clear();}
 rotateToward(bone,from,to){const delta=new Quaternion().setFromUnitVectors(from.normalize(),to.normalize());const world=bone.getWorldQuaternion(new Quaternion()).premultiply(delta);bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).invert().multiply(world));bone.updateWorldMatrix(false,true);}
 update(state,phase,age,dt){
  const active=['walk','turn'].includes(state)&&(state!=='walk'||age>=.18);
  for(const leg of this.legs){
   const {hip,knee,foot}=leg;if(!hip||!knee||!foot)continue;
   const h=hip.getWorldPosition(new Vector3()),k=knee.getWorldPosition(new Vector3()),a=foot.getWorldPosition(new Vector3());
   const p=(phase+(leg.side==='L'?.5:0))%1;let anchor=this.anchors.get(leg.side);
   const contact=active&&p<.5&&(!anchor||anchor.state===state);
   if(contact&&!anchor){anchor={position:a.clone(),rotation:foot.getWorldQuaternion(new Quaternion()),state,weight:0};this.anchors.set(leg.side,anchor);}
   if(!anchor)continue;
   anchor.weight=Math.max(0,Math.min(1,anchor.weight+dt*(contact?12.5:-8.333333)));
   if(anchor.weight===0){this.anchors.delete(leg.side);continue;}
   // Fade the extra correction itself, including when leaving locomotion.
   const target=a.clone().lerp(anchor.position,anchor.weight);
   if(!contact)target.y=Math.max(target.y,anchor.position.y+.035*Math.sin((1-anchor.weight)*Math.PI));
   const footRotation=foot.getWorldQuaternion(new Quaternion()).slerp(anchor.rotation,anchor.weight);
   const l1=h.distanceTo(k),l2=k.distanceTo(a),d=target.clone().sub(h);const distance=Math.min(d.length(),l1+l2-.002),u=d.normalize();target.copy(h).addScaledVector(u,distance);
   const along=(l1*l1-l2*l2+distance*distance)/(2*Math.max(distance,.001)),height=Math.sqrt(Math.max(0,l1*l1-along*along));
   const pole=k.clone().sub(h).addScaledVector(u,-k.clone().sub(h).dot(u));if(pole.lengthSq()<1e-8)continue;
   const targetKnee=h.clone().addScaledVector(u,along).addScaledVector(pole.normalize(),height);
   this.rotateToward(hip,k.clone().sub(h),targetKnee.clone().sub(h));
   const nowKnee=knee.getWorldPosition(new Vector3()),nowFoot=foot.getWorldPosition(new Vector3());this.rotateToward(knee,nowFoot.sub(nowKnee),target.clone().sub(nowKnee));
   foot.quaternion.copy(foot.parent.getWorldQuaternion(new Quaternion()).invert().multiply(footRotation));foot.updateWorldMatrix(false,true);
  }
 }
}
