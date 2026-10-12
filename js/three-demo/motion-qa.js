// Opt-in replay of real movement commands; it uses the normal skirmish step.
export function createMotionQA({reset,getUnits,getElapsed,controllerVersion,onTarget}) {
 const commands=[
  [0,'直行',[3,-1]], [4,'左转90',[3,-4]], [7,'右转90',[0,-4]],
  [10,'掉头180',[4,-4]], [12,'途中停止',null], [13,'重新起步',[4,-4]],
  [16,'短距1',[2,-2]], [16.6,'短距2',[1,-3]], [17.2,'短距3',[2,-1]],
  [18,'短距4',[0,-1]], [19,'直行收尾',[-3,-1]], [23,'停止收尾',null],
 ];
 let running=false,index=0,label='等待重放',startTime=0;const trace=[];
 function start(){reset();trace.length=0;index=0;label='开始';startTime=getElapsed();running=true;}
 function beforeStep(time){if(!running)return;const t=time-startTime;while(index<commands.length&&t>=commands[index][0]){const [,text,target]=commands[index++];label=text;const units=getUnits();units.forEach((u,i)=>{u.target=target?{x:target[0],z:target[1]}:null;u.stopRequested=!target;});onTarget(target);}}
 function afterStep(time,dt){if(!running)return;const t=time-startTime;const units=getUnits();trace.push({time:t,dt,label,units:units.map(u=>{const foot=[];u.model.traverse(o=>{if(o.isSkinnedMesh&&foot.length===0){for(const bone of o.skeleton.bones){if(/^Foot/.test(bone.name)){const e=bone.matrixWorld.elements;foot.push({name:bone.name,x:e[12],y:e[13],z:e[14]});}}}});return {id:u.id,x:u.x,z:u.z,heading:u.heading,moving:u.moving,speed:u.speed,state:u.animation.state,walkTime:u.animation.actions.get('walk').time,actionTime:u.animation.actions.get(u.animation.state).time,actionDuration:u.animation.actions.get(u.animation.state).getClip().duration,foot};})});if(t>=24)running=false;}
 const button=document.createElement('button');button.textContent='重放动作序列';button.onclick=start;document.querySelector('.demo-controls').prepend(button);
 const api={start,beforeStep,afterStep,trace,commands,version:controllerVersion,get running(){return running;},get label(){return label;},get ready(){return true;}};window.motionQA=api;return api;
}

// Two fighters use the same combat update/events as the full battlefield.
export function createDuelQA({reset,startFight,getUnits}){
 let running=false;const trace=[],events=[];
 function start(){reset();trace.length=0;events.length=0;api.frames.length=0;api.captureTick=-1;startFight();running=true;}
 function recordEvents(time,list){if(!running)return;for(const e of list)events.push({time,type:e.type,from:e.from?.id,target:e.target?.id,unit:e.unit?.id});}
 function afterStep(time){if(!running)return;const units=getUnits();trace.push({time,distance:Math.hypot(units[0].x-units[1].x,units[0].z-units[1].z),units:units.map(u=>({id:u.id,x:u.x,z:u.z,heading:u.heading,hp:u.hp,speed:u.speed,runup:u.runup,pierceTime:u.pierceTime,chargeFlash:u.chargeFlash,state:u.animation.state,actionTime:u.animation.actions.get(u.animation.state).time,pendingStrike:u.pendingStrike?{...u.pendingStrike}:null,deathComplete:u.animation.deathComplete,corpseSettled:!!u.corpseSettled}))});if(time>=18)running=false;}
 const api={ready:true,start,recordEvents,afterStep,trace,events,frames:[],get running(){return running;}};window.duelQA=api;const button=document.createElement('button');button.textContent='重放双兵交战';button.onclick=start;document.querySelector('.demo-controls').prepend(button);return api;
}

// Flat, offset ranks retain real contact, target selection, damage and death.
export function createCrowdQA({reset,startFight,getUnits,mode,version}){
 let running=false;const trace=[],events=[];
 function start(){reset();trace.length=0;events.length=0;api.frames.length=0;api.captureTick=-1;startFight();running=true;}
 function recordEvents(time,list){if(running)for(const e of list)events.push({time,type:e.type,from:e.from?.id,target:e.target?.id,unit:e.unit?.id});}
 function afterStep(time,dt){if(!running)return;trace.push({time,dt,units:getUnits().map(u=>({id:u.id,team:u.team,x:u.x,z:u.z,heading:u.heading,hp:u.hp,moving:u.moving,speed:u.speed,state:u.animation.state,actionTime:u.animation.actions.get(u.animation.state).time,targetId:u.combatTargetId,blockedBy:u.blockedBy,deathComplete:u.animation.deathComplete,corpseSettled:!!u.corpseSettled}))});if(time>=32)running=false;}
 const api={ready:true,start,recordEvents,afterStep,trace,events,frames:[],meta:{mode,version,width:1280,height:900,sample:'post-render exact simulation time'},get running(){return running;}};window.crowdQA=api;
 const group=document.createElement('div');group.className='control-group';const b=document.createElement('button');b.textContent='重放'+(mode==='four'?'4 对 4':'16 对 16');b.onclick=start;group.append(b);
 for(const v of ['baseline','candidate']){const b=document.createElement('button');b.textContent=v==='baseline'?'M1/D1 基准':'多人候选 C1';b.setAttribute('aria-pressed',String(version===v));b.onclick=()=>{const p=new URLSearchParams(location.search);p.set('crowd',v);location.search=p.toString();};group.append(b);}
 document.querySelector('.demo-controls').prepend(group);return api;
}
