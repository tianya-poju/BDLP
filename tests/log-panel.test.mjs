import test from 'node:test';import assert from 'node:assert/strict';
class Element{constructor(){this.children=[];this.style={setProperty(){}};this.dataset={};}setAttribute(){}appendChild(el){this.children.push(el);el.parent=this;}get childElementCount(){return this.children.length;}get firstElementChild(){return this.children[0];}remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);}}
globalThis.document={createElement:()=>new Element(),createTextNode:()=>new Element()};
const {createLogPanel}=await import('../frontend/js/components.js');
test('visible log panel remains bounded while total log count increases',()=>{
 const panel=createLogPanel();for(let i=0;i<2010;i++)panel.append('entry '+i);assert.equal(panel.count,2010);assert.equal(panel.el.childElementCount,2000);
});
