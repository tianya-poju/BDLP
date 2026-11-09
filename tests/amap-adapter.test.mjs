import test from 'node:test';import assert from 'node:assert/strict';
let created=[];
class Element{constructor(){this.style={};this.children=[];this.rect={width:320,height:240};}getBoundingClientRect(){return this.rect;}appendChild(x){this.children.push(x);x.parent=this;}contains(x){return this.children.includes(x);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}}
globalThis.getComputedStyle=el=>({position:el.cssPosition||el.style.position||'static'});
const observers=[];globalThis.ResizeObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(el){this.el=el;}disconnect(){this.disconnected=true;}};
globalThis.document={createElement:()=>new Element()};
class MapMock{constructor(el,options){if(el.sdkError||el.parent?.sdkError)throw Error('INVALID_USER_KEY');el.style.position='relative';this.opts=options;this.handlers={};created.push(this);queueMicrotask(()=>this.handlers.complete?.());}on(name,fn){this.handlers[name]=fn;}resize(){this.resizes=(this.resizes||0)+1;}setStatus(v){this.status=v;}setZoomAndCenter(z,p){this.center=p;}setBounds(b){this.bounds=b;}destroy(){this.dead=true;}containerToLngLat(p){return{getLat:()=>28.1,getLng:()=>112.2}}}
class Overlay{constructor(options){this.opts=options;}setMap(m){this.map=m;}}
let configurationCalls=0;
globalThis.window={__TAURI__:{core:{invoke:async cmd=>{assert.equal(cmd,'map_config');configurationCalls++;return{jsApiKey:'synthetic',securityJsCode:'synthetic'};}}},AMapLoader:{load:async options=>{assert.equal(options.version,'2.0');return{Map:MapMock,Polyline:Overlay,Polygon:Overlay,Marker:Overlay,CircleMarker:Overlay,Pixel:class{constructor(x,y){this.x=x;this.y=y;}},Bounds:class{constructor(lo,hi){this.lo=lo;this.hi=hi;}}}}}};
const {Geo,mapError}=await import('../frontend/js/amap-adapter.js');
test('official map adapter keeps GCJ latitude/longitude order and queues overlays until ready',async()=>{
 const map=Geo.map(new Element(),{center:[28,112],zoom:17});const overlay=Geo.polyline([[28,112],[28.1,112.1]],{color:'blue'}).addTo(map);await map.ready;await Promise.resolve();
 assert.deepEqual(created[0].opts.center,[112,28]);assert.deepEqual(overlay.native.opts.path,[[112,28],[112.1,28.1]]);assert.deepEqual(map.containerPointToLatLng([1,2]),{lat:28.1,lng:112.2});
 let click;map.on('click',e=>click=e.latlng);await Promise.resolve();created[0].handlers.click({lnglat:{getLat:()=>28,getLng:()=>112}});assert.deepEqual(click,{lat:28,lng:112});
 map.remove();assert.ok(created[0].dead);
});
test('destroying a queued map never mounts another live map',async()=>{
 const before=created.length;const map=Geo.map(new Element(),{});map.remove();assert.equal(await map.ready,null);assert.equal(created.length,before);assert.equal(configurationCalls,1);
});
test('SDK failures show a safe reason without echoing credentials or URL',()=>{
 for(const code of ['INVALID_USER_KEY','INVALID_USER_SCODE','INVALID_USER_DOMAIN','USERKEY_PLAT_NOMATCH','SERVICE_NOT_AVAILABLE']){const m=mapError(Error(`${code} https://example.com/?key=private`));assert.ok(m.includes(code));assert.ok(!m.includes('private'));}
 assert.ok(!mapError(Error('https://example.com/?key=private')).includes('private'));
});

const tick=()=>new Promise(r=>setTimeout(r,10));
test('absolute fill positioning is retained and a static container alone becomes relative',async()=>{
 const el=new Element();el.cssPosition='absolute';const map=Geo.map(el,{});await map.ready;assert.equal(el.style.position,undefined);assert.equal(getComputedStyle(el).position,'absolute');map.remove();
 const plain=new Element();const normal=Geo.map(plain,{});await normal.ready;assert.equal(plain.style.position,'relative');normal.remove();
});
test('zero-size containers wait for layout and resize events are cleaned on removal',async()=>{
 const el=new Element();el.rect={width:0,height:0};const before=created.length;const map=Geo.map(el,{});await tick();assert.equal(created.length,before);
 const observer=observers.at(-1);el.rect={width:400,height:300};observer.callback();const native=await map.ready;await tick();assert.ok(native);const initial=native.resizes;el.rect.width=500;observer.callback();await tick();assert.ok(native.resizes>initial);map.remove();assert.ok(observer.disconnected);
});
test('removal while waiting for dimensions resolves without constructing the SDK map',async()=>{
 const el=new Element();el.rect={width:0,height:0};const before=created.length;const map=Geo.map(el,{});const observer=observers.at(-1);map.remove();assert.equal(await map.ready,null);observer.callback();await tick();assert.equal(created.length,before);assert.ok(observer.disconnected);
});
test('initialization failure stays visible and releases observation callbacks',async()=>{
 const el=new Element();el.sdkError=true;const map=Geo.map(el,{});assert.equal(await map.ready,null);assert.ok(el.children.some(c=>c.textContent.includes('Key')));assert.equal(el.style.minHeight,'80px');assert.ok(observers.at(-1).disconnected);map.remove();
});
