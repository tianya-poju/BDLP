"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) =>
  function __require() {
    try {
      return (
        mod ||
          (0, cb[__getOwnPropNames(cb)[0]])(
            (mod = { exports: {} }).exports,
            mod,
          ),
        mod.exports
      );
    } catch (e) {
      throw ((mod = 0), e);
    }
  };

// src/protocol/timeWindow.js
var require_timeWindow = __commonJS({
  "src/protocol/timeWindow.js"(exports2, module2) {
    "use strict";
    var DAY = 86400;
    var TZ_OFFSET = 8 * 3600;
    function secOfDay(epochSec) {
      const n = Math.floor(Number(epochSec) || 0);
      return (((n + TZ_OFFSET) % DAY) + DAY) % DAY;
    }
    function fmtSecOfDay(sec) {
      const s = Math.max(0, Math.min(DAY, Math.floor(Number(sec) || 0)));
      return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
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
      if (
        !(startSecOfDay > 0 && endSecOfDay > 0 && endSecOfDay > startSecOfDay)
      )
        return null;
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
        hasPaceLimit:
          maxPaceSec > 0 && minPaceSec > 0 && maxPaceSec < minPaceSec,
        hasDistanceLimit: numOf(o, "max_distance") > 0,
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
        return {
          inWindow: true,
          rule: null,
          message: "\u672A\u914D\u7F6E\u953B\u70BC\u65F6\u6BB5\u9650\u5236",
          remainSec: 0,
          untilNextSec: -1,
        };
      }
      const sod = secOfDay(nowSec);
      const hit =
        rules.find((r) => sod >= r.startSecOfDay && sod <= r.endSecOfDay) ||
        null;
      if (hit) {
        const remain = hit.endSecOfDay - sod;
        const next2 = rules
          .filter((r) => r.startSecOfDay > sod)
          .sort((a, b) => a.startSecOfDay - b.startSecOfDay)[0];
        return {
          inWindow: true,
          rule: hit,
          message: `\u5F53\u524D\u5728\u953B\u70BC\u65F6\u6BB5 ${fmtSecOfDay(hit.startSecOfDay)}~${fmtSecOfDay(hit.endSecOfDay)}\uFF08\u5269\u4F59 ${Math.floor(remain / 60)} \u5206\u949F\uFF09`,
          remainSec: remain,
          untilNextSec: next2 ? next2.startSecOfDay - sod : -1,
        };
      }
      const next = rules
        .filter((r) => r.startSecOfDay > sod)
        .sort((a, b) => a.startSecOfDay - b.startSecOfDay)[0];
      const last = rules[rules.length - 1];
      const message = next
        ? `\u5F53\u524D\u4E0D\u5728\u953B\u70BC\u65F6\u6BB5\uFF08\u4E0B\u4E00\u65F6\u6BB5 ${fmtSecOfDay(next.startSecOfDay)} \u5F00\u59CB\uFF0C\u8FD8\u6709 ${Math.floor((next.startSecOfDay - sod) / 60)} \u5206\u949F\uFF09`
        : `\u4ECA\u65E5\u953B\u70BC\u65F6\u6BB5\u5DF2\u7ED3\u675F\uFF08\u6700\u540E\u4E00\u6BB5 ${fmtSecOfDay(last.startSecOfDay)}~${fmtSecOfDay(last.endSecOfDay)}\uFF09`;
      return {
        inWindow: false,
        rule: null,
        message,
        remainSec: 0,
        untilNextSec: next ? next.startSecOfDay - sod : -1,
      };
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
      const pace = rule.hasPaceLimit
        ? `${paceText(rule.maxPaceSec)}~${paceText(rule.minPaceSec)}/km`
        : "\u914D\u901F\u4E0D\u9650";
      const dist = rule.hasDistanceLimit
        ? `${rule.minDistanceKm.toFixed(1)}~${rule.maxDistanceKm.toFixed(1)}km`
        : "\u8DDD\u79BB\u4E0D\u9650";
      const points =
        rule.pointNumOnline > 0
          ? `${rule.pointNumOnline} \u4E2A\u6253\u5361\u70B9`
          : "\u65E0\u6253\u5361\u70B9\u8981\u6C42";
      return { pace, dist, points };
    }
    module2.exports = {
      secOfDay,
      fmtSecOfDay,
      paceText,
      parseRules,
      evaluate,
      checkDuration,
      checkDistance,
      paceOutOfRange,
      ruleSummary,
    };
  },
});

