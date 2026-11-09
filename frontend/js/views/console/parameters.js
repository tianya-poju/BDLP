import { h, toast } from "../../util.js";
import { api } from "../../api.js";

export function createParameters({ app, paramCard, schedulePreview }) {
  let cancelMad = () => {};
  function slider({
    label,
    value,
    min,
    max,
    step,
    unit,
    onChange,
    hint,
    decimals,
  }) {
    /** 显示位数（如强度 1 → 1.00） */
    const disp = (v) =>
      decimals != null ? Number(v).toFixed(decimals) : String(v);
    const valEl = h("span", {
      class: "field-val",
      text: `${disp(value)}${unit || ""}`,
    });
    /** 已滑过部分高亮（CSS 用 --fill 画线性渐变） */
    const pctOf = (v) =>
      `${((Number(v) - Number(min)) / Math.max(Number(max) - Number(min), 1e-6)) * 100}%`;
    const input = h("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      style: { "--fill": pctOf(value) },
      onInput: (e) => {
        const v = Number(e.target.value);
        valEl.textContent = `${disp(v)}${unit || ""}`;
        e.target.style.setProperty("--fill", pctOf(v));
        onChange && onChange(v);
      },
    });
    return h(
      "div",
      { class: "field" },
      [
        h("div", { class: "field-row" }, [h("label", { text: label }), valEl]),
        input,
        hint ? h("span", { class: "hint xs", text: hint }) : null,
      ].filter(Boolean),
    );
  }

  function renderParams() {
    cancelMad();
    const cfg = app.state.runConfig;
    paramCard.innerHTML = "";
    const madBadge = h("span", { class: "badge", text: "—" });
    const madDetail = h("span", {
      class: "hint xs",
      text: "调参后按官方算法实算",
    });
    const madRow = h("div", { class: "mad-row" }, [madBadge, madDetail]);
    /** 心跳节奏的「约 X 秒/次」提示：切档时立即更新，不等重渲染 */
    const heartbeatNote = h("span", {
      class: "hint xs mono",
      text: `约 ${Math.round((Number(cfg.replayDelayMs ?? 20) * 30) / 1000)} 秒 / 次`,
    });
    let madTimer = null;
    let madSeq = 0;
    cancelMad = () => {
      madSeq++;
      if (madTimer) clearTimeout(madTimer);
    };
    /**
     * 传感器 MAD 实算（对齐 nine 的做法）：防抖 420ms → 服务端真合成一段波形、
     * 按官方算法算窗口 MAD 统计，而不是「3.40 × 强度」的线性估算。
     */
    function scheduleMad() {
      if (madTimer) clearTimeout(madTimer);
      const seq = ++madSeq;
      const c = app.state.runConfig;
      madBadge.className = "badge";
      madBadge.textContent = "计算中";
      madDetail.textContent = "本地模拟计算…";
      madTimer = setTimeout(async () => {
        try {
          const res = await api.simulateSensor({
            intensity: Number(c.sensorIntensity),
            cadenceSpm: Number(c.cadenceSpm),
          });
          if (seq !== madSeq) return; // 过期响应丢弃（拖滑杆时不回跳）
          const m = res.mad || {};
          if (m.error) {
            madBadge.textContent = "—";
            madDetail.textContent = m.error;
            return;
          }
          const tone =
            m.status === 1 ? "ok" : m.status === 3 ? "warn" : "danger";
          madBadge.className = `badge ${tone}`;
          madBadge.textContent = `中位 ${m.median.toFixed(2)} · status ${m.status}`;
          madDetail.textContent = `窗口 ${m.min.toFixed(2)}~${m.max.toFixed(2)} · 正常占比 ${Math.round(m.status1Pct)}%（判定带 2.0~5.0）`;
        } catch (e) {
          if (seq !== madSeq) return;
          madBadge.textContent = "—";
          madDetail.textContent = `实算失败：${e.message}`;
        }
      }, 420);
    }

    const paceChips = h(
      "div",
      { class: "chips equal" },
      app.state.paceOptions.map((o) =>
        h(
          "button",
          {
            class: "chip",
            "aria-pressed": String(Number(cfg.paceLevel) === o.level),
            onClick: async () => {
              const res = await api.paceFor(o.level);
              Object.assign(app.state.runConfig, res.runConfig);
              renderParams();
              schedulePreview();
              toast(
                `已按「${o.name}」档生成参数：直道 ${res.paceResult.straightSpeed} / 弯道 ${res.paceResult.curveSpeed} m/s · ${res.paceResult.cadenceSpm} spm`,
                "ok",
              );
            },
          },
          [
            h("span", { text: o.name }),
            h("span", { class: "chip-sub", text: o.range }),
          ],
        ),
      ),
    );

    const headNote = h("span", { class: "head-note" });
    const sumDetail = h("summary");
    const sumSpeed = h("summary");
    const sumSample = h("summary");
    const sumBody = h("summary");

    /** 折叠区摘要与顶部均速随参数变化同步刷新（否则改了滑块摘要仍是旧值） */
    function refreshSummaries(estimateMad = true) {
      const c = app.state.runConfig;
      headNote.textContent = `${((c.straightSpeed + c.curveSpeed) / 2).toFixed(2)} m/s 均速`;
      sumDetail.textContent = `高级参数 · 直道 ${c.straightSpeed} / 弯道 ${c.curveSpeed} · 采样 ${(c.gpsIntervalMs / 1000).toFixed(1)}s`;
      sumSpeed.textContent = `速度 · ${c.straightSpeed}/${c.curveSpeed} m/s · 加速度 ${c.maxAccel ?? 0.4}`;
      sumBody.textContent = `传感器 · ${c.cadenceSpm}spm · 强度 ${Number(c.sensorIntensity).toFixed(2)}×`;
      sumSample.textContent = `采样与节奏 · ${c.gpsIntervalMs}ms · 热身 ${c.warmupTime ?? 10}s / 冷却 ${c.cooldownTime ?? 8}s`;
      if (estimateMad) scheduleMad();
    }

    /** 真正会改变上传数据的字段（只有这些变时才需要重合成预览/重算传感器） */
    const PREVIEW_KEYS = new Set([
      "straightSpeed",
      "curveSpeed",
      "maxAccel",
      "cadenceSpm",
      "sensorIntensity",
      "gpsIntervalMs",
      "warmupTime",
      "cooldownTime",
      "stepLengthM",
    ]);
    const MAD_KEYS = new Set(["sensorIntensity", "cadenceSpm"]);

    const update = async (rawPatch) => {
      const patch = { ...rawPatch };
      // 步长不单独暴露（不参与提交，只用来自洽校验）：速度或步频变化时按「速度 × 60 / 步频」自动更新
      if (
        patch.straightSpeed !== undefined ||
        patch.curveSpeed !== undefined ||
        patch.cadenceSpm !== undefined
      ) {
        const merged = { ...app.state.runConfig, ...patch };
        const mean =
          (Number(merged.straightSpeed) + Number(merged.curveSpeed)) / 2;
        const cadence = Number(merged.cadenceSpm);
        if (mean > 0 && cadence > 0) {
          const len = Math.min(1.8, Math.max(1.0, (mean / cadence) * 60));
          patch.stepLengthM = Math.round(len * 100) / 100;
        }
      }
      const res = await api.saveConfig(patch);
      Object.assign(app.state.runConfig, res.runConfig);
      const touched = Object.keys(patch);
      const dataDirty = touched.some((k) => PREVIEW_KEYS.has(k));
      const madDirty = touched.some((k) => MAD_KEYS.has(k));
      refreshSummaries(madDirty);
      // 心跳节奏等纯回放参数不改变任何上传数据：不重合成预览（那是点击卡顿的真正来源）
      if (dataDirty) schedulePreview();
    };

    paramCard.append(
      h("div", { class: "card-head" }, [
        h("h3", { text: "跑步参数" }),
        headNote,
      ]),
      h("div", { class: "card-body" }, [
        paceChips,
        // 心跳节奏：控制回放时每个轨迹点的真实等待，间接决定 GPS 心跳的到达间隔
        h("div", { class: "col", style: { gap: "6px" } }, [
          h("div", { class: "between" }, [
            h("span", { class: "hint", text: "心跳节奏" }),
            heartbeatNote,
          ]),
          h(
            "div",
            { class: "chips equal" },
            [
              { v: 20, t: "瞬发", s: "几十秒" },
              { v: 500, t: "快速", s: "2~3 分钟" },
              { v: 2000, t: "拟真", s: "约 10 分钟" },
            ].map((o) =>
              h(
                "button",
                {
                  class: "chip",
                  "aria-pressed": String(
                    Number(cfg.replayDelayMs ?? 20) === o.v,
                  ),
                  onClick: (ev) => {
                    // 立即反馈选中态与提示（update 只落盘配置，不重绘卡片）
                    for (const b of Array.from(
                      ev.currentTarget.parentElement.children,
                    )) {
                      b.setAttribute("aria-pressed", "false");
                    }
                    ev.currentTarget.setAttribute("aria-pressed", "true");
                    heartbeatNote.textContent = `约 ${Math.round((o.v * 30) / 1000)} 秒 / 次`;
                    update({ replayDelayMs: o.v });
                  },
                },
                [
                  h("span", { text: o.t }),
                  h("span", { class: "chip-sub", text: o.s }),
                ],
              ),
            ),
          ),
          h("p", {
            class: "hint",
            text:
              "控制回放时每个轨迹点的等待（约 30 点 = 1 次 GPS 心跳）。瞬发最快；快速约 15 秒/次；" +
              "拟真约 60 秒/次。实际按学校返回的规则执行；参数预览不代表服务端已接受成绩。",
          }),
        ]),
        // 只保留会真正影响上传数据的项：速度（配速）/ 步频 / 传感器强度 / 采样与节奏。
        // 加速度、体重、步长不参与生成或提交（步长由速度与步频自动推导），不再占用界面。
        h("details", { class: "fold" }, [
          sumDetail,
          h("div", { class: "fold-body" }, [
            h("details", { class: "fold", open: true }, [
              sumSpeed,
              h("div", { class: "fold-body" }, [
                slider({
                  label: "直道速度",
                  value: cfg.straightSpeed,
                  min: 2.0,
                  max: 5.0,
                  step: 0.1,
                  unit: " m/s",
                  onChange: (v) => update({ straightSpeed: v }),
                }),
                slider({
                  label: "弯道速度",
                  value: cfg.curveSpeed,
                  min: 1.5,
                  max: 5.0,
                  step: 0.1,
                  unit: " m/s",
                  onChange: (v) => update({ curveSpeed: v }),
                }),
                slider({
                  label: "加速度",
                  value: cfg.maxAccel ?? 0.4,
                  min: 0.1,
                  max: 2.0,
                  step: 0.1,
                  unit: " m/s²",
                  hint: "限制每秒速度变化，越大越灵敏；影响直道/弯道之间的过渡",
                  onChange: (v) => update({ maxAccel: v }),
                }),
              ]),
            ]),
            h("details", { class: "fold" }, [
              sumBody,
              h("div", { class: "fold-body" }, [
                slider({
                  label: "步频",
                  value: cfg.cadenceSpm,
                  min: 140,
                  max: 180,
                  step: 1,
                  unit: " spm",
                  onChange: (v) => update({ cadenceSpm: v }),
                }),
                slider({
                  label: "传感器强度",
                  value: cfg.sensorIntensity,
                  min: 0.7,
                  max: 1.15,
                  step: 0.01,
                  unit: " ×",
                  decimals: 2,
                  hint: "建议 0.85~1.05 ×（提交时还有闭环自校准兜底）",
                  onChange: (v) => update({ sensorIntensity: v }),
                }),
                madRow,
              ]),
            ]),
            h("details", { class: "fold" }, [
              sumSample,
              h("div", { class: "fold-body" }, [
                slider({
                  label: "采样间隔",
                  value: cfg.gpsIntervalMs,
                  min: 500,
                  max: 5000,
                  step: 500,
                  unit: " ms",
                  onChange: (v) => update({ gpsIntervalMs: v }),
                }),
                h("p", {
                  class: "hint",
                  text: "点距超过服务端上限时会自动收紧",
                }),
                slider({
                  label: "热身时长",
                  value: cfg.warmupTime ?? 10,
                  min: 0,
                  max: 30,
                  step: 1,
                  unit: " s",
                  onChange: (v) => update({ warmupTime: v }),
                }),
                slider({
                  label: "冷却时长",
                  value: cfg.cooldownTime ?? 8,
                  min: 0,
                  max: 20,
                  step: 1,
                  unit: " s",
                  onChange: (v) => update({ cooldownTime: v }),
                }),
              ]),
            ]),
          ]),
        ]),
      ]),
    );
    refreshSummaries();
  }

  return { renderParams, destroy: () => cancelMad() };
}
