"""Independent sword / mounted sample. Old generators and assets are read-only.
Run Blender -b --python this.py -- public/assets/3d-sample/vitality --kind infantry|cavalry.
"""
from pathlib import Path
import math, json, sys, hashlib
import bpy
from mathutils import Vector, Matrix


def vitality_geometry(c):
    # Refine the existing continuous anatomy instead of stacking armour blobs.
    mounted=c['KIND']=='cavalry'; lift=1 if mounted else 0
    for p in c['parts']:
        if p.name.startswith(('standard tunic torso','standard cuirass torso','standard tabard')):
            for v in p.data.vertices:
                w=p.matrix_world@v.co; z=w.z-lift
                # Defined ribcage -> cinched waist -> hips, with looser lower cloth.
                waist=math.exp(-((z-1.63)/.20)**2)
                w.x*=1-.10*waist
                if 'tabard' in p.name and z<1.48:
                    w.y+=.012*math.sin(w.x*31)*(1.48-z)/.38
                v.co=p.matrix_world.inverted()@w
        if p.name.startswith('horse standard continuous barrel'):
            # Haunch and shoulder flow into the barrel; avoid cylindrical belly.
            for v in p.data.vertices:
                w=v.co;old=(p.name,*[round(q,6) for q in w]);weight=c['standard_horse_weights'][old]; w.x*=1+.045*math.cos((w.y+.4)*3.2)
                if w.z<1.52:w.z+=.045*math.exp(-((w.y+.55)/.30)**2)
                c['standard_horse_weights'][(p.name,*[round(q,6) for q in w])]=weight
    c['vital_weights']={}
    def weighted(p,bone):c['vital_weights'][p.name]=bone if isinstance(bone,dict) else {bone:1};return p
    rod,uv,box=c['rod'],c['uv'],c['box']
    steel,edge,leather,gold,red=c['steel'],c['edge'],c['leather'],c['gold'],c['red']
    # Collar and overlapping articulated waist plates create readable thickness.
    for sign in (-1,1):
        weighted(rod('vital collar '+str(sign),(sign*.04,-.178,2.16+lift),(sign*.23,-.206,2.10+lift),.014,.012,edge),'Chest')
        for row in range(3):
            z=1.43-row*.095+lift
            weighted(box('vital fauld '+str(sign)+' '+str(row),(sign*.233,-.176,z),(.16,.065,.112),steel,.018),'Hips')
        for z in (1.66,1.79,1.92):
            weighted(uv('vital chest fastening '+str(sign)+' '+str(z),(sign*.255,-.193,z+lift),(.018,.014,.018),gold,8,6),'Chest' if z>1.8 else 'Spine')
        # A closed wrist guard supports an actual grip, never an unattached jewel.
        wrist=c['rig'].data.bones['Forearm.'+('L' if sign<0 else 'R')].tail_local
        weighted(uv('vital elbow hinge '+str(sign),c['rig'].data.bones['Forearm.'+('L' if sign<0 else 'R')].head_local,(.11,.098,.103),steel,12,8),'Forearm.'+('L' if sign<0 else 'R'))
    # Close-fitting shoulder shells retain an overlapping edge but lose the
    # oversized ball silhouette. The red sleeve still fills the joint beneath.
    for part in c['parts']:
        if part.name.startswith('standard shoulder plate '):
            side=part.name[-1];center=c['rig'].data.bones['UpperArm.'+side].head_local
            for vertex in part.data.vertices:
                delta=vertex.co-center;vertex.co=center+delta*.88
        if part.name.startswith('standard soft arm '):
            side=part.name[-1];shoulder,elbow,wrist=c['standard_arm_axes'][side]
            # Preserve indexed ring weights for the mounted bent elbow.
            for vertex in part.data.vertices:
                old=(side,*[round(q,6) for q in vertex.co]);weight=c['standard_arm_ring_weights'].get(old)
                upper=elbow-shoulder;t=max(0,min(1,(vertex.co-shoulder).dot(upper)/upper.length_squared))
                if t<.76:
                    center=shoulder+upper*t;vertex.co=center+(vertex.co-center)*.92
                if weight is not None:c['standard_arm_ring_weights'][(side,*[round(q,6) for q in vertex.co])]=weight
    for side,sign in [('L',-1),('R',1)]:
        # A shallow anatomical knee shell with an open rear, not a ball cap.
        vertices=[];faces=[]
        for z,width,depth in [(.67,.081,.104),(.755,.105,.130),(.84,.089,.111)]:
            cy=(.065 if side=='L' else -.07)+((- .01 if side=='L' else -.145)-(.065 if side=='L' else -.07))*(z-.16)/.59
            for j in range(9):
                angle=-math.pi/2+(j/8-.5)*2.2
                point=Vector((sign*.187+width*math.cos(angle),cy+depth*math.sin(angle)-.015,z))
                if mounted:point=c['mounted_leg_point'](point,side)
                vertices.append(point)
        for row in range(2):
            for j in range(8):q=row*9+j;faces.append((q,q+1,q+10,q+9))
        mesh=bpy.data.meshes.new('articulated knee');mesh.from_pydata(vertices,[],faces);mesh.update()
        obj=bpy.data.objects.new('vital shaped kneecap '+side,mesh);bpy.context.collection.objects.link(obj);c['finish'](obj,obj.name,steel)
        obj.modifiers.new('forged knee thickness','SOLIDIFY').thickness=.015
        for poly in mesh.polygons:poly.use_smooth=True
        weighted(obj,{'Thigh.'+side:.5,'Shin.'+side:.5})
    if mounted:
        # Draped saddle blanket replaces the flat tabletop under the saddle.
        for p in list(c['parts']):
            if p.name=='horse red saddle cloth':c['parts'].remove(p);bpy.data.objects.remove(p,do_unlink=True)
        verts=[];faces=[]
        for y in (-.32,-.05,.25,.55):
            for x,z in [(-.56,1.57),(-.48,1.83),(-.28,2.015),(0,2.04),(.28,2.015),(.48,1.83),(.56,1.57)]:verts.append((x,y,z))
        for i in range(3):
            for j in range(6):q=i*7+j;faces.append((q,q+1,q+8,q+7))
        mesh=bpy.data.meshes.new('draped saddle blanket');mesh.from_pydata(verts,[],faces);mesh.update()
        obj=bpy.data.objects.new('vital draped saddle blanket',mesh);bpy.context.collection.objects.link(obj);c['finish'](obj,obj.name,red)
        obj.modifiers.new('wool thickness','SOLIDIFY').thickness=.025
        for poly in mesh.polygons:poly.use_smooth=True
        weighted(obj,'HorseBody')
        for sign in (-1,1):
            # Stirrup follows the boot; straps blend to the horse in future cloth work.
            foot=c['rig'].data.bones['Foot.'+('L' if sign<0 else 'R')].head_local
            for a,b,label in [(foot+Vector((-.085,.05,-.04)),foot+Vector((.085,.05,-.04)),'tread'),(foot+Vector((-.085,.05,-.04)),foot+Vector((0,.06,.12)),'left'),(foot+Vector((.085,.05,-.04)),foot+Vector((0,.06,.12)),'right')]:weighted(rod('vital stirrup '+str(sign)+label,a,b,.018,.018,edge),'Foot.'+('L' if sign<0 else 'R'))
            weighted(rod('vital saddle pommel '+str(sign),(sign*.32,-.19,2.02),(sign*.28,-.23,2.16),.05,.04,leather),'HorseBody')
            weighted(rod('vital bridle cheek '+str(sign),(sign*.18,-1.24,2.4),(sign*.18,-1.72,2.09),.018,.018,leather),'HorseHead')
            weighted(uv('vital nostril '+str(sign),(sign*.134,-1.772,2.092),(.015,.026,.019),c['visor'],10,6),'HorseHead')
    else:
        # A visible raised central helmet ridge strengthens the compact silhouette.
        weighted(rod('vital helmet ridge',(0,-.17,2.52),(0,.11,2.57),.022,.022,edge),'Head')


