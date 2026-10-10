import bpy, math, os
from mathutils import Vector
import sys, json
from pathlib import Path
D=str(Path(sys.argv[sys.argv.index('--')+1]) if '--' in sys.argv else Path(__file__).resolve().parents[1]/'public/assets/3d-sample')
KIND=sys.argv[sys.argv.index('--kind')+1] if '--kind' in sys.argv else 'infantry'
assert KIND in ('infantry','pikeman','archer','cavalry')
ASSET_NAME='spear' if KIND=='pikeman' else KIND
Path(D).mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
# Front is negative Y. All components remain named and independently editable.
def mat(n,c,r=.8):
 m=bpy.data.materials.new(n); m.diffuse_color=(*c,1); m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*c,1); p.inputs['Roughness'].default_value=r
 if 'armour' in n or 'forged' in n:p.inputs['Metallic'].default_value=.35
 return m
red=mat('team_cloth',(.26,.034,.019));steel=mat('dark forged armour',(.18,.205,.20),.47);edge=mat('pale steel blade',(.39,.43,.41),.4);leather=mat('brown leather',(.105,.068,.033));skin=mat('skin in helmet shadow',(.40,.25,.13));dark=mat('charcoal steel mail',(.070,.080,.075),.83);visor=mat('dark eye slit',(.018,.022,.018),.9);cream=mat('ivory linen tabard',(.66,.60,.46));gold=mat('aged golden shield rim',(.40,.28,.12),.55);groundmat=mat('stage',(.255,.28,.24))
parts=[]
def finish(o,n,m):
 o.name=n; o.data.materials.append(m); parts.append(o); return o

def uv(n,loc,sc,m,seg=16,rings=10):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=seg,ring_count=rings,location=loc); o=bpy.context.object; o.scale=sc
 bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 for p in o.data.polygons:p.use_smooth=True
 return finish(o,n,m)
def loft(n,rings,m,N=16):
 vs=[]
 for z,x,y,rx,ry in rings:
  for j in range(N):
   a=2*math.pi*j/N; vs.append((x+rx*math.cos(a),y+ry*math.sin(a),z))
 fs=[tuple(reversed(range(N)))]
 for k in range(len(rings)-1):
  for j in range(N):fs.append((k*N+j,k*N+(j+1)%N,(k+1)*N+(j+1)%N,(k+1)*N+j))
 fs.append(tuple((len(rings)-1)*N+j for j in range(N)))
 me=bpy.data.meshes.new(n);me.from_pydata(vs,[],fs);me.update();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o)
 for p in me.polygons:p.use_smooth=False
 return finish(o,n,m)
def rod(n,a,b,r1,r2,m):
 d=Vector(b)-Vector(a);bpy.ops.mesh.primitive_cone_add(vertices=12,radius1=r1,radius2=r2,depth=d.length,location=(Vector(a)+Vector(b))/2);o=bpy.context.object;o.rotation_euler=d.to_track_quat('Z','Y').to_euler()
 bevel=o.modifiers.new('soft forged corners','BEVEL');bevel.width=.035;bevel.segments=2
 for p in o.data.polygons:p.use_smooth=True
 return finish(o,n,m)
def box(n,loc,sc,m,b=.04):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.scale=sc;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 mod=o.modifiers.new('rounded hand worked edge','BEVEL');mod.width=b;mod.segments=3
 o.modifiers.new('weighted surface normals','WEIGHTED_NORMAL'); return finish(o,n,m)
# Native 2D identity: adult, narrow enclosed helmet, red sleeves, ivory surcoat,
# dark articulated steel, brown fitted boots, gold-rimmed red heater shield.
for side in [-1,1]:
 x=side*.17;y=-.07 if side==1 else .065
 loft(('right' if side==1 else 'left')+' brown trouser',[(.35,x,y,.082,.102),(.78,x,y+.035,.10,.11),(1.13,x*.97,y+.02,.125,.125),(1.45,x*.85,0,.14,.14)],leather)
 loft(('right' if side==1 else 'left')+' fitted boot shaft',[(.12,x,y,.091,.108),(.40,x,y+.01,.091,.105),(.68,x,y+.028,.105,.114)],leather)
 # A sloping continuous shoe last, not a sphere or a box.
 rings=[(-.27,.075,.075),(-.22,.10,.13),(-.06,.107,.18),(.07,.089,.22)]
 vs=[]
 for dy,rx,h in rings:
  for j in range(12):
   a=math.pi*2*j/12;vs.append((x+rx*math.cos(a),y+dy,.065+h*.5+h*.5*math.sin(a)))
 fs=[]
 for k in range(len(rings)-1):
  for j in range(12):fs.append((k*12+j,k*12+(j+1)%12,(k+1)*12+(j+1)%12,(k+1)*12+j))
 fs.extend([tuple(reversed(range(12))),tuple(36+j for j in range(12))]);me=bpy.data.meshes.new('fitted shoe last');me.from_pydata(vs,[],fs);me.update();o=bpy.data.objects.new(('right' if side==1 else 'left')+' fitted boot foot',me);bpy.context.collection.objects.link(o);finish(o,o.name,leather)
 for p in me.polygons:p.use_smooth=True
 # Curved shields follow shin and knee instead of discs pasted on legs.
 def leg_shell(n,rows):
  vs=[];fs=[]
  for z,w,ry in rows:
   for j in range(11):
    ang=-math.pi/2+(j/10-.5)*2.3
    vs.append((x+w*math.cos(ang),y+ry*math.sin(ang),z))
  for k in range(len(rows)-1):
   for j in range(10):q=k*11+j;fs.append((q,q+1,q+12,q+11))
  me=bpy.data.meshes.new(n);me.from_pydata(vs,[],fs);me.update();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o);finish(o,n,steel);o.modifiers.new('forged thickness','SOLIDIFY').thickness=.012
  for p in me.polygons:p.use_smooth=True
 leg_shell(('right' if side==1 else 'left')+' fitted knee cup',[(.83,.073,.123),(.88,.114,.150),(.97,.119,.153),(1.04,.085,.127)])
 leg_shell(('right' if side==1 else 'left')+' fitted shin plate',[(.30,.083,.119),(.45,.096,.132),(.69,.109,.146),(.81,.105,.143)])
