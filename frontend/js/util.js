/* 通用工具：DOM / 格式化 / Toast / Modal / 图标 */
"use strict";

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    // CSS 自定义属性必须走 setProperty（Object.assign 会静默忽略 --xxx）
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    } else if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(
      typeof c === "string" || typeof c === "number"
        ? document.createTextNode(String(c))
        : c,
    );
  }
  return el;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 图标（内联 SVG，统一 24 格线框风格） */
export const icon = (() => {
  const paths = {
    console:
      '<rect x="3.5" y="4.5" width="17" height="12" rx="2.2"/><path d="M12 16.5V20M8.5 20h7"/>',
    records:
      '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8 8.5h8M8 12.5h8M8 16.5h5"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    route:
      '<path d="M6 19a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4z"/><path d="M8 17c3 0 3-6 6-6s4-1 4-3"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    refresh: '<path d="M20 12a8 8 0 11-2.3-5.7"/><path d="M20 4v4h-4"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    camera:
      '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3"/>',
    qr: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><path fill="currentColor" d="M6.5 6.5h1.5v1.5H6.5zM16 6.5h1.5v1.5H16zM6.5 16h1.5v1.5H6.5zM13.5 13.5h2.5v2.5h-2.5zM17.5 17.5h2.5V20h-2.5z"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M12 4v11M7 12l5 5 5-5M5 20h14"/>',
    pen: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
    undo: '<path d="M9 8H5V4"/><path d="M5 8a8 8 0 1113 6"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8h.01"/>',
    external:
      '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v5H5V6h5"/>',
    user: '<circle cx="12" cy="9" r="3.2"/><path d="M5 20c1-4 3.6-6 7-6s6 2 7 6"/>',
  };
  return (name, size = 20) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
})();

export function svg(name, size = 20) {
  const span = document.createElement("span");
  span.style.display = "inline-flex";
  span.innerHTML = icon(name, size);
  return span.firstElementChild;
}

// ── 格式化 ──

export function fmtKm(km, digits = 2) {
  return Number(km || 0).toFixed(digits);
}

export function fmtDuration(sec) {
  const s = Math.max(Math.round(Number(sec) || 0), 0);
  const m = Math.floor(s / 60);
  return `${m}'${String(s % 60).padStart(2, "0")}"`;
}

export function fmtPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return "-";
  return fmtDuration(secPerKm);
}

export function fmtPaceFromSpeed(mps) {
  if (!Number.isFinite(mps) || mps <= 0) return "-";
  return fmtDuration(1000 / mps);
}

