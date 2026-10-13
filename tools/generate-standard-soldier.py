"""R2 anatomy layer over the established six-clip D1 Blender authoring source.

This keeps one skeleton / animation implementation for all iterations. The two
explicit insertion points fail closed if the base authoring layout changes.
"""
from pathlib import Path
import hashlib
import json
import math
import sys
import bpy
from mathutils import Vector


def smooth_mesh(mesh):
    for polygon in mesh.data.polygons:
        polygon.use_smooth = True
    return mesh


def standard_geometry(ctx):
    """Build real mesh volumes around the existing bind axes, not pose offsets."""
    parts, finish, loft = ctx['parts'], ctx['finish'], ctx['loft']
    steel, red, dark = ctx['steel'], ctx['red'], ctx['dark']
    cream, leather = ctx['cream'], ctx['leather']
    remove_terms = ('trouser', 'boot shaft', 'knee cup', 'shin plate', 'hip layer',
                    'tunic', 'torso', 'tabard', 'waist belt', 'belt over',
                    'upper sleeve', 'sleeve lower', 'lower sleeve', 'forearm',
                    'vambrace', 'shoulder lamella', 'mail coif')
    for part in list(parts):
        if any(term in part.name for term in remove_terms):
            parts.remove(part)
            bpy.data.objects.remove(part, do_unlink=True)
    # A rounded barrel ribcage narrows at the waist and opens over the pelvis.
    smooth_mesh(loft('standard tunic torso', [
        (1.19, 0, .010, .288, .197), (1.34, 0, .003, .305, .201),
        (1.52, 0, -.005, .267, .185), (1.68, 0, -.021, .253, .181),
        (1.87, 0, -.030, .304, .203), (2.035, 0, -.025, .351, .210),
        (2.135, 0, -.016, .308, .193), (2.225, 0, -.025, .169, .124)], red, 20))
    smooth_mesh(loft('standard cuirass torso', [
        (1.52, 0, -.008, .275, .192), (1.64, 0, -.021, .265, .192),
        (1.86, 0, -.031, .315, .211), (2.025, 0, -.025, .353, .221),
        (2.105, 0, -.024, .303, .201), (2.18, 0, -.027, .170, .139)], steel, 20))
    smooth_mesh(loft('standard mail hip', [
        (1.10, 0, .019, .294, .191), (1.18, 0, .016, .316, .213),
        (1.36, 0, .010, .315, .211), (1.54, 0, -.012, .277, .198)], dark, 20))

    # The cloth wraps the curved cuirass. Its cut and folds follow chest and hip;
    # a split begins below the belt, instead of a straight plank down the back.
    rows = [(2.205, .143, -.191), (2.08, .209, -.264),
            (1.88, .234, -.262), (1.68, .193, -.235),
            (1.51, .211, -.250), (1.33, .255, -.260), (1.12, .266, -.237)]
    for front in (True, False):
        vertices, faces = [], []
        for side in (-1, 1):
            base = len(vertices)
            for i, (z, width, depth) in enumerate(rows):
                slit = .029 if z < 1.50 else 0
                for j in range(9):
                    t = j / 8
                    x = side * (slit + (width - slit) * t)
                    # Gentle longitudinal folds in the loose hem, small at chest.
                    amplitude = .004 if z > 1.5 else .014
                    y = depth + .052*t*t + amplitude*math.sin(t*math.pi*3)
                    if not front:
                        y = -y - .040 + max(0,min(.040,(1.52-z)*.10))
                    hem = .025*math.sin(t*math.pi) + (.07*(1-t) if i == 6 else 0)
                    vertices.append((x, y, z+hem))
            for i in range(len(rows)-1):
                for j in range(8):
                    q = base+i*9+j
                    face=(q,q+1,q+10,q+9)
                    if (front and side==1) or (not front and side==-1):
                        face=tuple(reversed(face))
                    faces.append(face)
        data = bpy.data.meshes.new('standard shaped linen')
        data.from_pydata(vertices, [], faces); data.update()
        obj = bpy.data.objects.new('standard tabard '+('front' if front else 'back'), data)
        bpy.context.collection.objects.link(obj); finish(obj, obj.name, cream)
        cloth=obj.modifiers.new('woven cloth thickness', 'SOLIDIFY')
        cloth.thickness=.009
        cloth.offset=-1
        smooth_mesh(obj)
    # Side waist leather is physically outside the surcoat, with the old buckle.
    smooth_mesh(loft('standard waist belt', [(1.52,0,-.013,.299,.274),
                                            (1.598,0,-.013,.291,.267)], leather, 20))
    for part in parts:
        if part.name == 'brass belt buckle':
            part.location.z += .074
            part.location.y -= .018
    # Neck coif has a single shoulder-to-jaw taper, not stacked neck rings.
    smooth_mesh(loft('standard mail neck', [(2.085,0,-.023,.189,.141),
        (2.18,0,-.025,.162,.132), (2.29,0,-.031,.153,.132),
        (2.39,0,-.032,.160,.137)], dark,20))

    def tube(name, rings, material, count=16):
        vertices, faces = [], []
        for i, (point, radius) in enumerate(rings):
            before = Vector(rings[max(0,i-1)][0]); after = Vector(rings[min(len(rings)-1,i+1)][0])
            direction = (after-before).normalized()
            u = direction.cross(Vector((0,1,0))).normalized(); v = direction.cross(u).normalized()
            for j in range(count):
                angle = j/count*math.tau
                vertices.append(Vector(point)+u*math.cos(angle)*radius+v*math.sin(angle)*radius*.90)
        for i in range(len(rings)-1):
            for j in range(count):
                q=i*count+j;faces.append((q,i*count+(j+1)%count,(i+1)*count+(j+1)%count,q+count))
        faces.extend([tuple(reversed(range(count))),tuple((len(rings)-1)*count+j for j in range(count))])
        data=bpy.data.meshes.new(name);data.from_pydata(vertices,[],faces);data.update()
        obj=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(obj)
        finish(obj,name,material);smooth_mesh(obj)
        return obj

    ctx['standard_arm_axes'] = {}
    ctx['standard_arm_ring_weights'] = {}
    for side, sign in [('L', -1), ('R', 1)]:
        bones=ctx['rig'].data.bones
        shoulder=bones['UpperArm.'+side].head_local.copy()
        elbow=bones['UpperArm.'+side].tail_local.copy()
        wrist=bones['Forearm.'+side].tail_local.copy()
        ctx['standard_arm_axes'][side] = (shoulder,elbow,wrist)
        upper=elbow-shoulder; lower=wrist-elbow
        rings=[(shoulder-upper*.060,.130), (shoulder+upper*.14,.139),
               (shoulder+upper*.38,.128), (shoulder+upper*.67,.117),
               (elbow-upper*.10,.105), (elbow,.102), (elbow+lower*.15,.109),
               (elbow+lower*.42,.099), (elbow+lower*.75,.081), (wrist+lower*.04,.067)]
        sleeve=tube('standard soft arm '+side,rings,red)
        if ctx['KIND']=='pikeman':
            # A pike forearm folds back across the upper-arm axis. Projection
            # cannot distinguish its segments; tube ring order provides an
            # unambiguous continuous skin transition.
            ring_weights=[{'Chest':.53,'UpperArm.'+side:.47},
                {'Chest':.27,'UpperArm.'+side:.73},
                {'UpperArm.'+side:1},{'UpperArm.'+side:1},
                {'UpperArm.'+side:.80,'Forearm.'+side:.20},
                {'UpperArm.'+side:.50,'Forearm.'+side:.50},
                {'UpperArm.'+side:.20,'Forearm.'+side:.80},
                {'Forearm.'+side:1},{'Forearm.'+side:1},{'Forearm.'+side:1}]
            for vertex in sleeve.data.vertices:
                key=(side,*[round(value,6) for value in vertex.co])
                ctx['standard_arm_ring_weights'][key]=ring_weights[vertex.index//16]
        # Forged forearm sleeve overlaps the continuous gambeson at both ends.
        tube('standard forearm plate '+side,[(elbow+lower*.24,.112),
            (elbow+lower*.40,.108),(elbow+lower*.70,.090),(elbow+lower*.87,.078)],steel)
        # The shoulder is an open curved cap along the upper-arm axis, with a
        # thin rolled edge. It does not form a detached sphere or full hoop.
        direction=upper.normalized();u=direction.cross(Vector((0,1,0))).normalized()*sign;v=direction.cross(u).normalized()
        verts=[];faces=[]
        for offset,radius in [(-.090,.142),(-.035,.175),(.055,.176),(.150,.149),(.205,.125)]:
            center=shoulder+direction*offset
            for j in range(13):
                angle=-1.40+j/12*2.80
                verts.append(center+u*math.cos(angle)*radius+v*math.sin(angle)*radius*.9)
        for i in range(4):
            for j in range(12):q=i*13+j;faces.append((q,q+1,q+14,q+13))
        data=bpy.data.meshes.new('continuous pauldron');data.from_pydata(verts,[],faces);data.update()
        obj=bpy.data.objects.new('standard shoulder plate '+side,data);bpy.context.collection.objects.link(obj);finish(obj,obj.name,steel)
        obj.modifiers.new('forged plate thickness','SOLIDIFY').thickness=.018;smooth_mesh(obj)
        tube('standard glove cuff '+side,[(wrist-lower*.15,.071),(wrist+lower*.13,.070)],leather)

    # Full thighs, a clear calf taper and a continuous ankle: plates remain thin
    # overlays and stop before the flexing joints.
    for side,sign in [('L',-1),('R',1)]:
        x=sign*.187
        def center_y(z):
            ankle=.065 if side=='L' else -.07;knee=-.01 if side=='L' else -.145
            return ankle+(knee-ankle)*(z-.16)/.59 if z<=.75 else knee+(.015-knee)*(z-.75)/.45
        smooth_mesh(loft('standard trouser '+side,[(z,x,center_y(z),rx,ry) for z,rx,ry in
            [(.15,.084,.098),(.34,.107,.111),(.53,.119,.126),(.67,.111,.119),
             (.76,.101,.108),(.87,.123,.137),(1.05,.158,.161),(1.20,.165,.170),(1.30,.154,.163)]],leather,18))
        smooth_mesh(loft('standard boot shaft '+side,[(z,x,center_y(z),rx,ry) for z,rx,ry in
            [(.11,.093,.104),(.24,.099,.107),(.38,.110,.116),(.51,.119,.126)]],leather,18))
        verts=[];faces=[]
        for z,rx,ry in [(.235,.099,.113),(.36,.111,.123),(.52,.120,.134),(.65,.111,.126)]:
            for j in range(11):
                angle=-math.pi/2+(j/10-.5)*2.10
                verts.append((x+rx*math.cos(angle),center_y(z)+ry*math.sin(angle)-.006,z))
        for i in range(3):
            for j in range(10):q=i*11+j;faces.append((q,q+1,q+12,q+11))
        data=bpy.data.meshes.new('fitted continuous greave');data.from_pydata(verts,[],faces);data.update()
        obj=bpy.data.objects.new('standard shin plate '+side,data);bpy.context.collection.objects.link(obj);finish(obj,obj.name,steel)
        obj.modifiers.new('forged greave thickness','SOLIDIFY').thickness=.012;smooth_mesh(obj)
    # Broaden the real blade across its edge axis; the tip/hilt and motion axis
    # remain unchanged so the main camera can read a blade rather than a line.
    if ctx['KIND']=='infantry':
        blade=next(part for part in parts if part.name=='sword - ridged steel blade')
        vertices=blade.data.vertices
        center=(vertices[0].co+vertices[2].co)*.5
        blade_axis=(vertices[6].co-center).normalized()
        ctx['standard_blade_rest_axis']=blade_axis.copy()
        cross=(vertices[2].co-vertices[0].co)
        cross=(cross-blade_axis*cross.dot(blade_axis)).normalized()
        for vertex in vertices:
            if vertex.index == 6:
                continue
            offset=(vertex.co-center).dot(cross)
            vertex.co += cross*offset*.40


def standard_weights(ctx, fallback, name, point):
    if name.startswith('standard soft arm '):
        side=name[-1];shoulder,elbow,wrist=ctx['standard_arm_axes'][side]
        ring_weight=ctx.get('standard_arm_ring_weights',{}).get((side,*[round(value,6) for value in point]))
        if ctx['KIND']=='pikeman':
            assert ring_weight is not None, f'P2 sleeve ring weight missing: {side} {point[:]}'
        if ring_weight is not None:return ring_weight
        upper=elbow-shoulder;lower=wrist-elbow
        t=(point-shoulder).dot(upper)/upper.length_squared
        # Soft chest influence at the shoulder and continuous elbow transition.
        if t < .22:
            arm=max(.18,min(1,(t+.08)/.30))
            return {'Chest':1-arm,'UpperArm.'+side:arm}
        elbow_distance=(point-elbow).dot(lower.normalized())
        if t>.85 and elbow_distance>-.025:
            bend=max(0,min(1,(elbow_distance+.025)/.07))
            return {'UpperArm.'+side:1-bend,'Forearm.'+side:bend}
        return {'UpperArm.'+side:1}
    if name.startswith('standard forearm plate '):return {'Forearm.'+name[-1]:1}
    if name.startswith('standard shoulder plate '):return {'UpperArm.'+name[-1]:1}
    if name.startswith('standard glove cuff '):return {'Hand.'+name[-1]:1}
    if name.startswith('standard trouser '):
        side=name[-1];t=max(0,min(1,(point.z-.66)/.21))
        hip=max(0,min(.35,(point.z-1.16)*2.5))
        return {'Shin.'+side:(1-t)*(1-hip),'Thigh.'+side:t*(1-hip),'Hips':hip}
    if name.startswith(('standard boot shaft ','standard shin plate ')):return {'Shin.'+name[-1]:1}
    if name.startswith('standard tabard '):
        if point.z >= 1.52:
            t=max(0,min(1,(point.z-1.52)/.45))
            return {'Spine':1-t,'Chest':t}
        t=max(0,min(1,(point.z-1.22)/.30))
        return {'Hips':1-t,'Spine':t}
    if name=='standard mail neck':
        t=max(0,min(1,(point.z-2.13)/.22));return {'Chest':1-t,'Neck':t*.45,'Head':t*.55}
    return fallback(name,point)


def standard_pike_pose(ctx, action, frame):
    """P2's outboard channel: fixed limb lengths, exact shared shaft grip.

    Mesh and bind positions stay native P1. Only the new P2 action poses move
    the rear hand / shaft together and let the front hand slide on that shaft.
    """
    rig=ctx['rig'];bones=rig.data.bones;pose=rig.pose.bones
    bpy.context.view_layer.update()
    chest_delta=pose['Chest'].matrix @ bones['Chest'].matrix_local.inverted()
    shaft_axis=Vector((0,-1,0))
    thrust=0
    if action=='Attack':
        thrust={0:0,4:-.08,8:-.12,11:.16,16:.07,21:0}.get(frame,0)
    offset=Vector((.13,.06,0))
    rear_center=chest_delta @ (ctx['rc']+offset)+Vector((0,-thrust,0))
    hand_rest=bones['Hand.R'].matrix_local
    hand_matrix=chest_delta @ hand_rest
    hand_matrix.translation += chest_delta.to_3x3() @ offset + Vector((0,-thrust,0))
    desired_axis=shaft_axis
    if action=='Death':
        # Entry uses the new guard. The shaft lies down with the body; the
        # forward hand releases during the fall rather than snapping at t=0.
        progress=max(0,min(1,(frame-5)/8))
        body_axis=(chest_delta.to_3x3() @ shaft_axis).normalized()
        desired_axis=(body_axis*(1-progress)+Vector((.70,-.70,.015)).normalized()*progress).normalized()
    current_axis=((hand_matrix @ hand_rest.inverted()).to_3x3() @ shaft_axis).normalized()
    rotation=current_axis.rotation_difference(desired_axis)
    rotated=rotation.to_matrix().to_4x4() @ hand_matrix
    rotated.translation=hand_matrix.translation
    rotated.translation += rear_center-(rotated @ hand_rest.inverted()) @ ctx['rc']

    def solve_arm(side, wrist, hand_goal, elbow_pole=None):
        shoulder=chest_delta @ bones['UpperArm.'+side].head_local
        upper=pose['UpperArm.'+side];lower=pose['Forearm.'+side]
        l1=upper.bone.length;l2=lower.bone.length;direction=wrist-shoulder;distance=direction.length
        assert abs(l1-l2)+1e-5 < distance <= l1+l2-.002, f'P2 {action} {frame} {side} unreachable {distance:.6f}/{l1+l2:.6f}'
        axis=direction.normalized();along=(l1*l1-l2*l2+distance*distance)/(2*distance)
        height=math.sqrt(max(1e-8,l1*l1-along*along))
        pole=(elbow_pole-shoulder if elbow_pole is not None else
              chest_delta @ Vector(ctx['arm_targets'][side][0])-shoulder)
        pole=pole-axis*pole.dot(axis)
        if pole.length<1e-6:pole=Vector((1 if side=='R' else -1,0,0))-axis*axis.x
        elbow=shoulder+axis*along+pole.normalized()*height
        ctx['align_bone'](upper,shoulder,elbow)
        ctx['align_bone'](lower,elbow,wrist)
        pose['Hand.'+side].matrix=hand_goal
        bpy.context.view_layer.update()
        scales=[*upper.scale,*lower.scale]
        assert max(abs(value-1) for value in scales)<2e-5, f'P2 {action} {frame} stretched {side}'
        ctx.setdefault('pike_pose_checks',[]).append({'clip':action,'frame':frame,'side':side,
            'reach':distance,'maximumReach':l1+l2,'scales':scales,'wrist':wrist[:]})

    if action=='Death' and frame>=13:
        # The native fall leaves the forward glove below the entire torso.
        # Settle connected arms next to the body, using its actual lower mesh
        # envelope; neither a glove nor the full-length shaft props it up.
        body=ctx['body']
        def skinned_point(vertex):
            result=Vector((0,0,0))
            for group in vertex.groups:
                name=body.vertex_groups[group.group].name
                result+=(pose[name].matrix @ bones[name].matrix_local.inverted() @ vertex.co)*group.weight
            return result
        body_indices=[v.index for v in body.data.vertices if v.groups and
            body.vertex_groups[max(v.groups,key=lambda g:g.weight).group].name
            in ('Hips','Spine','Chest','Head','Thigh.L','Thigh.R','Shin.L','Shin.R','Foot.L','Foot.R')]
        floor=min(skinned_point(body.data.vertices[i]).z for i in body_indices)
        lateral=chest_delta.to_3x3() @ Vector((1,0,0));lateral.z=0;lateral.normalize()
        lengthwise=chest_delta.to_3x3() @ Vector((0,0,1));lengthwise.z=0;lengthwise.normalize()
        progress=min(1,(frame-5)/18)
        desired_axis=-lengthwise
        current_axis=((hand_matrix @ hand_rest.inverted()).to_3x3() @ shaft_axis).normalized()
        rotation=current_axis.rotation_difference(desired_axis)
        right=rotation.to_matrix().to_4x4() @ hand_matrix
        right.translation=hand_matrix.translation
        # Hand rotations are independent of arm reach. Translation stays at
        # the wrist and the original grip vertices stay attached to Hand.R.
        for side in ('R','L'):
            shoulder=chest_delta @ bones['UpperArm.'+side].head_local
            side_sign=1 if side=='R' else -1
            settled=shoulder+lateral*(side_sign*.10)-lengthwise*.65
            settled.z=floor+.160+(.050 if side=='R' else 0)
            if side=='R':
                hand=right.copy();guard=rotated.translation
            else:
                hand=chest_delta @ bones['Hand.L'].matrix_local
                guard=(rotated @ hand_rest.inverted() @ bones['Hand.L'].matrix_local).translation
                guard+=(rotated @ hand_rest.inverted()).to_3x3() @ Vector((0,.10,0))
            wrist=guard.lerp(settled,progress)
            # During the half-fall the boots still define the body envelope.
            # Follow a reachable arc; the final horizontal pose reaches the
            # envelope target directly, without stretching either arm.
            reach=(wrist-shoulder).length
            limit=bones['UpperArm.'+side].length+bones['Forearm.'+side].length-.020
            if reach>limit:wrist=shoulder+(wrist-shoulder).normalized()*limit
            hand.translation=wrist
            elbow_pole=shoulder+lateral*(side_sign*.22)-lengthwise*.30+Vector((0,0,.20))
            solve_arm(side,wrist,hand,elbow_pole)
        ctx.setdefault('pike_death_checks',[]).append({'frame':frame,'bodyEnvelopeZ':floor,
            'armWristZBySide':{'R':floor+.210,'L':floor+.160},'shaftAxis':desired_axis[:],'releaseBlend':progress,
            'lowestVertices':sorted([{'vertex':v.index,'point':skinned_point(v)[:],
                'bone':body.vertex_groups[max(v.groups,key=lambda g:g.weight).group].name}
                for v in body.data.vertices if v.groups],key=lambda v:v['point'][2])[:4],
            'shoulders':[pose['UpperArm.'+side].matrix.translation[:] for side in ('R','L')],
            'elbows':[pose['Forearm.'+side].matrix.translation[:] for side in ('R','L')]})
        return

    solve_arm('R',rotated.translation.copy(),rotated)
    right_deform=pose['Hand.R'].matrix @ hand_rest.inverted()
    left_goal=right_deform @ bones['Hand.L'].matrix_local
    left_goal.translation += right_deform.to_3x3() @ Vector((0,.10,0))
    solve_arm('L',left_goal.translation.copy(),left_goal)


def standard_pike_euler_continuity(ctx, action, frame):
    """Equivalent Euler values follow the short path between P2 arm keys."""
    if frame==0:ctx['pike_previous_eulers']={}
    previous=ctx['pike_previous_eulers']
    for bone in ctx['rig'].pose.bones:
        if bone.name in previous:
            before=bone.rotation_euler.copy()
            bone.rotation_euler.make_compatible(previous[bone.name])
            if max(abs(a-b) for a,b in zip(before,bone.rotation_euler))>math.pi:
                ctx.setdefault('pike_euler_checks',[]).append({'clip':action,'frame':frame,'bone':bone.name})
        previous[bone.name]=bone.rotation_euler.copy()


bpy.context.preferences.filepaths.save_version=0
base = Path(__file__).resolve().with_name('generate-rigged-soldier.py')
# Only this independent output is generated. The baseline script / assets are
# read, never overwritten, and all D1 action construction is reused as-is.
source=base.read_text()
geometry_marker='mesh_parts=[];deps=bpy.context.evaluated_depsgraph_get()'
weights_marker='for o in mesh_parts:\n groups={n:o.vertex_groups.new(name=n) for n in B}'
for marker in (geometry_marker,weights_marker):
    assert source.count(marker)==1, 'Base authoring insertion point changed'
source=source.replace(geometry_marker,'standard_geometry(globals())\n'+geometry_marker)
axis_marker='blade_rest_axis=(blade_part.data.vertices[6].co-(blade_part.data.vertices[0].co+blade_part.data.vertices[2].co)*.5).normalized()'
assert source.count(axis_marker)==1, 'Base blade-axis insertion point changed'
source=source.replace(axis_marker,'blade_rest_axis=standard_blade_rest_axis')
pose_marker='solve_variant_arms(name,frame)'
assert source.count(pose_marker)==1, 'Base variant pose insertion point changed'
source=source.replace(pose_marker,"standard_pike_pose(globals(),name,frame) if KIND=='pikeman' else solve_variant_arms(name,frame)")
source=source.replace("if KIND!='infantry' and name!='Death':","if KIND=='pikeman' or (KIND!='infantry' and name!='Death'):")
source=source.replace("if KIND!='cavalry' and name=='Death' and frame>=13:",
    "if KIND not in ('cavalry','pikeman') and name=='Death' and frame>=13:")
source=source.replace('for frame,pose in poses:',
    "for frame,pose in poses:\n  if KIND=='pikeman' and name=='Death' and frame in (23,30):pose=next(p for f,p in poses if f==30)")
key_marker="for pb in rig.pose.bones:pb.keyframe_insert('location',frame=frame);"
assert source.count(key_marker)==1, 'Base animation-key insertion point changed'
source=source.replace(key_marker,"if KIND=='pikeman':standard_pike_euler_continuity(globals(),name,frame)\n  "+key_marker)
source=source.replace(weights_marker,"baseline_weights_for=weights_for\ndef weights_for(n,v):\n return standard_weights(globals(),baseline_weights_for,n,v)\n"+weights_marker)
out=Path(sys.argv[sys.argv.index('--')+1])
kind=sys.argv[sys.argv.index('--kind')+1] if '--kind' in sys.argv else 'infantry'
assert kind in ('infantry','pikeman'), 'Only internally established model stages may generate'
variant_flag='--duel' if kind=='infantry' else '--pikeman-candidate'
sys.argv=[str(base),'--',str(out),'--kind',kind,variant_flag]
ctx={'__file__':str(base),'standard_geometry':standard_geometry,'standard_weights':standard_weights,
    'standard_pike_pose':standard_pike_pose,'standard_pike_euler_continuity':standard_pike_euler_continuity}
exec(compile(source,str(base),'exec'),ctx)
metadata_path=out/(kind+'-rig-metadata.json')
metadata=json.loads(metadata_path.read_text())
metadata.update(standardVersion='R2' if kind=='infantry' else 'P2',baseAuthoringSha256=hashlib.sha256(base.read_bytes()).hexdigest(),
    meshScope='continuous anatomy, layered cloth/plate, soft shoulder/elbow weights, fitted calf/ankle, readable sword edge',
    animationScope=('existing D1' if kind=='infantry' else 'existing P1')+' six clips and original 18-bone bind hierarchy')
if kind=='pikeman':
    metadata['animationScope']='P2 outboard dual-hand poses; original P1 18-bone bind and six-clip timings retained'
    metadata['pikeGripPose']={'outboardOffset':.13,'rearPullback':.06,'frontGripSlide':.10,'attackThrust':.16,'death':'new guard entry; forward hand releases during fall; shaft lies down'}
    (out/'pike-pose-checks.json').write_text(json.dumps(ctx['pike_pose_checks'],indent=2)+'\n')
    metadata['lateDeathPoseChecks']=ctx.get('pike_death_checks',[])
    metadata['eulerContinuityChecks']=ctx.get('pike_euler_checks',[])
metadata_path.write_text(json.dumps(metadata,indent=2)+'\n')
