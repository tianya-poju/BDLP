// Recovered pure helper from supplied 1.2.0.

    var DAY = 86400;
    var TZ_OFFSET = 8 * 3600;
    function secOfDay(epochSec) {
      const n = Math.floor(Number(epochSec) || 0);
      return ((n + TZ_OFFSET) % DAY + DAY) % DAY;
    }
    function fmtSecOfDay(sec) {
      const s = Math.max(0, Math.min(DAY, Math.floor(Number(sec) || 0)));
      return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}`;
    }
    function paceText(secPerKm) {
      const v = Math.floor(Number(secPerKm) || 0);
      if (v <= 0) return "\u672A\u9650\u5236";
      if (v < 60) return `${v}'00"`;
      return `${Math.floor(v / 60)}'${String(v % 60).padStart(2, "0")}"`;
    }
    function numOf(o, ...keys) {
      for (const k of keys) {
        if (!o || !Object.prototype.hasOwnProperty.call(o, k)) continue;
        const raw = o[k];
        if (raw === null || raw === void 0 || raw === "") continue;
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
      return 0;
    }
    function intOf(o, ...keys) {
      return Math.trunc(numOf(o, ...keys));
    }
    function ruleOf(o) {
      const startSecOfDay = intOf(o, "start_time");
      const endSecOfDay = intOf(o, "end_time");
      if (!(startSecOfDay > 0 && endSecOfDay > 0 && endSecOfDay > startSecOfDay)) return null;
      const minPaceSec = intOf(o, "min_pace");
      const maxPaceSec = intOf(o, "max_pace");
      return {
        startSecOfDay,
        endSecOfDay,
        minDistanceKm: numOf(o, "min_distance"),
        maxDistanceKm: numOf(o, "max_distance"),
        /** 慢端（数值大） */
        minPaceSec,
        /** 快端（数值小） */
        maxPaceSec,
        pointNumOnline: intOf(o, "point_num_online"),
        pointNumOffline: intOf(o, "point_num_offline"),
        hasPaceLimit: maxPaceSec > 0 && minPaceSec > 0 && maxPaceSec < minPaceSec,
        hasDistanceLimit: numOf(o, "max_distance") > 0
      };
    }
    function parseRules(brData) {
      const d = brData || {};
      let rules = [];
      if (Array.isArray(d.time_rule_arr)) {
        rules = d.time_rule_arr.map(ruleOf).filter(Boolean);
      }
      if (rules.length === 0 && Array.isArray(d.running_time)) {
        rules = d.running_time.map(ruleOf).filter(Boolean);
      }
      if (rules.length === 0) {
        const s = intOf(d, "run_start_time");
        const e = intOf(d, "run_end_time");
        if (s > 0 && e > 0 && e > s) {
          const single = ruleOf({ start_time: s, end_time: e });
          if (single) rules = [single];
        }
      }
      return rules.sort((a, b) => a.startSecOfDay - b.startSecOfDay);
    }
    function evaluate(brData, nowSec) {
      const rules = parseRules(brData);
      if (rules.length === 0) {
        return { inWindow: true, rule: null, message: "\u672A\u914D\u7F6E\u953B\u70BC\u65F6\u6BB5\u9650\u5236", remainSec: 0, untilNextSec: -1 };
      }
      const sod = secOfDay(nowSec);
      const hit = rules.find((r) => sod >= r.startSecOfDay && sod <= r.endSecOfDay) || null;
      if (hit) {
        const remain = hit.endSecOfDay - sod;
        const next2 = rules.filter((r) => r.startSecOfDay > sod).sort((a, b) => a.startSecOfDay - b.startSecOfDay)[0];
        return {
          inWindow: true,
          rule: hit,
          message: `\u5F53\u524D\u5728\u953B\u70BC\u65F6\u6BB5 ${fmtSecOfDay(hit.startSecOfDay)}~${fmtSecOfDay(hit.endSecOfDay)}\uFF08\u5269\u4F59 ${Math.floor(remain / 60)} \u5206\u949F\uFF09`,
          remainSec: remain,
          untilNextSec: next2 ? next2.startSecOfDay - sod : -1
        };
      }
      const next = rules.filter((r) => r.startSecOfDay > sod).sort((a, b) => a.startSecOfDay - b.startSecOfDay)[0];
      const last = rules[rules.length - 1];
      const message = next ? `\u5F53\u524D\u4E0D\u5728\u953B\u70BC\u65F6\u6BB5\uFF08\u4E0B\u4E00\u65F6\u6BB5 ${fmtSecOfDay(next.startSecOfDay)} \u5F00\u59CB\uFF0C\u8FD8\u6709 ${Math.floor((next.startSecOfDay - sod) / 60)} \u5206\u949F\uFF09` : `\u4ECA\u65E5\u953B\u70BC\u65F6\u6BB5\u5DF2\u7ED3\u675F\uFF08\u6700\u540E\u4E00\u6BB5 ${fmtSecOfDay(last.startSecOfDay)}~${fmtSecOfDay(last.endSecOfDay)}\uFF09`;
      return { inWindow: false, rule: null, message, remainSec: 0, untilNextSec: next ? next.startSecOfDay - sod : -1 };
    }
    function checkDuration(status, durationS, nowSec) {
      if (!status) return null;
      if (!status.inWindow) return status.message;
      const rule = status.rule;
      if (!rule) return null;
      const sod = secOfDay(nowSec);
      const remain = rule.endSecOfDay - sod;
      const duration = Math.max(Math.trunc(Number(durationS) || 0), 0);
      if (remain < duration + 20) {
        return `\u672C\u65F6\u6BB5\u5269\u4F59 ${Math.floor(remain / 60)} \u5206\u949F\uFF0C\u4E0D\u8DB3\u672C\u6B21\u8DD1\u6B65 ${Math.floor(duration / 60)} \u5206\u949F\uFF0C\u8BF7\u7F29\u77ED\u8DEF\u7EBF\u6216\u6362\u4E2A\u65F6\u6BB5`;
      }
      const sinceStart = sod - rule.startSecOfDay;
      if (sinceStart < duration + 20) {
        return `\u672C\u65F6\u6BB5\u521A\u5F00\u59CB ${Math.floor(sinceStart / 60)} \u5206\u949F\uFF0C\u4E0D\u8DB3\u4EE5\u5B8C\u6210 ${Math.floor(duration / 60)} \u5206\u949F\u8DD1\u6B65\uFF0C\u8BF7\u7A0D\u540E\u518D\u8DD1`;
      }
      return null;
    }
    function checkDistance(distanceKm, rule) {
      if (!rule || !rule.hasDistanceLimit) return null;
      const d = Number(distanceKm) || 0;
      if (rule.minDistanceKm > 0 && d < rule.minDistanceKm) {
        return `\u672C\u65F6\u6BB5\u8981\u6C42\u81F3\u5C11 ${rule.minDistanceKm.toFixed(2)}km\uFF0C\u5F53\u524D\u8DEF\u7EBF\u53EA\u6709 ${d.toFixed(2)}km`;
      }
      if (rule.maxDistanceKm > 0 && d > rule.maxDistanceKm) {
        return `\u672C\u65F6\u6BB5\u6700\u591A ${rule.maxDistanceKm.toFixed(2)}km\uFF0C\u5F53\u524D\u8DEF\u7EBF ${d.toFixed(2)}km \u8D85\u4E86`;
      }
      return null;
    }
    function paceOutOfRange(speedMps, rule) {
      const v = Number(speedMps) || 0;
      if (!rule || !rule.hasPaceLimit || v <= 0) return null;
      const pace = Math.trunc(1e3 / v);
      if (pace < rule.maxPaceSec) {
        return `\u914D\u901F ${paceText(pace)}/km \u6BD4\u672C\u65F6\u6BB5\u6700\u5FEB ${paceText(rule.maxPaceSec)}/km \u8FD8\u5FEB`;
      }
      if (pace > rule.minPaceSec) {
        return `\u914D\u901F ${paceText(pace)}/km \u6BD4\u672C\u65F6\u6BB5\u6700\u6162 ${paceText(rule.minPaceSec)}/km \u8FD8\u6162`;
      }
      return null;
    }
    function ruleSummary(rule) {
      if (!rule) return null;
      const pace = rule.hasPaceLimit ? `${paceText(rule.maxPaceSec)}~${paceText(rule.minPaceSec)}/km` : "\u914D\u901F\u4E0D\u9650";
      const dist = rule.hasDistanceLimit ? `${rule.minDistanceKm.toFixed(1)}~${rule.maxDistanceKm.toFixed(1)}km` : "\u8DDD\u79BB\u4E0D\u9650";
      const points = rule.pointNumOnline > 0 ? `${rule.pointNumOnline} \u4E2A\u6253\u5361\u70B9` : "\u65E0\u6253\u5361\u70B9\u8981\u6C42";
      return { pace, dist, points };
    }
    export const TimeWindow = {
      secOfDay,
      fmtSecOfDay,
      paceText,
      parseRules,
      evaluate,
      checkDuration,
      checkDistance,
      paceOutOfRange,
      ruleSummary
    };