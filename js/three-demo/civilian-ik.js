import {Vector3,Quaternion,Matrix4} from 'three';
const basis=(y,z)=>{y=y.clone().normalize();z=z.clone().addScaledVector(y,-z.dot(y)).normalize();return new Matrix4().makeBasis(y.clone().cross(z).normalize(),y,z);};
export function prepareCivilianLimb(limb){
 const h=limb.hip.getWorldPosition(new Vector3()),k=limb.knee.getWorldPosition(new Vector3()),f=limb.foot.getWorldPosition(new Vector3());
 const normal=k.clone().sub(h).cross(f.clone().sub(k));if(normal.lengthSq()<1e-10)normal.set(0,0,1);normal.normalize();
 const frames=[{bone:limb.hip,child:limb.knee},{bone:limb.knee,child:limb.foot}].map(({bone,child})=>{const q=bone.getWorldQuaternion(new Quaternion()),y=child.position.clone().normalize(),z=normal.clone().applyQuaternion(q.clone().invert());return new Quaternion().setFromRotationMatrix(basis(y,z)).invert();});Object.defineProperty(limb,'frames',{value:frames,writable:true});
}
// A complete anatomical frame avoids inheriting animated axial roll.
export function solveCivilianLimb(limb,requested,orientation,poleDirection,minFlex=.22){
 if(!limb.frames)prepareCivilianLimb(limb);
 const {hip,knee,foot}=limb,h=hip.getWorldPosition(new Vector3()),k=knee.getWorldPosition(new Vector3()),f=foot.getWorldPosition(new Vector3());
 const l1=h.distanceTo(k),l2=k.distanceTo(f),delta=requested.clone().sub(h),axis=delta.lengthSq()>1e-12?delta.normalize():new Vector3(0,-1,0);
 const min=Math.sqrt(l1*l1+l2*l2+2*l1*l2*Math.cos(2.65)),max=Math.sqrt(l1*l1+l2*l2+2*l1*l2*Math.cos(minFlex)),d=Math.max(min,Math.min(max,h.distanceTo(requested))),target=h.clone().addScaledVector(axis,d);
 const pole=poleDirection.clone().addScaledVector(axis,-poleDirection.dot(axis));if(pole.lengthSq()<1e-8){pole.set(0,1,0).addScaledVector(axis,-axis.y);if(pole.lengthSq()<1e-8)pole.set(1,0,0);}pole.normalize();
 const along=(l1*l1-l2*l2+d*d)/(2*d),joint=h.clone().addScaledVector(axis,along).addScaledVector(pole,Math.sqrt(Math.max(0,l1*l1-along*along)));
 const normal=joint.clone().sub(h).cross(target.clone().sub(joint)).normalize();
 const orient=(bone,y,frame)=>{const q=new Quaternion().setFromRotationMatrix(basis(y,normal)).multiply(frame).normalize();bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).normalize().invert().multiply(q)).normalize();bone.updateWorldMatrix(false,true);};
 orient(hip,joint.clone().sub(h),limb.frames[0]);orient(knee,target.clone().sub(knee.getWorldPosition(new Vector3())),limb.frames[1]);
 foot.quaternion.copy(foot.parent.getWorldQuaternion(new Quaternion()).normalize().invert().multiply(orientation.clone().normalize())).normalize();foot.updateWorldMatrix(false,true);return {requestedDistance:h.distanceTo(requested),solvedDistance:d,min,max};
}

// Death grounding preserves the current native bend plane and axial roll.
export function projectCivilianFoot(limb,requested,orientation){
 const {hip,knee,foot}=limb,h=hip.getWorldPosition(new Vector3()),k=knee.getWorldPosition(new Vector3()),f=foot.getWorldPosition(new Vector3()),l1=h.distanceTo(k),l2=k.distanceTo(f),axis=requested.clone().sub(h).normalize();
 const distance=Math.max(Math.sqrt(l1*l1+l2*l2+2*l1*l2*Math.cos(2.65)),Math.min(Math.sqrt(l1*l1+l2*l2+2*l1*l2*Math.cos(.10)),h.distanceTo(requested))),target=h.clone().addScaledVector(axis,distance);
 let pole=k.clone().sub(h).addScaledVector(axis,-k.clone().sub(h).dot(axis));if(pole.lengthSq()<1e-10)pole=new Vector3(0,0,1).addScaledVector(axis,-axis.z);pole.normalize();const along=(l1*l1-l2*l2+distance*distance)/(2*distance),joint=h.clone().addScaledVector(axis,along).addScaledVector(pole,Math.sqrt(Math.max(0,l1*l1-along*along)));
 const rotate=(bone,from,to)=>{const q=new Quaternion().setFromUnitVectors(from.normalize(),to.normalize()).multiply(bone.getWorldQuaternion(new Quaternion()).normalize());bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).normalize().invert().multiply(q)).normalize();bone.updateWorldMatrix(false,true);};
 rotate(hip,k.clone().sub(h),joint.clone().sub(h));const now=knee.getWorldPosition(new Vector3());rotate(knee,foot.getWorldPosition(new Vector3()).sub(now),target.clone().sub(now));foot.quaternion.copy(foot.parent.getWorldQuaternion(new Quaternion()).normalize().invert().multiply(orientation.clone().normalize())).normalize();foot.updateWorldMatrix(false,true);
}
