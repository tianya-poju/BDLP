import { createEnvironment } from "./console/environment.js";
import { createRoute } from "./console/route.js";
import { createParameters } from "./console/parameters.js";
import { createPhotos } from "./console/photos.js";
import { createTasks } from "./console/tasks.js";
import { createPreview } from "./console/preview.js";
/* 控制台：学校 / 跑区 / 路线 / 人脸 / 参数 / 数据预览 / 上传 */
("use strict");

import { h, toast, openModal } from "../util.js";
import { api } from "../api.js";
import { createLogPanel } from "../components.js";

/* 试用版由构建开关控制（正式运行未定义 → 全部为 false） */

/** 图例项：色点 + 名称（色值来自 tokens，与图表同源） */
export function ConsoleView(app) {
  const root = h("div", { class: "view" });
  // ═══ 环境（学校 + 跑区合并为一张卡，减少卡片层级） ═══
  const envCard = h("div", { class: "card" });
  const envHeadNote = h("span", { class: "head-note", text: "" });
  const schoolSlot = h("div");
  const zoneSlot = h("div");
  // ═══ 本跑区要求（只读，来自学校/跑区配置） ═══
  const requirementCard = h("div", { class: "card" });
  // ═══ 完整版可用性（仅试用版） ═══
  const compatCard = globalThis.LEPAO_TRIAL
    ? h("div", { class: "card" })
    : null;
  // ═══ 路线 ═══
  const routeCard = h("div", { class: "card" });
  // ═══ 人脸 ═══
  const photos = createPhotos(app);
  const faceCard = photos.el;
  // ═══ 参数 ═══
  const paramCard = h("div", { class: "card" });
  // ═══ 预览 ═══
  const previewCard = h("div", { class: "card" });
  // ═══ 上传（正式版） ═══
  const uploadCard = globalThis.LEPAO_TRIAL
    ? null
    : h("div", { class: "card" });
  const logPanel = globalThis.LEPAO_TRIAL
    ? null
    : createLogPanel({ maxHeight: 240 });

  const previews = createPreview({ app, previewCard });
  const { schedulePreview, doPreview } = previews;
  const environment = createEnvironment({
    app,
    envCard,
    envHeadNote,
    schoolSlot,
    zoneSlot,
    requirementCard,
    schedulePreview,
    goAlipay,
    testAlipayLaunch,
  });
  const { renderEnv, mountEnvCard, renderRequirement } = environment;
  const { renderRoute } = createRoute({ app, routeCard, schedulePreview });
  const parameters = createParameters({ app, paramCard, schedulePreview });
  const { renderParams } = parameters;
  const tasks = createTasks({ app, uploadCard, logPanel, goAlipay });
  const { renderUpload } = tasks;
  root.append(
    ...[
      envCard,
      requirementCard,
      compatCard,
      routeCard,
      faceCard,
      paramCard,
      previewCard,
      globalThis.LEPAO_TRIAL ? null : uploadCard,
    ].filter(Boolean),
  );

  // ─────────── 环境（学校 + 跑区，共用一张卡） ───────────
  // ── 支付宝拉起辅助（Web 端只对手机浏览器有效，桌面需要扫码/复制链接） ──

  /** 本地生成深链二维码（含 token，不经过任何第三方） */
  function qrSvgOf(text) {
    try {
      const qr = window.qrcode(0, "L");
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({
        cellSize: 4,
        margin: 8,
        scalable: true,
        alt: "支付宝拉起二维码",
      });
    } catch (_) {
      return "";
    }
  }

  /** 当前环境能不能拉起支付宝 —— 按 UA 给事实结论，不做猜测 */
  function alipayEnvDiag() {
    const ua = navigator.userAgent || "";
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const inWeChat = /MicroMessenger/i.test(ua);
    const inWeCom = /wxwork/i.test(ua);
    const lines = [`环境：${mobile ? "手机浏览器" : "桌面浏览器"}`];
    if (inWeChat)
      lines.push(
        "微信内置浏览器会拦截 alipays://：请点右上角「在浏览器打开」后再试。",
      );
    if (inWeCom)
      lines.push(
        "企业微信内置浏览器通常拦截自定义协议：请改用系统浏览器打开。",
      );
    if (!mobile)
      lines.push(
        "桌面浏览器没有支付宝客户端时无法拉起：用手机支付宝扫码，或复制链接到手机打开。",
      );
    if (mobile && !inWeChat && !inWeCom)
      lines.push("手机浏览器支持 alipays://，点「尝试拉起」应能切到支付宝。");
    return lines.join("\n");
  }

  /** 尝试拉起：手机直接跳转；桌面用隐藏 iframe 尝试，未切走则给失败提示 */
  function openAlipayScheme(url, failText) {
    api.alipayLaunch(url).catch((e) => toast(e.message, "warn", 9000));
  }

  /** 支付宝小程序刷脸深链（学校 face_verify_type != 1 时才显示按钮） */
  async function goAlipay(opts = {}) {
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      if (opts.onResult) opts.onResult(ok);
    };
    try {
      const res =
        opts.ticket || (await api.alipayFaceUrl(Number(opts.position || 0)));
      if (Number(res.status) !== 1 || !res.url) {
        toast(res.info || "生成支付宝刷脸链接失败", "warn");
        settle(false);
        return;
      }
      const input = h("input", {
        class: "input mono",
        value: res.url,
        readOnly: true,
      });
      const qrHtml = qrSvgOf(res.url);
      const checkBtn = h("button", {
        class: "btn",
        text: "我已完成，查核验",
        onClick: async () => {
          checkBtn.disabled = true;
          checkBtn.textContent = "查询中…";
          try {
            const r = await api.alipayFaceCheck(Number(opts.position || 0));
            toast(
              r.info || (r.done ? "刷脸已完成" : "还没完成"),
              r.done ? "ok" : "warn",
              6000,
            );
            if (r.done) {
              settle(true);
              modal.close();
            }
          } catch (e) {
            toast(`查询失败：${e.message}`, "danger");
          } finally {
            checkBtn.disabled = false;
            checkBtn.textContent = "我已完成，查核验";
          }
        },
      });
      const modal = openModal({
        title: "支付宝刷脸",
        body: [
          h("p", {
            class: "hint",
            text: "手机端可直接点「打开支付宝」；电脑端请用手机支付宝「扫一扫」下面的二维码，或复制链接到手机打开。刷完后点「我已完成，查核验」确认，再回来开跑。",
          }),
          ...(res.warning
            ? [h("p", { class: "hint warn", text: res.warning })]
            : []),
          ...(qrHtml ? [h("div", { class: "qr-box", html: qrHtml })] : []),
          input,
        ],
        footer: [
          h("button", {
            class: "btn",
            text: "复制链接",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(res.url);
                toast("已复制刷脸链接", "ok");
              } catch (_) {
                input.select();
                try {
                  document.execCommand("copy");
                  toast("已复制刷脸链接", "ok");
                } catch (_) {
                  toast("复制失败，请手动选择链接", "warn");
                }
              }
            },
          }),
          h("button", {
            class: "btn btn-primary",
            text: "打开支付宝",
            onClick: () => {
              // 官方在跳转后补一条 updateZfbStatus(2)（纯通知，失败不影响刷脸）
              api.alipayFaceOpened().catch(() => {});
              openAlipayScheme(
                res.url,
                "这台电脑没有可接管 alipays:// 的支付宝客户端。" +
                  "请点「复制链接」发到手机，用手机浏览器打开（微信内会拦截 alipays:// 链接）。",
              );
            },
          }),
          checkBtn,
        ],
        onClose: () => settle(false),
      });
    } catch (e) {
      toast(`生成刷脸链接失败：${e.message}`, "danger");
      settle(false);
    }
  }

  /**
   * 开跑前的支付宝刷脸闸门：需要支付宝刷脸且尚未完成核验时，先弹出刷脸弹窗。
   * 只有用户真的查到 status=1 的核验记录才放行（中途/结束刷脸后端会直接中止，不在这里拦）。
   * @returns {Promise<boolean>} 是否继续开跑
   */
  async function testAlipayLaunch() {
    let res;
    try {
      res = await api.alipayFaceUrl(0, true);
    } catch (e) {
      toast(`生成测试链接失败：${e.message}`, "danger");
      return;
    }
    if (Number(res.status) !== 1 || !res.url) {
      toast(res.info || "生成测试链接失败", "warn");
      return;
    }
    const diag = alipayEnvDiag();
    const resultLine = h("p", { class: "hint" });
    const input = h("input", {
      class: "input mono",
      value: res.url,
      readOnly: true,
    });
    const qrHtml = qrSvgOf(res.url);
    openModal({
      title: "支付宝拉起自检",
      body: [
        h("p", {
          class: "hint mono",
          text: diag,
          style: { whiteSpace: "pre-wrap" },
        }),
        h("p", {
          class: "hint",
          text: "测试链接只验证拉起，不会在服务端创建刷脸任务，也不记录 face_time。",
        }),
        ...(qrHtml ? [h("div", { class: "qr-box", html: qrHtml })] : []),
        input,
        resultLine,
      ],
      footer: [
        h("button", {
          class: "btn",
          text: "复制链接",
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(res.url);
              toast("已复制测试链接", "ok");
            } catch (_) {
              input.select();
              try {
                document.execCommand("copy");
                toast("已复制测试链接", "ok");
              } catch (_) {
                toast("复制失败，请手动复制", "warn");
              }
            }
          },
        }),
        h("button", {
          class: "btn btn-primary",
          text: "尝试拉起",
          onClick: () => {
            resultLine.className = "hint";
            resultLine.textContent =
              "已发起跳转：若 2 秒内没有切到支付宝，说明当前环境不支持 alipays://（见上方环境判定）。";
            openAlipayScheme(
              res.url,
              "没有应用接管 alipays://：桌面上请用手机扫码，或复制链接到手机打开。",
            );
          },
        }),
      ],
    });
  }

  // ─────────── 路线卡片 ───────────
  // ─────────── 参数卡片 ───────────
  // ─────────── 数据预览 ───────────
  // ─────────── 完整版可用性（仅试用版，只读检测） ───────────
  function renderCompat() {
    if (!compatCard) return;
    compatCard.innerHTML = "";
    const resultBox = h("div", { class: "col", style: { gap: "8px" } });
    const btn = h("button", {
      class: "btn btn-sm btn-block",
      text: "检测本校正能否使用完整版",
      onClick: async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        b.textContent = "检测中…";
        resultBox.innerHTML = "";
        try {
          const res = await api.compat();
          renderCompatResult(resultBox, res);
        } catch (e) {
          resultBox.appendChild(
            h("p", { class: "hint danger", text: `检测失败：${e.message}` }),
          );
        } finally {
          b.disabled = false;
          b.textContent = "重新检测";
        }
      },
    });
    compatCard.append(
      h("div", { class: "card-head" }, [
        h("h3", { text: "完整版可用性" }),
        h("span", { class: "head-note", text: "仅试用版检测" }),
      ]),
      h("div", { class: "card-body tight" }, [
        h("p", {
          class: "hint",
          text: "读取该校 beforeRun 配置，做理论层面的可行性分析；不会生成轨迹、不会发起任何提交。",
        }),
        btn,
        resultBox,
      ]),
    );
  }

  function renderCompatResult(box, res) {
    box.innerHTML = "";
    if (Number(res.status) !== 1) {
      box.appendChild(
        h("p", { class: "hint danger", text: res.info || "检测失败" }),
      );
      return;
    }
    const r = res.result || {};
    const tone =
      r.level === "ok" ? "ok" : r.level === "risk" ? "warn" : "danger";
    const s = res.summary || {};
    box.append(
      ...[
        h("div", { class: "between" }, [
          h("span", { class: `badge ${tone}`, text: r.title || "—" }),
          h("span", {
            class: "hint xs",
            text: [s.schoolName, s.runZoneName].filter(Boolean).join(" · "),
          }),
        ]),
        r.blocked && r.blocked.length
          ? h("div", { class: "col", style: { gap: "4px" } }, [
              h("span", { class: "hint xs", text: "硬性阻断" }),
              ...r.blocked.map((t) =>
                h("p", { class: "hint danger", text: `· ${t}` }),
              ),
            ])
          : null,
        r.warnings && r.warnings.length
          ? h("div", { class: "col", style: { gap: "4px" } }, [
              h("span", { class: "hint xs", text: "风险提示" }),
              ...r.warnings.map((t) =>
                h("p", { class: "hint warn", text: `· ${t}` }),
              ),
            ])
          : null,
        r.level === "ok"
          ? h("p", {
              class: "hint ok",
              text: "配置层未发现硬性阻断；实际成绩还取决于照片库、路线与当前时段。",
            })
          : null,
        res.configLines && res.configLines.length
          ? h("details", { class: "fold" }, [
              h("summary", { text: "查看配置依据" }),
              h(
                "div",
                { class: "fold-body" },
                res.configLines.map((t) =>
                  h("p", { class: "hint xs", text: t }),
                ),
              ),
            ])
          : null,
      ].filter(Boolean),
    );
  }

  // ─────────── 上传卡片（正式版） ───────────
  // ─────────── 渲染 ───────────
  function renderAll() {
    mountEnvCard();
    renderEnv();
    renderRequirement();
    renderCompat();
    renderRoute();
    renderParams();
    renderUpload();
    doPreview();
  }

  renderAll();
  tasks.startWatching();

  return {
    el: root,
    refresh: renderAll,
    destroy: () => {
      photos.destroy();
      parameters.destroy();
      previews.destroy();
      tasks.destroy();
    },
  };
}
