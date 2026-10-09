"""Reproducible lightweight Chinese-inspired ancient battlefield assets.
Run Blender --background --factory-startup --python this_file -- OUTPUT_DIR.
Named transform joints animate in the browser; static meshes are merged per joint.
No downloaded assets or textures. Models authored parametrically in this source.
"""
import bpy, math, sys, json
from pathlib import Path
from mathutils import Vector
OUT=Path(sys.argv[sys.argv.index('--')+1]) if '--' in sys.argv else Path(__file__).resolve().parents[1]/'public/assets/3d-sample'
OUT.mkdir(parents=True,exist_ok=True)
PREVIEW=OUT/'previews'
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def mat(name,color,metal=0,rough=.7):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    return m
M={
 'skin':mat('skin',(.49,.31,.20),0,.78),'iron':mat('iron',(.16,.20,.22),.75,.4),
 'edge':mat('steel_edge',(.36,.40,.40),.8,.32),'cloth':mat('team_cloth',(.36,.055,.035)),
 'linen':mat('linen',(.33,.29,.20)),'wood':mat('timber',(.16,.075,.035)),
 'leather':mat('leather',(.085,.047,.022)),'stone':mat('sandstone',(.36,.34,.27)),
 'stone2':mat('stone_light',(.47,.44,.35)),'horse':mat('horse',(.19,.095,.047)),
 'horse2':mat('horse_muzzle',(.115,.058,.031)),'dark':mat('dark',(.021,.025,.021)),
 'brass':mat('brass',(.45,.30,.10),.65,.44),'roof':mat('roof_tiles',(.10,.135,.13)),
 'white':mat('horse_mark',(.49,.45,.35))}

def empty(name,loc=(0,0,0),parent=None):
    o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);o.parent=parent;o.location=loc;return o

def finish(o,name,loc,scale,material,parent,smooth=False):
    o.name=name;o.parent=parent;o.location=loc;o.scale=scale;o.data.materials.append(material)
    if smooth:
        for p in o.data.polygons:p.use_smooth=True
    return o

def ell(name,loc,scale,m,parent,segments=12,rings=6):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings)
    return finish(bpy.context.object,name,loc,scale,m,parent,True)

def box(name,loc,scale,m,parent,bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=2);o=finish(bpy.context.object,name,loc,scale,m,parent)
    if bevel:
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        modifier=o.modifiers.new('small_soft_edges','BEVEL');modifier.width=bevel;modifier.segments=1
        bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=modifier.name)
    return o

def taper(name,loc,r1,r2,depth,m,parent,vertices=10):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices,radius1=r1,radius2=r2,depth=depth)
    return finish(bpy.context.object,name,loc,(1,1,1),m,parent)

def line(name,a,b,r,m,parent,vertices=8,r2=None):
    a,b=Vector(a),Vector(b);d=b-a
    o=taper(name,(a+b)/2,r,r if r2 is None else r2,d.length,m,parent,vertices)
    o.rotation_euler=d.to_track_quat('Z','Y').to_euler();return o

def mesh(name,verts,faces,m,parent):
    data=bpy.data.meshes.new(name);data.from_pydata(verts,[],faces);data.update()
    o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o);o.parent=parent;o.data.materials.append(m);return o

