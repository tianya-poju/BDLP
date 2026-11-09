"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// src/protocol/pace.js
var require_pace = __commonJS({
  "src/protocol/pace.js"(exports2, module2) {
    "use strict";
    var PACE_OPTIONS = [
      { level: 0, name: "\u5FEB\u8DD1", range: `3'45"~4'05"/km` },
      { level: 1, name: "\u8F83\u5FEB", range: `4'20"~4'40"/km` },
      { level: 2, name: "\u666E\u901A", range: `4'55"~5'15"/km` },
      { level: 3, name: "\u6162\u8DD1", range: `5'30"~5'50"/km` }
    ];
    function randInt(min, max) {
      return min + Math.floor(Math.random() * (max - min));
    }
    function randFloat() {
      return Math.random();
    }
    function round(v, d) {
      const p = 10 ** d;
      return Math.round(v * p) / p;
    }
    function calculate(paceLevel) {
      let targetPaceSecPerKm;
      switch (paceLevel) {
        case 0:
          targetPaceSecPerKm = randInt(225, 245);
          break;
        case 1:
          targetPaceSecPerKm = randInt(260, 280);
          break;
        case 2:
          targetPaceSecPerKm = randInt(295, 315);
          break;
        default:
          targetPaceSecPerKm = randInt(330, 350);
          break;
      }
      const avgSpeed = 1e3 / targetPaceSecPerKm;
      const straightRatio = paceLevel === 0 ? 1.12 : paceLevel === 1 ? 1.1 : paceLevel === 2 ? 1.08 : 1.05;
      const straight = Math.min(Math.max(avgSpeed * straightRatio * (1 + (randFloat() - 0.5) * 0.06), 2.5), 5);
      const curve = Math.min(Math.max(avgSpeed * (2 - straightRatio) * (1 + (randFloat() - 0.5) * 0.06), 2), 4.5);
      let accel;
      if (paceLevel === 0) accel = randFloat() * 0.3 + 0.5;
      else if (paceLevel === 1) accel = randFloat() * 0.25 + 0.35;
      else accel = randFloat() * 0.2 + 0.2;
      const stepBase = paceLevel === 0 ? randFloat() * 0.15 + 1.55 : paceLevel === 1 ? randFloat() * 0.15 + 1.45 : paceLevel === 2 ? randFloat() * 0.15 + 1.35 : randFloat() * 0.15 + 1.25;
      const stepLen = stepBase * (1 + (randFloat() - 0.5) * 0.06);
      const cadence = Math.min(Math.max(Math.trunc(avgSpeed / stepLen * 60), 145), 180);
      return {
        straightSpeed: round(straight, 1),
        curveSpeed: round(curve, 1),
        maxAccel: round(accel, 1),
        stepLengthM: round(stepLen, 2),
        cadenceSpm: cadence,
        gpsIntervalMs: 2e3
      };
    }
    function formatPace(secPerKm) {
      if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "-";
      const m = Math.floor(secPerKm / 60);
      const s = Math.round(secPerKm % 60);
      return `${m}'${String(s).padStart(2, "0")}"`;
    }
    function formatDuration(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return "-";
      const m = Math.floor(seconds / 60);
      const s = Math.round(seconds % 60);
      return `${m}'${String(s).padStart(2, "0")}"`;
    }
    function sanityCheck(cfg, distanceKm, avgSpeed) {
      const warnings = [];
      const pace = avgSpeed > 0 ? 1e3 / avgSpeed : 0;
      if (avgSpeed > 4.8) warnings.push(`\u5747\u901F ${avgSpeed.toFixed(2)} m/s \u504F\u5FEB\uFF08>4.8 m/s \u53EF\u80FD\u89E6\u53D1\u300C\u901F\u5EA6\u8FC7\u5FEB\u300D\u5224\u5B9A\uFF09`);
      if (avgSpeed < 2 && avgSpeed > 0) warnings.push(`\u5747\u901F ${avgSpeed.toFixed(2)} m/s \u504F\u6162\uFF08<2.0 m/s\uFF09`);
      if (pace > 0 && pace < 180) warnings.push(`\u914D\u901F ${formatPace(pace)} \u5FEB\u4E8E\u5B89\u5168\u4E0B\u9650 3'00"/km`);
      if (pace > 600) warnings.push(`\u914D\u901F ${formatPace(pace)} \u6162\u4E8E\u5B89\u5168\u4E0A\u9650 10'00"/km`);
      if (cfg.cadenceSpm > 180) warnings.push(`\u6B65\u9891 ${cfg.cadenceSpm} spm \u504F\u9AD8\uFF08\u771F\u5B9E 145~173\uFF09`);
      if (cfg.stepLengthM < 1.2) warnings.push(`\u6B65\u957F ${cfg.stepLengthM.toFixed(2)}m \u504F\u5C0F\uFF08\u771F\u5B9E 1.41~1.71m\uFF09`);
      if (Number(cfg.curveSpeed) > Number(cfg.straightSpeed)) {
        warnings.push(`\u5F2F\u9053\u901F\u5EA6 ${cfg.curveSpeed} \u9AD8\u4E8E\u76F4\u9053\u901F\u5EA6 ${cfg.straightSpeed}\uFF08\u771F\u5B9E\u8DD1\u6B65\u4E00\u822C\u76F4\u9053\u66F4\u5FEB\uFF09`);
      }
      const hasSpeeds = Number.isFinite(Number(cfg.straightSpeed)) && Number.isFinite(Number(cfg.curveSpeed));
      const meanSpeed = hasSpeeds ? (Number(cfg.straightSpeed) + Number(cfg.curveSpeed)) / 2 : avgSpeed;
      const derivedSpeed = cfg.stepLengthM * cfg.cadenceSpm / 60;
      if (meanSpeed > 0 && Math.abs(derivedSpeed - meanSpeed) / meanSpeed > 0.2) {
        warnings.push(`\u6B65\u957F\xD7\u6B65\u9891\u63A8\u51FA\u901F\u5EA6 ${derivedSpeed.toFixed(2)} m/s \u4E0E${hasSpeeds ? "\u914D\u7F6E\u5747\u901F" : "\u5B9E\u9645\u5747\u901F"} ${meanSpeed.toFixed(2)} m/s \u5DEE\u8D85\u8FC7 20%`);
      }
      if (cfg.sensorIntensity < 0.8 || cfg.sensorIntensity > 1.1) {
        warnings.push(`\u4F20\u611F\u5668\u5F3A\u5EA6 ${cfg.sensorIntensity.toFixed(2)} \u8D8A\u754C\uFF08\u5C06\u88AB\u5939\u7D27\u5230 0.80~1.10\uFF09`);
      } else if (cfg.sensorIntensity < 0.85 || cfg.sensorIntensity > 1.05) {
        warnings.push(`\u4F20\u611F\u5668\u5F3A\u5EA6 ${cfg.sensorIntensity.toFixed(2)} \u5728\u63A8\u8350\u533A\u95F4(0.85~1.05)\u4E4B\u5916`);
      }
      return warnings;
    }
    module2.exports = { PACE_OPTIONS, calculate, formatPace, formatDuration, sanityCheck };
  }
});


export const {PACE_OPTIONS,calculate,sanityCheck,formatPace}=require_pace();