def vitality_pose(c,action,frame):
    if action in ('Death','Hit'):return # true reaction / original settled support wins
    p=c['rig'].pose.bones; mounted=c['KIND']=='cavalry'
    if not mounted:
        if action in ('Walk','Turn'):
            phase=frame/(18 if action=='Walk' else 12)*math.tau
            p['Chest'].rotation_euler.z+=.045*math.sin(phase)
            p['Spine'].rotation_euler.z-=.030*math.sin(phase)
            p['Head'].rotation_euler.z-=.016*math.sin(phase)
            p['UpperArm.R'].rotation_euler.x+=.10*math.sin(phase)
            p['UpperArm.L'].rotation_euler.x-=.055*math.sin(phase)
        elif action=='Attack':
            # Same .458s impact. Load through the torso, sharp release, then settle.
            load={0:0,4:-.045,8:-.075,11:.095,16:.025,21:0}.get(frame,0)
            p['Spine'].rotation_euler.x+=load
            p['Chest'].rotation_euler.z+={4:-.055,8:-.075,11:.055,16:.025}.get(frame,0)
            p['Head'].rotation_euler.x-=load*.45
            bpy.context.view_layer.update();c['solve_duel_attack'](frame)
        return
    if action in ('Walk','Charge'):
        period=24 if action=='Walk' else 18;phase=frame/period*math.tau
        body=p['HorseBody'];m=body.matrix.copy();m.translation.z-=.085;body.matrix=m
        # Rider absorbs saddle motion at hip/spine instead of riding as a statue.
        p['Chest'].rotation_euler.x=(.12 if action=='Walk' else .30)+.035*math.sin(phase+.5)
        p['Spine'].rotation_euler.x=-.045-.025*math.sin(phase+.5)
        p['Head'].rotation_euler.x=-.055-.012*math.sin(phase)
        p['Hips'].rotation_euler.x=.035*math.sin(phase-.5)
        p['Chest'].rotation_euler.z=.027*math.sin(phase)
        # Two diagonal support pairs in trot; offset four-beat charge with flexed
        # recovery. Hooves follow a stance trajectory, not swinging rigid sticks.
        for key,(hip,knee,ankle,toe) in c['horse_joints'].items():
            offset=({'FL':0,'BR':0,'FR':.5,'BL':.5} if action=='Walk' else {'FL':0,'FR':.12,'BL':.55,'BR':.67})[key]
            t=(frame/period+offset)%1;stance=.56 if action=='Walk' else .48
            stride=1.35 if action=='Walk' else 1.60
            if t<stance:y=-stride/2+stride*t/stance;z=0
            else:
                swing=(t-stance)/(1-stance);y=stride/2-stride*(swing-math.sin(swing*math.tau)/math.tau);z=(.24 if action=='Walk' else .34)*math.sin(swing*math.pi)
            upper=p['HorseUpper.'+key];lower=p['HorseLower.'+key];hoof=p['HorseHoof.'+key]
            bpy.context.view_layer.update();a=upper.matrix.translation.copy();target=ankle+Vector((0,y,z))
            l1=upper.bone.length;l2=lower.bone.length;d=target-a;distance=min(d.length,l1+l2-.003);axis=d.normalized();target=a+axis*distance
            along=(l1*l1-l2*l2+distance*distance)/(2*distance);bend=math.sqrt(max(0,l1*l1-along*along))
            pole=Vector((0,-1 if key[0]=='F' else 1,0));pole-=axis*pole.dot(axis)
            k=a+axis*along+pole.normalized()*bend
            c['align_bone'](upper,a,k);c['align_bone'](lower,k,target)
            m=hoof.bone.matrix_local.copy();m.translation=target;hoof.matrix=m
        bpy.context.view_layer.update();c['solve_variant_arms'](action,frame)
    elif action=='Idle':
        p['Chest'].rotation_euler.x=.08;p['Spine'].rotation_euler.x=-.025
        bpy.context.view_layer.update();c['solve_variant_arms'](action,frame)

