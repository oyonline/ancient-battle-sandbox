"""Blender background: --python tools/generate-3d-sample.py -- OUTPUT_DIR.
Low-poly authored components; named pivot joints are animated by the browser.
"""
import bpy, math, sys
from pathlib import Path
out = Path(sys.argv[sys.argv.index('--') + 1]) if '--' in sys.argv else Path(__file__).resolve().parents[1] / 'public/assets/3d-sample'
out.mkdir(parents=True, exist_ok=True)
def material(name, color):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True; m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(*color,1); m.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.85; return m
skin=material('skin',(0.74,0.48,0.28)); metal=material('iron',(0.22,0.28,0.30)); cloth=material('team_cloth',(0.65,0.19,0.12)); wood=material('timber',(0.29,0.16,0.08)); stone=material('sandstone',(0.56,0.49,0.34)); horse=material('horse',(0.35,0.20,0.11)); dark=material('dark',(0.08,0.09,0.08))
def empty(name, loc=(0,0,0), parent=None):
    o=bpy.data.objects.new(name,None); bpy.context.collection.objects.link(o); o.location=loc; o.parent=parent; return o
def shape(name,loc,scale,mat,parent=None,kind='cube'):
    if kind=='sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4)
    elif kind=='cone': bpy.ops.mesh.primitive_cone_add(vertices=8,radius1=1,radius2=0,depth=2)
    else: bpy.ops.mesh.primitive_cube_add(size=2)
    o=bpy.context.object; o.name=name; o.parent=parent; o.location=loc; o.scale=scale; o.data.materials.append(mat); return o

def soldier(parent, z=0):
    body=empty('rider' if z else 'soldier',(0,0,z),parent)
    shape('tunic',(0,0,1.04),(.23,.16,.30),cloth,body)
    shape('breastplate',(0,-.17,1.12),(.20,.035,.21),metal,body)
    shape('head',(0,0,1.58),(.17,.15,.20),skin,body,'sphere')
    shape('helmet',(0,0,1.75),(.22,.19,.13),metal,body,'sphere')
    shape('crest',(0,.02,1.89),(.035,.17,.06),cloth,body)
    for side in [-1,1]:
        leg=empty('leg_left' if side==-1 else 'leg_right',(side*.12,0,.80),body)
        shape('leg',(0,0,-.29),(.085,.09,.28),dark,leg)
        shape('boot',(0,-.06,-.64),(.10,.16,.075),wood,leg)
        arm=empty('arm_left' if side==-1 else 'arm_right',(side*.29,0,1.30),body)
        shape('arm',(0,0,-.20),(.075,.08,.23),cloth,arm)
        shape('hand',(0,0,-.43),(.08,.08,.08),skin,arm)
        if side==1:
            shape('sword',(0,-.07,-.05),(.027,.027,.43),metal,arm)
            shape('guard',(0,-.07,-.35),(.12,.04,.025),wood,arm)
        else:
            shape('shield',(0,-.16,-.25),(.19,.055,.29),wood,arm)
            shape('shield_mark',(0,-.22,-.25),(.055,.015,.24),cloth,arm)
    return body

def export(name):
    bpy.ops.export_scene.gltf(filepath=str(out/(name+'.glb')),export_format='GLB',export_yup=True,export_animations=False)
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)

bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
root=empty('infantry'); soldier(root); export('infantry')
root=empty('cavalry')
shape('horse_body',(0,0,1.02),(.31,.65,.33),horse,root,'sphere')
neck=shape('horse_neck',(0,-.55,1.37),(.19,.20,.42),horse,root); neck.rotation_euler.x=-.35
shape('horse_head',(0,-.72,1.72),(.18,.30,.18),horse,root,'sphere')
shape('mane',(0,-.40,1.50),(.06,.22,.30),dark,root)
for side in [-1,1]:
    shape('ear',(side*.11,-.65,1.97),(.055,.055,.14),horse,root,'cone')
    for end in [-1,1]:
        leg=empty('horse_leg_'+str(side)+'_'+str(end),(side*.22,end*.42,.94),root)
        shape('horse_leg',(0,0,-.37),(.065,.07,.38),horse,leg)
        shape('hoof',(0,-.02,-.85),(.09,.13,.09),dark,leg)
shape('saddle',(0,.04,1.40),(.33,.32,.075),wood,root)
soldier(root,.91)
shape('tail',(0,.74,.88),(.08,.10,.36),dark,root)
export('cavalry')
root=empty('tower')
shape('tower_base',(0,0,.16),(1.20,1.20,.16),stone,root)
shape('tower_body',(0,0,1.50),(.94,.94,1.35),stone,root)
shape('door',(0,-.95,.73),(.28,.02,.58),wood,root)
shape('platform',(0,0,2.95),(1.15,1.15,.14),wood,root)
for x in [-.9,.9]:
    for y in [-.9,.9]: shape('pillar',(x,y,3.58),(.07,.07,.62),wood,root)
roof=shape('roof',(0,0,4.36),(1.64,1.64,.56),wood,root,'cone'); roof.rotation_euler.z=math.pi/4
for x in [-.65,0,.65]: shape('window',(x,-.95,2.16),(.10,.025,.22),dark,root)
shape('banner_pole',(1.35,0,2.5),(.035,.035,2.5),wood,root)
shape('banner',(1.75,0,4.40),(.38,.045,.48),cloth,root)
export('tower')
print('SAMPLE_GLB_EXPORT_OK',out)