loft('dark mail hip layer',[(1.17,0,0,.285,.185),(1.52,0,0,.26,.175)],dark)
loft('red fitted tunic',[(1.42,0,0,.245,.19),(1.74,0,0,.245,.18),(2.07,0,.015,.295,.19),(2.31,0,.015,.275,.18),(2.40,0,.018,.18,.13)],red)
loft('steel torso under surcoat',[(1.59,0,-.005,.254,.204),(1.87,0,0,.283,.206),(2.16,0,.006,.301,.208),(2.29,0,0,.264,.175)],steel)
# Ivory surcoat front with a two-sided split lower hem and real cloth thickness.
def panel(n,verts,m):
 fs=[tuple(range(len(verts)))];me=bpy.data.meshes.new(n);me.from_pydata(verts,[],fs);me.update();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o);finish(o,n,m);sol=o.modifiers.new('cloth thickness','SOLIDIFY');sol.thickness=.018;be=o.modifiers.new('soft cloth edge','BEVEL');be.width=.010;be.segments=2;return o
def draped_tabard(n,front=True):
 rows=[(2.33,.15,-.176,.002),(2.16,.218,-.221,.004),(1.90,.212,-.229,.009),(1.71,.207,-.247,.002),(1.52,.219,-.236,.013),(1.30,.244,-.222,.023),(1.17,.258,-.218,.029)]
 verts=[];fs=[]
 # Separate lower halves naturally open a centre slit, upper edges meet.
 for side in [-1,1]:
  base=len(verts)
  for k,(z,w,y,amp) in enumerate(rows):
   inner=.014 if z<1.6 else 0
   for j in range(9):
    t=j/8;x=side*(inner+(w-inner)*t)
    yy=y+.063*t*t+amp*math.sin(t*math.pi*2.0+.4)
    zz=z+(.025*math.sin(t*math.pi)+(.075*(1-t) if k==len(rows)-1 else 0))
    if not front:yy=-yy-.012
    verts.append((x,yy,zz))
  for k in range(len(rows)-1):
   for j in range(8):
    q=base+k*9+j;fs.append((q,q+1,q+10,q+9))
 me=bpy.data.meshes.new(n);me.from_pydata(verts,[],fs);me.update();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o);finish(o,n,cream)
 so=o.modifiers.new('linen thickness','SOLIDIFY');so.thickness=.009
 for p in me.polygons:p.use_smooth=True
 return o
draped_tabard('ivory tabard - draped front');draped_tabard('ivory tabard - draped back',False)
loft('brown waist belt',[(1.63,0,-.007,.264,.236),(1.713,0,-.007,.262,.235)],leather)
panel('brown belt over ivory cloth',[(-.195,-.252,1.635),(.195,-.252,1.635),(.195,-.252,1.713),(-.195,-.252,1.713)],leather)
box('brass belt buckle',(.025,-.275,1.67),(.075,.025,.067),gold,.008)
# Dark mail coif and steel helmet conceal the baby-face problem entirely.
loft('mail coif - neck and jaw',[(2.27,0,.005,.18,.145),(2.40,0,.01,.18,.155),(2.58,0,0,.165,.145),(2.72,0,0,.12,.11)],dark,20)
uv('shadowed face',(0,-.085,2.63),(.13,.065,.11),skin,20,12)
loft('helmet - tall tapered steel cap',[(2.67,0,.016,.188,.169),(2.76,0,.019,.190,.175),(2.86,0,.023,.158,.150),(2.95,0,.025,.102,.100),(2.99,0,.025,.036,.04)],steel,24)
loft('helmet - forged brow band',[(2.674,0,.011,.198,.178),(2.704,0,.011,.198,.178)],edge,24)
box('helmet - dark eye opening',(0,-.184,2.651),(.240,.013,.033),visor,.006)
panel('helmet - tapered nose guard',[(-.030,-.197,2.716),(.030,-.197,2.716),(.025,-.214,2.535),(-.014,-.214,2.514)],steel)
# Cheek plates continue the enclosing helmet around the shadowed face.
for side in [-1,1]:
 panel(('left' if side<0 else 'right')+' steel cheek guard',[(side*.16,-.107,2.67),(side*.19,.04,2.69),(side*.173,.055,2.53),(side*.123,-.10,2.49)],steel)
# A thin steel ridge catches light on the helmet, matching the source silhouette.
rod('helmet central ridge',(0,-.164,2.756),(0,.026,2.995),.009,.008,edge)
# Red sleeves and layered shoulder plates, no round spherical shoulder caps.
for side in [-1,1]:
 a=Vector((side*.28,.018,2.275));b=Vector((side*.405,.0,2.10));c=Vector((side*.435,.008,1.93))
 rod(('right' if side==1 else 'left')+' red upper sleeve',a,c,.12,.118,red)
 # Overlapping curved shallow rings, angled along upper arm; two clear layers.
 direction=(c-a).normalized()
 for i in range(2):
  center=a+direction*(.075+i*.075)
  rod(('right' if side==1 else 'left')+' shoulder lamella '+str(i+1),center-direction*.038,center+direction*.038,.132-i*.005,.138-i*.005,steel)
# Left shield arm bends forward behind the shield.
rod('left sleeve lower',(-.405,0,2.10),(-.49,-.045,1.83),.114,.10,red)
rod('left forearm mail',(-.49,-.045,1.83),(-.47,-.31,1.93),.088,.065,dark)
rod('left forearm vambrace',(-.493,-.105,1.854),(-.478,-.26,1.912),.091,.075,steel)
# True shield handle behind its curved red board.
SC=Vector((-.50,-.42,1.92))
outline=[(-.20,.46),(-.11,.52),(.11,.52),(.20,.46),(.267,.24),(.239,-.13),(.15,-.34),(0,-.48),(-.15,-.34),(-.239,-.13),(-.267,.24)]
def shieldshape(n,scale,depth,m):
 verts=[(SC.x,SC.y+depth-.044,SC.z)]+[(SC.x+x*scale,SC.y+depth,SC.z+z*scale) for x,z in outline]
 fs=[(0,1+j,1+(j+1)%len(outline)) for j in range(len(outline))];me=bpy.data.meshes.new(n);me.from_pydata(verts,[],fs);me.update();o=bpy.data.objects.new(n,me);bpy.context.collection.objects.link(o);finish(o,n,m);sol=o.modifiers.new('shield board thickness','SOLIDIFY');sol.thickness=.042;sol.offset=1;be=o.modifiers.new('rounded rim','BEVEL');be.width=.009;be.segments=2;return o
shieldshape('shield - golden rim',1,0,gold);shieldshape('shield - red inset',.93,-.017,red)
rod('shield rear handle',(-.59,-.355,1.93),(-.40,-.355,1.93),.023,.023,leather)
for x in[-.59,-.40]:rod('shield handle bracket',(x,-.414,1.93),(x,-.355,1.93),.025,.025,steel)
box('left glove palm',(-.47,-.298,1.93),(.125,.06,.12),leather,.018)
for i in range(4):
 x=-.517+i*.03;rod('left curled glove finger '+str(i),(x,-.30,1.975),(x,-.383,1.953),.012,.012,leather);rod('left curled fingertip '+str(i),(x,-.383,1.953),(x,-.353,1.892),.012,.012,leather)