base=Path(__file__).with_name('generate-standard-soldier.py')
source=base.read_text()
source=source.replace("standard_geometry(globals())\\n", "standard_geometry(globals()); vitality_geometry(globals())\\n")
source=source.replace("def standard_weights(ctx, fallback, name, point):", "def standard_weights(ctx, fallback, name, point):\n    if name in ctx.get('vital_weights',{}):return ctx['vital_weights'][name]")
source=source.replace("source=base.read_text()", "source=base.read_text().replace(\"for pb in rig.pose.bones:pb.keyframe_insert('location',frame=frame);\", \"vitality_pose(globals(),name,frame)\\n  for pb in rig.pose.bones:pb.keyframe_insert('location',frame=frame);\")")
source=source.replace("ctx={'__file__':str(base),", "ctx={'__file__':str(base),'vitality_geometry':vitality_geometry,'vitality_pose':vitality_pose,")
namespace={'__file__':str(base),'vitality_geometry':vitality_geometry,'vitality_pose':vitality_pose}
exec(compile(source,str(base),'exec'),namespace)
meta=namespace['metadata'];meta['sample']='vitality-20261014';meta['animationScope']='new weighted gait/torso recoil and mounted support; same real strike at11/24, Hit/Death retained';meta['authoringSha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
namespace['metadata_path'].write_text(json.dumps(meta,indent=2)+'\n')
