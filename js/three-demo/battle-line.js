import { ARCHER, meleeReach } from './combat-model.js';

const foot=u=>u.kind==='infantry'||u.kind==='pikeman';
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const dot=(p,v)=>p.x*v.x+p.z*v.z;
const mean=us=>({x:us.reduce((n,u)=>n+u.x,0)/us.length,z:us.reduce((n,u)=>n+u.z,0)/us.length});
const turn=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));

// Automatic movement goals only. Slots never become player-command targets,
// combat enemies, damage events, or positions written directly into fighters.
export class BattleLine {
 constructor(units){
  this.time=0;this.teams=new Map();this.refills=[];this.goals=new Map();
  for(const team of ['red','blue']){
   const members=units.filter(u=>u.team===team&&foot(u));
   if(!members.length)continue;
   const opposition=units.filter(u=>u.team!==team&&foot(u));
   const center=mean(members),other=opposition.length?mean(opposition):{x:center.x+(team==='red'?1:-1),z:center.z};
   const angle=Math.atan2(other.z-center.z,other.x-center.x),forward={x:Math.cos(angle),z:Math.sin(angle)},lateral={x:-forward.z,z:forward.x};
   const count=Math.min(members.length,members.length<=4?2:4);
   const spacing=Math.max(2.2,Math.max(...members.map(u=>u.radius))*2+.2);
   const ordered=[...members].sort((a,b)=>dot(b,forward)-dot(a,forward)||dot(a,lateral)-dot(b,lateral)||a.id-b.id);
   const first=ordered.slice(0,count).sort((a,b)=>dot(a,lateral)-dot(b,lateral)||a.id-b.id);
   const anchor=mean(first),columns=first.map(u=>[u.id]),membership=new Map(first.map((u,i)=>[u.id,i]));
   for(const u of ordered.slice(count)){
    let best=0,distance=Infinity;
    for(let col=0;col<count;col++){
     const offset=(col-(count-1)/2)*spacing;
     const score=Math.abs(dot(u,lateral)-dot(anchor,lateral)-offset)+Math.max(0,columns[col].length-Math.ceil(members.length/count)+1)*spacing*3;
     if(score<distance){distance=score;best=col;}
    }
    columns[best].push(u.id);membership.set(u.id,best);
   }
   this.teams.set(team,{team,angle,forward,lateral,anchor,spacing,columns,membership,detached:new Map(),manualCenters:new Map()});
  }
 }
 update(units,dt,fighting){
  this.time+=dt;this.goals.clear();this.units=new Map(units.map(u=>[u.id,u]));this.fighting=fighting;
  if(!fighting)return;
  for(const formation of this.teams.values()){
   const available=id=>{const u=this.units.get(id);return u&&u.hp>0&&!u.target;};
   for(const [id]of formation.manualCenters){const u=this.units.get(id);if(!u||u.hp<=0||!u.target)formation.manualCenters.delete(id);}
   // Record the actual occupied place when a current front receives a command.
   // An uneven fighting line is not the ideal stripe or the other columns' mean.
   for(const queue of formation.columns){const u=this.units.get(queue[0]);if(u?.hp>0&&u.target&&!formation.manualCenters.has(u.id))formation.manualCenters.set(u.id,{x:u.x,z:u.z});}
   const frontAvailable=(id,col)=>{
    const u=this.units.get(id);if(!u||u.hp<=0)return false;
    if(!u.target)return true;
    // A command is not a vacancy. Keep its surviving front actor until its
    // real centre has left the current body-sized slot; never replace target.
    const center=formation.manualCenters.get(id);
    // A commanded reserve has no occupied front place to inherit until its
    // command ends. A current front keeps its own place until it really leaves.
    return !!center&&Math.hypot(u.x-center.x,u.z-center.z)<=formation.spacing;
   };
   for(const [id,col]of formation.detached){if(available(id)){formation.columns[col].push(id);formation.detached.delete(id);}}
   for(let col=0;col<formation.columns.length;col++){
    const queue=formation.columns[col],before=queue[0];
    while(queue.length&&!frontAvailable(queue[0],col)){const id=queue.shift(),u=this.units.get(id);formation.manualCenters.delete(id);if(u?.hp>0)formation.detached.set(id,col);}
    for(let j=queue.length-1;j>0;j--)if(this.units.get(queue[j])?.hp<=0)queue.splice(j,1);
    if(!queue.length){
     // Take a nearby reserve, never steal another column's surviving front.
     const neighbours=formation.columns.map((q,i)=>({q,i})).filter(x=>x.q.length>1).sort((a,b)=>Math.abs(a.i-col)-Math.abs(b.i-col)||a.i-b.i);
     const donor=neighbours.find(x=>available(x.q[1]));
     if(donor){const id=donor.q.splice(1,1)[0];queue.push(id);formation.membership.set(id,col);}
    }
    if(before!==undefined&&queue[0]!==undefined&&before!==queue[0])this.refills.push({time:this.time,team:formation.team,column:col,previous:before,id:queue[0]});
   }
   const fronts=formation.columns.map(q=>this.units.get(q[0])).filter(u=>u?.hp>0);
   const enemyFormation=this.teams.get(formation.team==='red'?'blue':'red');
   const enemies=units.filter(u=>u.hp>0&&u.team!==formation.team&&foot(u));
   const enemyFront=enemyFormation?.columns.map(q=>this.units.get(q[0])).filter(u=>u?.hp>0);
   if(!fronts.length||!enemies.length)continue;
   const from=mean(fronts),to=mean(enemyFront?.length?enemyFront:enemies),angle=Math.atan2(to.z-from.z,to.x-from.x);
   const delta=turn(formation.angle,angle);
   if(Math.abs(delta)>.02)formation.angle+=clamp(delta,-dt*.4,dt*.4);
   formation.forward={x:Math.cos(formation.angle),z:Math.sin(formation.angle)};
   formation.lateral={x:-formation.forward.z,z:formation.forward.x};
   // A bounded lateral follow handles a shifted opposing line without ID churn.
   const shift=dot(to,formation.lateral)-dot(formation.anchor,formation.lateral);
   if(Math.abs(shift)>.6){const advance=clamp(shift,-dt*.45,dt*.45);formation.anchor.x+=formation.lateral.x*advance;formation.anchor.z+=formation.lateral.z*advance;}
  }
 }
 intent(u,enemy){
  if(!this.fighting||!enemy||u.target||u.pendingStrike||u.pendingShot||u.hitFlash>0||u.pierceTime>0||u.kind==='cavalry')return null;
  const formation=this.teams.get(u.team);if(!formation)return null;
  const opposite=[...this.units.values()].filter(v=>v.hp>0&&v.team!==u.team&&foot(v));
  const fronts=formation.columns.map(q=>this.units.get(q[0])).filter(v=>v?.hp>0&&!v.target);
  // Surviving bowmen and cavalry must remain finishable after the foot line dies.
  if(!fronts.length||!opposite.length)return null;
  const d=Math.hypot(enemy.x-u.x,enemy.z-u.z);
  if(foot(u)&&d<=meleeReach(u,enemy)+.25)return null;
  if(u.kind==='archer'&&(d<3||d<=ARCHER.range))return null;
  const {forward,lateral,spacing}=formation;
  let goal;
  if(foot(u)){
   const col=formation.membership.get(u.id),queue=formation.columns[col];
   if(col===undefined||!queue)return null;
   const rank=queue.indexOf(u.id);if(rank<0)return null;
   // End-game isolated enemies release the line rather than waiting in holes.
   if(opposite.length<=1)return null;
   const side=dot(formation.anchor,lateral)+(col-(formation.columns.length-1)/2)*spacing;
   const leader=this.units.get(queue[0]);
   const along=rank===0?dot(enemy,forward)-(u.radius+enemy.radius+.14):dot(leader,forward)-rank*(leader.radius+u.radius+.2);
   const raw={x:forward.x*along+lateral.x*side,z:forward.z*along+lateral.z*side};
   // Soft lane edges allow the actual foe to be reached after a local gap opens.
   if(rank===0&&Math.abs(dot(enemy,lateral)-side)>spacing*.85)return null;
   goal={x:clamp(raw.x,-16.8,16.8),z:clamp(raw.z,-12.8,12.8),stop:.1,hold:Math.hypot(raw.x-u.x,raw.z-u.z)<.16,column:col,rank};
  }else if(u.kind==='archer'){
   const archers=[...this.units.values()].filter(v=>v.hp>0&&v.team===u.team&&v.kind==='archer').sort((a,b)=>a.id-b.id);
   const index=archers.findIndex(v=>v.id===u.id),side=dot(formation.anchor,lateral)+(index-(archers.length-1)/2)*Math.max(3,u.radius*2+.2);
   const along=dot(mean(fronts),forward)-4;
   goal={x:clamp(forward.x*along+lateral.x*side,-16.8,16.8),z:clamp(forward.z*along+lateral.z*side,-12.8,12.8),stop:.15,hold:false,role:'bow-support'};
   if(Math.hypot(enemy.x-goal.x,enemy.z-goal.z)>ARCHER.range-.2){goal.x=enemy.x-(enemy.x-u.x)/d*7.6;goal.z=enemy.z-(enemy.z-u.z)/d*7.6;}
   goal.hold=Math.hypot(goal.x-u.x,goal.z-u.z)<.16;
  }
  if(goal)this.goals.set(u.id,{...goal});return goal??null;
 }
 inspect(){return {time:this.time,refills:this.refills.slice(),goals:[...this.goals].map(([id,goal])=>({id,...goal})),teams:[...this.teams.values()].map(f=>({team:f.team,angle:f.angle,spacing:f.spacing,anchor:{...f.anchor},columns:f.columns.map(q=>q.slice())}))};}
}
