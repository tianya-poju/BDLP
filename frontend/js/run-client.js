import {calculatePreview} from './preview-client.js';
import {invoke} from './ipc.js';
let opening=false;
function previewImage(points){
 const canvas=document.createElement('canvas');canvas.width=720;canvas.height=720;const c=canvas.getContext('2d');
 c.fillStyle='#f2f3f7';c.fillRect(0,0,720,720);c.strokeStyle='#4676ff';c.lineWidth=5;c.lineJoin='round';
 const lat=points.map(p=>p[0]),lng=points.map(p=>p[1]);const lo=[Math.min(...lat),Math.min(...lng)],hi=[Math.max(...lat),Math.max(...lng)];
 const center=(lo[0]+hi[0])/2,ratio=Math.cos(center*Math.PI/180);const w=(hi[1]-lo[1])*ratio,h=hi[0]-lo[0],scale=620/Math.max(w,h,1e-6);
 const xy=p=>[360+(p[1]-(lo[1]+hi[1])/2)*ratio*scale,360-(p[0]-center)*scale];
 c.beginPath();points.forEach((p,i)=>{const [x,y]=xy(p);i?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();
 for(const [p,color]of [[points[0],'#22c55e'],[points.at(-1),'#ef4444']]){const [x,y]=xy(p);c.beginPath();c.arc(x,y,7,0,2*Math.PI);c.fillStyle=color;c.fill();}
 return canvas.toDataURL('image/png');
}
export async function startRun({mode,uid}){
 if(opening)throw Error('正在创建任务');opening=true;let id;
 try{
   const start=await invoke('run_open',{mode,uid});id=start.jobId;
   const prepared=await invoke('run_prepare',{id});
   const plan=await calculatePreview('run',start,prepared);
   plan.previewPng=previewImage(start.points);
   await invoke('run_execute',{id,plan});
   return {jobId:id,mode};
 }catch(e){if(id)await invoke('run_action',{id,action:'fail',args:{error:String(e)}}).catch(()=>{});throw e;}
 finally{opening=false;}
}
export function cancelRun(id){return invoke('run_cancel',{id});}
export function subscribeRun(id,{onLog,onDone,onFaceRequest}){
 let stopped=false,offset=0,busy=false,lastFace='',unlisten=null;
 const poll=async()=>{
   if(stopped||busy)return;busy=true;
   try{const state=await invoke('run_status',{id});if(stopped)return;
     const start=Number(state.logStart)||0;const from=Math.max(0,offset-start);for(const msg of state.logs.slice(from))onLog?.({msg});offset=start+state.logs.length;
     if(state.awaiting?.url&&String(state.awaiting.startTime)!==lastFace){lastFace=String(state.awaiting.startTime);onFaceRequest?.(state.awaiting);}
     if(!['running','submitting','submitted'].includes(state.status)){stopped=true;clearInterval(timer);unlisten?.();onDone?.(state);}
   }catch(e){if(!stopped){stopped=true;clearInterval(timer);unlisten?.();onDone?.({status:'failed',error:String(e)});}}
   finally{busy=false;}
 };
 const timer=setInterval(poll,600);window.__TAURI__?.event?.listen('job-updated',({payload})=>{if(payload===id)poll()}).then(fn=>{if(stopped)fn();else unlisten=fn;}).catch(()=>{});poll();return()=>{stopped=true;clearInterval(timer);unlisten?.();};
}
