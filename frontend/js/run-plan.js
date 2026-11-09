import * as Track from './preview-track.js';
import {Sensor} from './preview-sensor.js';
import {Checkin} from './run-checkin.js';
import {Face} from './run-face.js';
import {Guard} from './run-guard.js';
import {TimeWindow} from './run-timeWindow.js';
export function prepareRun(start,prepared){
 const c=start.runConfig,br=prepared.rules,ts=prepared.timestamp;
 const status=TimeWindow.evaluate(br,Number(ts.timestamp));
 if(start.mode==='campus'&&br.authStatus!=null&&Number(br.authStatus)!==2)throw Error('账号尚未通过学生认证，请在官方应用完成');
 if(start.mode==='campus'&&!status.inWindow)throw Error(status.message);
 const speed=Math.max(c.straightSpeed,c.curveSpeed,1),gap=Number(br.android_gps_max_distance)||0;
 const interval=Math.max(.5,Math.min(c.gpsIntervalMs/1000,gap>0?gap/speed:Infinity));
 const points=Track.generateRoute(start.points,c.straightSpeed,c.curveSpeed,interval,c.warmupTime,c.cooldownTime,{maxAccel:c.maxAccel});
 if(points.length<2||points.length>40000||points.at(-1).t>14400)throw Error('路线长度或采样数量超出支持范围');
 const distance=Track.calcDistance(points),duration=Math.trunc(points.at(-1).t);
 if(distance>20000)throw Error('路线不能超过20公里');
 let checkpoints=[],plan={points:[],passedCount:0,total:0},required=0;
 if(start.mode==='campus'){
  const info=br.run_line_info||{},count=Math.max(Number(info.point_num)||2,1),repeat=Number(br.repeat_num)||0;
  const available=(info.point_list||[]).filter(cp=>String(cp.is_online??1)!=='0').map(cp=>{const [lat,lng]=String(cp.jingwei).split(',').map(Number);return {id:String(cp.id??cp.point_id),lat,lng}}).filter(cp=>Number.isFinite(cp.lat)&&Number.isFinite(cp.lng));
  checkpoints=available.map(cp=>({cp,p:Checkin.build([cp],points,repeat+1)})).sort((a,b)=>b.p.passedCount-a.p.passedCount).slice(0,count).map(x=>x.cp);
  plan=Checkin.build(checkpoints,points,repeat+1);required=count*(repeat+1);
  if(plan.passedCount<required)throw Error(`路线可完成 ${plan.passedCount} 次打卡，学校要求 ${required} 次，请调整路线`);
  const effective=status.rule?{...br,min_distance:status.rule.minDistanceKm,max_distance:status.rule.maxDistanceKm,min_pace:status.rule.minPaceSec,max_pace:status.rule.maxPaceSec}:br;
  const verdict=Guard.check(effective,distance,duration,points,plan.passedCount,required,Number(ts.timestamp),Checkin.heartbeatIndices(plan,points.length,interval,Number(ts.location_septal)||60));
  if(!verdict.ok)throw Error(verdict.blockers.join('；'));
  const warn=TimeWindow.checkDistance(distance/1000,status.rule)||TimeWindow.checkDuration(status,duration,Number(ts.timestamp));if(warn)throw Error(warn);
 }
 const fc=br.run_face_verify_config||{},cum=Checkin.cumulativeDistance(points);
 const faceIdx=start.mode==='campus'?Face.toRouteIndices(Face.middleDistances(fc,status.rule?.minDistanceKm||Number(br.min_distance)||0,distance/1000),cum):[];
 if(start.mode==='campus'&&Number(fc.middle_status)===1&&!faceIdx.length)throw Error('路线不足以触发学校要求的中途核验');
 const capture=br.capture_config||{},captureOn=start.mode==='campus'&&Number(capture.capture_type)===1&&((capture.config||[]).length||Number(br.is_capture_zone)===1);
 const targets=[];if(captureOn){for(let d=1000;d<=distance;d+=1000)targets.push(d);if(!targets.length)targets.push(distance);if(!start.faceCount)throw Error('本跑区需要本人照片，请先添加');}
 const captureIdx=Face.toRouteIndices(targets,cum);
 const sensorJson=start.mode==='campus'?Sensor.build(points,0,duration,c.cadenceSpm,c.sensorIntensity):'[]';
 return {points,sensorJson,plan,faceIdx,captureIdx,heartbeats:Checkin.heartbeatIndices(plan,points.length,interval,Number(ts.location_septal)||60),rule:status.rule,distance,duration,cum};
}