export function fmtClock(unixSec) {
  if (!unixSec) return "-";
  const d = new Date(unixSec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtShortTime(unixSec) {
  if (!unixSec) return "-";
  const d = new Date(unixSec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Toast ──

let toastBox = null;
export function toast(message, kind = "", ms = 3600) {
  if (!toastBox) {
    toastBox = h("div", { class: "toasts" });
    document.body.appendChild(toastBox);
  }
  const node = h("div", { class: `toast ${kind}`, text: message });
  toastBox.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, ms);
}

// ── Modal ──

/**
 * 打开模态：openModal({title, body:[nodes], footer:[buttons], onClose})
 * 返回 {close}
 */
const modalStack = [];
let modalOverflow = "";
export function openModal({
  title,
  body = [],
  footer = [],
  onClose,
  wide = false,
  className = "",
}) {
  const modal = h("div", {
    class: `modal ${className}`.trim(),
    style: wide ? { maxWidth: "720px" } : {},
  });
  const overlay = h("div", { class: "overlay" }, [modal]);
  let closed = false;
  const esc = (e) => {
    if (e.key === "Escape" && modalStack.at(-1) === overlay) {
      e.stopImmediatePropagation();
      close();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", esc);
    const index = modalStack.indexOf(overlay);
    if (index >= 0) modalStack.splice(index, 1);
    overlay.remove();
    if (!modalStack.length) document.body.style.overflow = modalOverflow;
    if (onClose) onClose();
  };
  const head = h("div", { class: "modal-head" }, [
    h("h3", { text: title || "" }),
    h(
      "button",
      { class: "btn btn-icon btn-ghost", "aria-label": "关闭", onClick: close },
      [svg("close", 16)],
    ),
  ]);
  const bodyEl = h("div", { class: "modal-body" }, body);
  const footEl = footer.length
    ? h("div", { class: "modal-foot" }, footer)
    : null;
  modal.append(head, bodyEl);
  if (footEl) modal.appendChild(footEl);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", esc);
  if (!modalStack.length) modalOverflow = document.body.style.overflow;
  modalStack.push(overlay);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  return { close, bodyEl, overlay };
}

/** 确认框 */
export function confirmDialog({
  title,
  message,
  okText = "确定",
  cancelText = "取消",
  danger = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const m = openModal({
      title,
      body: [
        h("p", {
          class: "hint",
          text: message,
          style: { color: "var(--text)" },
        }),
      ],
      footer: [
        h("button", {
          class: "btn btn-ghost",
          text: cancelText,
          onClick: () => {
            settled = true;
            m.close();
            resolve(false);
          },
        }),
        h("button", {
          class: `btn ${danger ? "btn-danger" : "btn-primary"}`,
          text: okText,
          onClick: () => {
            settled = true;
            m.close();
            resolve(true);
          },
        }),
      ],
      onClose: () => {
        if (!settled) resolve(false);
      },
    });
  });
}

/**
 * 多选一对话框：choices = [{ text, value, kind?: 'primary'|'danger' }]
 * 返回被选项的 value；取消返回 null。选项竖排全宽，避免 3 个按钮挤在一行。
 */
export function choiceDialog({
  title,
  message,
  choices = [],
  cancelText = "取消",
}) {
  return new Promise((resolve) => {
    let settled = false;
    const m = openModal({
      title,
      body: [
        message
          ? h("p", {
              class: "hint",
              text: message,
              style: { color: "var(--text)" },
            })
          : null,
        h(
          "div",
          { class: "col" },
          choices.map((c) =>
            h("button", {
              class: `btn btn-block${c.kind === "danger" ? " btn-danger" : c.kind === "primary" ? " btn-primary" : ""}`,
              text: c.text,
              onClick: () => {
                settled = true;
                m.close();
                resolve(c.value);
              },
            }),
          ),
        ),
      ].filter(Boolean),
      footer: [
        h("button", {
          class: "btn btn-ghost",
          text: cancelText,
          onClick: () => {
            settled = true;
            m.close();
            resolve(null);
          },
        }),
      ],
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
  });
}

/** 输入框对话框（单字段） */
export function promptDialog({
  title,
  message,
  value = "",
  placeholder = "",
  multiline = false,
  okText = "保存",
}) {
  return new Promise((resolve) => {
    let settled = false;
    const input = multiline
      ? h("textarea", { class: "textarea", placeholder, value })
      : h("input", { class: "input mono", placeholder, value });
    const m = openModal({
      title,
      body: [
        message ? h("p", { class: "hint", text: message }) : null,
        input,
      ].filter(Boolean),
      footer: [
        h("button", {
          class: "btn btn-ghost",
          text: "取消",
          onClick: () => {
            settled = true;
            m.close();
            resolve(null);
          },
        }),
        h("button", {
          class: "btn btn-primary",
          text: okText,
          onClick: () => {
            settled = true;
            const v = input.value;
            m.close();
            resolve(v);
          },
        }),
      ],
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
    setTimeout(() => input.focus(), 40);
  });
}

export function download(filename, content) {
  const blob =
    content instanceof Blob
      ? content
      : new Blob([content], { type: "text/plain" });
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** localStorage 小工具（视图偏好等非敏感状态） */
export const pref = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`lepao.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`lepao.${key}`, JSON.stringify(value));
    } catch (_) {
      /* ignore */
    }
  },
};
