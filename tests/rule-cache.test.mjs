import test from 'node:test';import assert from 'node:assert/strict';
let zone='a',requests=0;
globalThis.window={__TAURI__:{core:{invoke:async(cmd,{kind}={})=>{
 if(cmd==='local_state')return {account:{uid:'same'},school_id:'school',zone:{id:zone}};
 if(cmd==='network_read'&&kind==='rules'){requests++;return {data:{school_id:'school',game_id:zone,run_zone_name:zone}};}
 throw Error('Unexpected operation');
}}}};
const {api}=await import('../frontend/js/api.js');
test('school rules cache is invalidated on zone change for the same account',async()=>{
 const first=await api.zoneConfig();assert.equal(first.config.zoneId,'a');await api.zoneConfig();assert.equal(requests,1);
 zone='b';const second=await api.zoneConfig();assert.equal(second.config.zoneId,'b');assert.equal(requests,2);
});
