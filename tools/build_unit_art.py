#!/usr/bin/env python3
"""Package the approved ImageGen sheets, without redrawing or warping poses.
One physical scale per unit, chosen from WALK body height, is reused for every
clip. Raising a weapon never makes the person smaller. Bottom-foot centroids
align frames; original pixels/alpha and articulated animation remain intact.
"""
import colorsys,json,statistics
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'tools/unit-art-v3'
DEST=ROOT/'public/assets/units'
SIZE=256
GROUND=224
BODY_HEIGHT={'axe':122,'worker':116,'medic':112}
CLIPS={'axe':['walk','attack'],'worker':['walk','build','attack','carry'],'medic':['walk','heal']}
def cells(image,rows):
 return [[image.crop((round(c*image.width/4),round(r*image.height/rows),round((c+1)*image.width/4),round((r+1)*image.height/rows))) for c in range(4)] for r in range(rows)]
def bounds(im):
 box=im.getchannel('A').point(lambda a:255 if a>32 else 0).getbbox()
 if not box:raise ValueError('Empty frame')
 return box
def recolor(im,team):
 if team=='red':return im
 out=im.copy();px=out.load()
 for y in range(out.height):
  for x in range(out.width):
   r,g,b,a=px[x,y]
   if not a:continue
   h,s,v=colorsys.rgb_to_hsv(r/255,g/255,b/255)
   if (h<=.07 or h>=.96) and s>=.38 and r>=62:
    rgb=colorsys.hsv_to_rgb(.61,min(.88,s*.92),v) if team=='blue' else colorsys.hsv_to_rgb(.68,.12,v*.52)
    px[x,y]=(*(round(c*255) for c in rgb),a)
 return out
def frame(im,scale):
 box=bounds(im);alpha=im.getchannel('A');xs=[]
 # Exclude weapons far to the right when finding soles (axe follow-through
 # can be lower than a boot). Every approved sheet keeps the torso centrally.
 left,right=round(im.width*.12),round(im.width*.70)
 central=alpha.crop((left,0,right,im.height)).getbbox()
 bottom=central[3]
 for y in range(max(central[1],bottom-12),bottom):
  for x in range(left,right):
   if alpha.getpixel((x,y))>96:xs.append(x)
 footx=statistics.mean(xs) if xs else im.width*.45
 scaled=im.resize((round(im.width*scale),round(im.height*scale)),Image.Resampling.NEAREST)
 dx=round(SIZE/2-footx*scale);dy=round(GROUND-bottom*scale)
 b=scaled.getchannel('A').getbbox()
 if dx+b[0]<0 or dx+b[2]>SIZE or dy+b[1]<0 or dy+b[3]>SIZE:raise ValueError(f'Frame clips at edge {b} {dx} {dy}')
 out=Image.new('RGBA',(SIZE,SIZE));out.alpha_composite(scaled,(dx,dy));return out
manifest_path=ROOT/'js/manifest.js';manifest=json.loads(manifest_path.read_text().split('export const MANIFEST = ',1)[1].strip().rstrip(';'))
metrics={}
for unit,clips in CLIPS.items():
 im=Image.open(SOURCE/f'{unit}.png').convert('RGBA')
 # Generated sheets contain nearly invisible background alpha dust. Preserve
 # genuine edge transparency above 32; discard only the transparent fringe.
 im.putalpha(im.getchannel('A').point(lambda a:0 if a<=32 else a))
 rows=cells(im,len(clips))
 if unit=='axe':
  # The overhead axe crosses the nominal halfway line. The actual empty
  # gutter is y=400 in the approved 887px source; retain every pose intact.
  rows=[[im.crop((round(c*im.width/4),a,round((c+1)*im.width/4),b)) for c in range(4)] for a,b in [(0,400),(400,im.height)]]
 heights=[bounds(f)[3]-bounds(f)[1] for f in rows[0]];scale=BODY_HEIGHT[unit]/statistics.median(heights)
 metrics[unit]={'scale':scale,'bodyHeight':BODY_HEIGHT[unit],'walkBodyHeights':heights,'frameSize':SIZE,'ground':GROUND,'clips':clips}
 packed={clip:[frame(f,scale) for f in frames] for clip,frames in zip(clips,rows)}
 if unit=='medic':packed['attack']=packed['heal'] # Legacy harmless animation alias.
 for team in ['red','blue','black']:
  name=f'{team}_{unit}';static=recolor(packed['walk'][0],team);static.save(DEST/f'{name}.png')
  manifest['units'][name]={'file':f'units/{name}.png','w':SIZE,'h':SIZE};manifest['anims'][name]={}
  for clip,frames in packed.items():
   strip=Image.new('RGBA',(SIZE*4,SIZE))
   for i,f in enumerate(frames):strip.alpha_composite(recolor(f,team),(SIZE*i,0))
   filename=f'anim/{name}_{clip}.png';strip.save(DEST/filename)
   manifest['anims'][name][clip]={'file':filename,'fw':SIZE,'fh':SIZE,'frames':4}
serial=json.dumps(manifest,ensure_ascii=False,indent=2)
manifest_path.write_text('// Production asset manifest; unit art packed by tools/build_unit_art.py.\nexport const MANIFEST = '+serial+';\n')
(ROOT/'public/assets/manifest.json').write_text(serial+'\n')
(SOURCE/'packing.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(json.dumps(metrics))