def torso(parent,z=0):
    # Shoulders broad; waist narrower; six-sided body prevents toy box silhouette.
    verts=[]
    for h,width,depth in [(.86,.14,.10),(1.02,.17,.12),(1.38,.24,.14),(1.47,.21,.11)]:
        verts += [(-width,-depth,h),(width,-depth,h),(width,depth,h),(-width,depth,h)]
    faces=[(0,3,2,1),(12,13,14,15)]
    for i in range(3):
        for j in range(4):faces.append((i*4+j,i*4+(j+1)%4,(i+1)*4+(j+1)%4,(i+1)*4+j))
    mesh('armoured_torso',verts,faces,M['iron'],parent)
    box('waist_belt',(0,0,.97),(.175,.13,.035),M['leather'],parent,.012)
    box('belt_buckle',(0,-.145,.97),(.036,.012,.037),M['brass'],parent,.005)
    # Lamellar rows are merged into the body mesh, not separate runtime objects.
    for row in range(5):
        h=1.04+row*.071;width=.16+row*.015
        for col in range(6):
            x=(col-2.5)*width/3
            box('lamellar_scale',(x,-.133-(row/4)*.011,h),(.025,.015,.029),M['edge'] if row%2==0 else M['iron'],parent,.004)
    for side in [-1,1]:
        skirt=box('armour_skirt',(side*.14,0,.86),(.12,.135,.13),M['iron'],parent,.015);skirt.rotation_euler.y=side*.10
        box('cloth_skirt',(side*.095,-.151,.82),(.065,.016,.16),M['cloth'],parent,.008)
    ell('neck',(0,0,1.51),(.065,.065,.09),M['skin'],parent)
    # Face points forward -Y; shaped brow, nose and cheek guards.
    ell('head',(0,-.018,1.66),(.102,.105,.145),M['skin'],parent)
    box('nose',(0,-.122,1.67),(.016,.025,.031),M['skin'],parent,.009)
    for side in [-1,1]:
        box('eye',(side*.043,-.114,1.704),(.015,.004,.005),M['dark'],parent)
        guard=box('helmet_cheek',(side*.103,-.025,1.627),(.014,.084,.083),M['iron'],parent,.010)
        guard.rotation_euler.y=side*.10
    ell('helmet_dome',(0,.006,1.747),(.128,.129,.114),M['iron'],parent,16,8)
    taper('helmet_spike',(0,.005,1.858),.041,.006,.16,M['edge'],parent)
    box('helmet_brow',(0,-.111,1.743),(.103,.027,.021),M['edge'],parent,.009)
    box('nasal_guard',(0,-.131,1.693),(.012,.008,.065),M['edge'],parent,.003)
    # Small cloth tassel keeps team legible at distance without huge fantasy plume.
    tassel=ell('helmet_tassel',(0,.049,1.905),(.045,.09,.07),M['cloth'],parent,8,4);tassel.rotation_euler.x=.5
    return parent

def limb(parent,name,origin,side,arm=True,rider=False):
    pivot=empty(name,origin,parent)
    if arm:
        shoulder=ell('shoulder',(0,0,-.026),(.125,.12,.115),M['iron'],pivot)
        line('upper_arm',(0,0,-.04),(side*.025,-.018,-.26),.066,M['cloth'],pivot,r2=.055)
        ell('elbow',(side*.025,-.02,-.27),(.065,.066,.058),M['iron'],pivot)
        line('forearm',(side*.025,-.02,-.29),(side*.012,-.12,-.47),.053,M['leather'],pivot,r2=.043)
        ell('hand',(side*.01,-.13,-.49),(.045,.045,.058),M['skin'],pivot)
        # Layered shoulder strips reinforce plate silhouette.
        for row in range(3):box('shoulder_lame',(0,-.025,-.04-row*.045),(.13-row*.012,.104,.023),M['edge'],pivot,.009)
    else:
        line('thigh',(0,0,-.025),(0,.012,-.33),.080,M['linen'],pivot,r2=.058)
        ell('knee',(0,-.015,-.35),(.064,.068,.065),M['iron'],pivot)
        line('shin',(0,.01,-.38),(0,0,-.73),.055,M['leather'],pivot,r2=.044)
        box('shin_plate',(0,-.045,-.52),(.040,.021,.15),M['iron'],pivot,.013)
        ell('boot',(0,-.044,-.78),(.068,.13,.075),M['dark'],pivot)
    return pivot

