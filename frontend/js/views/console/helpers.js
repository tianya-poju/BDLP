import { h } from "../../util.js";

import { renderMadBar, madZone } from "../../charts.js";

export function legendItem(name, color) {
  return h("span", { class: "legend-item" }, [
    h("i", { class: "dot", style: { background: color } }),
    h("span", { text: name }),
  ]);
}

/** 跑区要求状态徽标 */
export function reqBadge(text, tone = "") {
  return h("span", { class: `badge${tone ? ` ${tone}` : ""}`, text });
}

/** 秒/公里 → m'ss" */
export function paceSecText(sec) {
  const s = Math.trunc(Number(sec) || 0);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, "0")}"`;
}

/** 配置缓存时间的人话（本跑区要求 12h 过期） */
export function fmtCfgAge(ts) {
  const m = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 60000));
  if (m < 1) return "刚刚更新";
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

/** 传感器自检：MAD 强度区间条 + 实测读数（正常窗口占比是官方 runStatus 的核心指标） */
export function sensorCheck(sc) {
  const zone = madZone(sc.median);
  const bar = h("div", { class: "pacebar" });
  renderMadBar(bar, sc.median);
  return h("div", { class: "col", style: { gap: "6px" } }, [
    h("div", { class: "divider" }),
    h("div", { class: "between" }, [
      h("span", {
        class: "hint xs",
        text: `跑步强度 · MAD 中位 ${sc.median.toFixed(2)}`,
      }),
      h("span", {
        class: `badge${zone.tone ? ` ${zone.tone}` : ""}`,
        text: zone.name,
      }),
    ]),
    bar,
    h("span", {
      class: "hint xs mono",
      text: `正常窗口 ${sc.status1Pct.toFixed(0)}% · ${sc.samples} 点 · MAD ${sc.min.toFixed(2)}~${sc.max.toFixed(2)}`,
    }),
  ]);
}