// src/protocol/diagnosis.js
var require_diagnosis = __commonJS({
  "src/protocol/diagnosis.js"(exports2, module2) {
    "use strict";
    var TimeWindow = require_timeWindow();
    function paceText(v) {
      const n = Number(v || 0);
      if (n <= 0) return "\u672A\u9650\u5236";
      if (n < 60) return `${n}'00"`;
      return `${Math.floor(n / 60)}'${String(n % 60).padStart(2, "0")}"`;
    }
    function diagnose(brData, nowSec = Math.floor(Date.now() / 1e3)) {
      const config = [];
      const fields = [];
      const unsupported = [];
      const blocked = [];
      const geeTest = Number(brData.is_check_geetest || 0) === 1;
      const geeDevice = Number(brData.is_check_geedevice || 0) === 1;
      const deepknow =
        Number(brData.is_check_deepknow || brData.is_check_deepkonw || 0) === 1;
      const shumeng = Number(brData.is_check_shumeng || 0) === 1;
      const checkDevice = Number(brData.is_check_device || 0) === 1;
      const checkTime = Number(brData.is_check_time || 0) === 1;
      const on = [];
      if (geeTest) on.push("\u6781\u9A8C\u6ED1\u5757");
      if (geeDevice) on.push("\u6781\u9A8C\u8BBE\u5907");
      if (deepknow) on.push("\u6570\u7F8E");
      if (shumeng) on.push("\u6570\u76DF");
      if (checkDevice) on.push("\u8BBE\u5907\u6307\u7EB9");
      if (checkTime) on.push("\u65F6\u95F4\u6821\u9A8C");
      config.push(
        "\u53CD\u4F5C\u5F0A\u5F00\u5173\uFF1A" +
          (on.length === 0 ? "\u5168\u90E8\u672A\u5F00\u542F" : on.join(" / ")),
      );
      const captureConfig = brData.capture_config || {};
      const captureType = Number(captureConfig.capture_type || 0);
      const capturePoints = Array.isArray(captureConfig.config)
        ? captureConfig.config.length
        : 0;
      const captureOn =
        captureType > 0 &&
        (capturePoints > 0 || Number(brData.is_capture_zone || 0) === 1);
      const captureSiteNum = Number(captureConfig.site_num ?? -1);
      const captureInterval = Number(captureConfig.capture_interval || 0);
      config.push(
        "\u6293\u62CD\uFF1A" +
          (!captureOn
            ? "\u672A\u542F\u7528\uFF08\u65E0\u6293\u62CD\u70B9\u914D\u7F6E\uFF09"
            : captureType === 1
              ? `\u5BA2\u6237\u7AEF\u6293\u62CD\uFF08${capturePoints} \u4E2A\u70B9\uFF09\xB7 \u7528\u7167\u7247\u5E93\u7167\u7247\u6BCF 1km \u6A21\u62DF\u4E00\u6B21`
              : `\u7EBF\u4E0B\u8BBE\u5907\u6293\u62CD(type=${captureType})`),
      );
      if (captureOn && captureType === 1) {
        unsupported.push(
          "\u65E0\u611F\u6293\u62CD\uFF08capture_type=1\uFF09\uFF1A\u6539\u7528\u7167\u7247\u5E93\u91CC\u7684\u771F\u4EBA\u7167\u7247\u6309 1km \u8282\u594F\u6A21\u62DF\u6293\u62CD\uFF1B\u670D\u52A1\u7AEF\u82E5\u4E25\u683C\u6838\u5BF9\u70B9\u4F4D\u6444\u50CF\u5934\uFF0C\u4ECD\u53EF\u80FD\u5224\u300C\u6F0F\u62CD/\u6253\u5361\u70B9\u8FC7\u5C11\u300D",
        );
      } else if (captureOn && captureType === 2) {
        unsupported.push(
          `\u70B9\u4F4D\u6444\u50CF\u5934\u6838\u5BF9\uFF08capture_type=2\uFF0C\u6293\u62CD\u8BB0\u5F55\u4F1A\u662F 0\uFF0C\u53EF\u80FD\u88AB\u5224\u6F0F\u62CD\uFF1B\u70B9\u4F4D ${captureSiteNum >= 0 ? captureSiteNum : "\u672A\u77E5"}\uFF09`,
        );
      }
      const face = brData.run_face_verify_config || {};
      const fStart = Number(face.start_status || 0);
      const fMiddle = Number(face.middle_status || 0);
      const fStop = Number(face.stop_status || 0);
      const fType = Number(face.face_verify_type || 1);
      const faceOn = fStart === 1 || fMiddle === 1 || fStop === 1;
      config.push(
        "\u4EBA\u8138\u6838\u9A8C\uFF1A" +
          (!faceOn
            ? "\u672A\u5F00\u542F"
            : `\u5F00\u59CB=${fStart === 1 ? "\u8981" : "\u5426"} \u4E2D\u9014=${fMiddle === 1 ? `${Number(face.middle_num || 1)}\u6B21` : "\u5426"} \u7ED3\u675F=${fStop === 1 ? "\u8981" : "\u5426"} \u65B9\u5F0F=${fType === 1 ? "\u5185\u7F6E\u76F8\u673A" : `\u652F\u4ED8\u5B9D\u5C0F\u7A0B\u5E8F(type=${fType})`}`),
      );
      if (faceOn && fType !== 1) {
        unsupported.push(
          "\u652F\u4ED8\u5B9D\u5C0F\u7A0B\u5E8F\u5237\u8138\uFF1A\u6838\u9A8C\u7ED3\u679C\u7531\u652F\u4ED8\u5B9D\u670D\u52A1\u5668\u56DE\u4F20\uFF0C\u811A\u672C\u65E0\u6CD5\u4F2A\u9020\uFF0C\u9700\u5148\u5728\u652F\u4ED8\u5B9D\u5C0F\u7A0B\u5E8F\u5B8C\u6210\u5237\u8138",
        );
        blocked.push(
          "\u8BE5\u8DD1\u533A\u8981\u6C42\u652F\u4ED8\u5B9D\u5C0F\u7A0B\u5E8F\u5237\u8138\uFF0C\u9700\u5148\u5728\u652F\u4ED8\u5B9D\u5B8C\u6210\u6838\u9A8C\u518D\u56DE\u6765",
        );
      }
      const minDistance = Number(brData.min_distance || 0);
      const maxDistance = Number(brData.max_distance || 0);
      const minPace = Number(brData.min_pace || 0);
      const maxPace = Number(brData.max_pace || 0);
      const logLogic = Number(brData.log_logic || 0);
      const passNum = Number(brData.pass_num || 0);
      const passRate = Number(brData.pass_rate || 0);
      const stepLength = Number(brData.stepLength || 0);
      config.push(
        `\u8DDD\u79BB\u533A\u95F4\uFF1A${minDistance.toFixed(2)}km ~ ${maxDistance > 0 ? `${maxDistance.toFixed(2)}km` : "\u4E0D\u9650"}`,
      );
      config.push(
        `\u914D\u901F\u533A\u95F4\uFF1A${paceText(maxPace)} ~ ${paceText(minPace)}`,
      );
      config.push(
        "\u8DD1\u533A\u5185\u70B9\u6570\uFF1A\u6A21\u5F0F=" +
          (logLogic === 2
            ? `\u6309\u7EDD\u5BF9\u6570\uFF08\u9700 \u2265 ${passNum} \u70B9\uFF09`
            : logLogic === 3
              ? `\u6309\u6BD4\u4F8B\uFF08\u9700 \u2265 ${(passRate * 100).toFixed(0)}%\uFF09`
              : "\u672A\u542F\u7528"),
      );
      const limitRange = Number(brData.is_limit_range || 0) === 1;
      const fenceSize = Array.isArray(brData.run_zone_latlng)
        ? brData.run_zone_latlng.length
        : 0;
      config.push(
        `\u8DD1\u533A\u56F4\u680F\uFF1A${limitRange ? "\u542F\u7528" : "\u672A\u542F\u7528"}\uFF08\u9876\u70B9 ${fenceSize} \u4E2A\uFF09`,
      );
      config.push(
        `\u670D\u52A1\u7AEF\u6B65\u957F\uFF1A${stepLength > 0 ? `${stepLength.toFixed(2)}m` : "\u672A\u4E0B\u53D1\uFF08\u7528\u672C\u5730\u6B65\u957F\uFF09"}`,
      );
      const line = brData.run_line_info || {};
      const pointNum = Number(line.point_num || 0);
      const repeatNum = Number(brData.repeat_num || 0);
      const logMode = Number(brData.log_mode || 0);
      config.push(
        `\u6253\u5361\uFF1A\u6A21\u5F0F=${logMode === 2 ? "\u5B9A\u5411(\u987A\u5E8F)" : "\u81EA\u7531"} \u70B9\u6570=${pointNum} \u91CD\u590D=${repeatNum} \u2192 \u9700\u6253\u5361 ${pointNum * (repeatNum + 1)} \u6B21`,
      );
      const ts = Number(brData.term_start_time || 0);
      const te = Number(brData.term_end_time || 0);
      if (ts > 0 && te > 0) {
        config.push(
          `\u5B66\u671F\u65F6\u95F4\u7A97\uFF1A${fmtTime(ts)} ~ ${fmtTime(te)}`,
        );
      }
      const rs = Number(brData.run_start_time || 0);
      const re = Number(brData.run_end_time || 0);
      if (re > rs && re > 0)
        config.push(
          `\u8DD1\u533A\u5F00\u653E\u65F6\u6BB5\uFF1A${hms(rs)} ~ ${hms(re)}`,
        );
      const timeRules = TimeWindow.parseRules(brData);
      const timeStatus = TimeWindow.evaluate(brData, nowSec);
      if (timeRules.length) {
        config.push(
          `\u953B\u70BC\u65F6\u6BB5\uFF1A${timeRules.map((r) => `${TimeWindow.fmtSecOfDay(r.startSecOfDay)}~${TimeWindow.fmtSecOfDay(r.endSecOfDay)}`).join(" / ")}`,
        );
        config.push(`\u65F6\u6BB5\u72B6\u6001\uFF1A${timeStatus.message}`);
        const rs2 = TimeWindow.ruleSummary(timeStatus.rule);
        if (rs2)
          config.push(
            `\u672C\u65F6\u6BB5\u9608\u503C\uFF1A${rs2.dist} \xB7 ${rs2.pace} \xB7 ${rs2.points}`,
          );
      }
      const add = (field, needed, reason) =>
        fields.push({ field, needed, reason });
      [
        "school_id",
        "term_id",
        "game_id",
        "start_time",
        "end_time",
        "used_time",
        "distance",
        "step_num",
        "step_info",
        "record_file",
        "log_data",
        "pass_total",
        "record_str",
        "ip",
        "run_check_res",
      ].forEach((f) => add(f, true, "\u65E0\u6761\u4EF6\u5FC5\u53D1"));
      add(
        "pass_effective_num",
        true,
        "\u6709\u56F4\u680F/\u6BD4\u4F8B\u6821\u9A8C\u65F6\u670D\u52A1\u7AEF\u4F1A\u770B",
      );
      add(
        "is_running_area_valid",
        limitRange || logLogic === 2 || logLogic === 3,
        "\u6709\u8DD1\u533A\u5224\u5B9A\u624D\u9700\u8981",
      );
      add("file_img", true, '\u65E0\u622A\u56FE\u65F6\u5B98\u65B9\u53D1 "1"');
      add(
        "record_img",
        false,
        "\u672A\u62CD\u7167 \u2192 \u5B98\u65B9\u53D1\u7A7A\u4E32",
      );
      add(
        "run_face_verify_id",
        faceOn,
        "\u4EC5\u5F00\u542F\u4EBA\u8138\u6838\u9A8C\u65F6\u624D\u53D1",
      );
      add(
        "is_timeout_zfb",
        faceOn && fType !== 1,
        "\u4EC5\u652F\u4ED8\u5B9D\u5237\u8138\u6A21\u5F0F\u624D\u6709\u610F\u4E49\uFF08\u5185\u7F6E\u76F8\u673A\u6A21\u5F0F\u4E0B\u6052 0\uFF09",
      );
      add(
        "gee_token",
        geeTest || geeDevice,
        "\u4EC5\u5F00\u542F\u6781\u9A8C\u65F6\u624D\u9700\u8981\uFF1B\u88AB\u62BD\u4E2D\u9700\u4EBA\u5DE5\u8FC7\u6ED1\u5757",
      );
      add(
        "newMobileDeviceId",
        deepknow,
        "\u4EC5\u5F00\u542F\u6570\u7F8E\u65F6\u624D\u9700\u8981",
      );
      add(
        "session_id",
        checkDevice && (geeTest || geeDevice),
        "isNeedCheckGeeDp \u573A\u666F\uFF0C\u4E00\u822C\u4E0D\u89E6\u53D1",
      );
      add(
        "oaid",
        false,
        "\u62FF\u4E0D\u5230\u771F\u503C\uFF1B\u5B98\u65B9\u4E5F\u662F\u6761\u4EF6\u5B57\u6BB5\uFF0C\u7F16\u6392\u53CD\u800C\u66F4\u50CF\u6362\u8BBE\u5907",
      );
      add(
        "mac",
        checkDevice,
        "\u8BBE\u5907\u6307\u7EB9\u6821\u9A8C\u65F6\u5B98\u65B9\u4F1A\u5E26\uFF1B\u65E0\u771F\u503C\uFF0C\u4E0D\u53D1",
      );
      add(
        "sim_sign",
        false,
        "\u5B98\u65B9\u7531 native \u751F\u6210\uFF0C\u65E0\u6CD5\u590D\u73B0",
      );
      add("sim_code", false, "\u540C\u4E0A");
      return {
        configLines: config,
        fields,
        neededFields: fields.filter((f) => f.needed).map((f) => f.field),
        skippedFields: fields.filter((f) => !f.needed).map((f) => f.field),
        unsupported,
        blocked,
        /** 给「本跑区要求」卡片与 per-school 缓存用的结构化摘要（不含整包 brData） */
        summary: {
          schoolId: String(brData.school_id || ""),
          zone: {
            id: String(brData.game_id || brData.run_zone_id || ""),
            name: String(brData.run_zone_name || ""),
          },
          time: {
            rules: timeRules,
            inWindow: timeStatus.inWindow,
            message: timeStatus.message,
            remainSec: timeStatus.remainSec,
            untilNextSec: timeStatus.untilNextSec,
            rule: timeStatus.rule,
            ruleText: TimeWindow.ruleSummary(timeStatus.rule),
          },
          capture: {
            type: captureType,
            on: captureOn,
            points: capturePoints,
            siteNum: captureSiteNum,
            interval: captureInterval,
          },
          face: {
            on: faceOn,
            start: fStart,
            middle: fMiddle,
            stop: fStop,
            num: Number(face.middle_num || 1),
            type: fType,
          },
          checks: {
            geetest: geeTest,
            geeDevice,
            deepknow,
            shumeng,
            device: checkDevice,
            time: checkTime,
          },
          thresholds: {
            minDistance,
            maxDistance,
            minPace,
            maxPace,
            stepLength,
            logLogic,
            passNum,
            passRate,
          },
          checkins: {
            pointNum,
            repeatNum,
            required: pointNum * (repeatNum + 1),
            logMode,
          },
          blocked,
        },
      };
    }
    function hms(sec) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    function fmtTime(unixSec) {
      const d = new Date(unixSec * 1e3);
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    module2.exports = { diagnose };
  },
});

export const diagnose = require_diagnosis().diagnose;
