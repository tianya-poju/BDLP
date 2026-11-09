// Production artifacts only. Source and user data are never used as build output.
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),source=path.join(root,'frontend'),out=path.join(root,'build/frontend');
if(path.relative(root,out)!==path.join('build','frontend'))throw Error('Unsafe output directory');
fs.mkdirSync(out,{recursive:true});
if(fs.lstatSync(out).isSymbolicLink())throw Error('Build output must not be a link');
// Clean only this verified generated directory; no application data is stored here.
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
let before=0,after=0,count=0;
function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 if(entry.isSymbolicLink())throw Error('Unexpected link in frontend');
 const file=path.join(dir,entry.name);if(entry.isDirectory()){visit(file);continue;}
 const rel=path.relative(source,file),ext=path.extname(file).slice(1);
 if(!['js','css','html','json','png','jpg','jpeg','gif','svg','woff','woff2'].includes(ext))throw Error('Unexpected production asset: '+rel);
 if(/(?:^|[\\/])(?:runner|run-worker)\.js$/.test(rel)||/\.map$/.test(rel))throw Error('Development-only asset: '+rel);
 const input=fs.readFileSync(file);let content=input;
 if(ext==='js'||ext==='css')content=Buffer.from(esbuild.transformSync(input.toString('utf8'),{loader:ext,minify:true,sourcemap:false,legalComments:'inline',target:'es2022',charset:'utf8'}).code);
 const target=path.join(out,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);before+=input.length;after+=content.length;count++;
}}
visit(source);
console.log(`Production frontend: ${count} files; ${before} -> ${after} bytes; no source maps`);
