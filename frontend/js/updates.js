import { invoke } from "./ipc.js";
import { h, toast } from "./util.js";
export function createUpdateClient(call, notify = () => {}) {
  let state = {
      status: "idle",
      currentVersion: "",
      latestVersion: null,
      checking: false,
      error: null,
    },
    pending = null,
    started = false;
  const listeners = new Set(),
    emit = () => listeners.forEach((cb) => cb({ ...state }));
  const check = () => {
    if (pending) return pending;
    state = { ...state, checking: true, error: null };
    emit();
    pending = Promise.resolve()
      .then(() => call("update_check"))
      .then(
        (result) => {
          state = { ...result, checking: false, error: null };
          return state;
        },
        (error) => {
          state = {
            ...state,
            status: "error",
            checking: false,
            error: error.message || "检查更新失败，请稍后重试",
          };
          return state;
        },
      )
      .finally(() => {
        pending = null;
        emit();
      });
    return pending;
  };
  return {
    check,
    startup() {
      if (started) return;
      started = true;
      void check().then((r) => {
        if (r.status === "available")
          notify(
            `发现新版本 ${r.latestVersion}，请到设置“关于”前往 GitHub 更新`,
          );
      });
    },
    version(version) {
      if (version && version !== state.currentVersion) {
        state = { ...state, currentVersion: version };
        emit();
      }
    },
    subscribe(cb) {
      listeners.add(cb);
      cb({ ...state });
      return () => listeners.delete(cb);
    },
    open: () => call("update_open"),
  };
}
export const updates = createUpdateClient(invoke, (message) =>
  toast(message, "ok", 6000),
);
export function updateControls(version) {
  updates.version(version);
  const text = h("p", { class: "hint" }),
    check = h("button", {
      class: "btn btn-sm",
      text: "检查更新",
      onClick: () => updates.check(),
    });
  const open = h("button", {
    class: "btn btn-sm",
    text: "前往 GitHub 更新",
    onClick: async () => {
      try {
        await updates.open();
      } catch (e) {
        toast(e.message, "danger");
      }
    },
  });
  const stop = updates.subscribe((s) => {
    check.disabled = s.checking;
    check.textContent = s.checking ? "检查中…" : "检查更新";
    text.textContent = s.checking
      ? "正在连接 GitHub…"
      : s.status === "available"
        ? `发现新版本 ${s.latestVersion}`
        : s.status === "current"
          ? `已是最新正式版本（GitHub：${s.latestVersion}）`
          : s.status === "unpublished"
            ? "GitHub 暂无正式发行版本"
            : s.status === "error"
              ? s.error
              : "尚未检查更新";
  });
  return {
    el: h("div", {}, [text, h("div", { class: "btn-row" }, [check, open])]),
    destroy: stop,
  };
}
