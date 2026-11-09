import * as Track from "./preview-track.js";
import { Sensor } from "./preview-sensor.js";
import { sanityCheck } from "./pace.js";

function number(value, fallback, min, max, name) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max)
    throw Error(`${name}应在 ${min}~${max} 之间`);
  return n;
}
function seeded(value) {
  let h = 2166136261;
  for (const ch of JSON.stringify(value))
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Sensor.mulberry32(h >>> 0);
}
export function sampleRoute(points, config = {}, rules = null) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 10000)
    throw Error("路线需要 2~10000 个点");
  if (
    points.some(
      (p) =>
        !Array.isArray(p) ||
        p.length !== 2 ||
        !p.every(Number.isFinite) ||
        Math.abs(p[0]) > 85 ||
        Math.abs(p[1]) > 180,
    )
  )
    throw Error("路线坐标无效");
  const distance = Track.calcGeoDistance(points);
  if (distance < 1 || distance > 20000)
    throw Error("本地预览支持 1 米至 20 公里的路线");
  number(config.replayDelayMs, 20, 0, 5000, "回放间隔");
  const c = {
    straightSpeed: number(config.straightSpeed, 4.1, 1, 5, "直道速度"),
    curveSpeed: number(config.curveSpeed, 3.3, 0.5, 5, "弯道速度"),
    gpsIntervalMs: number(config.gpsIntervalMs, 2000, 500, 10000, "采样间隔"),
    maxAccel: number(config.maxAccel, 0.4, 0.05, 3, "最大加速度"),
    warmupTime: number(config.warmupTime, 10, 0, 60, "热身时长"),
    cooldownTime: number(config.cooldownTime, 8, 0, 60, "冷身时长"),
    cadenceSpm: number(config.cadenceSpm, 160, 100, 220, "步频"),
    sensorIntensity: number(config.sensorIntensity, 1, 0.7, 1.15, "传感器强度"),
    stepLengthM: number(config.stepLengthM, 1.5, 0.5, 3, "步长"),
  };
  const gap = Number(rules?.android_gps_max_distance ?? 0);
  if (!Number.isFinite(gap) || gap < 0)
    throw Error("学校采样规则无效，请重新读取");
  const interval = Math.max(
    0.5,
    Math.min(
      c.gpsIntervalMs / 1000,
      gap > 0 ? gap / Math.max(c.straightSpeed, c.curveSpeed, 1) : Infinity,
    ),
  );
  const rng = seeded([points, c, interval]);
  const pts = Track.generateRoute(
    points,
    c.straightSpeed,
    c.curveSpeed,
    interval,
    c.warmupTime,
    c.cooldownTime,
    { rng, maxAccel: c.maxAccel },
  );
  if (pts.length < 2) throw Error("路线过短，无法生成预览");
  return { pts, c, rng, interval, estimated: rules == null };
}
export function previewRoute(points, config = {}, rules = null) {
  const { pts, c, rng, estimated } = sampleRoute(points, config, rules);
  const distanceKm = Track.calcDistance(pts) / 1000,
    durationS = pts.at(-1).t;
  if (!(durationS > 0)) throw Error("预览时长无效");
  const avgSpeed = (distanceKm * 1000) / durationS;
  const speedCurve = [],
    stride = Math.max(1, Math.ceil((pts.length - 1) / 119));
  let cum = 0,
    minSpeed = Infinity,
    maxSpeed = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) cum += Track.calcDistance([pts[i - 1], pts[i]]);
    minSpeed = Math.min(minSpeed, pts[i].speed);
    maxSpeed = Math.max(maxSpeed, pts[i].speed);
    if (i % stride === 0 || i === pts.length - 1)
      speedCurve.push({ d: cum / 1000, v: pts[i].speed });
  }
  const sensor = Sensor.build(
    pts,
    0,
    Math.min(durationS, 120),
    c.cadenceSpm,
    c.sensorIntensity,
    { rng },
  );
  const trace = pts
    .filter((_, i) => i % Math.max(1, Math.ceil((pts.length - 1) / 399)) === 0)
    .map((p) => [p.lat, p.lng]);
  if (
    trace.at(-1)?.[0] !== pts.at(-1).lat ||
    trace.at(-1)?.[1] !== pts.at(-1).lng
  )
    trace.push([pts.at(-1).lat, pts.at(-1).lng]);
  const madEstimate = Sensor.estimateMad(c.sensorIntensity);
  return {
    status: 1,
    localOnly: true,
    estimated,
    pointCount: pts.length,
    distanceKm,
    durationS,
    avgSpeed,
    steps: Math.max(
      1,
      Math.trunc((durationS / 60) * c.cadenceSpm * (1 + (rng() - 0.5) * 0.06)),
    ),
    paceSecPerKm: 1000 / avgSpeed,
    minSpeed,
    maxSpeed,
    speedCurve,
    trace,
    sensorWave: Sensor.waveformPreview(sensor),
    sensorSelfCheck: Sensor.selfCheck(sensor),
    madEstimate,
    madStatus: Sensor.statusOf(madEstimate),
    warnings: sanityCheck(c, distanceKm, avgSpeed),
  };
}
export function simulateSensor(config = {}) {
  const intensity = number(config.intensity, 1, 0.7, 1.15, "传感器强度"),
    cadenceSpm = number(config.cadenceSpm, 160, 100, 220, "步频"),
    durationS = number(config.durationS, 90, 30, 240, "模拟时长");
  const lat = 32,
    lng = 112,
    a = 240 / 111320,
    b = a / Math.cos((lat * Math.PI) / 180);
  const rng = seeded([intensity, cadenceSpm, durationS]);
  const pts = Track.generateRoute(
    [
      [lat, lng],
      [lat + a, lng],
      [lat + a, lng + b],
      [lat, lng + b],
      [lat, lng],
    ],
    3.4,
    3,
    2,
    6,
    4,
    { rng },
  );
  const report = Sensor.selfCheck(
    Sensor.build(pts, 0, durationS, cadenceSpm, intensity, { rng }),
  );
  return {
    localOnly: true,
    intensity,
    cadenceSpm,
    durationS,
    safeRange: [0.85, 1.05],
    mad: report
      ? { ...report, status: Sensor.statusOf(report.median) }
      : { error: "样本不足" },
  };
}
