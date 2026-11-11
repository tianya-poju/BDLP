import { updateControls } from "../updates.js";
/* 设置页：账号 / 数据（设备信息只在登录页维护） */
("use strict");

import { h, toast, fmtShortTime } from "../util.js";
import { api } from "../api.js";
import { openAccountSwitcher, refreshSchoolTable } from "../components.js";

/* 试用版由构建开关控制（正式运行未定义 → 全部为 false） */

export function SettingsView(app) {
  const root = h("div", { class: "view" });
  let aboutUpdates = null;
  render();

  function render() {
    aboutUpdates?.destroy();
    root.innerHTML = "";
    const s = app.state;
    const a = s.account;

    // ── 账号 ──
    const accounts = s.accounts || [];
    root.appendChild(
      h("div", { class: "card" }, [
        h("div", { class: "card-head" }, [
          h("h3", { text: "账号" }),
          h("span", {
            class: "head-note",
            text: accounts.length > 1 ? `${accounts.length} 个档案` : "",
          }),
        ]),
        h("div", { class: "card-body" }, [
          h("div", {}, [
            kv(
              "当前",
              a.uid ? a.label || a.nickname || `UID ${a.uid}` : "未登录",
            ),
            kv("UID", a.uid || "-"),
            kv(
              "学校",
              a.schoolName
                ? `${a.schoolName}（ID ${a.schoolId}）`
                : a.schoolId
                  ? `ID ${a.schoolId}`
                  : "未设置",
            ),
            kv("学号", a.studentNum || "-"),
            kv(
              "跑区",
              s.zone.name ? `${s.zone.name}（ID ${s.zone.id}）` : "未查询",
            ),
          ]),
          h("p", {
            class: "hint",
            text: "设备、参数、路线与跑区按账号分别保存",
          }),
          h(
            "div",
            { class: "btn-row" },
            [
              h("button", {
                class: "btn",
                text: "账号管理",
                onClick: () => openAccountSwitcher(app),
              }),
              h("button", {
                class: "btn",
                text: "添加账号",
                onClick: () => app.openAddAccount && app.openAddAccount(),
              }),
              a.uid
                ? h("button", {
                    class: "btn btn-danger",
                    text: "退出登录",
                    // 走统一入口：弹出「保留档案 / 删除档案」二选一（文案与行为只在一处维护）
                    onClick: () => app.doLogout && app.doLogout(),
                  })
                : null,
            ].filter(Boolean),
          ),
        ]),
      ]),
    );

    // ── 数据 ──
    // 试用版不展示、也不读取任何上传留痕
    const uploads = globalThis.LEPAO_TRIAL ? [] : s.uploads || [];
    const uploadHistory = globalThis.LEPAO_TRIAL
      ? null
      : uploads.length === 0
        ? h("p", { class: "hint", text: "还没有上传记录" })
        : h(
            "div",
            {},
            uploads.map((u) =>
              h("div", { class: "kv" }, [
                h("span", {
                  class: "k",
                  text: `${u.mode === "campus" ? "校园跑" : "自由跑"} · ${fmtShortTime(u.time / 1000)}`,
                }),
                h("span", {
                  class: `v ${u.ok ? "ok" : "warn"}`,
                  text: u.recordId ? `#${u.recordId}` : u.status || "",
                }),
              ]),
            ),
          );
    root.appendChild(
      h("div", { class: "card" }, [
        h("div", { class: "card-head" }, [
          h("h3", { text: "最近提交" }),
          h("span", {
            class: "head-note",
            text:
              !globalThis.LEPAO_TRIAL && uploads.length
                ? `${uploads.length} 条上传`
                : "",
          }),
        ]),
        h("div", { class: "card-body tight" }, [
          uploadHistory,
          uploadHistory ? h("div", { class: "divider" }) : null,
          h("button", {
            class: "btn btn-sm btn-block",
            text: "刷新学校表（联网合并）",
            onClick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              btn.textContent = "刷新中…";
              try {
                const res = await refreshSchoolTable(app);
                if (!res.all)
                  toast(res.info || "服务端未返回学校表", "warn", 6000);
                else if (res.saved)
                  toast(`✓ 已刷新 ${res.all} 所，并写回内置学校表`, "ok");
                else
                  toast(
                    `✓ 已刷新 ${res.all} 所（写入失败，仅本次运行生效）`,
                    "warn",
                    6000,
                  );
              } catch (e) {
                toast(`刷新失败：${e.message}`, "danger");
              } finally {
                btn.disabled = false;
                btn.textContent = "刷新学校表（联网合并）";
              }
            },
          }),
          app.android
            ? null
            : h("div", {}, [kv("数据保护", "Windows 当前用户加密")]),
        ]),
      ]),
    );

    // ── 设备（当前指纹摘要 + 可选补充字段） ──
    const dev = s.device || {};
    const oaidInput = h("input", {
      class: "input mono",
      placeholder: "留空 = 不发送",
      value: dev.oaid || "",
    });
    const macInput = h("input", {
      class: "input mono",
      placeholder: "留空 = 不发送",
      value: dev.mac || "",
    });
    root.appendChild(
      h("div", { class: "card" }, [
        h("div", { class: "card-head" }, [
          h("h3", { text: "设备" }),
          h("span", { class: "head-note", text: "可选补充" }),
        ]),
        h("div", { class: "card-body tight" }, [
          h("div", {}, [
            kv("设备ID", dev.id || "-"),
            kv(
              "机型",
              dev.model
                ? `${dev.model} · Android ${dev.osVersion || "-"}`
                : "-",
            ),
            kv("来源", dev.source || "-"),
          ]),
          h("div", { class: "divider" }),
          h("p", {
            class: "hint",
            text: "官方校园跑会带 OAID / WLAN MAC；留空就不发，不影响已能通过的提交。",
          }),
          h("div", { class: "field" }, [
            h("label", { text: "OAID" }),
            oaidInput,
          ]),
          h("div", { class: "field" }, [
            h("label", { text: "WLAN MAC" }),
            macInput,
          ]),
          h("button", {
            class: "btn btn-sm btn-block",
            text: "保存补充字段",
            onClick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              try {
                await api.saveDeviceExtra(
                  oaidInput.value.trim(),
                  macInput.value.trim(),
                );
                toast("✓ 已保存（下次提交生效）", "ok");
                await app.refresh();
              } catch (e) {
                toast(`保存失败：${e.message}`, "danger");
              } finally {
                btn.disabled = false;
              }
            },
          }),
        ]),
      ]),
    );

    root.appendChild(
      h("div", { class: "card" }, [
        h("div", { class: "card-head" }, [h("h3", { text: "登录状态" })]),
        h("div", { class: "card-body" }, [
          h("p", {
            class: "hint",
            text:
              app.lastSessionMessage?.uid === app.state.activeUid
                ? app.lastSessionMessage.message
                : "",
          }),
          h("button", {
            class: "btn btn-block",
            text: "检测登录状态",
            onClick: async () => {
              try {
                const r = await api.checkSession();
                app.lastSessionMessage = {
                  uid: app.state.activeUid,
                  message: r.message,
                };
                toast(r.message, r.loggedIn ? "ok" : "warn");
                await app.refresh();
              } catch (e) {
                toast(e.message, "danger");
              }
            },
          }),
        ]),
      ]),
    );
    if (app.windowSettingsCard) root.appendChild(app.windowSettingsCard());
    aboutUpdates = updateControls(s.version, app.android);
    root.appendChild(
      h("div", { class: "card about-card" }, [
        h("div", { class: "card-head" }, [h("h3", { text: "关于" })]),
        h("div", { class: "card-body" }, [
          h("p", { text: `不道乐跑 ${s.version || "读取中"} · 作者：破局` }),
          aboutUpdates?.el,
          h("p", {
            class: "hint danger",
            text: "仅供学习研究，请遵守学校规定与平台协议。",
          }),
        ]),
      ]),
    );
  }

  function kv(k, v) {
    return h("div", { class: "kv" }, [
      h("span", { class: "k", text: k }),
      h("span", { class: "v", text: v }),
    ]);
  }

  return { el: root, refresh: render, destroy: () => aboutUpdates?.destroy() };
}