def shield(parent):
    # Convex oval front; iron rim with wood field and central boss.
    n=16;verts=[(0,-.236,-.36)]
    for i in range(n):
        a=i*2*math.pi/n;verts.append((math.cos(a)*.21,-.185, -.36+math.sin(a)*.33))
    faces=[(0,i+1,(i+1)%n+1) for i in range(n)]
    mesh('convex_shield',verts,faces,M['wood'],parent)
    for i in range(n):line('shield_rim',verts[i+1],verts[(i+1)%n+1],.013,M['edge'],parent,6)
    ell('shield_boss',(0,-.244,-.36),(.057,.030,.065),M['iron'],parent)
    # Team-painted narrow field, not an entire flat square.
    box('shield_team_band',(0,-.240,-.36),(.032,.005,.24),M['cloth'],parent,.005)

def sword(parent):
    line('dao_grip',(.014,-.13,-.57),(.014,-.13,-.44),.021,M['leather'],parent)
    box('dao_guard',(.014,-.13,-.43),(.073,.032,.013),M['brass'],parent,.006)
    verts=[(-.013,-.145,-.42),(.047,-.145,-.42),(.047,-.145,.30),(.006,-.145,.43),(-.013,-.145,.30),(-.013,-.115,-.42),(.047,-.115,-.42),(.047,-.115,.30),(.006,-.115,.43),(-.013,-.115,.30)]
    faces=[(0,1,2,3,4),(9,8,7,6,5),(0,5,6,1),(1,6,7,2),(2,7,8,3),(3,8,9,4),(4,9,5,0)]
    mesh('dao_blade',verts,faces,M['edge'],parent)

def infantry():
    root=empty('infantry');body=empty('soldier',parent=root);torso(body)
    for side in [-1,1]:limb(body,'leg_left' if side==-1 else 'leg_right',(side*.095,0,.86),side,False)
    arm=limb(body,'arm_left',(-.275,0,1.37),-1);shield(arm)
    arm=limb(body,'arm_right',(.275,0,1.37),1);sword(arm)
    return root

def horse_leg(root,side,end):
    pivot=empty('horse_leg_'+str(side)+'_'+str(end),(side*.22,end*.57,1.26),root)
    knee=(side*.035,.03 if end==-1 else -.16,-.54)
    line('horse_upper_leg',(0,0,-.02),knee,.09,M['horse'],pivot,r2=.047)
    ell('horse_knee',knee,(.055,.064,.064),M['horse2'],pivot)
    ankle=(side*.035,-.005,-1.14)
    line('horse_lower_leg',knee,ankle,.040,M['horse'],pivot,r2=.030)
    ell('fetlock',ankle,(.047,.05,.053),M['horse2'],pivot)
    taper('hoof',(side*.035,-.035,-1.19),.065,.048,.12,M['dark'],pivot)

