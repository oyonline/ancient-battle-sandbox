"""Offline local-only source preparation; no download. Original skin weights retained.
Blender 5.2: -- A_PBR_GLB C_PBR_GLB KAYKIT_SOURCE_GLB OUTPUT_DIR
A/C are user-downloaded Leonardo Carvalho models; motion source is KayKit CC0.
"""
import bpy,sys,json,math,re
from pathlib import Path
from mathutils import Vector,Matrix,Quaternion
args=sys.argv[sys.argv.index('--')+1:];a_path,c_path,k_path,out=map(Path,args);out.mkdir(parents=True,exist_ok=True)
clips={'Idle':'Idle','Walk':'Walking_A','Slash':'1H_Melee_Attack_Slice_Horizontal','Cleave':'1H_Melee_Attack_Chop','Thrust':'1H_Melee_Attack_Stab','Block':'Block_Hit','Guard':'Blocking','Hit':'Hit_A','Death':'Death_B'}
semantic={'hips':'Hips','spine':'Spine','chest':'Spine2','head':'Head','neck':'Neck'}
for side,label in [('l','Left'),('r','Right')]:
 for sem,b in [('shoulder','Shoulder'),('arm','Arm'),('forearm','ForeArm'),('hand','Hand'),('thigh','UpLeg'),('shin','Leg'),('foot','Foot'),('toes','ToeBase')]:semantic[sem+side]=label+b
mapping={'Hips':'hips','Spine':'spine','Spine1':'spine','Spine2':'chest','Neck':'chest','Head':'head'}
for label,s in [('Left','l'),('Right','r')]:
 for target,source in [('Arm','upperarm'),('ForeArm','lowerarm'),('Hand','hand'),('UpLeg','upperleg'),('Leg','lowerleg'),('Foot','foot')]:mapping[label+target]=source+'.'+s

def bounds(objects):
 pts=[];dg=bpy.context.evaluated_depsgraph_get()
 for o in objects:
  if o.type=='MESH':pts.extend(o.evaluated_get(dg).matrix_world@v.co for v in o.evaluated_get(dg).data.vertices)
 return min(v.z for v in pts),max(v.z for v in pts)
def turn(b,axis,angle):
 p=b.head.copy();b.matrix=Matrix.Translation(p)@Matrix.Rotation(angle,4,axis)@Matrix.Translation(-p)@b.matrix;bpy.context.view_layer.update()
def ik(hip,knee,foot,goal,rotation,pole=None,min_flex=.12):
 a,b,c=hip.head.copy(),knee.head.copy(),foot.head.copy();l1=(b-a).length;l2=(c-b).length;v=goal-a;axis=v.normalized() if v.length>.0001 else Vector((0,0,-1));minimum=math.sqrt(l1*l1+l2*l2+2*l1*l2*math.cos(2.65));maximum=math.sqrt(l1*l1+l2*l2+2*l1*l2*math.cos(min_flex));d=max(minimum,min(maximum,v.length));goal=a+axis*d
 bend=(pole.copy() if pole is not None else Vector((0,-1,0)));bend-=axis*bend.dot(axis)
 if bend.length<.001:
  bend=Vector((0,0,1));bend-=axis*bend.dot(axis)
 bend.normalize();along=(l1*l1-l2*l2+d*d)/(2*d);joint=a+axis*along+bend*math.sqrt(max(0,l1*l1-along*along))
 hip.matrix=Matrix.Translation(a)@(b-a).rotation_difference(joint-a).to_matrix().to_4x4()@Matrix.Translation(-a)@hip.matrix;bpy.context.view_layer.update();b,c=knee.head.copy(),foot.head.copy();knee.matrix=Matrix.Translation(b)@(c-b).rotation_difference(goal-b).to_matrix().to_4x4()@Matrix.Translation(-b)@knee.matrix;bpy.context.view_layer.update();m=rotation.to_matrix().to_4x4();m.translation=foot.head;foot.matrix=m

def smooth(x):x=max(0,min(1,x));return x*x*(3-2*x)
def curve(keys,t):
 for j in range(1,len(keys)):
  if t<=keys[j][0]:
   a,b=keys[j-1],keys[j];return Vector(a[1]).lerp(Vector(b[1]),smooth((t-a[0])/(b[0]-a[0])))
 return Vector(keys[-1][1])
