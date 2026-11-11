import test from 'node:test';
import assert from 'node:assert/strict';
import {openModal} from '../frontend/js/util.js';
class Node {
 constructor(tag){this.tag=tag;this.children=[];this.events=new Map();this.style={};this.dataset={};}
 append(...nodes){for(const n of nodes)this.appendChild(n);}
 appendChild(node){this.children.push(node);node.parent=this;return node;}
 setAttribute(){}
 addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}
 removeEventListener(type,fn){this.events.get(type)?.delete(fn);}
 emit(type,props={}){let stopped=false,prevented=false;const e={target:this,...props,preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}};for(const fn of [...(this.events.get(type)||[])]){fn(e);if(stopped)break;}return !prevented;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
}
function fixture(){const doc=new Node('document');doc.body=new Node('body');doc.body.style.overflow='scroll';doc.createElement=tag=>new Node(tag);doc.createElementNS=(_,tag)=>new Node(tag);doc.createTextNode=text=>({text});globalThis.document=doc;return doc;}
test('every close path removes its Escape listener and closes exactly once',()=>{
 for(const method of ['button','overlay','escape','programmatic']){
  const doc=fixture();let calls=0;const modal=openModal({title:'test',onClose:()=>calls++});
  assert.equal(doc.events.get('keydown').size,1);const el=modal.overlay.children[0];
  if(method==='button')el.children[0].children[1].emit('click');
  if(method==='overlay')modal.overlay.emit('click');
  if(method==='escape')assert.equal(doc.emit('keydown',{key:'Escape'}),false);
  if(method==='programmatic')modal.close();
  modal.close();doc.emit('keydown',{key:'Escape'});
  assert.equal(calls,1);assert.equal(doc.events.get('keydown').size,0);assert.equal(doc.body.style.overflow,'scroll');assert.equal(doc.body.children.length,0);
 }
 delete globalThis.document;
});
test('Escape closes only the top modal and scrolling stays locked until all close',()=>{
 const doc=fixture();const closed=[];const first=openModal({onClose:()=>closed.push('first')});const second=openModal({onClose:()=>closed.push('second')});
 doc.emit('keydown',{key:'Escape'});assert.deepEqual(closed,['second']);assert.equal(doc.body.style.overflow,'hidden');assert.equal(doc.events.get('keydown').size,1);
 doc.emit('keydown',{key:'Escape'});assert.deepEqual(closed,['second','first']);assert.equal(doc.body.style.overflow,'scroll');second.close();first.close();
 const a=openModal({}),b=openModal({});a.close();assert.equal(doc.body.style.overflow,'hidden');b.close();assert.equal(doc.body.style.overflow,'scroll');delete globalThis.document;
});
