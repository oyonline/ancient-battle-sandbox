"""Offline CC0 source preparation. Blender 5.2; original rigs/weights are retained.
Usage: blender -b --python this.py -- SOURCE_DIRECTORY OUTPUT_DIRECTORY
No network access. Q Warrior + Kay Adventurers 1.0. See ASSETS.md for provenance.
"""
import bpy,sys,json,math
from pathlib import Path
from mathutils import Vector,Matrix,Quaternion
arguments=sys.argv[sys.argv.index('--')+1:];src,out=map(Path,arguments[:2]);kay_death=arguments[2] if len(arguments)>2 else 'Death_A';assert kay_death in ['Death_A','Death_B'];out.mkdir(parents=True,exist_ok=True)
qfile=src/'qrpg/RPG Characters - Nov 2020/Blends/Warrior.blend'
kfile=src/'kay1/addons/kaykit_character_pack_adventures/Characters/gltf/Knight.glb'
bpy.ops.wm.open_mainfile(filepath=str(qfile));q=next(o for o in bpy.data.objects if o.type=='ARMATURE');q.name='QuaterniusRig'
qobjects=list(bpy.data.objects);q_native_death=bpy.data.actions['Death']
# Bake the native death with its original constraints before preparing retargeted
# clips. Standing foot anchors must never keep a falling torso suspended.
for tr in q.animation_data.nla_tracks:tr.mute=True
q.animation_data.action=q_native_death
native_death=[];death_duration=float(q_native_death.frame_range[1])/24;death_frames=round(death_duration*30)
for frame in range(death_frames+1):
 f=min(float(q_native_death.frame_range[1]),frame/30*24);bpy.context.scene.frame_set(math.floor(f),subframe=f%1);bpy.context.view_layer.update();record={}
 for b in q.pose.bones:
  args={'matrix':b.matrix.copy(),'matrix_local':b.bone.matrix_local,'invert':True}
  if b.parent:args.update(parent_matrix=b.parent.matrix.copy(),parent_matrix_local=b.parent.bone.matrix_local)
  record[b.name]=b.bone.convert_local_to_pose(**args).decompose()
 native_death.append(record)

for im in bpy.data.images:
 tex=src/'qrpg/RPG Characters - Nov 2020/Textures'/Path(im.filepath.replace('\\','/')).name
 if tex.exists():im.filepath=str(tex);im.reload();im.pack()
for material in bpy.data.materials:
 if not material.node_tree:continue
 nodes=material.node_tree.nodes;texture=next((n for n in nodes if n.type=='TEX_IMAGE'),None)
 if not texture:continue
 output=next(n for n in nodes if n.type=='OUTPUT_MATERIAL');bsdf=nodes.new('ShaderNodeBsdfPrincipled');bsdf.inputs['Roughness'].default_value=.82;material.node_tree.links.new(texture.outputs['Color'],bsdf.inputs['Base Color']);material.node_tree.links.new(bsdf.outputs['BSDF'],output.inputs['Surface'])
for o in qobjects:
 if o.animation_data:o.animation_data_clear()
for b in q.pose.bones:
 for c in list(b.constraints):b.constraints.remove(c)
 b.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()
bpy.ops.import_scene.gltf(filepath=str(kfile));k=next(o for o in bpy.data.objects if o.type=='ARMATURE' and o!=q);k.name='KayKitRig';kobjects=[o for o in bpy.data.objects if o not in qobjects]
for o in list(kobjects):
 if o.type=='MESH' and not(o.name.startswith('Knight_') or o.name in ['1H_Sword','Badge_Shield']):kobjects.remove(o);bpy.data.objects.remove(o,do_unlink=True)
clips={'Idle':'Idle.001','Walk':'Walking_A','Slash':'1H_Melee_Attack_Slice_Horizontal','Cleave':'1H_Melee_Attack_Chop','Thrust':'1H_Melee_Attack_Stab','Block':'Block_Hit','Guard':'Blocking','Hit':'Hit_A','Death':kay_death}
# Q's original Idle occupied the name during import. Resolve by the action slot.
if 'Idle.001' not in bpy.data.actions:clips['Idle']='Idle'
source_actions={n:bpy.data.actions[v] for n,v in clips.items()}
for tr in list(k.animation_data.nla_tracks):k.animation_data.nla_tracks.remove(tr)
k.animation_data.action=None
for b in k.pose.bones:b.matrix_basis=Matrix.Identity(4)
bpy.context.view_layer.update()
# Source dimensions are measured in the bind pose, excluding weapons. Helmets/hair
# count as head top; feet are the bottom. Proportions are never stretched.
def bounds(objects,exclude):
 pts=[];dg=bpy.context.evaluated_depsgraph_get()
 for o in objects:
  if o.type!='MESH' or o.name in exclude:continue
  ev=o.evaluated_get(dg);pts += [ev.matrix_world@v.co for v in ev.data.vertices]
 return [min(v.z for v in pts),max(v.z for v in pts)]
