import {Vector3,Quaternion} from 'three';
// Two-bone solve with an explicit anatomical plane. The preferred bend comes
// from the character frame, never the nearly-straight previous joint projection.
export function solveCivilianLimb(limb,requested,orientation,poleDirection,minFlex=.14){
 const {hip,knee,foot}=limb,h=hip.getWorldPosition(new Vector3()),k=knee.getWorldPosition(new Vector3()),f=foot.getWorldPosition(new Vector3());
 const l1=h.distanceTo(k),l2=k.distanceTo(f),delta=requested.clone().sub(h),axis=delta.lengthSq()>1e-12?delta.normalize():new Vector3(0,-1,0);
 const min=Math.sqrt(l1*l1+l2*l2+2*l1*l2*Math.cos(2.65)),max=Math.sqrt(l1*l1+l2*l2+2*l1*l2*Math.cos(minFlex)),d=Math.max(min,Math.min(max,h.distanceTo(requested))),target=h.clone().addScaledVector(axis,d);
 let pole=poleDirection.clone().addScaledVector(axis,-poleDirection.dot(axis));if(pole.lengthSq()<1e-8){pole=new Vector3(0,1,0);pole.addScaledVector(axis,-pole.dot(axis));if(pole.lengthSq()<1e-8)pole.set(1,0,0);}pole.normalize();
 const along=(l1*l1-l2*l2+d*d)/(2*d),joint=h.clone().addScaledVector(axis,along).addScaledVector(pole,Math.sqrt(Math.max(0,l1*l1-along*along)));
 const rotate=(bone,from,to)=>{const q=new Quaternion().setFromUnitVectors(from.normalize(),to.normalize()).multiply(bone.getWorldQuaternion(new Quaternion()));bone.quaternion.copy(bone.parent.getWorldQuaternion(new Quaternion()).invert().multiply(q));bone.updateWorldMatrix(false,true);};
 rotate(hip,k.clone().sub(h),joint.clone().sub(h));const now=knee.getWorldPosition(new Vector3());rotate(knee,foot.getWorldPosition(new Vector3()).sub(now),target.clone().sub(now));foot.quaternion.copy(foot.parent.getWorldQuaternion(new Quaternion()).invert().multiply(orientation));foot.updateWorldMatrix(false,true);return {requestedDistance:h.distanceTo(requested),solvedDistance:d,min,max};
}
