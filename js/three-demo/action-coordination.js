import { Vector3, Quaternion } from 'three';
import { updateSkinMatrices } from './animation-controller.js';

// Presentation only: projectile simulation, damage and collision remain untouched.
const point = new Vector3(),lean=new Quaternion(),localX=new Vector3(1,0,0);
export function heldArrow(unit) { return unit.model.getObjectByName('Arrow'); }
export function syncHeldArrow(unit) {
 const bone=heldArrow(unit);if(!bone)return;
 bone.scale.setScalar(unit.hp>0&&!unit.arrowReleased?1:.001);
}
export function coordinateEvent(event) {
 const unit=event.from;
 if(event.type==='draw'){unit.arrowReleased=false;}
 else if(event.type==='shoot'){unit.arrowReleased=true;}
 else if(event.type==='charge'&&unit.animation&&!unit.animation.dead){
  // A resolved impact takes over a pending ordinary thrust, but never a hit/death.
  unit.animation.cancelAttack(true);
  if(!unit.animation.oneShot)unit.animation.play('charge');
 }
}
export function arrowReleasePoint(unit) {
 const bone=heldArrow(unit);if(!bone)return unit.root.position.clone().add(new Vector3(0,1.5,0));
 bone.scale.setScalar(1);updateSkinMatrices(unit.model);
 // Arrow bone is rooted at the nock and its local +Y points along the shaft.
 point.set(0,.79,0);return bone.localToWorld(point).clone();
}
export function flightPose(shot,origin,heightAt,launch) {
 const progress=Math.min(1,Math.max(0,shot.age/shot.duration));
 const y0=heightAt(shot.startX,shot.startZ)+1.5,y1=heightAt(shot.endX,shot.endZ)+1.5;
 const offsetX=origin.x-launch.x,offsetZ=origin.z-launch.z;
 const position=new Vector3(shot.x+offsetX*(1-progress),y0+(y1-y0)*progress+(origin.y-y0)*(1-progress)+Math.sin(progress*Math.PI)*.45,shot.z+offsetZ*(1-progress));
 const tangent=new Vector3(shot.vx-offsetX/shot.duration,(y1-y0-origin.y+y0+Math.cos(progress*Math.PI)*Math.PI*.45)/shot.duration,shot.vz-offsetZ/shot.duration).normalize();
 return {position,tangent};
}

export function syncChargeImpact(unit) {
 if(unit.kind!=='cavalry'||unit.animation.dead||unit.animation.state==='hit')return;
 const chest=unit.model.getObjectByName('Chest');
 if(chest&&unit.chargeFlash>0){unit.chargeImpactBase=chest.quaternion.clone();chest.quaternion.multiply(lean.setFromAxisAngle(localX,.10*Math.min(1,unit.chargeFlash/.7)));}
}

// The exported bow-side death arm hangs below the lying body. Reposition that
// connected arm at the corpse's side rather than letting it lift the whole body.
const shoulder=new Vector3(),wrist=new Vector3(),desired=new Vector3();
const parentRotation=new Quaternion(),handRotation=new Quaternion(),correction=new Quaternion();
export function restBowArm(unit) {
 if(unit.kind!=='archer'||unit.deathTime<.35)return;
 const upper=unit.model.getObjectByName('UpperArmL'),hand=unit.model.getObjectByName('HandL');if(!upper||!hand)return;
 if(unit.corpseSettled&&unit.bowDeathFinal){upper.quaternion.copy(unit.bowDeathFinal.upper);hand.quaternion.copy(unit.bowDeathFinal.hand);updateSkinMatrices(unit.model);return;}
 const time=unit.animation.actions.get('death').time;
 if(unit.bowDeathBase?.time===time){upper.quaternion.copy(unit.bowDeathBase.upper);hand.quaternion.copy(unit.bowDeathBase.hand);}
 else unit.bowDeathBase={time,upper:upper.quaternion.clone(),hand:hand.quaternion.clone()};
 unit.model.position.y=0;updateSkinMatrices(unit.model);
 upper.getWorldPosition(shoulder);hand.getWorldPosition(wrist);hand.getWorldQuaternion(handRotation);
 const current=wrist.clone().sub(shoulder),length=current.length();if(length<1e-5)return;
 const targetY=unit.root.position.y+.12;if(wrist.y>=targetY)return;
 const vertical=Math.min(length*.95,targetY-shoulder.y),horizontal=Math.sqrt(Math.max(0,length*length-vertical*vertical));
 desired.set(current.x,0,current.z);if(desired.lengthSq()<1e-8)return;desired.normalize().multiplyScalar(horizontal);desired.y=vertical;
 correction.setFromUnitVectors(current.normalize(),desired.normalize());upper.parent.getWorldQuaternion(parentRotation);
 correction.premultiply(parentRotation.clone().invert()).multiply(parentRotation);
 correction.slerp(new Quaternion(),1-Math.min(1,(unit.deathTime-.35)/.3));upper.quaternion.premultiply(correction);
 updateSkinMatrices(unit.model);
 // Preserve the native released bow's orientation while the upper arm moves.
 hand.parent.getWorldQuaternion(parentRotation);hand.quaternion.copy(parentRotation.invert().multiply(handRotation));
 updateSkinMatrices(unit.model);
 if(unit.animation.deathComplete)unit.bowDeathFinal={upper:upper.quaternion.clone(),hand:hand.quaternion.clone()};
}

export function restoreBowArm(unit) {
 if(!unit.bowDeathBase)return;
 unit.model.getObjectByName('UpperArmL')?.quaternion.copy(unit.bowDeathBase.upper);
 unit.model.getObjectByName('HandL')?.quaternion.copy(unit.bowDeathBase.hand);
}

export function restoreChargeImpact(unit) {
 if(!unit.chargeImpactBase)return;
 unit.model.getObjectByName('Chest')?.quaternion.copy(unit.chargeImpactBase);
 unit.chargeImpactBase=null;
}
