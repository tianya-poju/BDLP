// Pure local preview functions recovered from supplied 1.2.0; no network or uploads.
function generateRoute(
  waypoints,
  straightSpeed = 3.3,
  curveSpeed = 2.7,
  intervalS = 1,
  warmupS = 10,
  cooldownS = 8,
  opts = {},
) {
  if (!waypoints || waypoints.length < 2) return [];
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  const meanSpeed = (straightSpeed + curveSpeed) / 2;
  const accelRaw = Number(opts.maxAccel);
  const accelLimit =
    Number.isFinite(accelRaw) && accelRaw > 0 ? accelRaw : Infinity;
  const cleaned = [];
  for (const p of waypoints) {
    if (!p) continue;
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev) {
      const dLat = (lat - prev[0]) * 111320;
      const dLng = (lng - prev[1]) * 111320 * Math.cos((lat * Math.PI) / 180);
      if (Math.hypot(dLat, dLng) < 0.5) continue;
    }
    cleaned.push([lat, lng]);
  }
  if (cleaned.length < 2) return [];
  const wp = smoothWaypoints(cleaned, 4);
  const nSeg = wp.length - 1;
  const segDist = new Array(nSeg).fill(0);
  const segHead = new Array(nSeg).fill(0);
  const cum = new Array(wp.length).fill(0);
  for (let i = 0; i < nSeg; i += 1) {
    const [lat0, lng0] = wp[i];
    const [lat1, lng1] = wp[i + 1];
    const dLatM = (lat1 - lat0) * 111320;
    const dLngM = (lng1 - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180);
    segDist[i] = Math.sqrt(dLatM * dLatM + dLngM * dLngM);
    segHead[i] = Math.atan2(dLngM, dLatM);
    cum[i + 1] = cum[i] + segDist[i];
  }
  const totalLen = cum[cum.length - 1];
  if (!(totalLen > 0)) return [];
  const paceWaves = [
    { w: (2 * Math.PI) / 211, a: 0.03, p: rng() * 2 * Math.PI },
    { w: (2 * Math.PI) / 127, a: 0.02, p: rng() * 2 * Math.PI },
    { w: (2 * Math.PI) / 53, a: 0.01, p: rng() * 2 * Math.PI },
  ];
  const fatigue = 0.02 + rng() * 0.015;
  const dips = [];
  const dipCount =
    totalLen > 1600
      ? rng() < 0.6
        ? 2
        : 1
      : totalLen > 800 && rng() < 0.65
        ? 1
        : 0;
  for (let i = 0; i < dipCount; i += 1) {
    const frac = 0.2 + (0.6 * (i + 0.5)) / dipCount + (rng() - 0.5) * 0.06;
    dips.push({
      s: totalLen * Math.min(Math.max(frac, 0.12), 0.85),
      sigma: 8 + rng() * 10,
      // 约 4~10 秒的短时减速
      depth: 0.07 + rng() * 0.08,
    });
  }
  const curves = [];
  for (let i = 1; i < wp.length - 1; i += 1) {
    let d = ((segHead[i] - segHead[i - 1]) * 180) / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    const turn = Math.abs(d);
    if (turn > 30)
      curves.push({
        s: cum[i],
        strength: Math.min(Math.max(turn / 180, 0.3), 1),
        radius: 10 + turn / 12,
      });
  }
  const speedAt = (s2, t2) => {
    let blend = 1;
    for (const c of curves) {
      const d = Math.abs(s2 - c.s);
      if (d < c.radius * 2.5) {
        const g = Math.exp(-((d / c.radius) ** 2));
        blend = Math.min(blend, 1 - c.strength * g);
      }
    }
    let speed = curveSpeed + (straightSpeed - curveSpeed) * blend;
    let drift = 1;
    for (const w of paceWaves) drift += w.a * Math.sin(w.w * t2 + w.p);
    speed *= drift;
    const prog = Math.min(Math.max(s2 / totalLen, 0), 1);
    speed *= 1 - (fatigue * Math.max(0, prog - 0.2)) / 0.8;
    for (const d of dips) {
      const dd = s2 - d.s;
      if (Math.abs(dd) < d.sigma * 3)
        speed *= 1 - d.depth * Math.exp(-(dd * dd) / (2 * d.sigma * d.sigma));
    }
    speed += gauss(rng) * 0.04;
    if (t2 < warmupS) {
      const w = t2 / warmupS;
      speed *= 0.3 + 0.7 * (w * w * (3 - 2 * w));
    }
    const cooldownZone = meanSpeed * cooldownS;
    const remain = totalLen - s2;
    if (remain < cooldownZone) {
      const c2 = Math.min(Math.max(remain / cooldownZone, 0), 1);
      speed = meanSpeed * (0.3 + 0.7 * (c2 * c2 * (3 - 2 * c2)));
    }
    return Math.min(Math.max(speed, 0.5), 5);
  };
  const latLngAt = (s2) => {
    let seg = nSeg - 1;
    for (let i = 0; i < nSeg; i += 1) {
      if (s2 <= cum[i + 1]) {
        seg = i;
        break;
      }
    }
    const frac =
      segDist[seg] <= 0
        ? 0
        : Math.min(Math.max((s2 - cum[seg]) / segDist[seg], 0), 1);
    const [lat0, lng0] = wp[seg];
    const [lat1, lng1] = wp[seg + 1];
    return [lat0 + (lat1 - lat0) * frac, lng0 + (lng1 - lng0) * frac];
  };
  const pts = [];
  const [startLat, startLng] = latLngAt(0);
  let prevSpeed = speedAt(0, 0);
  pts.push({ lat: startLat, lng: startLng, speed: trunc2(prevSpeed), t: 0 });
  let s = 0;
  let t = 0;
  let guard = 0;
  const noiseAmp = 12e-6;
  const noiseAlpha = 0.35;
  let nLat = 0;
  let nLng = 0;
  while (s < totalLen - 0.5 && guard < 1e5) {
    guard += 1;
    const targetSpeed = speedAt(s, t);
    const maxDelta = accelLimit * intervalS;
    const v =
      maxDelta === Infinity
        ? targetSpeed
        : Math.min(
            Math.max(targetSpeed, prevSpeed - maxDelta),
            prevSpeed + maxDelta,
          );
    prevSpeed = v;
    t += intervalS;
    s = Math.min(s + v * intervalS, totalLen);
    const [lat, lng] = latLngAt(s);
    nLat += ((rng() - 0.5) * 2 * noiseAmp - nLat) * noiseAlpha;
    nLng += ((rng() - 0.5) * 2 * noiseAmp - nLng) * noiseAlpha;
    pts.push({ lat: lat + nLat, lng: lng + nLng, speed: trunc2(v), t });
  }
  return pts;
}
function trunc2(v) {
  return Math.trunc(v * 100) / 100;
}
function gauss(rng = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function smoothWaypoints(wp, perSeg = 4) {
  if (wp.length < 3 || perSeg <= 0) return wp;
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    const f = (a, b, c, d) =>
      0.5 *
      (2 * b +
        (-a + c) * t +
        (2 * a - 5 * b + 4 * c - d) * t2 +
        (-a + 3 * b - 3 * c + d) * t3);
    return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
  };
  const out = [];
  const n = wp.length;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = wp[Math.max(i - 1, 0)];
    const p1 = wp[i];
    const p2 = wp[i + 1];
    const p3 = wp[Math.min(i + 2, n - 1)];
    for (let j = 0; j < perSeg; j += 1)
      out.push(cr(p0, p1, p2, p3, j / perSeg));
  }
  out.push(wp[wp.length - 1]);
  return out;
}
function calcDistance(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const dLat = (pts[i].lat - pts[i - 1].lat) * 111320;
    const dLng =
      (pts[i].lng - pts[i - 1].lng) *
      111320 *
      Math.cos((pts[i].lat * Math.PI) / 180);
    total += Math.sqrt(dLat * dLat + dLng * dLng);
  }
  return total;
}
function calcGeoDistance(pts) {
  if (pts.length < 2) return 0;
  let dist = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const dLat = (pts[i + 1][0] - pts[i][0]) * 111320;
    const dLng =
      (pts[i + 1][1] - pts[i][1]) *
      111320 *
      Math.cos((pts[i][0] * Math.PI) / 180);
    dist += Math.sqrt(dLat * dLat + dLng * dLng);
  }
  return dist;
}

export { generateRoute, calcDistance, calcGeoDistance };