rod('left opposed glove thumb',(-.398,-.30,1.91),(-.426,-.375,1.962),.018,.015,leather)
# Planar painted lion, assembled from contiguous silhouettes rather than beads.
SY=-.490
lion_paths={
 'body':[(-.058,-.054),(-.070,-.011),(-.046,.050),(-.020,.100),(.021,.099),(.055,.052),(.036,.000),(.040,-.047),(.000,-.070)],
 'mane head':[(-.026,.106),(-.027,.154),(-.011,.178),(.026,.182),(.045,.170),(.075,.164),(.084,.145),(.070,.137),(.044,.143),(.031,.120),(.004,.097)],
 'raised forepaw':[(.018,.085),(.058,.100),(.092,.153),(.113,.157),(.117,.141),(.103,.125),(.083,.080),(.033,.061)],
 'lower forepaw':[(.026,.041),(.065,.055),(.109,.100),(.130,.098),(.137,.082),(.103,.063),(.078,.026),(.026,.015)],
 'right haunch':[(.010,-.039),(.059,-.057),(.073,-.104),(.099,-.110),(.103,-.129),(.067,-.129),(.048,-.096),(.022,-.090),(-.003,-.063)],
 'left haunch':[(-.047,-.044),(-.078,-.084),(-.103,-.120),(-.088,-.143),(-.053,-.142),(-.050,-.125),(-.070,-.117),(-.028,-.079)]}
for n,pts in lion_paths.items():panel('shield painted lion '+n,[(SC.x+x,SY,SC.z+z+.015) for x,z in pts],cream)
# Flat S-shaped tail on the left; no cylinders or spheres.
pts=[(-.052,-.018),(-.097,.012),(-.106,.045),(-.101,.080),(-.080,.108),(-.082,.146),(-.106,.166),(-.124,.146),(-.116,.128),(-.104,.138),(-.097,.127),(-.104,.107),(-.122,.080),(-.123,.034),(-.108,.000),(-.065,-.037)]
panel('shield painted lion curved tail',[(SC.x+x,SY,SC.z+z+.015) for x,z in pts],cream)
# A tiny red eye notch and an angular muzzle make it read as a beast.
panel('shield lion eye notch',[(SC.x+.033,SY-.012,SC.z+.173),(SC.x+.045,SY-.012,SC.z+.170),(SC.x+.038,SY-.012,SC.z+.163)],red)
# Normal right-handed grip in a consistent local basis; blade is toward index.
from mathutils import Matrix
axis=Vector((.44,-.26,.86)).normalized();back=Vector((0,1,0));back=(back-axis*back.dot(axis)).normalized();side=back.cross(axis).normalized();q=Matrix((side,back,axis)).transposed().to_quaternion();C=Vector((.565,-.27,1.83))
def H(x,y,z):return C+side*x+back*y+axis*z
elbow=Vector((.435,.015,1.815));wrist=H(-.045,.065,-.022)
rod('right red lower sleeve',(.405,0,2.10),elbow,.10,.094,red)
rod('right forearm mail',elbow,wrist,.082,.061,dark)
rod('right tapered steel vambrace',elbow+(wrist-elbow)*.15,wrist-(wrist-elbow)*.16,.087,.068,steel)
palm=box('right leather glove palm',H(0,.050,0),(.12,.057,.145),leather,.021);palm.rotation_euler=q.to_euler()
bridge=uv('right wrist glove heel',H(-.032,.052,-.011),(.060,.052,.065),leather);bridge.rotation_euler=q.to_euler()
def finger(n,pts,r):
 cu=bpy.data.curves.new(n,'CURVE');cu.dimensions='3D';cu.resolution_u=5;cu.bevel_depth=r;cu.bevel_resolution=2;cu.use_fill_caps=True;sp=cu.splines.new('BEZIER');sp.bezier_points.add(len(pts)-1)
 for b,p in zip(sp.bezier_points,pts):b.co=H(*p);b.handle_left_type='AUTO';b.handle_right_type='AUTO'
 o=bpy.data.objects.new(n,cu);bpy.context.collection.objects.link(o);bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.convert(target='MESH');finish(bpy.context.object,n,leather)
for n,z,r,k in [('little',-.055,.012,.85),('ring',-.021,.013,.95),('middle',.015,.014,1),('index',.050,.013,.94)]:finger('right glove '+n,[(.05,.039,z),(.066*k,.006,z),(.046*k,-.032,z),(.006,-.041,z),(-.020,-.023,z)],r)
finger('right glove opposing thumb',[(-.050,.035,.04),(-.062,.004,.066),(-.052,-.023,.073),(-.017,-.04,.074)],.017)
rod('sword - wrapped hilt',H(0,0,-.104),H(0,0,.116),.023,.023,leather);uv('sword - steel pommel',H(0,0,-.125),(.034,.03,.03),steel)
guard=box('sword - straight cross guard',H(0,0,.127),(.215,.048,.03),edge,.009);guard.rotation_euler=q.to_euler()
# Blade has a central ridge and thinner bevelled cutting edges.
coords=[(-.038,0,.146),(0,-.027,.146),(.038,0,.146),(-.032,0,.757),(0,-.020,.757),(.032,0,.757),(0,0,.88),(0,.024,.146),(0,.018,.757)]
coords=[(x,y,.146+(z-.146)*1.25) for x,y,z in coords]
verts=[H(*p) for p in coords];fs=[(0,1,4,3),(1,2,5,4),(3,4,6),(4,5,6),(0,3,8,7),(7,8,5,2),(3,6,8),(8,6,5),(0,7,2,1)]
me=bpy.data.meshes.new('ridged sword blade');me.from_pydata(verts,[],fs);me.update();o=bpy.data.objects.new('sword - ridged steel blade',me);bpy.context.collection.objects.link(o);finish(o,o.name,edge)
# Compact soldier stance: knee flex, broader shoulder/chest, and embedded helmet.
head_prefix=('helmet','shadowed face','left steel cheek','right steel cheek')
for o in parts:
 if o.name.startswith('shield painted lion') or o.name.startswith('shield lion eye'):
  for mod in o.modifiers:
   if mod.type=='SOLIDIFY':mod.thickness=.002
 for v in o.data.vertices:
  w=o.matrix_world @ v.co
  z=w.z
  w.x*=1.10
  if z<=1.2:
   w.z=z*.90
   w.y-=.075*math.sin(math.pi*max(0,z)/1.2)
  elif z<=2.4:
   w.z=z-.12;w.y-=.04*(z-1.2)/1.2
  else:
   w.z=2.28+(z-2.4)*.78;w.y-=.04
  if o.name.startswith(head_prefix):w.z-=.07
  v.co=o.matrix_world.inverted() @ w
