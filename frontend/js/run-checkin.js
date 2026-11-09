// Recovered pure helper from supplied 1.2.0.

    var PASS_RADIUS_M = 30;
    function cumulativeDistance(pts) {
      const cum = new Array(pts.length).fill(0);
      for (let i = 1; i < pts.length; i += 1) {
        const dLat = (pts[i].lat - pts[i - 1].lat) * 111320;
        const dLng = (pts[i].lng - pts[i - 1].lng) * 111320 * Math.cos(pts[i].lat * Math.PI / 180);
        cum[i] = cum[i - 1] + Math.sqrt(dLat * dLat + dLng * dLng);
      }
      return cum;
    }
    function distanceM(lat1, lng1, lat2, lng2) {
      const dLat = (lat2 - lat1) * 111320;
      const dLng = (lng2 - lng1) * 111320 * Math.cos((lat1 + lat2) / 2 * (Math.PI / 180));
      return Math.sqrt(dLat * dLat + dLng * dLng);
    }
    function build(checkpoints, pts, maxPassPerPoint = 1) {
      if (!pts || pts.length === 0) return { points: [], passedCount: 0, total: 0 };
      const cap = Math.max(maxPassPerPoint, 1);
      const cum = cumulativeDistance(pts);
      const out = [];
      for (const cp of checkpoints) {
        const cpLat = Number(cp.lat);
        const cpLng = Number(cp.lng);
        const id = String(cp.id);
        if (!Number.isFinite(cpLat) || !Number.isFinite(cpLng)) continue;
        const dists = pts.map((p) => distanceM(cpLat, cpLng, p.lat, p.lng));
        let nearestIdx = 0;
        for (let i = 1; i < dists.length; i += 1) if (dists[i] < dists[nearestIdx]) nearestIdx = i;
        const groups = [];
        let start = -1;
        let prev = -2;
        for (let j = 0; j < dists.length; j += 1) {
          if (dists[j] <= PASS_RADIUS_M) {
            if (start < 0) start = j;
            else if (j - prev > 2) {
              groups.push([start, prev]);
              start = j;
            }
            prev = j;
          }
        }
        if (start >= 0) groups.push([start, prev]);
        if (groups.length === 0) {
          out.push({
            id,
            lat: cpLat,
            lng: cpLng,
            routeIndex: nearestIdx,
            distanceM: cum[nearestIdx],
            timeOffsetS: -1,
            passed: false,
            passLat: cpLat,
            passLng: cpLng
          });
        } else {
          for (const [g0, g1] of groups.slice(0, cap)) {
            let idx = g0;
            for (let j = g0; j <= g1; j += 1) if (dists[j] < dists[idx]) idx = j;
            out.push({
              id,
              lat: cpLat,
              lng: cpLng,
              routeIndex: idx,
              distanceM: cum[idx],
              timeOffsetS: pts[idx].t,
              passed: true,
              passLat: pts[idx].lat,
              passLng: pts[idx].lng
            });
          }
        }
      }
      out.sort((a, b) => a.routeIndex - b.routeIndex);
      return {
        points: out,
        passedCount: out.filter((p) => p.passed).length,
        total: out.length
      };
    }
    function toLogData(plan, startSec, timeScale = 1) {
      const scale = Number.isFinite(Number(timeScale)) && Number(timeScale) > 0 ? Number(timeScale) : 1;
      return JSON.stringify(plan.points.map((p) => ({
        point_id: Number(p.id) || p.id,
        time: p.passed ? Math.trunc(startSec + p.timeOffsetS * scale) : 0,
        latitude: p.passed ? Number(p.passLat.toFixed(6)) : 0,
        longtitude: p.passed ? Number(p.passLng.toFixed(6)) : 0,
        distance: Number(p.distanceM.toFixed(1))
      })));
    }
    function heartbeatIndices(plan, ptsSize, intervalS, septalS) {
      if (ptsSize <= 0) return [];
      const septal = septalS > 0 ? septalS : 60;
      const step = intervalS > 0 ? Math.max(Math.trunc(septal / intervalS), 1) : 1;
      const set = /* @__PURE__ */ new Set();
      for (let i = 0; i < ptsSize; i += step) set.add(i);
      set.add(ptsSize - 1);
      for (const p of plan.points) set.add(Math.min(Math.max(p.routeIndex, 0), ptsSize - 1));
      return Array.from(set).sort((a, b) => a - b);
    }
    export const Checkin = { PASS_RADIUS_M, cumulativeDistance, distanceM, build, toLogData, heartbeatIndices };