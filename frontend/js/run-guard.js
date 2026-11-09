// Recovered pure helper from supplied 1.2.0.

import { Checkin } from "./run-checkin.js";
const { distanceM } = Checkin;
import { TimeWindow } from "./run-timeWindow.js";
function parseFence(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const out = [];
  for (const s of arr) {
    for (const piece of String(s).split(/[;|]/)) {
      const parts = piece.trim().split(",");
      if (parts.length !== 2) continue;
      const a = parseFloat(parts[0]);
      const b = parseFloat(parts[1]);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      if (Math.abs(a) > 54) out.push([b, a]);
      else if (Math.abs(b) > 54) out.push([a, b]);
      else out.push(a >= b ? [b, a] : [a, b]);
    }
  }
  return out;
}
function insidePolygon(lat, lng, poly) {
  let inside = false;
  let j = poly.length - 1;
  for (let i = 0; i < poly.length; i += 1) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (
      xi > lng !== xj > lng &&
      lat < ((yj - yi) * (lng - xi)) / (xj - xi) + yi
    )
      inside = !inside;
    j = i;
  }
  return inside;
}
function pointInFence(lat, lng, polygon, holes) {
  if (!insidePolygon(lat, lng, polygon)) return false;
  if (holes.length >= 3) {
    let i = 0;
    while (i + 2 < holes.length) {
      if (insidePolygon(lat, lng, [holes[i], holes[i + 1], holes[i + 2]]))
        return false;
      i += 3;
    }
  }
  return true;
}
function fenceHitRatePts(pts, fence) {
  if (fence.length < 3 || pts.length === 0) return null;
  return (
    pts.filter((p) => pointInFence(p[0], p[1], fence, [])).length / pts.length
  );
}
function paceFieldToSec(v) {
  if (!v || v <= 0) return 0;
  return v < 60 ? v * 60 : v;
}
function fmtPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "-";
  const m = Math.floor(secPerKm / 60);
  const s = Math.floor(secPerKm % 60);
  return `${m}'${String(s).padStart(2, "0")}"`;
}
function check(
  brData,
  distanceMVal,
  durationS,
  pts,
  checkinPass,
  checkinNeed,
  nowSecC,
  hbIdx,
) {
  const blockers = [];
  const warnings = [];
  const minDistanceM = Number(brData.min_distance || 0) * 1e3;
  if (minDistanceM > 0 && distanceMVal < minDistanceM) {
    blockers.push(
      `\u8DDD\u79BB\u4E0D\u8FBE\u6807\uFF1A\u672C\u6B21 ${(distanceMVal / 1e3).toFixed(2)}km < \u8981\u6C42 ${(minDistanceM / 1e3).toFixed(2)}km`,
    );
  }
  const maxDistanceM = Number(brData.max_distance || 0) * 1e3;
  if (maxDistanceM > 0 && distanceMVal > maxDistanceM) {
    blockers.push(
      `\u8DDD\u79BB\u8D85\u51FA\u4E0A\u9650\uFF1A\u672C\u6B21 ${(distanceMVal / 1e3).toFixed(2)}km > \u4E0A\u9650 ${(maxDistanceM / 1e3).toFixed(2)}km`,
    );
  }
  if (durationS > 0 && distanceMVal > 10) {
    const paceSecPerKm = (durationS * 1e3) / distanceMVal;
    const slowestSec = paceFieldToSec(Number(brData.min_pace || 0));
    const fastestSec = paceFieldToSec(Number(brData.max_pace || 0));
    if (slowestSec > 0 && paceSecPerKm > slowestSec) {
      blockers.push(
        `\u901F\u5EA6\u8FC7\u6162\uFF1A\u914D\u901F ${fmtPace(paceSecPerKm)} \u6162\u4E8E\u4E0A\u9650 ${fmtPace(slowestSec)}`,
      );
    }
    if (fastestSec > 0 && paceSecPerKm < fastestSec) {
      blockers.push(
        `\u901F\u5EA6\u8FC7\u5FEB\uFF08\u7591\u4F3C\u4F5C\u5F0A\uFF09\uFF1A\u914D\u901F ${fmtPace(paceSecPerKm)} \u5FEB\u4E8E\u4E0B\u9650 ${fmtPace(fastestSec)}`,
      );
    }
  }
  if (checkinNeed > 0 && checkinPass < checkinNeed) {
    blockers.push(
      `\u6253\u5361\u6B21\u6570\u4E0D\u8DB3\uFF1A\u53EF\u6EE1\u8DB3 ${checkinPass} \u6B21 < \u8981\u6C42 ${checkinNeed} \u6B21`,
    );
  }
  const fence = parseFence(brData.run_zone_latlng);
  const holes = parseFence(brData.run_zone_latlng_invalid);
  let fenceValid = null;
  if (fence.length >= 3) {
    const validCount = pts.filter((p) =>
      pointInFence(p.lat, p.lng, fence, holes),
    ).length;
    const total = pts.length;
    fenceValid = validCount;
    const logLogic = Number(brData.log_logic || 0);
    const passNum = Number(brData.pass_num || 0);
    const passRate = Number(brData.pass_rate || 0);
    if (logLogic === 2 && passNum > 0 && validCount < passNum) {
      blockers.push(
        `\u8DD1\u533A\u5185\u6709\u6548\u70B9\u6570\u4E0D\u8DB3\uFF1A${validCount} < pass_num=${passNum}\uFF08log_logic=2\uFF09`,
      );
    }
    if (logLogic === 3 && passRate > 0) {
      const rate = total > 0 ? validCount / total : 0;
      if (rate < passRate) {
        blockers.push(
          `\u8DD1\u533A\u5185\u70B9\u5360\u6BD4\u4E0D\u8DB3\uFF1A${(rate * 100).toFixed(0)}% < pass_rate=${(passRate * 100).toFixed(0)}%`,
        );
      }
    }
    if (validCount < total) {
      warnings.push(
        `\u6709 ${total - validCount}/${total} \u4E2A\u8F68\u8FF9\u70B9\u5728\u8DD1\u533A\u5916\uFF08is_running_area_valid \u53EF\u80FD\u88AB\u5224 0\uFF09`,
      );
    }
    const sampleIdx =
      Array.isArray(hbIdx) && hbIdx.length > 0
        ? hbIdx
        : Array.from({ length: Math.ceil(pts.length / 30) }, (_, k) => k * 30);
    if (sampleIdx.length > 0) {
      const hbRate =
        sampleIdx.filter(
          (i) =>
            i < pts.length &&
            pointInFence(pts[i].lat, pts[i].lng, fence, holes),
        ).length / sampleIdx.length;
      const septal = Number(brData.location_septal || 60);
      if (logLogic === 3 && passRate > 0 && hbRate < passRate) {
        blockers.push(
          `\u5FC3\u8DF3\u70B9\u56F4\u680F\u5360\u6BD4\u4E0D\u8DB3\uFF1A${(hbRate * 100).toFixed(0)}% < ${(passRate * 100).toFixed(0)}%\uFF08\u670D\u52A1\u7AEF\u6309\u7EA6${septal}s\u4E00\u4E2A\u5FC3\u8DF3\u70B9\u5224\u5B9A\uFF0C\u6837\u672C\u5C0F\u6613\u7FFB\u8F66\uFF09`,
        );
      } else if (hbRate < 0.9) {
        warnings.push(
          `\u5FC3\u8DF3\u70B9\u89C6\u89D2\u56F4\u680F\u5360\u6BD4 ${(hbRate * 100).toFixed(0)}%\uFF0C\u8DEF\u7EBF\u8D34\u8FB9\u6709\u88AB\u5224\u300C\u672A\u8FBE\u5230\u89C4\u5B9A\u533A\u57DF\u300D\u7684\u98CE\u9669`,
        );
      }
    }
  } else {
    warnings.push(
      "\u672A\u62FF\u5230\u8DD1\u533A\u56F4\u680F\uFF08run_zone_latlng\uFF09\uFF0C\u65E0\u6CD5\u6821\u9A8C is_running_area_valid",
    );
  }
  const serverStep = Number(brData.stepLength || 0);
  if (serverStep > 0 && (serverStep < 0.7 || serverStep > 2)) {
    warnings.push(
      `\u670D\u52A1\u7AEF stepLength=${serverStep.toFixed(2)}m \u975E\u5E38\u89C4\u503C\uFF081.4~1.7m\uFF09\uFF1B\u6B65\u6570\u5DF2\u6309 \u6B65\u9891\xD7\u65F6\u957F \u8BA1\u7B97\uFF0C\u4E0D\u53D7\u5B83\u5F71\u54CD`,
    );
  }
  const now =
    Number.isFinite(nowSecC) && nowSecC > 0
      ? nowSecC
      : Math.floor(Date.now() / 1e3);
  const termStart = Number(brData.term_start_time || 0);
  const termEnd = Number(brData.term_end_time || 0);
  if (termStart > 0 && now < termStart)
    blockers.push(
      "\u5F53\u524D\u65E9\u4E8E\u5B66\u671F\u5F00\u59CB\u65F6\u95F4\uFF0C\u6210\u7EE9\u4E0D\u4F1A\u5173\u8054",
    );
  if (termEnd > 0 && now > termEnd)
    blockers.push(
      "\u5F53\u524D\u665A\u4E8E\u5B66\u671F\u7ED3\u675F\u65F6\u95F4\uFF0C\u6210\u7EE9\u4E0D\u4F1A\u5173\u8054",
    );
  const rs = Number(brData.run_start_time || 0);
  const re = Number(brData.run_end_time || 0);
  if (rs > 0 && re > rs) {
    const sod = TimeWindow.secOfDay(now);
    if (sod < rs || sod > re) {
      warnings.push(
        `\u5F53\u524D\u65F6\u95F4\u4E0D\u5728\u8DD1\u533A\u5F00\u653E\u65F6\u6BB5\uFF08${fmtHms(rs)}~${fmtHms(re)}\uFF09\uFF0C\u6210\u7EE9\u53EF\u80FD\u4E0D\u5173\u8054`,
      );
    }
  }
  const gpsMax = Number(brData.android_gps_max_distance || 0);
  if (gpsMax > 0 && pts.length > 1) {
    let maxGap = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const d = distanceM(
        pts[i - 1].lat,
        pts[i - 1].lng,
        pts[i].lat,
        pts[i].lng,
      );
      if (d > maxGap) maxGap = d;
    }
    if (maxGap > gpsMax) {
      warnings.push(
        `\u8F68\u8FF9\u6700\u5927\u70B9\u95F4\u8DDD ${maxGap.toFixed(0)}m \u8D85\u8FC7 android_gps_max_distance=${gpsMax.toFixed(0)}m\uFF0C\u53EF\u80FD\u88AB\u8FC7\u6EE4`,
      );
    }
  }
  return {
    blockers,
    warnings,
    fenceValidCount: fenceValid,
    totalCount: pts.length,
    ok: blockers.length === 0,
    summary:
      blockers.length > 0
        ? `\u2717 \u81EA\u68C0\u672A\u901A\u8FC7 ${blockers.length} \u9879`
        : warnings.length > 0
          ? `\u26A0 \u81EA\u68C0\u6709 ${warnings.length} \u9879\u98CE\u9669`
          : "\u2713 \u81EA\u68C0\u901A\u8FC7",
  };
}
function fmtHms(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
export const Guard = {
  check,
  parseFence,
  pointInFence,
  fenceHitRatePts,
  fmtPace,
  paceFieldToSec,
};
