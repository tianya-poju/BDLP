import { h, toast, confirmDialog } from "../util.js";
import { api } from "../api.js";
import { devicePresetSelect } from "../components.js";
export function LoginView(app) {
  let destroyed = false,
    wxSid = null,
    pollTimer = null,
    requestSeq = 0;
  const message = h("p", {
    class: "hint",
    text: "使用本人账号扫码并在手机上确认。",
  });
  const wxImage = h("img", {
    alt: "微信登录二维码",
    style: {
      width: "220px",
      height: "220px",
      display: "none",
      margin: "0 auto",
    },
  });
  const wxNote = h("p", { class: "hint", text: "点击下方按钮获取二维码" });
  async function cancelWx() {
    requestSeq++;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    const sid = wxSid;
    wxSid = null;
    if (sid) await api.wechatLoginCancel(sid).catch(() => {});
  }
  async function poll(sid) {
    if (destroyed || sid !== wxSid) return;
    try {
      const r = await api.wechatLoginPoll(sid);
      if (destroyed || sid !== wxSid) return;
      wxNote.textContent = r.message;
      if (r.status === "done") {
        wxSid = null;
        return;
      }
      if (r.status === "error") {
        wxSid = null;
        wxImage.style.display = "none";
        return;
      }
      pollTimer = setTimeout(() => poll(sid), 1500);
    } catch (e) {
      if (destroyed || sid !== wxSid) return;
      wxNote.textContent = String(e);
      await cancelWx();
    }
  }
  const wxButton = h("button", {
    class: "btn btn-primary btn-block",
    text: "获取微信二维码",
    onClick: async () => {
      wxButton.disabled = true;
      await cancelWx();
      const seq = requestSeq;
      wxImage.style.display = "none";
      wxNote.textContent = "正在获取二维码…";
      try {
        const r = await api.wechatLoginStart();
        if (destroyed || seq !== requestSeq) {
          await api.wechatLoginCancel(r.sid);
          return;
        }
        wxSid = r.sid;
        wxImage.src = r.qrImage;
        wxImage.style.display = "block";
        wxNote.textContent = "请使用微信扫码并在手机上确认";
        poll(r.sid);
      } catch (e) {
        if (!destroyed) wxNote.textContent = String(e);
      } finally {
        wxButton.disabled = false;
        wxButton.textContent = "重新获取二维码";
      }
    },
  });
  const wxCard = h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", { text: "微信扫码登录" })]),
    h("div", { class: "card-body col" }, [
      h("p", { class: "hint", text: "使用本人微信扫码并在手机上确认。" }),
      wxImage,
      wxNote,
      wxButton,
      h("button", {
        class: "btn btn-ghost",
        text: "取消扫码",
        onClick: async () => {
          await cancelWx();
          wxImage.style.display = "none";
          wxNote.textContent = "已取消扫码";
        },
      }),
    ]),
  ]);
  const qqCard = h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [h("h3", { text: "QQ 扫码登录" })]),
    h("div", { class: "card-body col" }, [
      h("p", { class: "hint", text: "使用本人 QQ 扫码并在手机上确认。" }),
      h("button", {
        class: "btn btn-primary btn-block",
        text: "打开 QQ 扫码授权",
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          await cancelWx();
          wxImage.style.display = "none";
          try {
            await api.qqLoginStart();
            message.textContent = "请在 QQ 授权窗口扫码，完成后自动返回。";
          } catch (error) {
            message.textContent = String(error);
          } finally {
            btn.disabled = false;
          }
        },
      }),
    ]),
  ]);
  const root = h("div", { class: "col" }, [
    h("div", { class: "page-head" }, [
      h("div", { class: "ph-main" }, [
        h("h1", { class: "ph-title", text: "登录不道乐跑" }),
        h("p", { class: "ph-sub", text: "扫码登录 · 账号数据保存在本机" }),
      ]),
    ]),
    message,
    wxCard,
    qqCard,
    deviceCard(),
  ]);
  return {
    el: root,
    destroy() {
      destroyed = true;
      cancelWx();
    },
  };

  function deviceCard() {
    // 「待登录设备」暂存优先（登录前设置所见即所得）；localIp 等只读项仍取 state.device
    const dev = {
      ...(app.state.device || {}),
      ...(app.state.loginDevice || {}),
    };
    const devIdInput = h("input", {
      class: "input mono",
      placeholder: dev.autoId || "留空 = 自动派生",
      value: dev.override || "",
    });
    const modelInput = h("input", {
      class: "input mono",
      placeholder: (app.state.devicePresets || [{}])[0].model || "25113PN0EC",
      value: dev.model || "",
    });
    const osInput = h("input", {
      class: "input mono",
      placeholder: (app.state.devicePresets || [{}])[0].osVersion || "16",
      value: dev.osVersion || "",
    });
    const presetSel = devicePresetSelect(app.state.devicePresets, (p) => {
      modelInput.value = p.model;
      osInput.value = p.osVersion;
      toast(
        `已填入 ${p.name}（${p.model} · Android ${p.osVersion}），记得保存`,
        "ok",
      );
    });
    /** 随机刷一个设备ID：只填入输入框，点「保存」才生效（同一账号请固定用一个，换来换去会被判换机） */
    const randBtn = h("button", {
      class: "btn btn-sm btn-ghost",
      text: "随机一个",
      onClick: async () => {
        randBtn.disabled = true;
        try {
          const r = await api.newDeviceId();
          devIdInput.value = r.id;
          toast("已填入新的设备ID，点「保存」生效", "ok");
        } catch (e) {
          toast(`生成失败：${e.message}`, "danger");
        } finally {
          randBtn.disabled = false;
        }
      },
    });
    /** 历史设备：点一行即保存该设备（ID + 机型 + 系统），切号时避免被判「换机」 */
    let history = (app.state.deviceHistory || []).slice();
    let historySaving = false; // 点一行即保存：防重复点击，也避免并发写待登录设备
    const historyBox = h("div", { class: "device-history" });
    const historyCount = h("span", { class: "hint xs" });
    const clearHistoryBtn = h("button", {
      class: "btn btn-sm btn-ghost",
      text: "清空",
      onClick: async () => {
        if (!history.length) return;
        const ok = await confirmDialog({
          title: "清空历史设备",
          message:
            "只会删除历史记录，不会修改账号当前使用的设备，也不影响登录。",
          okText: "清空",
          danger: true,
        });
        if (!ok) return;
        clearHistoryBtn.disabled = true;
        try {
          const res = await api.deviceHistoryClear();
          history = res.history || [];
          renderHistory();
          toast("已清空历史设备", "ok");
        } catch (e) {
          toast(`清空失败：${e.message}`, "danger");
        } finally {
          clearHistoryBtn.disabled = false;
        }
      },
    });
    const historyFoot = h("div", { class: "dh-foot" }, [
      historyCount,
      clearHistoryBtn,
    ]);

    /** 机型代码 → 友好名称（预设表里查得到就用名称） */
    function deviceName(d) {
      const preset = (app.state.devicePresets || []).find(
        (p) => p.model === d.model,
      );
      return preset ? preset.name : d.model || "未知机型";
    }

    /** 历史条目上的账号标识（档案还在就显示备注/昵称/学校） */
    function accountLabel(uid) {
      if (!uid) return "未记录账号";
      const acc = (app.state.accounts || []).find((a) => a.uid === uid);
      const name = acc && (acc.label || acc.nickname || acc.schoolName);
      return name ? `${name} · ${uid}` : `UID ${uid}`;
    }

    function renderHistory() {
      historyBox.innerHTML = "";
      historyCount.textContent = history.length
        ? `共 ${history.length} 台 · 最多保留 6 台，超出自动淘汰最旧的`
        : "暂无历史设备（登录成功后会记录本次实际使用的设备）";
      clearHistoryBtn.disabled = history.length === 0;
      if (!history.length) return;

      history.forEach((d) => {
        const active = devIdInput.value.trim() === d.id;
        const pick = h(
          "button",
          {
            class: "dh-pick",
            type: "button",
            "aria-pressed": String(active),
            onClick: async () => {
              if (historySaving) return;
              historySaving = true;
              const prev = {
                id: devIdInput.value,
                model: modelInput.value,
                os: osInput.value,
              };
              devIdInput.value = d.id;
              if (d.model) modelInput.value = d.model;
              if (d.osVersion) osInput.value = d.osVersion;
              renderHistory();
              try {
                // 点一行 = 直接保存为本次登录使用的设备（不用再向下滚去点「保存」）
                await api.saveDevice({
                  override: d.id,
                  model: d.model || modelInput.value.trim(),
                  osVersion: d.osVersion || osInput.value.trim(),
                });
                toast(`✓ 已保存：${deviceName(d)} · 本次登录生效`, "ok");
              } catch (e) {
                devIdInput.value = prev.id;
                modelInput.value = prev.model;
                osInput.value = prev.os;
                renderHistory();
                toast(`保存失败：${e.message}`, "danger");
              } finally {
                historySaving = false;
              }
            },
          },
          [
            h(
              "span",
              { class: "dh-head" },
              [
                h("span", {
                  class: "dh-title",
                  text: `${deviceName(d)} · Android ${d.osVersion || "?"}`,
                }),
                active ? h("span", { class: "badge ok", text: "当前" }) : null,
              ].filter(Boolean),
            ),
            h("span", { class: "dh-id", text: d.id }),
            h("span", {
              class: "dh-meta",
              text: [
                accountLabel(d.uid),
                d.at ? new Date(d.at).toLocaleDateString("zh-CN") : "",
              ]
                .filter(Boolean)
                .join(" · "),
            }),
          ],
        );
        const del = h("button", {
          class: "dh-del",
          type: "button",
          text: "×",
          title: "从历史中删除",
          "aria-label": "从历史中删除",
          onClick: async () => {
            del.disabled = true;
            try {
              const res = await api.deviceHistoryRemove(d.id);
              history = res.history || [];
              renderHistory();
              toast("已从历史中删除", "ok");
            } catch (e) {
              del.disabled = false;
              toast(`删除失败：${e.message}`, "danger");
            }
          },
        });
        historyBox.appendChild(
          h("div", { class: `dh-row${active ? " current" : ""}` }, [pick, del]),
        );
      });
    }
    renderHistory();
    const saveBtn = h("button", {
      class: "btn btn-primary btn-block",
      text: "保存",
      onClick: async () => {
        saveBtn.disabled = true;
        try {
          await api.saveDevice({
            override: devIdInput.value.trim(),
            model: modelInput.value.trim(),
            osVersion: osInput.value.trim(),
          });
          await app.refresh();
          toast("✓ 已保存，将在本次登录时套用", "ok");
        } catch (e) {
          toast(`保存失败：${e.message}`, "danger");
        } finally {
          saveBtn.disabled = false;
        }
      },
    });
    return h("details", { class: "fold" }, [
      h("summary", { text: "设备信息" }),
      h("div", { class: "fold-body" }, [
        h("p", {
          class: "hint warn",
          text: "只作用于「本次登录的那个账号」；登录后再改会被判「换设备」而掉线。",
        }),
        h("div", { class: "field" }, [
          h("label", { text: "历史设备" }),
          historyBox,
          historyFoot,
          h("span", {
            class: "hint xs",
            text: "点一行即保存为本次登录设备；手动改过 ID / 机型 / 系统后，再点下方「保存」",
          }),
        ]),
        h("div", { class: "field" }, [
          h("div", { class: "field-row" }, [
            h("label", { text: "设备ID" }),
            randBtn,
          ]),
          devIdInput,
          h("span", {
            class: "hint xs",
            text: "留空 = 自动派生；换新设备时点「随机一个」（同一账号请固定用一个ID）",
          }),
        ]),
        h("div", { class: "field" }, [
          h("label", { text: "常用机型" }),
          presetSel,
        ]),
        h("div", { class: "field" }, [
          h("label", { text: "上报机型" }),
          modelInput,
        ]),
        h("div", { class: "field" }, [
          h("label", { text: "系统版本" }),
          osInput,
        ]),
        h("div", { class: "field" }, [
          h("div", { class: "field-row" }, [
            h("label", { text: "上报 IP" }),
            h("span", {
              class: "field-val",
              text: dev.localIp || "未检测到网络接口",
            }),
          ]),
          h("span", {
            class: "hint xs",
            text: "自动取本机网络出口地址，不可修改",
          }),
        ]),
        saveBtn,
      ]),
    ]);
  }
}
