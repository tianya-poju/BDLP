// Pure local preview functions recovered from supplied 1.2.0.
var DT_MS = 60;
var WINDOW = 180;
var SPIKE_W = 35e-4;
var DEFAULT_CADENCE_SPM = 160;
var MAD_BASELINE = 3.4;
var INTENSITY_MIN = 0.8;
var INTENSITY_MAX = 1.1;
var INTENSITY_SAFE_MIN = 0.85;
var INTENSITY_SAFE_MAX = 1.05;
var CALIB_TARGET = 3.4;
var MAD_FLOOR = 2.15;
var MAD_CEIL = 4.85;
function clampIntensity(v) {
  return Math.min(Math.max(v, INTENSITY_MIN), INTENSITY_MAX);
}
function estimateMad(intensity) {
  return MAD_BASELINE * clampIntensity(intensity);
}
function statusOf(mad) {
  if (mad > 5) return 2;
  if (mad > 2) return 1;
  if (mad < 1.5) return 0;
  return 3;
}
function gauss(rng = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mulberry32(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function rng() {
    a = (a + 1831565813) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function build(
  pts,
  startEpochMs,
  durationS,
  cadenceSpm = DEFAULT_CADENCE_SPM,
  intensity = 1,
  opts = {},
) {
  if (!pts || pts.length === 0) return "[]";
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  let gain = clampIntensity(intensity);
  let json = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    json = render(pts, startEpochMs, durationS, cadenceSpm, gain, rng);
    const range = madRange(json);
    if (!range) return json;
    const [mn, mx] = range;
    if (mn >= MAD_FLOOR && mx <= MAD_CEIL) return json;
    const mid = (mn + mx) / 2;
    if (mid < 1e-6) return json;
    gain = Math.min(Math.max(gain * (CALIB_TARGET / mid), 0.6), 1.45);
  }
  return json;
}
function render(
  pts,
  startEpochMs,
  durationS,
  cadenceSpm,
  gain,
  rng = Math.random,
) {
  const trackDur = Math.max(pts[pts.length - 1].t, 1);
  const span = Math.max(durationS, 1);
  const count = Math.max(Math.trunc((span * 1e3) / DT_MS), 51);
  const trackScale = trackDur / span;
  const baseAmp = rng() * 0.14 + 0.93;
  const driftPhase = rng() * 2 * Math.PI;
  const asymPhase = rng() * 2 * Math.PI;
  const fatigueAmt = 0.055 + rng() * 0.025;
  const wobblePhase = rng() * 2 * Math.PI;
  const fStep = Math.min(Math.max(cadenceSpm, 100), 220) / 60;
  const arr = [];
  for (let i = 0; i < count; i += 1) {
    const tSec = (i * DT_MS) / 1e3;
    const trackT = tSec * trackScale;
    const speed = Math.max(speedAt(pts, trackT), 0.8);
    const drift = 1 + 0.13 * Math.sin(2 * Math.PI * 75e-4 * tSec + driftPhase);
    const fatigue = 1 - fatigueAmt * Math.min(tSec / span, 1);
    const asym = 1 + 0.032 * Math.sin(Math.PI * fStep * tSec + asymPhase);
    const amp = (4.55 + 0.12 * speed) * gain * baseAmp * drift * fatigue * asym;
    const ph =
      2 * Math.PI * fStep * tSec +
      0.1 * Math.sin(2 * Math.PI * 0.028 * tSec + wobblePhase);
    const phb = 0.5 * ph + 0.7;
    const frac = (((ph / (2 * Math.PI)) % 1) + 1) % 1;
    const spike =
      0.62 * amp * Math.exp(-(frac * frac) / SPIKE_W) +
      0.3 * amp * Math.exp(-((frac - 0.5) ** 2 / 6e-3));
    const ay =
      9.81 +
      amp * Math.sin(ph) +
      0.42 * amp * Math.sin(2 * ph + 0.4) +
      spike +
      gauss(rng) * 0.35;
    const ax =
      1.2 * Math.sin(phb) +
      0.6 * Math.sin(ph + 1.2) +
      0.05 * amp * Math.sin(2 * Math.PI * 0.07 * tSec) +
      gauss(rng) * 0.3;
    const az =
      1.2 * Math.cos(phb + 1.1) +
      0.5 * Math.cos(ph + 2) +
      0.03 * amp * Math.cos(2 * Math.PI * 0.06 * tSec) +
      gauss(rng) * 0.28;
    const gb = 1.6 * drift * gain * fatigue * asym;
    const gx = gb * Math.sin(ph + 0.3) + gauss(rng) * 0.13;
    const gy = 0.6 * gb * Math.cos(phb) + gauss(rng) * 0.11;
    const gz = 0.8 * gb * Math.sin(phb + 1.9) + gauss(rng) * 0.12;
    const [lat, lng] = posAt(pts, trackT);
    arr.push({
      n: lng.toFixed(6),
      a: lat.toFixed(6),
      t: startEpochMs + i * DT_MS + Math.trunc(rng() * 17) - 8,
      ax: ax.toFixed(2),
      ay: ay.toFixed(2),
      az: az.toFixed(2),
      gx: gx.toFixed(2),
      gy: gy.toFixed(2),
      gz: gz.toFixed(2),
    });
  }
  return JSON.stringify(arr);
}
function madRange(json) {
  const mags = magnitudes(json);
  if (!mags || mags.length <= WINDOW) return null;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = WINDOW; i < mags.length; i += 1) {
    let mean = 0;
    for (let j = i - WINDOW; j < i; j += 1) mean += mags[j];
    mean /= WINDOW;
    let mad = 0;
    for (let j = i - WINDOW; j < i; j += 1) mad += Math.abs(mags[j] - mean);
    mad /= WINDOW;
    if (mad < mn) mn = mad;
    if (mad > mx) mx = mad;
  }
  return [mn, mx];
}
function magnitudes(json) {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((o) => {
      const x = parseFloat(o.ax) || 0;
      const y = parseFloat(o.ay) || 0;
      const z = parseFloat(o.az) || 0;
      return Math.sqrt(x * x + y * y + z * z);
    });
  } catch (_) {
    return null;
  }
}
function selfCheck(json) {
  const mags = magnitudes(json);
  if (!mags || mags.length <= WINDOW) return null;
  let s1 = 0;
  let bad = 0;
  let total = 0;
  const mads = [];
  for (let i = WINDOW; i < mags.length; i += 1) {
    let mean = 0;
    for (let j = i - WINDOW; j < i; j += 1) mean += mags[j];
    mean /= WINDOW;
    let mad = 0;
    for (let j = i - WINDOW; j < i; j += 1) mad += Math.abs(mags[j] - mean);
    mad /= WINDOW;
    mads.push(mad);
    total += 1;
    if (mad > 2 && mad <= 5) s1 += 1;
    else bad += 1;
  }
  mads.sort((a, b) => a - b);
  return {
    samples: mags.length,
    min: mads[0],
    median: mads[Math.floor(mads.length / 2)],
    max: mads[mads.length - 1],
    status1Pct: (s1 * 100) / total,
    badPct: (bad * 100) / total,
  };
}
function speedAt(pts, tSec) {
  if (tSec <= pts[0].t) return pts[0].speed;
  if (tSec >= pts[pts.length - 1].t) return pts[pts.length - 1].speed;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= tSec) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const span = b.t - a.t;
  if (!(span > 1e-6)) return a.speed;
  const k = Math.min(Math.max((tSec - a.t) / span, 0), 1);
  return a.speed + (b.speed - a.speed) * k;
}
function posAt(pts, tSec) {
  if (tSec <= pts[0].t) return [pts[0].lat, pts[0].lng];
  if (tSec >= pts[pts.length - 1].t)
    return [pts[pts.length - 1].lat, pts[pts.length - 1].lng];
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= tSec) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const span = b.t - a.t;
  if (!(span > 1e-6)) return [a.lat, a.lng];
  const k = Math.min(Math.max((tSec - a.t) / span, 0), 1);
  return [a.lat + (b.lat - a.lat) * k, a.lng + (b.lng - a.lng) * k];
}
function waveformPreview(json, samples = 50) {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.slice(0, Math.max(samples, 2)).map((s) => ({
      ax: parseFloat(s.ax),
      ay: parseFloat(s.ay) - 9.81,
      // 去掉重力，三轴同量级便于对读
      az: parseFloat(s.az),
    }));
  } catch (_) {
    return null;
  }
}
export const Sensor = {
  build,
  estimateMad,
  clampIntensity,
  statusOf,
  selfCheck,
  madRange,
  waveformPreview,
  mulberry32,
  DEFAULT_CADENCE_SPM,
  INTENSITY_MIN,
  INTENSITY_MAX,
  INTENSITY_SAFE_MIN,
  INTENSITY_SAFE_MAX,
  MAD_BASELINE,
  DT_MS,
};
