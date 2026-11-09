import test from 'node:test';import assert from 'node:assert/strict';
import {registrationClient} from '../frontend/js/face-registration-client.js';
test('window open is single-flight and early load events are retained',async()=>{
 let receive,finish,calls=0;const phases=[];
 const client=registrationClient({open:()=>{calls++;return new Promise(r=>finish=r)},listen:async cb=>{receive=cb;return()=>{}},currentAccount:()=> 'A',onStatus:p=>phases.push(p)});
 const first=client.open(),second=client.open();assert.equal(first,second);await Promise.resolve();receive({payload:{id:'w',phase:'loaded'}});finish({id:'w',phase:'loading'});await first;assert.equal(calls,1);assert.equal(phases.at(-1),'loaded');client.destroy();
});
test('old account replies, failed creation and late destroyed events do not corrupt UI',async()=>{
 let account='A',finish,receive,unlistened=false;const phases=[];
 const client=registrationClient({open:()=>new Promise(r=>finish=r),listen:async cb=>{receive=cb;return()=>unlistened=true},currentAccount:()=>account,onStatus:p=>phases.push(p)});
 const p=client.open();await Promise.resolve();account='B';finish({id:'old',phase:'loaded'});await p;assert.ok(!phases.includes('loaded'));client.destroy();receive({payload:{id:'old',phase:'timeout'}});assert.ok(unlistened);assert.ok(!phases.includes('timeout'));
 const bad=registrationClient({open:async()=>{throw Error('create failed')},listen:async()=>()=>{},currentAccount:()=>account,onStatus:p=>phases.push(p)});await assert.rejects(bad.open(),/create failed/);assert.equal(phases.at(-1),'failed');bad.destroy();
});