qb=bounds(qobjects,{'Warrior_Sword'});kb=bounds(kobjects,{'1H_Sword','Badge_Shield'});ratio=(qb[1]-qb[0])/(kb[1]-kb[0]);reference=2.6122968196868896
mapping={'Hips':'hips','Abdomen':'spine','Torso':'chest','Neck':'chest','Head':'head'}
for side in ['L','R']:
 for target,source in [('UpperArm','upperarm'),('LowerArm','lowerarm'),('Fist','hand'),('UpperLeg','upperleg'),('LowerLeg','lowerleg'),('Foot','foot')]:mapping[target+'.'+side]=source+'.'+side.lower()
qr={n:b.matrix_local.copy() for n,b in q.data.bones.items()};kr={n:b.matrix_local.copy() for n,b in k.data.bones.items()}
# CC0 shield adapted from KayKit, preserving its mesh/material and grip plane.
shield=bpy.data.objects['Badge_Shield'].copy();shield.data=shield.data.copy();bpy.context.collection.objects.link(shield);shield.name='KayKit_Shield_On_Warrior';qobjects.append(shield)
source_shield_world=bpy.data.objects['Badge_Shield'].matrix_world.copy();shield.parent=q;shield.parent_type='BONE';shield.parent_bone='Fist.L';shield.matrix_parent_inverse=Matrix.Identity(4);bpy.context.view_layer.update()
hand_q=qr['Fist.L'].translation;hand_k=kr['hand.l'].translation
world=source_shield_world.copy();world.translation=hand_q+(source_shield_world.translation-hand_k)*ratio;world=world@Matrix.Diagonal((ratio,ratio,ratio,1));shield.matrix_world=world
# Save authored Q sword and the adapted shield rest transforms as metadata.
weapons={o.name:{'bone':o.parent_bone,'matrix_basis':[list(row) for row in o.matrix_basis]} for o in qobjects if o.name in ['Warrior_Sword','KayKit_Shield_On_Warrior']}
def ik(hip,knee,foot,goal,orientation):
 a,b,c=hip.head.copy(),knee.head.copy(),foot.head.copy();l1=(b-a).length;l2=(c-b).length;v=goal-a;d=min(l1+l2-.00001,max(abs(l1-l2)+.00001,v.length));axis=v.normalized();bend=b-a-axis*(b-a).dot(axis)
 if bend.length<.0001:bend=Vector((0,-1,0))-axis*axis.dot(Vector((0,-1,0)))
 bend.normalize();along=(l1*l1-l2*l2+d*d)/(2*d);joint=a+axis*along+bend*math.sqrt(max(0,l1*l1-along*along))
 m=hip.matrix.copy();m=Matrix.Translation(a)@(b-a).rotation_difference(joint-a).to_matrix().to_4x4()@Matrix.Translation(-a)@m;hip.matrix=m;bpy.context.view_layer.update()
 b,c=knee.head.copy(),foot.head.copy();m=knee.matrix.copy();knee.matrix=Matrix.Translation(b)@(c-b).rotation_difference(goal-b).to_matrix().to_4x4()@Matrix.Translation(-b)@m;bpy.context.view_layer.update();m=orientation.to_matrix().to_4x4();m.translation=foot.head;foot.matrix=m