def wrist_frame(keys,t,rest_q):
 # Parallel-transport a complete wrist frame at authored keys, then slerp.
 # Recomputing direction-only rotations independently has an antipodal roll flip.
 previous_direction=rest_q@Vector((1,0,0));q=rest_q.copy();frames=[]
 for time,d in keys:
  direction=Vector(d).normalized();q=previous_direction.rotation_difference(direction)@q;frames.append((time,q.copy()));previous_direction=direction
 # A closed blade path must close its complete guard frame, including roll.
 if Vector(keys[-1][1]).normalized().dot(Vector(keys[0][1]).normalized())>1-1e-6:frames[-1]=(frames[-1][0],frames[0][1].copy())
 for i in range(1,len(frames)):
  if t<=frames[i][0]:
   a,b=frames[i-1],frames[i];return a[1].slerp(b[1],smooth((t-a[0])/(b[0]-a[0])))
 return frames[-1][1]

def support_floors(objects,names):
 # Fit the prone shoe targets to each original body's actual cloth/shoe surface.
 # Dominant source weights are read, never rewritten; no runtime joint pressing.
 groups={'core':{names[n]for n in ['Hips','Spine','Spine1','Spine2','Head']}}
 for side,label in [('l','Left'),('r','Right')]:groups[side]={names[label+'Foot'],names[label+'ToeBase']}
 result={key:float('inf')for key in groups};dg=bpy.context.evaluated_depsgraph_get()
 for o in objects:
  if o.type!='MESH' or not o.vertex_groups:continue
  evaluated=o.evaluated_get(dg)
  for v in o.data.vertices:
   if not v.groups:continue
   name=o.vertex_groups[max(v.groups,key=lambda g:g.weight).group].name
   key=next((k for k,bones in groups.items()if name in bones),None)
   if key is not None:result[key]=min(result[key],(evaluated.matrix_world@evaluated.data.vertices[v.index].co).z)
 return result

