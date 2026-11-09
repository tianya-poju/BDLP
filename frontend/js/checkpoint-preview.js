import { sampleRoute } from "./preview-core.js";
import { Checkin } from "./run-checkin.js";
function inside(p, fence) {
  let hit = false;
  for (let i = 0, j = fence.length - 1; i < fence.length; j = i++) {
    const a = fence[i],
      b = fence[j];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (
      Math.abs(cross) < 1e-10 &&
      p[0] >= Math.min(a[0], b[0]) - 1e-10 &&
      p[0] <= Math.max(a[0], b[0]) + 1e-10 &&
      p[1] >= Math.min(a[1], b[1]) - 1e-10 &&
      p[1] <= Math.max(a[1], b[1]) + 1e-10
    )
      return true;
    if (
      a[0] > p[0] !== b[0] > p[0] &&
      p[1] < ((b[1] - a[1]) * (p[0] - a[0])) / (b[0] - a[0]) + a[1]
    )
      hit = !hit;
  }
  return hit;
}
export function segmentInside(a, b, fence) {
  if (!inside(a, fence) || !inside(b, fence)) return false;
  const r = [b[0] - a[0], b[1] - a[1]],
    ts = [0, 1];
  for (let i = 0; i < fence.length; i++) {
    const c = fence[i],
      e = fence[(i + 1) % fence.length],
      s = [e[0] - c[0], e[1] - c[1]],
      q = [c[0] - a[0], c[1] - a[1]],
      den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) > 1e-15) {
      const t = (q[0] * s[1] - q[1] * s[0]) / den,
        u = (q[0] * r[1] - q[1] * r[0]) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
    } else
      for (const p of [c, e]) {
        if (Math.abs(r[0] * (p[1] - a[1]) - r[1] * (p[0] - a[0])) < 1e-10) {
          const axis = Math.abs(r[0]) > Math.abs(r[1]) ? 0 : 1,
            t = (p[axis] - a[axis]) / r[axis];
          if (t > 0 && t < 1) ts.push(t);
        }
      }
  }
  ts.sort((x, y) => x - y);
  return ts.slice(1).every((t, i) => {
    const mid = (t + ts[i]) / 2;
    return inside([a[0] + mid * r[0], a[1] + mid * r[1]], fence);
  });
}
export function verifyCheckpointPreview(
  points,
  order,
  coverage,
  fence = [],
  config = {},
  rules = null,
) {
  const { pts, estimated } = sampleRoute(points, config, rules);
  if (pts.length > 40000 || pts.at(-1).t > 14400)
    throw Error("预览采样超过支持范围");
  const results = order.map((cp) => {
    const meta = coverage.find((c) => c.id === cp.id);
    const radius = Number(meta?.radiusM) || 30;
    const nearest = Math.min(
      ...pts.map((p) =>
        Checkin.distanceM(cp.point[0], cp.point[1], p.lat, p.lng),
      ),
    );
    return { id: cp.id, distanceM: nearest, covered: nearest <= radius };
  });
  const outsideCount =
    fence.length < 3
      ? 0
      : pts.filter((p) => !inside([p.lat, p.lng], fence)).length;
  let outsideSegments = 0,
    distanceM = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = [pts[i - 1].lat, pts[i - 1].lng],
      b = [pts[i].lat, pts[i].lng];
    distanceM += Checkin.distanceM(...a, ...b);
    if (fence.length >= 3 && !segmentInside(a, b, fence)) outsideSegments++;
  }
  if (distanceM > 20000) throw Error("预览重采样路线超过20公里");
  return {
    estimated,
    canApply:
      results.every((c) => c.covered) &&
      outsideCount === 0 &&
      outsideSegments === 0,
    passed: results.filter((c) => c.covered).length,
    total: results.length,
    outsideCount,
    outsideSegments,
    distanceM,
    samples: pts.length,
    missingIds: results.filter((c) => !c.covered).map((c) => c.id),
  };
}
