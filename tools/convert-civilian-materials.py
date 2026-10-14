import struct,json,sys
from pathlib import Path
src,out=map(Path,sys.argv[1:]);raw=src.read_bytes();n=struct.unpack_from('<I',raw,12)[0];j=json.loads(raw[20:20+n]);tail=raw[20+n:]
for mat in j.get('materials',[]):
 old=mat.get('extensions',{}).pop('KHR_materials_pbrSpecularGlossiness',None)
 if old:
  mat['pbrMetallicRoughness']={'baseColorFactor':old.get('diffuseFactor',[1,1,1,1]),'metallicFactor':0,'roughnessFactor':.78}
  if 'diffuseTexture' in old:mat['pbrMetallicRoughness']['baseColorTexture']=old['diffuseTexture']
 if mat.get('alphaMode')=='BLEND':
  if any(x in mat.get('name','').lower() for x in ['hair','beard','moustache','eyelash']):mat.update(alphaMode='MASK',alphaCutoff=.45)
  else:mat['alphaMode']='OPAQUE'
for k in ['extensionsUsed','extensionsRequired']:
 if k in j:j[k]=[x for x in j[k] if x!='KHR_materials_pbrSpecularGlossiness']
js=json.dumps(j,separators=(',',':')).encode();js+=b' '*((-len(js))%4);out.write_bytes(struct.pack('<4sII',b'glTF',2,20+len(js)+len(tail))+struct.pack('<II',len(js),0x4e4f534a)+js+tail)