# Align genuine soles with the preview ground.
for o in parts:o.location.z-=.065

# Weapon variants keep the identical adult armour identity and humanoid hierarchy.
arm_targets={}
if KIND!='infantry':
 for o in list(parts):
  if o.name.startswith(('sword','shield','right glove','right leather glove','right wrist glove','left glove','left curled','left opposed')) or 'sleeve' in o.name or 'forearm' in o.name or 'vambrace' in o.name:
   parts.remove(o);bpy.data.objects.remove(o,do_unlink=True)
 def grip(prefix,center,shaft_axis):
  global C,axis,back,side,q
  C=Vector(center);axis=Vector(shaft_axis).normalized();back=Vector((0,0,1))
  if abs(back.dot(axis))>.85:back=Vector((0,1,0))
  back=(back-axis*back.dot(axis)).normalized();side=back.cross(axis).normalized();q=Matrix((side,back,axis)).transposed().to_quaternion()
  palm=box(prefix+' glove palm',H(0,.050,0),(.12,.057,.145),leather,.018);palm.rotation_euler=q.to_euler()
  for n,z,r,k in [('little',-.055,.012,.85),('ring',-.021,.013,.95),('middle',.015,.014,1),('index',.050,.013,.94)]:finger(prefix+' glove '+n,[(.05,.039,z),(.066*k,.006,z),(.046*k,-.032,z),(.006,-.041,z),(-.020,-.023,z)],r)
  finger(prefix+' glove opposing thumb',[(-.050,.035,.04),(-.062,.004,.066),(-.052,-.023,.073),(-.017,-.04,.074)],.017)
  return C+back*.045-side*.035
 if KIND=='cavalry':
  weapon_axis=Vector((0,-1,0));rc=Vector((.58,-.34,1.75));lc=Vector((-.40,-.52,1.76))
  rw=grip('right',rc,weapon_axis);lw=grip('left',lc,(1,0,0))
  arm_targets={'R':((.50,.02,1.72),rw,rc+weapon_axis*.08),'L':((-.52,-.13,1.73),lw,lc+Vector((0,-.08,0)))}
  rod('spear cavalry lance',rc+Vector((0,.70,0)),rc+Vector((0,-2.30,0)),.029,.023,leather)
  rod('spear cavalry point',rc+Vector((0,-2.29,0)),rc+Vector((0,-2.58,0)),.068,0,edge)
 elif KIND=='pikeman':
  weapon_axis=Vector((0,-1,0));rc=Vector((.23,-.31,1.70));lc=rc+weapon_axis*.35
  rw=grip('right',rc,weapon_axis);lw=grip('left',lc,weapon_axis)
  arm_targets={'R':((.45,.01,1.72),rw,rc+weapon_axis*.08),'L':((-.23,-.35,1.83),lw,lc+weapon_axis*.08)}
  rod('spear ash shaft',rc-weapon_axis*.95,rc+weapon_axis*1.65,.024,.020,leather)
  rod('spear metal socket',rc+weapon_axis*1.53,rc+weapon_axis*1.76,.029,.024,steel)
  tip=rc+weapon_axis*2.08;base=rc+weapon_axis*1.70;cross=weapon_axis.cross(Vector((0,0,1))).normalized()
  verts=[base-cross*.075,base+cross*.075,base+Vector((0,0,.025)),base-Vector((0,0,.025)),tip]
  me=bpy.data.meshes.new('leaf spear');me.from_pydata(verts,[],[(0,2,4),(2,1,4),(1,3,4),(3,0,4),(0,3,1,2)]);me.update();o=bpy.data.objects.new('spear ridged leaf blade',me);bpy.context.collection.objects.link(o);finish(o,o.name,edge)
 else:
  lc=Vector((.10,-.78,2.16));rc=Vector((.10,-.24,2.16));weapon_axis=Vector((0,0,1));lw=grip('left',lc,weapon_axis);rw=grip('right',rc,(0,-1,0))
  arm_targets={'L':((-.45,-.34,2.07),lw,lc+Vector((0,-.08,0))),'R':((.62,-.02,2.00),rw,rc+Vector((0,-.08,0)))}
  # A continuous recurve stave and a deforming string, not a rigid sword animation.
  bow_points=[lc+Vector((0,-.13,-.65)),lc+Vector((0,-.20,-.54)),lc+Vector((0,-.10,-.28)),lc,lc+Vector((0,-.10,.28)),lc+Vector((0,-.20,.54)),lc+Vector((0,-.13,.65))]
  cu=bpy.data.curves.new('continuous recurve bow','CURVE');cu.dimensions='3D';cu.resolution_u=12;cu.bevel_depth=.027;cu.bevel_resolution=2;cu.use_fill_caps=True;sp=cu.splines.new('BEZIER');sp.bezier_points.add(len(bow_points)-1)
  for bp,pt in zip(sp.bezier_points,bow_points):bp.co=pt;bp.handle_left_type='AUTO';bp.handle_right_type='AUTO'
  o=bpy.data.objects.new('bow continuous ash stave',cu);bpy.context.collection.objects.link(o);bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.convert(target='MESH');finish(bpy.context.object,'bow continuous ash stave',leather)
  rod('bow leather grip',lc-Vector((0,0,.09)),lc+Vector((0,0,.09)),.038,.038,leather)
  # String vertices retain two anchor weights and a nock weight on the drawing hand.
  top=bow_points[-1];bottom=bow_points[0];nock=rc
  for j,(a,b) in enumerate([(bottom,nock),(nock,top)]):
   rod('string flexible '+str(j),a,b,.005,.005,cream)
  arrow_axis=(lc-rc).normalized();rod('arrow shaft',rc-arrow_axis*.08,rc+arrow_axis*.85,.009,.009,leather)
  rod('arrow steel point',rc+arrow_axis*.83,rc+arrow_axis*.94,.024,0,edge)
  for dz in [-.022,.022]:panel('arrow fletching '+str(dz),[rc-arrow_axis*.06+Vector((0,0,dz)),rc+arrow_axis*.13+Vector((0,0,dz)),rc+arrow_axis*.13],cream)
 for side_,(el,wrist_,hand_) in arm_targets.items():
  prefix='left' if side_=='L' else 'right';shoulder=Vector((-.31 if side_=='L' else .31,-.018,2.09));el=Vector(el);wrist_=Vector(wrist_)
  rod(prefix+' red upper sleeve',shoulder,el,.115,.09,red);rod(prefix+' forearm mail',el,wrist_,.082,.060,dark);rod(prefix+' forearm vambrace',el+(wrist_-el)*.20,wrist_-(wrist_-el)*.18,.085,.065,steel)

