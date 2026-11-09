import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {openModal} from '../frontend/js/util.js';
class Node{
 constructor(){this.children=[];this.events=new Map();this.style={};this.dataset={};}
 append(...nodes){for(const n of nodes)this.appendChild(n);}
 appendChild(n){this.children.push(n);n.parent=this;return n;}
 setAttribute(){}
 addEventListener(t,f){if(!this.events.has(t))this.events.set(t,new Set());this.events.get(t).add(f);}
 removeEventListener(t,f){this.events.get(t)?.delete(f);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
}
const source=fs.readFileSync(new URL('../frontend/desktop.js',import.meta.url),'utf8');
const start=source.indexOf('function login() {'),end=source.indexOf('app.openAddAccount = login;',start);
const eventStart=source.indexOf('.listen("login-result", async ({ payload }) => {')+'.listen("login-result", async ({ payload }) => {'.length;
const eventEnd=source.indexOf('\n  })\n  .catch',eventStart);
test('successful login closes through modal lifecycle without removing unrelated modal',async()=>{
 const doc=new Node();doc.body=new Node();doc.body.style.overflow='scroll';doc.createElement=()=>new Node();doc.createTextNode=text=>({text});globalThis.document=doc;
 let destroys=0,refreshes=0;const unrelated=openModal({});
 const factory=new Function('LoginView','openModal','h','app','logins','toast','refresh','api','show','let activeLoginView=null,loginModal=null;\n'+source.slice(start,end)+'\nreturn {login,handle:async({payload})=>{'+source.slice(eventStart,eventEnd)+'}};');
 const ui=factory(()=>({el:new Node(),destroy:()=>destroys++}),openModal,(tag,attrs,children)=>{const n=new Node();n.append(...children);return n;},{},{finish:p=>p.attemptId==='current',revision:()=>1},()=>{},async()=>refreshes++,{zoneConfig:async()=>{}},()=>{});
 ui.login();assert.equal(doc.body.children.length,2);await ui.handle({payload:{ok:true,attemptId:'stale'}});assert.equal(doc.body.children.length,2);
 await ui.handle({payload:{ok:true,attemptId:'current'}});assert.equal(destroys,1);assert.equal(doc.body.children.length,1);assert.equal(doc.events.get('keydown').size,1);assert.equal(doc.body.style.overflow,'hidden');assert.equal(refreshes,2);
 unrelated.close();assert.equal(doc.events.get('keydown').size,0);assert.equal(doc.body.style.overflow,'scroll');delete globalThis.document;
});