def cavalry():
    root=empty('cavalry')
    ell('horse_barrel',(0,.02,1.25),(.33,.76,.35),M['horse'],root,16,8)
    ell('horse_shoulder',(0,-.47,1.30),(.32,.34,.38),M['horse'],root)
    ell('horse_haunch',(0,.52,1.33),(.34,.34,.35),M['horse'],root)
    # Sloping neck and a long, recognizable muzzle.
    neck=ell('horse_neck',(0,-.65,1.69),(.23,.25,.52),M['horse'],root);neck.rotation_euler.x=-.48
    head=ell('horse_head',(0,-.98,2.02),(.17,.25,.22),M['horse'],root);head.rotation_euler.x=-.38
    muzzle=ell('horse_muzzle',(0,-1.17,1.88),(.15,.23,.13),M['horse2'],root);muzzle.rotation_euler.x=-.20
    for side in [-1,1]:
        ear=ell('horse_ear',(side*.105,-.91,2.25),(.045,.05,.16),M['horse'],root,8,4);ear.rotation_euler.y=side*.20
        ell('horse_eye',(side*.159,-1.03,2.071),(.013,.025,.013),M['dark'],root,8,4)
        ell('nostril',(side*.117,-1.30,1.897),(.018,.023,.014),M['dark'],root,8,4)
        for end in [-1,1]:horse_leg(root,side,end)
    for i in range(7):
        ell('mane',(0,-.43-i*.065,1.63+i*.075),(.069,.090,.11),M['dark'],root,8,4)
    line('tail_base',(0,.77,1.36),(0,1.0,1.12),.056,M['dark'],root)
    ell('tail',(0,1.06,.90),(.08,.09,.29),M['dark'],root,10,5)
    # Blanket, saddle, girth, bridle and reins share merged static body mesh.
    ell('saddle_blanket',(0,.07,1.48),(.37,.38,.16),M['cloth'],root)
    box('saddle_seat',(0,.09,1.61),(.23,.27,.05),M['leather'],root,.03)
    for y in [-.22,.37]:ell('saddle_rise',(0,y,1.65),(.23,.07,.10),M['leather'],root)
    for side in [-1,1]:
        line('girth',(side*.325,-.12,1.46),(side*.27,-.12,1.0),.019,M['leather'],root)
        line('bridle_cheek',(side*.173,-.96,2.12),(side*.15,-1.24,1.88),.012,M['leather'],root)
        line('bridle_nose',(side*.15,-1.24,1.88),(0,-1.37,1.86),.014,M['leather'],root)
        line('rein',(side*.15,-1.23,1.9),(side*.17,-.14,2.03),.009,M['leather'],root,6)
    rider=empty('rider',(0,.08,.87),root);torso(rider)
    # Bent riding legs keep heels alongside the horse; no walking leg joints.
    for side in [-1,1]:
        line('rider_thigh',(side*.1,0,.88),(side*.37,-.20,.67),.075,M['linen'],rider,r2=.061)
        ell('rider_knee',(side*.37,-.20,.67),(.065,.065,.063),M['iron'],rider)
        line('rider_shin',(side*.37,-.20,.67),(side*.37,-.12,.29),.05,M['leather'],rider,r2=.038)
        ell('rider_boot',(side*.37,-.18,.27),(.064,.13,.07),M['dark'],rider)
        line('stirrup_leather',(side*.30,.12,.83),(side*.37,-.12,.24),.012,M['leather'],rider,6)
        line('stirrup',(side*.32,-.12,.22),(side*.42,-.12,.22),.012,M['edge'],rider,6)
    limb(rider,'rider_rein_arm',(-.275,0,1.37),-1)
    arm=limb(rider,'arm_right',(.275,0,1.37),1)
    # Long lance visibly separates cavalry silhouette from shield infantry.
    line('lance_shaft',(.02,-.13,-.92),(.02,-.13,1.32),.018,M['wood'],arm,8)
    taper('lance_tip',(.02,-.13,1.47),.050,0,.31,M['edge'],arm,8)
    pennant=mesh('lance_pennant',[(.04,-.13,1.20),(.04,-.13,.93),(.36,-.13,1.09)],[(0,1,2)],M['cloth'],arm)
    return root

def hip_roof(root,z,width,depth,height):
    # Four pitched roof faces and extended turned eaves rather than a cone.
    verts=[(-width,-depth,z),(width,-depth,z),(width,depth,z),(-width,depth,z),(-width*.44,0,z+height),(width*.44,0,z+height)]
    mesh('hip_roof',verts,[(0,1,5,4),(1,2,5),(2,3,4,5),(3,0,4)],M['roof'],root)
    for i in range(4):line('eave',verts[i],verts[(i+1)%4],.055,M['wood'],root)
    line('ridge',verts[4],verts[5],.07,M['roof'],root)
    # Thin long raised tile strips read as roof texture without image textures.
    ridge_width=width*.44
    # Ribs follow each actual pitched face, raised clear of its surface.
    for i in range(9):
        x=-ridge_width+2*ridge_width*i/8
        for side in [-1,1]:line('tile_rib',(x,side*depth,z+.032),(x,0,z+height+.032),.012,M['roof'],root,6)
    for side in [-1,1]:
        for i in range(9):
            y=-depth+2*depth*i/8
            line('hip_tile_rib',(side*width,y,z+.032),(side*ridge_width,0,z+height+.032),.012,M['roof'],root,6)