def material(name,color,metal=0):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=.6;return m
for key,path in [('civilian-a',a_path),('civilian-c',c_path)]:
 bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.gltf(filepath=str(path));rig=next(o for o in bpy.data.objects if o.type=='ARMATURE');rig.name='CivilianRig';objects=list(bpy.data.objects)
 for o in objects:
  if o.animation_data:o.animation_data_clear()
 names={re.sub(r'_\d+$','',b.name).replace('mixamorig:',''):b.name for b in rig.data.bones}
 for b in rig.pose.bones:b.matrix_basis=Matrix.Identity(4)
 bpy.context.view_layer.update();bb=bounds(objects);height=bb[1]-bb[0];rest={n:b.matrix_local.copy()for n,b in rig.data.bones.items()}
 bpy.ops.import_scene.gltf(filepath=str(k_path));k=next(o for o in bpy.data.objects if o.type=='ARMATURE' and o!=rig);kobjects=[o for o in bpy.data.objects if o not in objects];acts={name:bpy.data.actions[source]for name,source in clips.items()}
 for tr in list(k.animation_data.nla_tracks):k.animation_data.nla_tracks.remove(tr)
 k.animation_data.action=None
 for b in k.pose.bones:b.matrix_basis=Matrix.Identity(4)
 bpy.context.view_layer.update();kb=bounds([o for o in kobjects if o.name.startswith('Knight_')]);ratio=height/(kb[1]-kb[0]);kr={n:b.matrix_local.copy()for n,b in k.data.bones.items()}
 # Model-space authored grip anchors; sword/round buckler are original geometry.
 steel=material('Forged steel',(.26,.29,.31),.7);wood=material('Dark wood',(.13,.067,.025));leather=material('Leather grip',(.045,.026,.013))
 def attach(o,name,bone,position):
  bpy.context.view_layer.update();m=o.matrix_world.copy();m.translation=Vector(position);o.name=name;o.parent=rig;o.parent_type='BONE';o.parent_bone=names[bone];bpy.context.view_layer.update();o.matrix_world=m;objects.append(o);return o
 def cylinder(name,bone,pos,radius,depth,mat,rotate=False):
  bpy.ops.mesh.primitive_cylinder_add(vertices=20,radius=radius,depth=depth,location=pos);o=bpy.context.object
  if rotate:o.rotation_euler.x=math.pi/2
  o.data.materials.append(mat);return attach(o,name,bone,pos)
 unit=height/180;grips={};gripAxes={};palmNormals={};gripRadii={}
 thumbAngles={'civilian-a':{'Left':(.48,.44,.66,.48),'Right':(.5,-.65,1.1,.4)},'civilian-c':{'Left':(.6,-.6,.85,.85),'Right':(.55,-.7,1.05,.95)}}[key]
 # Fit the handle to the three actually curled middle phalanges, not a wrist offset.
 curls={'Index':(.73,1.02,.68),'Middle':(.85,1.08,.72),'Ring':(.91,1.04,.74),'Pinky':(.96,.99,.72)}
 for label,sign in [('Left',-1),('Right',1)]:
  for finger,angles in curls.items():
   if key=='civilian-a' and label=='Left' and finger=='Index':angles=(.73,1.02,.68)
   for number,angle in enumerate(angles,1):
    bone=rig.pose.bones[names[label+'Hand'+finger+str(number)]];bone.rotation_mode='QUATERNION';bone.rotation_quaternion=Quaternion(Vector((1,0,0)),angle)
  opposition,*flex=thumbAngles[label]
  for number,angle in enumerate(flex,1):
   bone=rig.pose.bones[names[label+'HandThumb'+str(number)]];bone.rotation_mode='QUATERNION';bone.rotation_quaternion=Quaternion(Vector((0,0,1)),sign*opposition if number==1 else 0)@Quaternion(Vector((1,0,0)),angle)
 bpy.context.view_layer.update()
 indexFit={}
 if key=='civilian-a':
  # This rig's visible raised digit is Index-weighted. Fit its actual pad;
  # leave the Thumb-weighted palm web in the small original rotation.
  chain=[rig.pose.bones[names['LeftHandIndex'+str(i)]]for i in [1,2,3]]
  old=[bone.rotation_quaternion.copy()for bone in chain]
  for bone in chain:bone.matrix_basis=Matrix.Identity(4)
  bpy.context.view_layer.update();pad=Vector();count=0;dg=bpy.context.evaluated_depsgraph_get()
  for o in objects:
   if o.type!='MESH' or not o.vertex_groups:continue
   evaluated=o.evaluated_get(dg)
   for vertex in o.data.vertices:
    if vertex.groups and o.vertex_groups[max(vertex.groups,key=lambda g:g.weight).group].name in {names['LeftHandIndex3'],names['LeftHandIndex4']}:
     pad+=evaluated.matrix_world@evaluated.data.vertices[vertex.index].co;count+=1
  localPad=chain[2].matrix.inverted()@(pad/count)
  for bone,q in zip(chain,old):bone.rotation_quaternion=q
  bpy.context.view_layer.update();a,b,c=[rig.pose.bones[names['LeftHandMiddle'+str(i)]].head.copy()for i in [1,2,3]];u=b-a;v=c-a;n=u.cross(v);center=a+(v.length_squared*n.cross(u)+u.length_squared*v.cross(n))/(2*n.length_squared)
  axis=(chain[0].head-rig.pose.bones[names['LeftHandPinky1']].head).normalized();near=chain[0].head-center;near-=axis*near.dot(axis);radius=max(1.1*unit,min(2.4*unit,(center-b).length-.8*unit));target=center+axis*(chain[0].head-center).dot(axis)+near.normalized()*(radius+.35*unit)
  first,second=chain[1:];a,b,c=first.head.copy(),second.head.copy(),second.matrix@localPad;l1=(b-a).length;l2=(c-b).length;direction=(target-a).normalized();d=max(math.sqrt(l1*l1+l2*l2+2*l1*l2*math.cos(1.55)),min((target-a).length,(l1+l2)*.98));target=a+direction*d;pole=b-a;pole-=direction*pole.dot(direction)
  if pole.length<.001:pole=rest[names['LeftHand']].to_quaternion()@Vector((0,0,1));pole-=direction*pole.dot(direction)
  pole.normalize();along=(l1*l1-l2*l2+d*d)/(2*d);joint=a+direction*along+pole*math.sqrt(max(0,l1*l1-along*along));first.matrix=Matrix.Translation(a)@(b-a).rotation_difference(joint-a).to_matrix().to_4x4()@Matrix.Translation(-a)@first.matrix;bpy.context.view_layer.update();b=second.head.copy();c=second.matrix@localPad;second.matrix=Matrix.Translation(b)@(c-b).rotation_difference(target-b).to_matrix().to_4x4()@Matrix.Translation(-b)@second.matrix;bpy.context.view_layer.update();indexFit={bone.name:bone.matrix_basis.decompose()[1]for bone in chain}
 for label,side in [('Right','r'),('Left','l')]:
  a,b,c=[rig.pose.bones[names[label+'HandMiddle'+str(i)]].head.copy() for i in [1,2,3]];u=b-a;v=c-a;n=u.cross(v)
  center=a+(v.length_squared*n.cross(u)+u.length_squared*v.cross(n))/(2*n.length_squared)
  grips[side]=center;gripRadii[side]=max(1.1*unit,min(2.4*unit,(center-b).length-.8*unit));gripAxes[side]=(rig.pose.bones[names[label+'HandIndex1']].head-rig.pose.bones[names[label+'HandPinky1']].head).normalized();palmNormals[side]=rest[names[label+'Hand']].to_quaternion()@Vector((0,0,1))
 for bone in rig.pose.bones:bone.matrix_basis=Matrix.Identity(4)
 bpy.context.view_layer.update()
 across=gripAxes['l'];normal=palmNormals['l'];old=Matrix((across,normal.cross(across),normal)).transposed();front=Vector((0,-1,0));horizontal=Vector((1,0,0));target=Matrix((horizontal,front.cross(horizontal),front)).transposed();leftGripQ=(target@old.inverted()).to_quaternion()@rest[names['LeftHand']].to_quaternion()
 g=grips['r'];cylinder('SwordGrip','RightHand',g,gripRadii['r'],12*unit,leather);cylinder('SwordPommel','RightHand',g+Vector((0,0,-8*unit)),2.7*unit,3*unit,steel)
 bpy.ops.mesh.primitive_cube_add(size=1,location=g+Vector((0,0,7*unit)));guard=bpy.context.object;guard.dimensions=(16*unit,3*unit,2.5*unit);guard.data.materials.append(steel);attach(guard,'SwordGuard','RightHand',guard.location)
 verts=[(-2.8,-.55,7),(2.8,-.55,7),(-2.8,.55,7),(2.8,.55,7),(-2.1,0,64),(2.1,0,64),(0,0,77)];verts=[g+Vector(v)*unit for v in verts];mesh=bpy.data.meshes.new('SteelBlade');mesh.from_pydata(verts,[],[(0,1,5,6,4),(2,4,6,5,3),(0,4,2),(1,3,5),(0,2,3,1)]);mesh.materials.append(steel);o=bpy.data.objects.new('SwordBlade',mesh);bpy.context.collection.objects.link(o);attach(o,'SwordBlade','RightHand',(0,0,0))
 tip=bpy.data.objects.new('SwordTip',None);bpy.context.collection.objects.link(tip);attach(tip,'SwordTip','RightHand',g+Vector((0,0,77*unit)))
 g=grips['l']+Vector((0,-7*unit,0));cylinder('BucklerRim','LeftHand',g,23*unit,2.5*unit,steel,True);cylinder('BucklerWood','LeftHand',g+Vector((0,-1.5*unit,0)),21.5*unit,1*unit,wood,True);cylinder('BucklerBoss','LeftHand',g+Vector((0,-3*unit,0)),7*unit,4*unit,steel,True)
 handle=cylinder('BucklerHandle','LeftHand',grips['l'],gripRadii['l'],8.5*unit,leather)
 across=gripAxes['l'];m=Vector((0,0,1)).rotation_difference(across).to_matrix().to_4x4();m.translation=grips['l'];handle.matrix_world=m
 for sign in [-1,1]:
  mount=cylinder('BucklerMount'+str(sign),'LeftHand',grips['l']+across*sign*3.7*unit+palmNormals['l']*3.0*unit,1.0*unit,5.5*unit,steel);m=Vector((0,0,1)).rotation_difference(palmNormals['l']).to_matrix().to_4x4();m.translation=mount.matrix_world.translation;mount.matrix_world=m

 grip=bpy.data.objects.new('ShieldGrip',None);bpy.context.collection.objects.link(grip);attach(grip,'ShieldGrip','LeftHand',grips['l'])
 center=bpy.data.objects.new('ShieldContact',None);bpy.context.collection.objects.link(center);attach(center,'ShieldContact','LeftHand',g+Vector((0,-5*unit,0)))
 # Equipment starts in the same anatomical grip frame as the closed hand.
 for o in objects:
  if o.name.startswith('Sword'):fix=Vector((0,0,1)).rotation_difference(gripAxes['r']);pivot=grips['r']
  elif o.name in ['BucklerRim','BucklerWood','BucklerBoss','ShieldContact']:fix=Vector((0,-1,0)).rotation_difference(palmNormals['l']);pivot=grips['l']
  else:continue
  o.matrix_world=Matrix.Translation(pivot)@fix.to_matrix().to_4x4()@Matrix.Translation(-pivot)@o.matrix_world
 rig.animation_data_create();scene=bpy.context.scene;scene.render.fps=30;samples={}
 for name,act in acts.items():
  k.animation_data.action=act;duration=float(act.frame_range[1])/24;frames=round(duration*30);records=[]
  for frame in range(frames+1):
   f=min(float(act.frame_range[1]),frame/30*24);scene.frame_set(math.floor(f),subframe=f%1);bpy.context.view_layer.update()
   for b in rig.pose.bones:b.matrix_basis=Matrix.Identity(4)
   bpy.context.view_layer.update()
   for target,source in mapping.items():
    t=rig.pose.bones[names[target]];s=k.pose.bones[source];delta=s.matrix.to_quaternion()@kr[source].to_quaternion().inverted();basis=rest[names[target]].to_quaternion()
    if target.endswith(('Arm','ForeArm','Hand')):
     align=(basis@Vector((0,1,0))).rotation_difference(kr[source].to_quaternion()@Vector((0,1,0)));basis=align@basis
    m=(delta@basis).to_matrix().to_4x4();m.translation=t.head
    if target=='Hips':m.translation=rest[names[target]].translation+(s.head-kr[source].translation)*ratio
    t.matrix=m;bpy.context.view_layer.update()
   age=frame/30
   # Adult gait and load transfer keep pelvis travel inside the stance, rather
   # than rescaling a chibi stride into adult crossed knees.
   pelvis=rig.pose.bones[names['Hips']]
   if name=='Death':
    positions=[(0,(0,0,.55)),(.38,(0,.015,.43)),(.85,(.025,.04,.26)),(1.35,(.02,.075,.125)),(2.20,(.015,.09,.071)),(2.63,(.015,.09,.070))]
    pitch=curve([(0,(0,0,0)),(.38,(.18,0,0)),(.85,(.48,0,0)),(1.35,(1.02,0,0)),(2.2,(1.57,0,0)),(2.63,(1.57,0,0))],age).x
    m=(Quaternion(Vector((1,0,0)),pitch)@rest[names['Hips']].to_quaternion()).to_matrix().to_4x4();m.translation=curve(positions,age)*height;pelvis.matrix=m;bpy.context.view_layer.update()
    # Relaxation is baked in sequence: pelvis/knee, bracing hand, then torso.
    for target in ['Spine','Spine1','Spine2','Neck','Head']:
     bone=rig.pose.bones[names[target]];bone.matrix_basis=Matrix.Identity(4)
    bpy.context.view_layer.update();turn(rig.pose.bones[names['Spine']],Vector((1,0,0)),.20*smooth((age-.75)/1.2));turn(rig.pose.bones[names['Neck']],Vector((1,0,0)),-.06*smooth((age-.90)/1.2))
   else:
    contact={'Slash':.256,'Cleave':.587,'Thrust':.42}.get(name);load=math.sin(math.pi*min(1,age/contact)) if contact else 0;release=smooth((age-contact)/.10)*math.exp(-max(0,age-contact)*5) if contact and age>=contact else 0
    offset=Vector((0,.015*load-.025*release,-.014*load-.012*release))*height
    if name=='Walk':offset=Vector((0,0,.004*math.sin(age/duration*4*math.pi)))*height
    twist=0
    if contact:
     wind=smooth(age/max(.1,contact*.65))*(1-smooth((age-contact*.65)/(contact*.35)))
     drive=smooth((age-contact*.65)/(contact*.35))*(1-smooth((age-contact-.06)/max(.1,duration-contact-.06)))
     twist=(-.16*wind+.21*drive) if name=='Slash' else (-.07*wind+.09*drive)
    q=Quaternion(Vector((0,0,1)),twist*.45)@rest[names['Hips']].to_quaternion();m=q.to_matrix().to_4x4();m.translation=rest[names['Hips']].translation+offset;pelvis.matrix=m;bpy.context.view_layer.update()
    if contact:turn(rig.pose.bones[names['Spine']],Vector((0,0,1)),twist*.55)

   for label,side in [('Left','l'),('Right','r')]:
    foot=rig.pose.bones[names[label+'Foot']];goal=rest[names[label+'Foot']].translation.copy();q=rest[names[label+'Foot']].to_quaternion();pole=Vector((.10 if side=='l' else -.10,-1,0))
    if name=='Walk':
     phase=age/duration*2*math.pi+(0 if side=='l' else math.pi);goal.y+=math.sin(phase)*.15*height;goal.z+=max(0,math.cos(phase))*.032*height
    elif name=='Death':
     w=smooth((age-.65)/1.5);goal.y+=.49*height*w;goal.z-=.04*height*w;pole=Vector((.85 if side=='l' else -.85,-1,0)).lerp(Vector((.85 if side=='l' else -.85,0,1)),w).normalized()
    else:goal.y+=(-.035 if side=='l' else .035)*height
    ik(rig.pose.bones[names[label+'UpLeg']],rig.pose.bones[names[label+'Leg']],foot,goal,q,pole,.10)
   # Adult-proportion hand paths, solved with original limb lengths. Native
   # torso/legs remain the motion source; the three strike contacts are explicit.
   age=frame/30;ready=(-.15,-.13,.61);up=(0,-.70,.71)
   paths={
    'Slash':[(0,ready),(.13,(-.23,.015,.69)),(.256,(-.10,-.27,.63)),(.48,(.13,-.19,.54)),(.85,ready)],
    'Cleave':[(0,ready),(.30,(-.10,.02,.89)),(.587,(-.09,-.28,.58)),(.77,(-.10,-.20,.43)),(1.04,ready)],
    'Thrust':[(0,ready),(.20,(-.14,-.02,.60)),(.42,(-.09,-.32,.62)),(.60,(-.14,-.07,.61)),(.95,ready)]}
   axes={
    'Slash':[(0,up),(.13,(-.90,.30,.12)),(.256,(.45,-.89,.05)),(.48,(.9,.05,-.15)),(.85,up)],
    'Cleave':[(0,up),(.30,(0,.20,.98)),(.587,(0,-.90,-.43)),(.77,(0,-.55,-.83)),(1.04,up)],
    'Thrust':[(0,up),(.20,(0,-.98,.15)),(.42,(0,-1,0)),(.60,(0,-.99,.08)),(.95,up)]}
   if name!='Death':
    for label,side in [('Right','r'),('Left','l')]:
     hand=rig.pose.bones[names[label+'Hand']];restQ=rest[names[label+'Hand']].to_quaternion()
     if side=='r':
      goal=curve(paths.get(name,[(0,ready),(duration,ready)]),age)*height;direction=curve(axes.get(name,[(0,up),(duration,up)]),age).normalized();q=wrist_frame(axes.get(name,[(0,up),(duration,up)]),age,restQ)
     else:
      goal=Vector((.16,-.14,.61))*height;q=leftGripQ
     ik(rig.pose.bones[names[label+'Arm']],rig.pose.bones[names[label+'ForeArm']],hand,goal,q,Vector((-1 if side=='r' else 1,.20,-.35)),.18)
   else:
    for label,side in [('Right','r'),('Left','l')]:
     hand=rig.pose.bones[names[label+'Hand']];w=smooth((age-(.30 if side=='l' else .40))/(1.0 if side=='l' else 1.2));start=Vector((-.15 if side=='r' else .16,-.13,.61));end=Vector((-.16 if side=='r' else .18,-.22,.045));goal=start.lerp(end,w)*height;q=rest[names[label+'Hand']].to_quaternion();ik(rig.pose.bones[names[label+'Arm']],rig.pose.bones[names[label+'ForeArm']],hand,goal,q,Vector((-1 if side=='r' else 1,.15,-.25)),.18)
   # Flex each phalanx in its own local frame; oppose the thumb separately.
   curls={'Index':(.73,1.02,.68),'Middle':(.85,1.08,.72),'Ring':(.91,1.04,.74),'Pinky':(.96,.99,.72)}
   for label,sign in [('Left',-1),('Right',1)]:
    for finger,angles in curls.items():
     if key=='civilian-a' and label=='Left' and finger=='Index':angles=(.73,1.02,.68)
     for number,angle in enumerate(angles,1):
      bone=rig.pose.bones[names[label+'Hand'+finger+str(number)]];bone.rotation_mode='QUATERNION';bone.rotation_quaternion=Quaternion(Vector((1,0,0)),angle)
    opposition,*flex=thumbAngles[label]
    for number,angle in enumerate(flex,1):
     bone=rig.pose.bones[names[label+'HandThumb'+str(number)]];bone.rotation_mode='QUATERNION';bone.rotation_quaternion=Quaternion(Vector((0,0,1)),sign*opposition if number==1 else 0)@Quaternion(Vector((1,0,0)),angle)
   for bn,q in indexFit.items():rig.pose.bones[bn].rotation_quaternion=q
   bpy.context.view_layer.update()
   if name=='Death' and age>1.35:
    floors=support_floors(objects,names);settle=smooth((age-1.35)/.90)
    for label,side in [('Left','l'),('Right','r')]:
     foot=rig.pose.bones[names[label+'Foot']];goal=foot.head.copy();goal.z+=(floors['core']-floors[side])*settle
     q=foot.matrix.to_quaternion();pole=Vector((.85 if side=='l' else -.85,-1,0)).lerp(Vector((.85 if side=='l' else -.85,0,1)),smooth((age-.65)/1.5)).normalized()
     ik(rig.pose.bones[names[label+'UpLeg']],rig.pose.bones[names[label+'Leg']],foot,goal,q,pole,.10)
    # Bake cloth contact into the root trajectory; the runtime then only needs
    # sub-frame residual grounding instead of lifting the finished body 4 cm.
    floor=support_floors(objects,names)['core'];m=pelvis.matrix.copy();m.translation.z+=max(0,bb[0]-floor)*settle;pelvis.matrix=m;bpy.context.view_layer.update()
   if name=='Death':
    # The whole collapse, including the kneeling interval, must respect the
    # original shoe surfaces. Final contact alone misses mid-collapse floor cuts.
    for attempt in range(8):
     bpy.context.view_layer.update();floors=support_floors(objects,names)
     # Match the existing presentation's gradual body support descent.
     # Sub-millimetre clearance covers interpolation between 30 Hz source keys.
     floor=bb[0]+max(0,floors['core']-bb[0])*smooth((age/duration-.6)/.4)
     if all(floors[side]>=floor+height*.001-height*1e-7 for side in ['l','r']):break
     for label,side in [('Left','l'),('Right','r')]:
      lift=max(0,floor+height*.001-floors[side])
      if lift<=0:continue
      foot=rig.pose.bones[names[label+'Foot']];goal=foot.head.copy();goal.z+=lift;q=foot.matrix.to_quaternion();w=smooth((age-.65)/1.5)
      pole=Vector((.85 if side=='l' else -.85,-1,0)).lerp(Vector((.85 if side=='l' else -.85,0,1)),w).normalized()
      ik(rig.pose.bones[names[label+'UpLeg']],rig.pose.bones[names[label+'Leg']],foot,goal,q,pole,.10)
   records.append({b.name:b.matrix_basis.decompose()for b in rig.pose.bones})
  samples[name]=(frames,records,duration)
 k.animation_data.action=None
 for name,(frames,records,duration)in samples.items():
  action=bpy.data.actions.new(key+'_'+name);rig.animation_data.action=action
  for f,record in enumerate(records):
   for bn,(loc,rot,scale)in record.items():
    b=rig.pose.bones[bn];b.rotation_mode='QUATERNION';b.location=loc;b.rotation_quaternion=rot;b.scale=scale;b.keyframe_insert('location',frame=f);b.keyframe_insert('rotation_quaternion',frame=f);b.keyframe_insert('scale',frame=f)
  tr=rig.animation_data.nla_tracks.new();tr.name=name;strip=tr.strips.new(name,0,action);strip.action_frame_start=0;strip.action_frame_end=frames;tr.mute=True
 rig.animation_data.action=None
 # Calibrate authored equipment in the actual guard pose, not a T-pose guess.
 for bn,(loc,rot,scale)in samples['Idle'][1][0].items():
  b=rig.pose.bones[bn];b.rotation_mode='QUATERNION';b.location=loc;b.rotation_quaternion=rot;b.scale=scale
 bpy.context.view_layer.update();idleHands={s:rig.pose.bones[names[label+'Hand']].matrix.to_quaternion().copy()for label,s in [('Left','l'),('Right','r')]}
 for b in rig.pose.bones:b.matrix_basis=Matrix.Identity(4)
 bpy.context.view_layer.update()
 for side,label,prefix,current,desired in [('r','Right','Sword',gripAxes['r'],Vector((0,-.70,.71)).normalized()),('l','Left','Buckler',palmNormals['l'],Vector((0,-1,0)))]:
  restQ=rest[names[label+'Hand']].to_quaternion();delta=idleHands[side]@restQ.inverted();actual=delta@current;worldFix=actual.rotation_difference(desired);fix=delta.inverted()@worldFix@delta;pivot=grips[side]
  for o in objects:
   if o.name.startswith(prefix)or(side=='l' and o.name in ['ShieldContact','ShieldGrip']):
    o.matrix_world=Matrix.Translation(pivot)@fix.to_matrix().to_4x4()@Matrix.Translation(-pivot)@o.matrix_world
 bpy.context.view_layer.update()
 bpy.ops.object.select_all(action='DESELECT')
 for o in objects:o.select_set(True)
 bpy.context.view_layer.objects.active=rig
 for tr in rig.animation_data.nla_tracks:tr.mute=False
 bpy.ops.export_scene.gltf(filepath=str(out/(key+'.glb')),export_format='GLB',use_selection=True,export_apply=False,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_skins=True)
 clean=lambda n:re.sub(r'[\[\].:/]','',n)
 meta={'model':key,'sourceHeight':height,'sourceFloor':bb[0],'referenceHeight':2.6122968196868896,'normalization':2.6122968196868896/height,'front':'Three +Z','bones':{sem:clean(names[bn])for sem,bn in semantic.items()},'bodySupport':[clean(names[n])for n in ['Hips','Spine','Spine1','Spine2','Head']],'sourceRestMatrices':{n:[list(r)for r in m]for n,m in rest.items()},'contactCalibration':{'slash':.256,'cleave':.587,'thrust':.42},'clips':{n:{'source':('authored adult collapse' if n=='Death' else 'KayKit CC0 torso base plus adult stable-pole IK '+clips[n]),'duration':d}for n,(_,_,d)in samples.items()},'weapons':{'swordTip':'SwordTip','shieldContact':'ShieldContact','shieldGrip':'ShieldGrip','gripCm':{s:list(v)for s,v in grips.items()},'gripRadiiCm':gripRadii,'gripFit':'curled middle phalange circle; original skin weights'},'license':'CC BY 4.0' if key.endswith('a')else'Free Standard — local preview only'}
 (out/(key+'.json')).write_text(json.dumps(meta,indent=2));print('EXPORTED',key,bb,height)
