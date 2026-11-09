"""Read-only Windows artifact checks. Requires Pillow and pefile on the build machine."""
import io,json,struct,sys
from pathlib import Path
import pefile
from PIL import Image
def verify(path):
 pe=pefile.PE(str(path));assert pe.OPTIONAL_HEADER.Subsystem==2,'Expected GUI subsystem'
 assert pe.OPTIONAL_HEADER.DATA_DIRECTORY[4].Size==0,'Unexpected signing state'
 icons=[]
 for kind in pe.DIRECTORY_ENTRY_RESOURCE.entries:
  if kind.id!=3:continue
  for item in kind.directory.entries:
   for lang in item.directory.entries:
    record=lang.data.struct;data=pe.get_data(record.OffsetToData,record.Size)
    if data.startswith(b'\x89PNG'):
     image=Image.open(io.BytesIO(data)).convert('RGBA')
    else:
     _,w,h,planes,bpp=struct.unpack_from('<IiiHH',data)
     header=struct.pack('<HHHBBBBHHII',0,1,1,w%256,(h//2)%256,0,0,planes,bpp,len(data),22)
     image=Image.open(io.BytesIO(header+data)).convert('RGBA')
    w,h=image.size;alpha=[image.getpixel(p)[3] for p in [(0,0),(w-1,0),(0,h-1),(w-1,h-1)]]
    assert alpha==[0,0,0,0],f'Nontransparent icon corners: {w}x{h}'
    icons.append([w,h])
 assert icons,'Missing embedded icons'
 assert pe.FILE_HEADER.NumberOfSymbols==0,'Unexpected COFF symbol table'
 assert not any(s.Name.startswith(b'.debug') for s in pe.sections),'Unexpected debug sections'
 pdb=[]
 for entry in getattr(pe,'DIRECTORY_ENTRY_DEBUG',[]):
  if entry.struct.Type==2 and hasattr(entry,'entry'):
   name=entry.entry.PdbFileName.decode(errors='replace').rstrip('\0')
   assert '/' not in name and '\\' not in name,'Private build path in PDB reference'
   pdb.append(name)
 return {'file':path.name,'bytes':path.stat().st_size,'machine':hex(pe.FILE_HEADER.Machine),'subsystem':'GUI','transparentIcons':icons,'COFFSymbols':0,'pdbNameReferencesOnly':pdb}
if __name__=='__main__':
 print(json.dumps([verify(Path(p)) for p in sys.argv[1:]],ensure_ascii=False,indent=2))