def tower():
    root=empty('tower')
    box('stone_foundation',(0,0,.13),(1.23,1.23,.13),M['stone'],root,.045)
    verts=[]
    for z,w in [(.24,1.09),(2.70,.86)]:verts.extend([(-w,-w,z),(w,-w,z),(w,w,z),(-w,w,z)])
    mesh('tapered_stone_wall',verts,[(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],M['stone'],root)
    # Mortar courses and quoins provide stone scale cues.
    for h in [.54,.95,1.36,1.77,2.18,2.58]:
        w=1.09-(h-.24)/2.46*.23
        for side in [-1,1]:
            line('stone_course',(-w,side*w,h),(w,side*w,h),.009,M['stone2'],root,6)
            line('stone_course',(side*w,-w,h),(side*w,w,h),.009,M['stone2'],root,6)
    box('door',(0,-1.06,.88),(.30,.025,.59),M['wood'],root,.018)
    for x in [-.32,.32]:box('door_frame',(x,-1.074,.9),(.045,.04,.65),M['stone2'],root,.01)
    box('door_lintel',(0,-1.074,1.54),(.38,.06,.06),M['stone2'],root,.012)
    for x in [-.15,.15]:line('door_iron', (x,-1.10,.48),(x,-1.10,1.37),.008,M['iron'],root)
    for x in [-.59,0,.59]:box('arrow_slit',(x,-.89,2.10),(.045,.02,.20),M['dark'],root,.009)
    box('timber_floor',(0,0,2.78),(1.12,1.12,.09),M['wood'],root,.02)
    for x in [-.88,.88]:
        for y in [-.88,.88]:line('post',(x,y,2.86),(x,y,4.10),.07,M['wood'],root)
    for side in [-1,1]:
        for h in [3.05,3.42,3.96]:
            line('crossbeam',(-.95,side*.91,h),(.95,side*.91,h),.035,M['wood'],root)
            line('crossbeam',(side*.91,-.95,h),(side*.91,.95,h),.035,M['wood'],root)
        for i in range(7):
            t=-.75+i*.25
            line('railing',(t,side*.92,3.02),(t,side*.92,3.43),.016,M['wood'],root,6)
            line('railing',(side*.92,t,3.02),(side*.92,t,3.43),.016,M['wood'],root,6)
    hip_roof(root,4.06,1.39,1.30,.72)
    line('flagpole',(1.34,.20,.15),(1.34,.20,4.5),.027,M['wood'],root)
    mesh('banner',[(1.34,.20,4.3),(2.03,.17,4.23),(1.94,.15,3.42),(1.34,.20,3.5)],[(0,1,2,3)],M['cloth'],root)
    return root

def merge_static_meshes():
    groups={}
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH':groups.setdefault(o.parent,[]).append(o)
    for parent,objects in groups.items():
        if len(objects)<2:continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();objects[0].name='geometry_'+(parent.name if parent else 'asset')

ASSETS=[]
METADATA={}
def bounds_of(objects):
    bpy.context.view_layer.update()
    points=[o.matrix_world@Vector(c) for o in objects if o.type=='MESH' for c in o.bound_box]
    lo=[min(v[i] for v in points) for i in range(3)];hi=[max(v[i] for v in points) for i in range(3)]
    return {'blender_min':lo,'blender_max':hi,'three_min':[lo[0],lo[2],-hi[1]],'three_max':[hi[0],hi[2],-lo[1]],'planar_size':[hi[0]-lo[0],hi[1]-lo[1]]}
for name,builder in [('infantry',infantry),('cavalry',cavalry),('tower',tower)]:
    root=builder()
    raw=list(root.children_recursive)
    METADATA[name]={'whole_asset':bounds_of(raw)}
    if name=='infantry':METADATA[name]['torso']=bounds_of([o for o in raw if o.name.startswith('armoured_torso')])
    if name=='cavalry':
        horse_parts=[o for o in raw if o.type=='MESH' and o.name.startswith(('horse_','mane','tail','hoof','fetlock','saddle','girth','bridle','rein'))]
        METADATA[name]['horse_and_tack_without_rider_lance']=bounds_of(horse_parts)
        METADATA[name]['horse_body_without_legs']=bounds_of([o for o in raw if o.type=='MESH' and o.name.startswith(('horse_barrel','horse_shoulder','horse_haunch','horse_neck','horse_head','horse_muzzle'))])
    merge_static_meshes()
    # Export only authored model objects. Preview lights/camera never enter GLB.
    bpy.ops.object.select_all(action='DESELECT')
    model=[root]+list(root.children_recursive)
    for o in model:o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_animations=False)
    polys=sum(len(o.data.polygons) for o in model if o.type=='MESH')
    ASSETS.append((name,root));print('MODEL_EXPORT_OK',name,'polygons',polys)
    for o in model:o.hide_set(True);o.hide_render=True