samples={};scene=bpy.context.scene;scene.render.fps=30
for name,act in source_actions.items():
 k.animation_data.action=act
 # Imported glTF frame ranges use the scene's original 24fps. Durations are
 # recorded in seconds; resample at 30Hz without changing source timing.
 duration=float(act.frame_range[1])/24;frames=round(duration*30);records=[]
 for frame in range(frames+1):
  source_frame=min(float(act.frame_range[1]),frame/30*24);scene.frame_set(math.floor(source_frame),subframe=source_frame%1);bpy.context.view_layer.update()
  for b in q.pose.bones:b.matrix_basis=Matrix.Identity(4)
  bpy.context.view_layer.update()
  for nameq,namek in mapping.items():
   source=k.pose.bones[namek];target=q.pose.bones[nameq]
   delta=source.matrix.to_quaternion()@kr[namek].to_quaternion().inverted();rotation=delta@qr[nameq].to_quaternion();m=rotation.to_matrix().to_4x4();m.translation=target.head
   if nameq=='Hips':m.translation=qr[nameq].translation+(source.head-kr[namek].translation)*ratio
   target.matrix=m;bpy.context.view_layer.update()
  for side in ['L','R']:
   kn='foot.'+side.lower();qn='Foot.'+side;goal=qr[qn].translation+(k.pose.bones[kn].head-kr[kn].translation)*ratio
   ik(q.pose.bones['UpperLeg.'+side],q.pose.bones['LowerLeg.'+side],q.pose.bones[qn],goal,q.pose.bones[qn].matrix.to_quaternion())
  records.append({b.name:(b.location.copy(),b.rotation_quaternion.copy() if b.rotation_mode=='QUATERNION' else b.matrix_basis.to_quaternion(),b.scale.copy()) for b in q.pose.bones})
 samples[name]=(frames,records,duration)
k.animation_data.action=None
for b in k.pose.bones:b.matrix_basis=Matrix.Identity(4)
for b in q.pose.bones:b.matrix_basis=Matrix.Identity(4)
q.animation_data_create()
for name,(frames,records,duration) in samples.items():
 if name=='Death':frames,records,duration=death_frames,native_death,death_duration
 action=bpy.data.actions.new('Q_'+name);q.animation_data.action=action
 for f,record in enumerate(records):
  for bn,(loc,rot,scale) in record.items():
   b=q.pose.bones[bn];b.rotation_mode='QUATERNION';b.location=loc;b.rotation_quaternion=rot;b.scale=scale
   b.keyframe_insert('location',frame=f);b.keyframe_insert('rotation_quaternion',frame=f);b.keyframe_insert('scale',frame=f)
 tr=q.animation_data.nla_tracks.new();tr.name=name;strip=tr.strips.new(name,0,action);strip.action_frame_start=0;strip.action_frame_end=frames;tr.mute=True
q.animation_data.action=None
for b in q.pose.bones:b.matrix_basis=Matrix.Identity(4)
# Native Kay actions are not retargeted, only strip timing converts 24→30fps.
for name,act in source_actions.items():
 tr=k.animation_data.nla_tracks.new();tr.name=name;strip=tr.strips.new(name,0,act);strip.action_frame_start=0;strip.action_frame_end=act.frame_range[1];strip.scale=30/24;tr.mute=True
for rig,objects,key,bb in [(k,kobjects,'kaykit',kb),(q,qobjects,'quaternius',qb)]:
 bpy.ops.object.select_all(action='DESELECT')
 for o in objects:o.select_set(True)
 bpy.context.view_layer.objects.active=rig
 for tr in rig.animation_data.nla_tracks:tr.mute=False
 bpy.ops.export_scene.gltf(filepath=str(out/(key+'.glb')),export_format='GLB',use_selection=True,export_apply=False,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_skins=True)
 for tr in rig.animation_data.nla_tracks:tr.mute=True
 meta={'model':key,'sourceHeight':bb[1]-bb[0],'sourceFloor':bb[0],'referenceHeight':reference,'normalization':reference/(bb[1]-bb[0]),'front':'Three +Z (Blender -Y)','boneMap':mapping if key=='quaternius' else {v:v for v in mapping.values()},'restMatrices':{n:[list(r)for r in m]for n,m in (qr if key=='quaternius' else kr).items()},'weapons':weapons if key=='quaternius' else {'sword':'handslot.r','shield':'handslot.l'},'clips':{n:{'source':clips[n],'duration':d}for n,(_,_,d)in samples.items()}}
 meta['contactCalibration']={'slash':.256 if key=='kaykit' else .252,'cleave':.587 if key=='kaykit' else .635,'thrust':.42}
 meta['contactMethod']='Measured native sword trajectory; bounded arm IK adapts the target torso height around the unchanged rule contact.'
 if key=='quaternius':meta['clips']['Death']={'source':'Quaternius Warrior native Death, constraints baked before removal','duration':death_duration}
 (out/(key+'.json')).write_text(json.dumps(meta,indent=2))
print('EXPORTED',qb,kb,ratio)