# A mounted variant has an independently articulated quadruped hierarchy.
horse_joints={}
def mounted_leg_point(v,side_):
 sign=-1 if side_=='L' else 1
 oldhip=Vector((sign*.18,.015,1.20));oldknee=Vector((sign*.187,-.01 if side_=='L' else -.145,.75));oldankle=Vector((sign*.187,.065 if side_=='L' else -.07,.16))
 newhip=Vector((sign*.22,.10,2.14));newknee=Vector((sign*.58,-.40,1.82));newankle=Vector((sign*.62,-.32,1.04))
 a,b,c,d=(oldhip,oldknee,newhip,newknee) if v.z>=.75 else (oldknee,oldankle,newknee,newankle)
 oldaxis=(b-a).normalized();newaxis=(d-c).normalized();offset=v-a;along=offset.dot(oldaxis);radial=offset-oldaxis*along
 return c+newaxis*(along*(d-c).length/(b-a).length)+oldaxis.rotation_difference(newaxis)@radial
if KIND=='cavalry':
 for o in parts:
  for v in o.data.vertices:
   w=o.matrix_world@v.co
   if any(t in o.name for t in ('trouser','boot','shin plate','knee cup')):w=mounted_leg_point(w,'L' if o.name.startswith('left') else 'R')
   else:w.z+=1
   v.co=o.matrix_world.inverted()@w
 # Reins are actually gripped; they deform between the mounted hand and the bit.
 for sign in [-1,1]:rod('horse rein '+str(sign),lc+Vector((0,0,1)),(sign*.175,-1.60,2.12),.011,.011,leather)
 # Chestnut body, flat dark mane, fitted tack share existing restrained materials.
 uv('horse body barrel',(0,.12,1.52),(.49,.97,.51),leather,20,12)
 uv('horse powerful shoulder',(0,-.48,1.54),(.44,.43,.51),leather)
 uv('horse rounded hindquarters',(0,.79,1.57),(.47,.43,.48),leather)
 rod('horse neck',(0,-.65,1.57),(0,-1.12,2.28),.32,.22,leather)
 uv('horse head',(0,-1.29,2.23),(.205,.34,.28),leather)
 uv('horse muzzle',(0,-1.53,2.08),(.175,.30,.17),leather)
 for sign in [-1,1]:
  rod('horse ear '+str(sign),(sign*.125,-1.16,2.43),(sign*.155,-1.13,2.68),.067,.025,leather)
  uv('horse eye '+str(sign),(sign*.193,-1.41,2.30),(.015,.032,.024),visor,12,8)
 rod('horse mane',(0,-.46,1.85),(0,-.95,2.37),.075,.055,dark)
 rod('horse bridle noseband',(-.175,-1.65,2.12),(.175,-1.65,2.12),.018,.018,dark)
 box('horse saddle seat',(0,.18,2.005),(.73,.65,.11),leather,.06)
 box('horse red saddle cloth',(0,.15,1.91),(.85,.83,.09),red,.04)
 rod('horse tail',(0,1.01,1.70),(0,1.42,.95),.07,.043,dark)
 for end,y in [('F',-.60),('B',.73)]:
  for side_,sign in [('L',-1),('R',1)]:
   key=end+side_;hip=Vector((sign*.30,y,1.58));knee=Vector((sign*.32,y+(.04 if end=='F' else -.27),.82));ankle=Vector((sign*.33,y+(-.07 if end=='F' else .01),.17));toe=ankle+Vector((0,-.17,-.09));horse_joints[key]=(hip,knee,ankle,toe)
   rod('horse upper leg '+key,hip,knee,.125,.079,leather);uv('horse knee '+key,knee,(.084,.088,.10),leather,12,8)
   rod('horse lower leg '+key,knee,ankle,.078,.044,leather);uv('horse fetlock '+key,ankle,(.061,.074,.071),leather,12,8)
   loft('horse hoof '+key,[(.013,sign*.33,toe.y+.065,.085,.115),(.11,sign*.33,toe.y+.078,.075,.095)],dark,12)
# Real skeletal rig. Meshes are evaluated into common world coordinates so
# rigid armour and soft cloth share one exportable deforming skin.
bpy.ops.object.select_all(action='DESELECT')
rig_data=bpy.data.armatures.new('SoldierSkeleton');rig=bpy.data.objects.new('SoldierRig',rig_data);bpy.context.collection.objects.link(rig);rig.show_in_front=True;bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
B={}
def bone(n,h,t,parent=None):
 if KIND=='cavalry' and not n.startswith('Horse') and n!='Root':
  if n.startswith(('Thigh','Shin','Foot')):h=mounted_leg_point(Vector(h),n[-1]);t=mounted_leg_point(Vector(t),n[-1])
  else:h=Vector(h)+Vector((0,0,1));t=Vector(t)+Vector((0,0,1))
 b=rig_data.edit_bones.new(n);b.head=h;b.tail=t;b.roll=0
 if parent:b.parent=B[parent]
 B[n]=b
bone('Root',(0,0,0),(0,0,.2))
bone('Hips',(0,0,1.12),(0,0,1.35),'Root')
bone('Spine',(0,0,1.35),(0,-.025,1.78),'Hips')
bone('Chest',(0,-.025,1.78),(0,-.04,2.10),'Spine')
bone('Neck',(0,-.04,2.10),(0,-.04,2.25),'Chest')
bone('Head',(0,-.04,2.25),(0,-.04,2.62),'Neck')
for side,sgn in [('L',-1),('R',1)]:
 hip=(sgn*.18,.015,1.20);knee=(sgn*.187,-.01 if side=='L' else -.145,.75);ankle=(sgn*.187,.065 if side=='L' else -.07,.16);toe=(sgn*.187,-.19 if side=='L' else -.33,.13)
 bone('Thigh.'+side,hip,knee,'Hips');bone('Shin.'+side,knee,ankle,'Thigh.'+side);bone('Foot.'+side,ankle,toe,'Shin.'+side)
 shoulder=(sgn*.31,-.018,2.09);elbow=(-.539,-.066,1.645) if side=='L' else (.479,-.006,1.63);wrist=(-.52,-.32,1.74) if side=='L' else (.578,-.23,1.64);hand=(-.55,-.39,1.76) if side=='L' else (.64,-.32,1.65)
 if side in arm_targets:elbow,wrist,hand=arm_targets[side]
 bone('UpperArm.'+side,shoulder,elbow,'Chest');bone('Forearm.'+side,elbow,wrist,'UpperArm.'+side);bone('Hand.'+side,wrist,hand,'Forearm.'+side)