(OUT/'asset-metadata.json').write_text(json.dumps(METADATA,indent=2))

if '--no-previews' in sys.argv:
    print('SAMPLE_GLB_EXPORT_OK',OUT)
    sys.exit(0)

PREVIEW.mkdir(parents=True,exist_ok=True)

# Preview setup: neutral studio contact shadows, close and fixed angle views.
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=24
scene.render.resolution_x=1200;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.world.color=(.22,.22,.22)
scene.view_settings.view_transform='AgX'
def look(obj,point):obj.rotation_euler=(Vector(point)-obj.location).to_track_quat('-Z','Y').to_euler()
def area(name,loc,power,size):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;o=bpy.data.objects.new(name,data);scene.collection.objects.link(o);o.location=loc;look(o,(0,0,1.2))
area('key',(-3,-4,7),800,5);area('fill',(5,-2,4),400,4);area('rim',(1,5,6),650,3)
cdata=bpy.data.cameras.new('preview');cam=bpy.data.objects.new('preview',cdata);scene.collection.objects.link(cam);scene.camera=cam;cdata.type='ORTHO'
ground=box('preview_floor',(0,0,-.10),(200,200,.09),mat('preview_ground',(.12,.15,.12)),None)
for name,root in ASSETS:
    for o in [root]+list(root.children_recursive):o.hide_set(False);o.hide_render=False
    bpy.context.view_layer.update()
    corners=[o.matrix_world@Vector(c) for o in [root]+list(root.children_recursive) if o.type=='MESH' for c in o.bound_box]
    low=Vector(tuple(min(v[a] for v in corners) for a in range(3)));high=Vector(tuple(max(v[a] for v in corners) for a in range(3)));center=(low+high)/2
    print('MODEL_WORLD_BOUNDS',name,tuple(low),tuple(high))
    for view,loc in [('close',(4,-6,3.4 if name!='tower' else 5)),('isometric',(5,-7,8))]:
        cam.location=loc;look(cam,center);bpy.context.view_layer.update()
        local=[cam.matrix_world.inverted()@v for v in corners]
        width=max(v.x for v in local)-min(v.x for v in local);height=max(v.y for v in local)-min(v.y for v in local)
        aspect=scene.render.resolution_x/scene.render.resolution_y;cdata.ortho_scale=max(width,height*aspect)*1.18
        scene.render.filepath=str(PREVIEW/(name+'-'+view+'.png'));bpy.ops.render.render(write_still=True)
    for o in [root]+list(root.children_recursive):o.hide_set(True);o.hide_render=True
print('SAMPLE_GLB_EXPORT_OK',OUT)
