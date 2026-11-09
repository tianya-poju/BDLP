import {
  h,
  svg,
  fmtKm,
  fmtDuration,
  fmtPace,
  fmtPaceFromSpeed,
} from "../../util.js";
import { api } from "../../api.js";
import { statGrid } from "../../components.js";
import { drawSpeedCurve, drawSensorWave, renderPaceBar } from "../../charts.js";

import { legendItem, sensorCheck } from "./helpers.js";
export function createPreview({ app, previewCard }) {
  let previewTimer = null,
    previewSeq = 0;
  function schedulePreview() {
    previewSeq++;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(doPreview, 420);
  }

  async function doPreview() {
    const seq = ++previewSeq;
    const r = app.state.route;
    if (!r.points || r.points.length < 2) {
      previewCard.innerHTML = "";
      previewCard.append(
        h("div", { class: "card-head" }, [
          h("h3", { text: "全程数据预览 · 本地模拟" }),
        ]),
        h("div", {
          class: "empty",
          text: "先设置路线（至少 2 个拐点）才能预览",
        }),
      );
      return;
    }
    previewCard.innerHTML = `<div class="card-body"><div class="row"><span class="spinner"></span><span class="hint">正在合成数据…</span></div></div>`;
    try {
      let rules = null;
      try {
        rules = (await api.zoneConfig()).brData;
      } catch {}
      if (seq !== previewSeq) return;
      const res = await api.previewRoute(r.points, app.state.runConfig, rules);
      if (seq !== previewSeq) return;
      if (res.status !== 1) {
        previewCard.innerHTML = "";
        previewCard.append(
          h("div", { class: "card-body" }, [
            h("p", { class: "hint danger", text: res.info || "预览失败" }),
          ]),
        );
        return;
      }
      renderPreview(res);
    } catch (e) {
      if (seq !== previewSeq) return;
      previewCard.innerHTML = "";
      previewCard.append(
        h("div", { class: "card-body" }, [
          h("p", { class: "hint danger", text: `预览失败：${e.message}` }),
        ]),
      );
    }
  }

  function renderPreview(res) {
    const speedCanvas = h("canvas", { class: "chart" });
    const waveCanvas = h("canvas", { class: "chart sm" });
    const paceBar = h("div", { class: "pacebar" });
    const warnBox = h("div", { class: "col" });

    previewCard.innerHTML = "";
    previewCard.append(
      h("p", {
        class: "hint",
        text: res.estimated ? "规则未获取，仅为估算" : "按当前学校规则采样",
      }),
      h("div", { class: "card-head" }, [
        h("h3", { text: "全程数据预览 · 本地模拟" }),
        h("span", {
          class: "head-note",
          text: `${res.pointCount} 轨迹点 · ${res.laps || 1} 圈`,
        }),
      ]),
      h("div", { class: "card-body" }, [
        // 配速卡：标签在上、数值在下，单位与均速同行对齐
        h("div", { class: "col", style: { gap: "2px" } }, [
          h("span", { class: "hint xs", text: "平均配速" }),
          h(
            "div",
            { class: "row", style: { alignItems: "baseline", gap: "6px" } },
            [
              h("span", {
                class: "mono",
                text: fmtPace(res.paceSecPerKm),
                style: {
                  fontSize: "var(--fs-2xl)",
                  fontWeight: "600",
                  letterSpacing: "-0.5px",
                },
              }),
              h("span", { class: "hint mono", text: "/km" }),
              h("span", { class: "grow" }),
              h("span", {
                class: "hint mono",
                text: `${res.avgSpeed.toFixed(2)} m/s`,
              }),
            ],
          ),
        ]),
        paceBar,
        h("div", { class: "between" }, [
          h("span", {
            class: "hint xs mono",
            text: `最快 ${fmtPaceFromSpeed(res.maxSpeed)}`,
          }),
          h("span", {
            class: "hint xs mono",
            text: `最慢 ${fmtPaceFromSpeed(res.minSpeed)}`,
          }),
        ]),
        statGrid([
          { value: `${fmtKm(res.distanceKm)} km`, label: "距离" },
          { value: fmtDuration(res.durationS), label: "时长" },
          { value: `${res.steps} 步`, label: "步数" },
        ]),
        // 步频属于配置项（参数卡片已展示），这里只回显真正参与生成的一项
        h("div", { class: "row-wrap" }, [
          h("span", {
            class: "badge",
            text: `步频 ${app.state.runConfig.cadenceSpm} spm`,
          }),
        ]),
        h("div", { class: "col", style: { gap: "6px" } }, [
          h("div", { class: "inst-head" }, [
            h("span", { class: "name", text: "速度曲线 · 横轴累计距离" }),
            h("span", { class: "unit", text: "纵轴 m/s" }),
          ]),
          h("div", { class: "chart-panel" }, [speedCanvas]),
        ]),
        h(
          "div",
          { class: "col", style: { gap: "6px" } },
          [
            h("div", { class: "inst-head" }, [
              h("span", {
                class: "name",
                text: "传感器波形 · 首 3 秒原采样（60ms）",
              }),
              h("span", { class: "unit", text: "单位 m/s²" }),
            ]),
            h("div", { class: "chart-panel" }, [waveCanvas]),
            h("div", { class: "chart-legend" }, [
              legendItem("ax", "var(--axis-x)"),
              legendItem("ay", "var(--axis-y)"),
              legendItem("az", "var(--axis-z)"),
            ]),
            res.sensorSelfCheck ? sensorCheck(res.sensorSelfCheck) : null,
          ].filter(Boolean),
        ),
        warnBox,
      ]),
    );

    renderPaceBar(paceBar, res.paceSecPerKm);
    requestAnimationFrame(() => {
      drawSpeedCurve(speedCanvas, res.speedCurve, res.avgSpeed);
      drawSensorWave(waveCanvas, res.sensorWave);
    });

    warnBox.innerHTML = "";
    warnBox.appendChild(
      h(
        "div",
        { class: "checklist" },
        res.warnings.length === 0
          ? [
              h("div", { class: "check-item ok" }, [
                svg("check", 15),
                h("span", { text: "本地参数检查通过" }),
              ]),
            ]
          : res.warnings.map((w) =>
              h("div", { class: "check-item warn" }, [
                svg("info", 15),
                h("span", { text: w }),
              ]),
            ),
      ),
    );
  }

  return {
    schedulePreview,
    doPreview,
    destroy: () => {
      previewSeq++;
      api.cancelPreviews();
      clearTimeout(previewTimer);
    },
  };
}