if KIND=='cavalry':
 bone('HorseBody',(0,.20,1.52),(0,-.50,1.52),'Root')
 bone('HorseNeck',(0,-.65,1.57),(0,-1.12,2.28),'HorseBody');bone('HorseHead',(0,-1.12,2.28),(0,-1.56,2.10),'HorseNeck');bone('HorseTail',(0,1.01,1.70),(0,1.42,.95),'HorseBody')
 for key,(hip,knee,ankle,toe) in horse_joints.items():
  bone('HorseUpper.'+key,hip,knee,'HorseBody');bone('HorseLower.'+key,knee,ankle,'HorseUpper.'+key);bone('HorseHoof.'+key,ankle,toe,'HorseLower.'+key)
 B['Hips'].parent=B['HorseBody']
if KIND=='archer':bone('Arrow',rc,rc+arrow_axis*.25,'Hand.R')
bpy.ops.object.mode_set(mode='OBJECT')
for b in rig.pose.bones:b.rotation_mode='XYZ'
if KIND=='cavalry':
 arm_targets={k:tuple(Vector(p)+Vector((0,0,1)) for p in points) for k,points in arm_targets.items()};rc.z+=1;lc.z+=1
# Evaluate modifiers once; export geometry is compact and common-coordinate.
mesh_parts=[];deps=bpy.context.evaluated_depsgraph_get()
for old in parts:
 me=bpy.data.meshes.new_from_object(old.evaluated_get(deps),depsgraph=deps);me.transform(old.matrix_world)
 o=bpy.data.objects.new(old.name+'_skin',me);bpy.context.collection.objects.link(o);o['source_part']=old.name;mesh_parts.append(o);bpy.data.objects.remove(old,do_unlink=True)
def weights_for(n,v):
 z=v.z;side='L' if n.startswith('left') else 'R' if n.startswith('right') else 'L' if v.x<0 else 'R'
 if n.startswith('horse rein'):
  t=max(0,min(1,(v.y+1.60)/1.08));return {'Hand.L':t,'HorseHead':1-t}
 if n.startswith('horse'):
  key=n.split()[-1]
  if 'upper leg' in n or 'knee' in n:return {'HorseUpper.'+key:1}
  if 'lower leg' in n or 'fetlock' in n:return {'HorseLower.'+key:1}
  if 'hoof' in n:return {'HorseHoof.'+key:1}
  if 'head' in n or 'muzzle' in n or 'eye' in n or 'ear' in n or 'bridle' in n:return {'HorseHead':1}
  if 'neck' in n or 'mane' in n:return {'HorseNeck':1}
  if 'tail' in n:return {'HorseTail':1}
  return {'HorseBody':1}
 if n.startswith('spear'):return {'Hand.R':1}
 if n.startswith('bow'):return {'Hand.L':1}
 if n.startswith('arrow'):return {'Arrow':1}
 if n.startswith('string'):
  # The string nock is drawn by the right hand; limb tips stay on the bow hand.
  t=max(0,min(1,1-abs(z-2.16)/.65));return {'Hand.R':t,'Hand.L':1-t}
 if n.startswith(('helmet','shadowed face','left steel cheek','right steel cheek')):return {'Head':1}
 if 'mail coif' in n:return {'Neck':.3,'Head':.7}
 if n.startswith('sword') or n.startswith('right glove') or n.startswith('right leather glove') or n.startswith('right wrist glove'):return {'Hand.R':1}
 if n.startswith('shield') or n.startswith('left glove') or n.startswith('left curled') or n.startswith('left opposed'):return {'Hand.L':1}
 if 'forearm' in n or 'vambrace' in n:return {'Forearm.'+side:1}
 if 'sleeve' in n or 'shoulder lamella' in n:return {'UpperArm.'+side:1}
 if 'boot foot' in n:return {'Foot.'+side:1}
 if 'boot shaft' in n or 'shin plate' in n:return {'Shin.'+side:1}
 if 'knee cup' in n:return {'Shin.'+side:.5,'Thigh.'+side:.5}
 if 'trouser' in n:
  t=max(0,min(1,(z-.67)/.22));return {'Shin.'+side:1-t,'Thigh.'+side:t}
 if KIND=='cavalry':z-=1
 if 'tabard' in n:
  # Cloth follows torso while lower skirt softly follows hip/thigh motion.
  if z<1.28:
   t=max(0,min(.45,(1.28-z)*1.5));return {'Hips':1-t,'Thigh.'+side:t}
  t=max(0,min(1,(z-1.36)/.47));return {'Hips':(1-t)*.25,'Spine':(1-t)*.75,'Chest':t}
 if 'belt' in n or 'hip' in n:return {'Hips':1}
 if 'torso' in n or 'tunic' in n:
  t=max(0,min(1,(z-1.52)/.45));return {'Spine':1-t,'Chest':t}
 return {'Chest':1}
for o in mesh_parts:
 groups={n:o.vertex_groups.new(name=n) for n in B}
 for v in o.data.vertices:
  for n,w in weights_for(o['source_part'],v.co).items():
   if w>1e-6:groups[n].add([v.index],w,'REPLACE')
 o.parent=rig;mod=o.modifiers.new('Soldier skeletal deform','ARMATURE');mod.object=rig
component_bounds={}
for key,include in [('body',lambda n:not n.startswith(('sword','shield','spear','bow','arrow','string'))),('shield',lambda n:n.startswith('shield')),('weapon',lambda n:n.startswith(('sword','spear','bow','arrow'))),('torso',lambda n:any(x in n for x in ['torso','tunic','tabard']))]:
 verts=[v.co for o in mesh_parts if include(o['source_part']) for v in o.data.vertices]
 if not verts:continue
 component_bounds[key]={'min':[min(v[i] for v in verts) for i in range(3)],'max':[max(v[i] for v in verts) for i in range(3)]}
if KIND=='infantry':
 blade_part=next(o for o in mesh_parts if o['source_part']=='sword - ridged steel blade')
 blade_rest_axis=(blade_part.data.vertices[6].co-(blade_part.data.vertices[0].co+blade_part.data.vertices[2].co)*.5).normalized()
else:blade_rest_axis=weapon_axis
# Join all components into one mesh. Material primitives still share one skeleton,
# avoiding 73 separate skinned drawables. Named original parts stay in authoring script.
bpy.ops.object.select_all(action='DESELECT')
for o in mesh_parts:o.select_set(True)
bpy.context.view_layer.objects.active=mesh_parts[0];bpy.ops.object.join();body=bpy.context.object;body.name='SoldierSkin'
# Bake 5 in-place clips into independent Blender actions; no Empty animation.
s=bpy.context.scene;s.render.fps=24
if not rig.animation_data:rig.animation_data_create()
clips={}

