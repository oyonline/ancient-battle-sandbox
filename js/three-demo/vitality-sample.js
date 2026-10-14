import { stepSkirmish } from './combat-model.js';

export function sampleSettings(params) {
 const enabled=params.get('sample')==='vitality';
 return {enabled,scale:enabled&&params.get('size')==='30'?.3:1,refined:enabled&&params.get('look')!=='previous'};
}
// The small actors use the same combat algorithm in body-length coordinates.
// Only lengths/linear speeds scale: seconds, HP, damage and event order do not.
// The world boundary stays full size; camera and terrain never scale.
export function stepSizedSkirmish(units,dt,fighting,scale,movementIntent=null) {
 if(scale===1)return stepSkirmish(units,dt,fighting,movementIntent);
 const convert=factor=>{
  for(const u of units){
   for(const key of ['x','z','radius','speed','runup'])u[key]*=factor;
   if(u.target){u.target.x*=factor;u.target.z*=factor;}
  }
 };
 convert(1/scale);
 let events;
 try {events=stepSkirmish(units,dt,fighting,movementIntent,{boundaryScale:1/scale});}
 finally {convert(scale);}
 for(const event of events){if(Number.isFinite(event.x))event.x*=scale;if(Number.isFinite(event.z))event.z*=scale;}
 return events;
}
export function sampleFormation(scale){
 const result=[];
 for(const team of ['red','blue']){
  const side=team==='red'?-1:1;
  for(let i=0;i<6;i++)result.push({team,kind:'infantry',x:side*(5.2+Math.floor(i/3)*2.4)*scale,z:(i%3-1)*2.4*scale,index:i});
  for(let i=0;i<2;i++)result.push({team,kind:'cavalry',x:side*8*scale,z:(6+i*4.3)*scale,index:i+6});
 }
 return result;
}
