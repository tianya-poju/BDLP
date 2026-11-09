import { h, svg, toast, openModal } from "../../util.js";
import { api } from "../../api.js";
import { openSchoolPicker, openZonePicker, kvList } from "../../components.js";

import { reqBadge, paceSecText, fmtCfgAge } from "./helpers.js";
export function createEnvironment({
  app,
  envCard,
  envHeadNote,
  schoolSlot,
  zoneSlot,
  requirementCard,
  schedulePreview,
  goAlipay,
  testAlipayLaunch,
}) {
  function renderEnv() {
    const a = app.state.account;
    const z = app.state.zone || {};
    const fenceN = (z.fence || []).length;
    const bound = Boolean(z.id);

    envHeadNote.textContent = a.schoolName || "";
    schoolSlot.innerHTML = "";
    schoolSlot.append(
      ...[
        h("div", { class: "env-row" }, [
          h("span", { class: "env-k", text: "学校" }),
          h(
            "span",
            { class: "env-v" },
            [
              h("span", {
                class: "env-main",
                text: a.schoolId
                  ? a.schoolName || `学校 ${a.schoolId}`
                  : "未设置",
              }),
              a.schoolId
                ? h("span", {
                    class: "env-sub",
                    text: `ID ${a.schoolId}${a.studentNum ? ` · 学号 ${a.studentNum}` : ""}`,
                  })
                : null,
            ].filter(Boolean),
          ),
          h("button", {
            class: "btn btn-sm",
            text: a.schoolId ? "更换" : "选择",
            onClick: () => openSchoolPicker(app),
          }),
        ]),
        a.schoolId
          ? null
          : h("p", {
              class: "hint danger",
              text: globalThis.LEPAO_TRIAL
                ? "未设置学校会导致人脸核验报「参数异常」。"
                : "未设置学校会导致上传、人脸核验报「参数异常」。",
            }),
      ].filter(Boolean),
    );

    zoneSlot.innerHTML = "";
    zoneSlot.append(
      ...[
        h("div", { class: "env-row" }, [
          h("span", { class: "env-k", text: "跑区" }),
          h(
            "span",
            { class: "env-v" },
            [
              h("span", {
                class: "env-main",
                text: bound ? z.name || `跑区 ${z.id}` : "未绑定",
              }),
              bound
                ? h("span", {
                    class: "env-sub",
                    text: fenceN >= 3 ? `围栏 ${fenceN} 点` : "无围栏",
                  })
                : null,
            ].filter(Boolean),
          ),
          h(
            "span",
            { class: "env-actions" },
            [
              h("button", {
                class: "btn btn-sm",
                text: bound ? "更换" : "选择",
                onClick: () => openZonePicker(app),
              }),
              bound && fenceN < 3
                ? h("button", {
                    class: "btn btn-sm",
                    text: "获取围栏",
                    onClick: fetchFence,
                  })
                : null,
            ].filter(Boolean),
          ),
        ]),
        // 只在「没绑定 / 没围栏」时给一句必要提示
        !bound
          ? h("p", {
              class: "hint warn",
              text: "未绑定跑区：会按自由跑提交，没有围栏校验。",
            })
          : fenceN >= 3
            ? null
            : h("p", {
                class: "hint warn",
                text: "还没取到围栏，点「获取围栏」从 beforeRun 取一次。",
              }),
      ].filter(Boolean),
    );
  }

  /** 环境卡的外壳只建一次，重渲染只换里面的两行 */
  function mountEnvCard() {
    envCard.innerHTML = "";
    envCard.append(
      h("div", { class: "card-head" }, [
        h("h3", { text: "位置" }),
        envHeadNote,
      ]),
      h("div", { class: "card-body tight" }, [
        schoolSlot,
        h("div", { class: "divider" }),
        zoneSlot,
      ]),
    );
  }

  function showDiagnosis(res) {
    const d = res.diagnosis;
    const body = [
      h(
        "div",
        { class: "col" },
        d.configLines.map((l) =>
          h("div", { class: "kv" }, [
            h("span", { class: "k", text: "·" }),
            h("span", { class: "v", text: l, style: { textAlign: "left" } }),
          ]),
        ),
      ),
      h("div", { class: "divider" }),
      h(
        "div",
        { class: "col" },
        [
          h("span", { class: "small muted", text: "本次提交必发字段" }),
          h("p", {
            class: "mono xs",
            text: d.neededFields.join(", "),
            style: { wordBreak: "break-all", color: "var(--text-dim)" },
          }),
          d.skippedFields.length
            ? h("span", { class: "small muted", text: "按配置不发" })
            : null,
          d.skippedFields.length
            ? h("p", {
                class: "mono xs",
                text: d.skippedFields.join(", "),
                style: { wordBreak: "break-all", color: "var(--text-mute)" },
              })
            : null,
        ].filter(Boolean),
      ),
      d.unsupported.length
        ? h("div", { class: "col" }, [
            h("span", {
              class: "small",
              text: "⚠ 学校开了但我们扛不住",
              style: { color: "var(--warn-text)" },
            }),
            ...d.unsupported.map((u) =>
              h("p", { class: "hint warn", text: `· ${u}` }),
            ),
          ])
        : null,
      res.brData
        ? h("details", { class: "fold" }, [
            h("summary", { text: "beforeRun 关键字段" }),
            h("div", { class: "fold-body" }, [
              kvList([
                [
                  "跑区",
                  `${res.brData.runZoneName}（game_id ${res.brData.gameId}）`,
                ],
                ["学期", `term_id ${res.brData.termId}`],
                [
                  "距离区间",
                  `${res.brData.minDistance.toFixed(2)} ~ ${res.brData.maxDistance.toFixed(2)} km`,
                ],
                [
                  "配速区间",
                  `${res.brData.maxPace || "-"} ~ ${res.brData.minPace || "-"}（秒/km，服务端口径见诊断行）`,
                ],
                [
                  "打卡",
                  `点 ${res.brData.pointNum} × 重复 ${res.brData.repeatNum}`,
                ],
                ["围栏顶点", String((res.brData.fence || []).length)],
              ]),
            ]),
          ])
        : null,
    ].filter(Boolean);
    const modal = openModal({
      title: "跑区配置诊断",
      body,
      footer: [
        h("button", {
          class: "btn btn-primary",
          text: "知道了",
          onClick: () => modal.close(),
        }),
      ],
      wide: true,
    });
  }

  // ─────────── 跑区（已合并进环境卡） ───────────

  /** 获取围栏（走诊断链路：beforeRun 是围栏的唯一来源，且需要已绑定跑区） */
  async function fetchFence(ev) {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "获取中…";
    try {
      const res = await api.diagnose();
      await app.refresh();
      if (Number(res.status) !== 1) {
        toast(res.info || "获取失败", "warn");
        return;
      }
      const n = Number(res.fenceCount || 0);
      toast(
        n >= 3
          ? `✓ 已获取围栏（${n} 顶点）`
          : "服务端未下发围栏（该跑区可能没有围栏）",
        n >= 3 ? "ok" : "warn",
      );
    } catch (err) {
      toast(`获取失败：${err.message}`, "danger");
    } finally {
      btn.disabled = false;
      btn.textContent = "获取围栏";
    }
  }

  // ─────────── 本跑区要求（只读） ───────────
  function renderRequirement() {
    const cfg = app.state.zoneConfig;
    const sum = (cfg && cfg.summary) || null;
    requirementCard.innerHTML = "";

    async function reload(ev) {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await api.zoneConfig(true);
        if (Number(res.status) !== 1 || !res.config) {
          toast(res.info || "读取跑区要求失败", "warn", 5600);
          return;
        }
        app.state.zoneConfig = res.config;
        renderRequirement();
        renderEnv();
        schedulePreview();
        toast("✓ 已刷新本跑区要求", "ok");
      } catch (e) {
        toast(`读取失败：${e.message}`, "danger");
      } finally {
        btn.disabled = false;
      }
    }

    async function detailed(ev) {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "诊断中…";
      try {
        const res = await api.diagnose();
        await app.refresh();
        if (Number(res.status) === 1) showDiagnosis(res);
        else toast(res.info || "诊断失败", "warn");
      } catch (e) {
        toast(e.message, "danger");
      } finally {
        btn.disabled = false;
        btn.textContent = "查看完整诊断";
      }
    }

    const head = h("div", { class: "card-head" }, [
      h("h3", { text: "本跑区要求" }),
      h("div", { class: "row" }, [
        h("span", {
          class: "head-note",
          text: cfg ? fmtCfgAge(cfg.fetchedAt) : "未加载",
        }),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            "aria-label": "刷新跑区要求",
            onClick: reload,
          },
          [svg("refresh", 16)],
        ),
      ]),
    ]);

    if (!cfg || !sum) {
      requirementCard.append(
        head,
        h("div", { class: "card-body" }, [
          h("p", {
            class: "hint",
            text: app.state.account.schoolId
              ? "登录后自动读取，12 小时内复用。"
              : "先选择学校，登录后会自动读取。",
          }),
          h("button", {
            class: "btn btn-sm btn-block",
            text: "读取跑区要求",
            disabled: !app.state.account.schoolId,
            onClick: reload,
          }),
        ]),
      );
      return;
    }

    const t = sum.time || {};
    const th = sum.thresholds || {};
    const ck = sum.checkins || {};
    const cap = sum.capture || {};
    const face = sum.face || {};
    const checks = sum.checks || {};

    const chips = [
      t.inWindow ? reqBadge("时段内", "ok") : reqBadge("不在时段", "danger"),
    ];
    if (cap.on)
      chips.push(
        cap.type === 1
          ? reqBadge("抓拍 · 照片模拟", "warn")
          : reqBadge("抓拍 · 可能漏拍", "warn"),
      );
    if (face.on) {
      const parts = [];
      if (face.start === 1) parts.push("开始");
      if (face.middle === 1) parts.push(`中途${face.num}次`);
      if (face.stop === 1) parts.push("结束");
      chips.push(
        face.type !== 1
          ? reqBadge("人脸 · 支付宝", "danger")
          : reqBadge(`人脸 ${parts.join("/") || "开启"}`),
      );
    }
    if (checks.time) chips.push(reqBadge("校时"));
    if (checks.device) chips.push(reqBadge("设备指纹"));
    if (checks.geetest || checks.geeDevice)
      chips.push(reqBadge("极验 · 需人工", "warn"));
    if (checks.deepknow) chips.push(reqBadge("数美", "warn"));
    if (checks.shumeng) chips.push(reqBadge("数盟", "warn"));

    const distText =
      Number(th.maxDistance) > 0
        ? `${Number(th.minDistance).toFixed(1)}~${Number(th.maxDistance).toFixed(1)} km`
        : Number(th.minDistance) > 0
          ? `≥ ${Number(th.minDistance).toFixed(1)} km`
          : "距离不限";
    const paceText =
      Number(th.maxPace) > 0 &&
      Number(th.minPace) > 0 &&
      Number(th.maxPace) < Number(th.minPace)
        ? `${paceSecText(th.maxPace)}~${paceSecText(th.minPace)}/km`
        : "配速不限";
    const thresholdText = t.ruleText
      ? `${t.ruleText.dist} · ${t.ruleText.pace} · ${t.ruleText.points}`
      : `${distText} · ${paceText} · 打卡 ${ck.required || 0} 次`;

    // 只提示「当前设置与要求不匹配」，绝不自动改用户的路线 / 参数 —— 避免学校配置互相覆盖
    const hints = [];
    if (!t.inWindow)
      hints.push("当前不在锻炼时段，校园跑会中止；如需立即跑请用「自由跑」。");
    if (t.rule) {
      const r = t.rule;
      const routeKm = Number((app.state.route || {}).distanceKm || 0);
      if (r.minDistanceKm > 0 && routeKm > 0 && routeKm < r.minDistanceKm) {
        hints.push(
          `当前路线 ${routeKm.toFixed(2)}km 低于本时段最低 ${r.minDistanceKm.toFixed(1)}km`,
        );
      }
      if (r.maxDistanceKm > 0 && routeKm > r.maxDistanceKm) {
        hints.push(
          `当前路线 ${routeKm.toFixed(2)}km 超过本时段最高 ${r.maxDistanceKm.toFixed(1)}km`,
        );
      }
      if (r.hasPaceLimit) {
        const cfgRun = app.state.runConfig || {};
        [
          ["直道", cfgRun.straightSpeed],
          ["弯道", cfgRun.curveSpeed],
        ].forEach(([label, mps]) => {
          const speed = Number(mps || 0);
          if (speed <= 0) return;
          const pace = Math.trunc(1000 / speed);
          if (pace < r.maxPaceSec || pace > r.minPaceSec) {
            hints.push(
              `${label}配速 ${paceSecText(pace)}/km 超出本时段 ${paceSecText(r.maxPaceSec)}~${paceSecText(r.minPaceSec)}/km`,
            );
          }
        });
      }
    }

    requirementCard.append(
      head,
      h("div", { class: "card-body" }, [
        h("div", { class: "req-chips" }, chips),
        h("div", { class: "req-line" }, [
          h("span", { class: "k", text: "时段" }),
          h("span", { class: "v", text: t.message || "未限制锻炼时段" }),
        ]),
        h("div", { class: "req-line" }, [
          h("span", { class: "k", text: "阈值" }),
          h("span", { class: "v", text: thresholdText }),
        ]),
        h("div", { class: "req-line" }, [
          h("span", { class: "k", text: "打卡" }),
          h("span", {
            class: "v",
            text: ck.required
              ? `${ck.required} 次${Number(ck.logMode) === 2 ? " · 定向顺序" : ""}`
              : "无要求",
          }),
        ]),
        ...hints.map((x) => h("p", { class: "hint warn", text: `⚠ ${x}` })),
        (cfg.blocked || []).length
          ? h("p", {
              class: "hint danger",
              text: `✕ ${cfg.blocked.join("；")}`,
            })
          : null,
        h("div", { class: "btn-row" }, [
          h("button", {
            class: "btn btn-sm",
            text: "查看完整诊断",
            onClick: detailed,
          }),
          face.on && face.type !== 1
            ? h("button", {
                class: "btn btn-sm",
                text: "去支付宝刷脸",
                onClick: goAlipay,
              })
            : null,
          h("button", {
            class: "btn btn-sm",
            text: "测试拉起",
            onClick: testAlipayLaunch,
          }),
        ]),
      ]),
    );
  }

  return { renderEnv, mountEnvCard, renderRequirement };
}