def align_bone(pb,head,tail):
 rest=pb.bone.matrix_local;direction=(Vector(tail)-Vector(head)).normalized();delta=Vector(rest.to_3x3().col[1]).rotation_difference(direction);m=delta.to_matrix().to_4x4()@rest;m.translation=Vector(head);m.col[1]*=(Vector(tail)-Vector(head)).length/pb.bone.length;pb.matrix=m;bpy.context.view_layer.update()
def solve_variant_arms(action,frame):
 bpy.context.view_layer.update();chest=rig.pose.bones['Chest'];chest_delta=chest.matrix@chest.bone.matrix_local.inverted()
 thrust=0
 if action=='Attack':
  if KIND in ('pikeman','cavalry'):thrust={0:0,4:-.08,8:-.12,11:.21,16:.09,21:0}.get(frame,0)
  else:thrust={0:0,4:-.045,8:-.085,11:.10,16:.06,21:0}.get(frame,0)
 for side_ in ('R','L'):
  el,wrist_,hand_=arm_targets[side_]
  shoulder=chest_delta@rig.data.bones['UpperArm.'+side_].head_local;wrist=chest_delta@Vector(wrist_);tip=chest_delta@Vector(hand_)
  delta=Vector((0,-thrust,0)) if KIND in ('pikeman','cavalry') else Vector((0,-thrust,0)) if side_=='R' else Vector((0,0,0))
  wrist+=delta;tip+=delta
  if KIND=='pikeman' and side_=='L':
   rd=rig.pose.bones['Hand.R'].matrix@rig.data.bones['Hand.R'].matrix_local.inverted();wrist=rd@Vector(wrist_);tip=rd@Vector(hand_)
  restupper=rig.data.bones['UpperArm.'+side_];restlower=rig.data.bones['Forearm.'+side_];l1=restupper.length;l2=restlower.length
  d=wrist-shoulder;dist=min(d.length,l1+l2-.001);u=d.normalized();along=(l1*l1-l2*l2+dist*dist)/(2*dist);height=math.sqrt(max(.00001,l1*l1-along*along));pole=chest_delta@Vector(el)-shoulder;pole=(pole-u*pole.dot(u)).normalized();elbow=shoulder+u*along+pole*height
  # Keep the grip exact; at reach limit the forearm scales a few percent, rather than detaching a hand.
  align_bone(rig.pose.bones['UpperArm.'+side_],shoulder,elbow);align_bone(rig.pose.bones['Forearm.'+side_],elbow,wrist);align_bone(rig.pose.bones['Hand.'+side_],wrist,tip)
  if side_=='R':
   pb=rig.pose.bones['Hand.R'];deform=pb.matrix@pb.bone.matrix_local.inverted();center=deform@rc;axis_now=(deform.to_3x3()@Vector((0,-1,0))).normalized();delta_q=axis_now.rotation_difference(Vector((0,-1,0)));m=delta_q.to_matrix().to_4x4()@pb.matrix;m.translation=pb.matrix.translation;new_center=(m@pb.bone.matrix_local.inverted())@rc;m.translation+=center-new_center;pb.matrix=m;bpy.context.view_layer.update()


def animate_horse(action,frame):
 if action in ('Walk','Charge'):
  speed=1 if action=='Walk' else 1.5;period=24 if action=='Walk' else 18
  for key in horse_joints:
   phase=(0 if key in ('FL','BR') else math.pi) if action=='Walk' else {'FL':0,'FR':.6,'BL':math.pi,'BR':math.pi+.6}[key]
   a=math.sin(frame/period*math.tau+phase)
   rig.pose.bones['HorseUpper.'+key].rotation_euler.x=a*.37*speed
   rig.pose.bones['HorseLower.'+key].rotation_euler.x=max(0,-a)*.65
   rig.pose.bones['HorseHoof.'+key].rotation_euler.x=-a*.13
  rig.pose.bones['HorseBody'].location.z=abs(math.sin(frame/period*math.tau))*(.035 if action=='Walk' else .09)
  rig.pose.bones['HorseNeck'].rotation_euler.x=.04*math.sin(frame/period*math.tau)
  if action=='Charge':rig.pose.bones['Chest'].rotation_euler.x=.18
 elif action=='Idle':rig.pose.bones['HorseNeck'].rotation_euler.x=.025*math.sin(frame/48*math.tau)
 elif action=='Hit':rig.pose.bones['HorseNeck'].rotation_euler.x=-.15 if frame==3 else -.06 if frame==6 else 0
 elif action=='Death':
  t={0:0,5:.18,13:.65,23:.97,30:1}.get(frame,1)
  pb=rig.pose.bones['HorseBody'];rest=pb.bone.matrix_local.copy();rot=Matrix.Rotation(t*1.48,4,'Y');m=rot@rest;m.translation=rest.translation+Vector((.24*t,0,-.86*t));pb.matrix=m
  for key in horse_joints:rig.pose.bones['HorseLower.'+key].rotation_euler.x=.65*t
  rig.pose.bones['HorseNeck'].rotation_euler.x=.25*t
 bpy.context.view_layer.update()

def make_action(name,duration,poses):
 action=bpy.data.actions.new(name);action.use_fake_user=True;rig.animation_data.action=action
 for frame,pose in poses:
  for pb in rig.pose.bones:pb.location=(0,0,0);pb.rotation_euler=(0,0,0);pb.scale=(1,1,1)
  if KIND=='cavalry' and name in ('Death','Walk'):pose={}
  if KIND!='infantry' and name=='Attack':pose={'Chest':{'r':(.13 if frame==11 else -.035 if frame in (4,8) else 0,0,0)}}
  for name_,values in pose.items():
   pb=rig.pose.bones[name_]
   if 'r' in values:pb.rotation_euler=values['r']
   if 'l' in values:pb.location=values['l']
  if KIND!='infantry' and name!='Death':
   solve_variant_arms(name,frame)
   if KIND=='archer' and name=='Attack' and 11<=frame<21:
    rig.pose.bones['Arrow'].scale=(.001,.001,.001)
  if KIND=='cavalry':
   animate_horse(name,frame)
   if name!='Death':
    pb=rig.pose.bones['Hand.R'];deform=pb.matrix@pb.bone.matrix_local.inverted();center=deform@rc;now=(deform.to_3x3()@Vector((0,-1,0))).normalized();m=now.rotation_difference(Vector((0,-1,0))).to_matrix().to_4x4()@pb.matrix;m.translation=pb.matrix.translation;m.translation+=center-(m@pb.bone.matrix_local.inverted())@rc;pb.matrix=m;bpy.context.view_layer.update()
  if KIND!='cavalry' and name=='Death' and frame>=13:
   bpy.context.view_layer.update();hand=rig.pose.bones['Hand.L' if KIND=='archer' else 'Hand.R']
   current_axis=((hand.matrix @ hand.bone.matrix_local.inverted()).to_3x3() @ blade_rest_axis).normalized()
   desired=Vector((.70,-.70,.12 if frame==13 else .015)).normalized()
   delta=current_axis.rotation_difference(desired)
   target=delta.to_matrix().to_4x4() @ hand.matrix;target.translation=hand.matrix.translation
   hand.matrix=target;bpy.context.view_layer.update()
  if KIND=='archer' and name=='Death' and frame>=13:rig.pose.bones['Arrow'].scale=(.001,.001,.001)
  for pb in rig.pose.bones:pb.keyframe_insert('location',frame=frame);pb.keyframe_insert('rotation_euler',frame=frame);pb.keyframe_insert('scale',frame=frame)
 track=rig.animation_data.nla_tracks.new();track.name=name;strip=track.strips.new(name,0,action);strip.action_frame_start=0;strip.action_frame_end=round(duration*24);track.mute=True
 clips[name]={'duration':duration,'frames':round(duration*24)}
 rig.animation_data.action=None
