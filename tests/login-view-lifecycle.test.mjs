import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
let fixture;
globalThis.__loginView={
 logins:{cancel:()=>fixture.cancel(),start:async platform=>{fixture.starts.push(platform);return {sid:'synthetic',qrImage:'data:image/png;base64,test'};}},
 h:(tag,attrs={},children=[])=>({tag,...attrs,style:{...attrs.style},children,append(...n){this.children.push(...n);},setAttribute(){}}),
 toast(){},confirmDialog:async()=>false,api:{wechatLoginCancel:async()=>{},wechatLoginPoll:async()=>({status:'waiting'})},devicePresetSelect:()=>({}),
};
const source=fs.readFileSync(new URL('../frontend/js/views/login.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
const {LoginView}=await import('data:text/javascript,'+encodeURIComponent('const {logins,h,toast,confirmDialog,api,devicePresetSelect}=globalThis.__loginView;\n'+source));
function find(node,text){if(node?.text===text)return node;for(const child of node?.children||[]){const found=find(child,text);if(found)return found;}}
test('closing while previous authorization cancellation is pending does not start QQ or WeChat',async()=>{
 for(const text of ['获取微信二维码','打开 QQ 扫码授权']){
  let finish,count=0;fixture={starts:[],cancel:()=>++count===1?new Promise(r=>finish=r):Promise.resolve()};
  const view=LoginView({state:{devicePresets:[{}]}});const button=find(view.el,text);const pending=button.onClick({currentTarget:button});view.destroy();finish();await pending;assert.deepEqual(fixture.starts,[]);
 }
});
