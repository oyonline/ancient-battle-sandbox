import { Vector3, Quaternion, Matrix4 } from 'three';

// Optional, bounded slope overlay. The actor root and exported clips stay intact.
export class TerrainContact {
 constructor(model, feet, heightAt,scale=1) {
  this.scale=scale;
  this.model=model;this.feet=feet;this.heightAt=heightAt;this.saved=[];
  model.updateMatrixWorld(true);
  this.soles=feet.legs.map(leg=>{
   const vertices=[];model.traverse(mesh=>{
    if(!mesh.isSkinnedMesh)return;
    const indices=mesh.geometry.attributes.skinIndex,weights=mesh.geometry.attributes.skinWeight;
    for(let i=0;i<indices.count;i++){
     let dominant=0;for(let j=1;j<4;j++)if(weights.getComponent(i,j)>weights.getComponent(i,dominant))dominant=j;
     if(mesh.skeleton.bones[indices.getComponent(i,dominant)]!==leg.foot)continue;
     vertices.push(mesh.getVertexPosition(i,new Vector3()).applyMatrix4(mesh.matrixWorld));
    }
   });
   const bottom=Math.min(...vertices.map(v=>v.y));
   const inverse=leg.foot.matrixWorld.clone().invert();
   return {leg,points:vertices.filter(v=>v.y<=bottom+.025*scale).map(v=>v.applyMatrix4(inverse))};
  });
 }
 restore(){for(const [bone,q] of this.saved)bone.quaternion.copy(q);this.saved=[];this.flatGaps=null;}
 rememberLift(){
  this.model.updateMatrixWorld(true);
  const center=this.model.parent.getWorldPosition(new Vector3()),height=this.heightAt(center.x,center.z);
  // Capture the authored lift before world-space M1 support anchors affect Y.
  this.flatGaps=new Map(this.soles.map(({leg,points})=>[leg.side,Math.min(...points.map(p=>p.clone().applyMatrix4(leg.foot.matrixWorld).y-height))]));
 }
 apply(state,phase=0){
  if(!['idle','walk','turn','attack','hit'].includes(state))return;
  this.model.updateMatrixWorld(true);
  const root=this.model.parent,center=root.getWorldPosition(new Vector3()),centerHeight=this.heightAt(center.x,center.z);
  // Flat QA remains exactly the established pose, including authored foot lift.
  for(const {leg,points}of this.soles){
   const {hip,knee,foot}=leg;if(!points.length||!hip||!knee||!foot)continue;
   const a=foot.getWorldPosition(new Vector3());
   const dx=(this.heightAt(a.x+.1,a.z)-this.heightAt(a.x-.1,a.z))/.2;
   const dz=(this.heightAt(a.x,a.z+.1)-this.heightAt(a.x,a.z-.1))/.2;
   const slope=Math.hypot(dx,dz),delta=this.heightAt(a.x,a.z)-centerHeight;
   if(slope<1e-7&&Math.abs(delta)<1e-7)continue;
   for(const bone of [hip,knee,foot])this.saved.push([bone,bone.quaternion.clone()]);
   const p=(phase+(leg.side==='L'?.5:0))%1;
   // Swing follows the same terrain-relative height; its authored lift is retained.
   const weight=state==='walk'?.5+.5*Math.sin(p*2*Math.PI):1;
   const normal=new Vector3(-dx,1,-dz).normalize();
   const tilt=new Quaternion().setFromUnitVectors(new Vector3(0,1,0),normal);
   const angle=2*Math.acos(Math.min(1,Math.abs(tilt.w)));
   if(angle>.28)tilt.slerp(new Quaternion(),1-.28/angle);
   tilt.slerp(new Quaternion(),1-weight);
   const rotation=foot.getWorldQuaternion(new Quaternion()).premultiply(tilt);
   const h=hip.getWorldPosition(new Vector3()),k=knee.getWorldPosition(new Vector3());
   const rotated=new Matrix4().compose(a,rotation,foot.getWorldScale(new Vector3()));
   const flatGap=this.flatGaps?.get(leg.side)??Math.min(...points.map(p=>p.clone().applyMatrix4(foot.matrixWorld).y-centerHeight));
   const slopeGap=Math.min(...points.map(p=>{const v=p.clone().applyMatrix4(rotated);return v.y-this.heightAt(v.x,v.z);}));
   const target=a.clone();target.y+=Math.max(-.18*this.scale,Math.min(.18*this.scale,flatGap-slopeGap));
   const l1=h.distanceTo(k),l2=k.distanceTo(a),direction=target.clone().sub(h);
   const distance=Math.max(.001,Math.min(direction.length(),l1+l2-.002*this.scale)),axis=direction.normalize();
   const along=(l1*l1-l2*l2+distance*distance)/(2*distance),bend=Math.sqrt(Math.max(0,l1*l1-along*along));
   const pole=k.clone().sub(h);pole.addScaledVector(axis,-pole.dot(axis));
   if(pole.lengthSq()<1e-8)continue;
   const targetKnee=h.clone().addScaledVector(axis,along).addScaledVector(pole.normalize(),bend);
   this.feet.rotateToward(hip,k.clone().sub(h),targetKnee.sub(h));
   const nowKnee=knee.getWorldPosition(new Vector3()),nowFoot=foot.getWorldPosition(new Vector3());
   this.feet.rotateToward(knee,nowFoot.sub(nowKnee),target.sub(nowKnee));
   foot.quaternion.copy(foot.parent.getWorldQuaternion(new Quaternion()).invert().multiply(rotation));foot.updateWorldMatrix(false,true);
  }
 }
 inspect(){return this.soles.map(({leg,points})=>({side:leg.side,gap:Math.min(...points.map(p=>{const v=p.clone().applyMatrix4(leg.foot.matrixWorld);return v.y-this.heightAt(v.x,v.z);})),points:points.length}));}
}