idle=[]
for f in [0,12,24,36,48]:
 a=math.sin(f/48*math.tau);idle.append((f,{'Spine':{'r':(.018*a,0,0)},'Chest':{'r':(-.012*a,0,.008*a)},'Hips':{'l':(0,.009*a,0)}}))
make_action('Idle',2,idle)
walk=[]
for f in range(0,25,3):
 a=math.sin(f/24*math.tau);walk.append((f,{'Thigh.L':{'r':(.34*a,0,0)},'Thigh.R':{'r':(-.34*a,0,0)},'Shin.L':{'r':(max(0,-a)*.49,0,0)},'Shin.R':{'r':(max(0,a)*.49,0,0)},'Foot.L':{'r':(-.11*a,0,0)},'Foot.R':{'r':(.11*a,0,0)},'Hips':{'l':(0,abs(a)*.025,0)},'Chest':{'r':(.025,0,-.025*a)},'UpperArm.R':{'r':(-.07*a,0,0)},'UpperArm.L':{'r':(.035*a,0,0)}}))
make_action('Walk',1,walk)
make_action('Attack',.875,[(0,{}),(4,{'Chest':{'r':(0,0,-.13)},'UpperArm.R':{'r':(-.62,.10,-.15)},'Forearm.R':{'r':(-.40,0,0)}}),(8,{'Chest':{'r':(.045,0,-.08)},'UpperArm.R':{'r':(-.78,.08,-.24)},'Forearm.R':{'r':(-.42,0,0)}}),(11,{'Chest':{'r':(.13,0,.18)},'UpperArm.R':{'r':(.72,-.08,.20)},'Forearm.R':{'r':(.26,0,0)},'Hand.R':{'r':(.10,0,0)}}),(16,{'Chest':{'r':(.05,0,.07)},'UpperArm.R':{'r':(.22,0,.08)}}),(21,{})])
make_action('Hit',.417,[(0,{}),(3,{'Spine':{'r':(-.15,0,.10)},'Head':{'r':(-.12,0,0)},'UpperArm.L':{'r':(-.12,0,0)}}),(6,{'Spine':{'r':(-.07,0,.035)}}),(10,{})])
make_action('Death',1.25,[(0,{}),(5,{'Spine':{'r':(.12,0,.08)},'Thigh.L':{'r':(-.15,0,0)},'Thigh.R':{'r':(-.18,0,0)},'Shin.L':{'r':(.4,0,0)},'Shin.R':{'r':(.38,0,0)},'Hips':{'l':(0,-.15,0)}}),(13,{'Hips':{'l':(0,-.58,0),'r':(.60,0,-.15)},'Spine':{'r':(.28,0,0)},'UpperArm.R':{'r':(.65,0,.15)},'UpperArm.L':{'r':(.45,0,-.1)},'Shin.L':{'r':(.62,0,0)},'Shin.R':{'r':(.55,0,0)}}),(23,{'Hips':{'l':(0,-.91,0),'r':(1.45,0,-.20)},'Spine':{'r':(.10,0,.06)},'Head':{'r':(.15,0,0)},'UpperArm.R':{'r':(.65,0,.20)},'UpperArm.L':{'r':(.30,0,-.12)},'Shin.L':{'r':(.30,0,0)},'Shin.R':{'r':(.35,0,0)}}),(30,{'Hips':{'l':(0,-.92,0),'r':(1.50,0,-.20)},'Spine':{'r':(.10,0,.06)},'Head':{'r':(.15,0,0)},'UpperArm.R':{'r':(.65,0,.20)},'UpperArm.L':{'r':(.30,0,-.12)},'Shin.L':{'r':(.30,0,0)},'Shin.R':{'r':(.35,0,0)}})])
if KIND=='cavalry':make_action('Charge',.75,[(f,{}) for f in range(0,19,3)])
# Export NLA tracks as named clips, preserving the actual skin and bones.
rig.animation_data.action=None
for track in rig.animation_data.nla_tracks:track.mute=False
s.frame_set(0)
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);body.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=D+'/'+ASSET_NAME+'-rigged.glb',use_selection=True,export_apply=False,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_skins=True)
for track in rig.animation_data.nla_tracks:track.mute=True
# Measured neutral body bounds (exclude sword/shield group) and real mesh stats.
bounds=[v.co for v in body.data.vertices if not (v.groups and any(body.vertex_groups[g.group].name=='Hand.R' and g.weight>.99 for g in v.groups))]
metadata={'kind':KIND,'releaseSeconds':11/24 if KIND=='archer' else None,'clips':clips,'front':'Three +Z (Blender -Y)','height':max(v.co.z for v in body.data.vertices),'vertices':len(body.data.vertices),'triangles':sum(len(p.vertices)-2 for p in body.data.polygons),'bones':len(rig.pose.bones),'materials':[m.name for m in body.data.materials],'swordBladeScale':1.25 if KIND=='infantry' else None,'componentBoundsBlender':component_bounds,'bodyRadiusConservative': max(math.hypot(x,y) for x in component_bounds['body']['min'][0:1]+component_bounds['body']['max'][0:1] for y in [component_bounds['body']['min'][1],component_bounds['body']['max'][1]]),'authoring':'parameterized standalone Blender source; actual armature and vertex weights'}
Path(D+'/'+KIND+'-rig-metadata.json').write_text(json.dumps(metadata,indent=2))
bpy.ops.wm.save_as_mainfile(filepath=D+'/'+ASSET_NAME+'-rigged.blend')
print('RIGGED_SOLDIER_COMPLETE',json.dumps(metadata))
