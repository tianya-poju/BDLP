import { logins } from "./js/login-client.js";
import { updates } from "./js/updates.js";
import { installLifecycle } from "./js/lifecycle-ui.js";

import { h, svg, toast, openModal, choiceDialog } from "./js/util.js";
import { api } from "./js/api.js";
import { LoginView } from "./js/views/login.js";
import { ConsoleView } from "./js/views/console.js";
import { RecordsView } from "./js/views/records.js";
import { SettingsView } from "./js/views/settings.js";
import { openSchoolPicker, openAccountSwitcher } from "./js/components.js";
import { TrackMap } from "./js/map.js";

const app = {
  navigate: (name) => show(name),
  state: null,
  current: "console",
  view: null,
  asideMap: null,
  refreshAside: () => refreshAside(),
  openAddAccount: () => login(),
  doLogout: async () => {
    const remove = await choiceDialog({
      title: "退出登录",
      message: "是否保留这个账号的本地档案？",
      choices: [
        { text: "退出并保留档案", value: false, kind: "primary" },
        { text: "退出并删除档案", value: true, kind: "danger" },
      ],
    });
    if (remove === undefined || remove === null) return;
    await api.logout(remove);
    await refresh();
    show("console");
    toast("已清除本机登录凭据");
  },
};
let currentView = null,
  renderedPage = null,
  activeLoginView = null,
  loginModal = null;
const root = document.querySelector("#view");
const nav = {
  console: ConsoleView,
  records: RecordsView,
  settings: SettingsView,
};
function header(title) {
  return h("div", { class: "page-head" }, [
    h("div", { class: "ph-main" }, [
      h("h1", { class: "ph-title", text: title }),
    ]),
  ]);
}
let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  const next = await api.state();
  if (seq !== refreshSeq) return;
  app.state = next;
  updates.version(next.version);
  document.querySelector("#rail-zone").textContent =
    app.state.zone?.name || "未查询";
  document.querySelector("#rail-school").textContent =
    app.state.account.schoolName || "未设置";
  const accountLine = document.querySelector(".rail-account .ra-v");
  accountLine.textContent =
    app.state.account.label ||
    app.state.account.realName ||
    app.state.account.nickname ||
    app.state.account.uid ||
    "未登录";
  refreshAside();
}
app.refresh = async () => {
  const oldUid = app.state?.activeUid;
  await refresh();
  if (oldUid !== app.state?.activeUid || renderedPage !== app.current)
    show(app.current);
  else if (currentView?.refresh) currentView.refresh();
};
function show(name) {
  if (!app.state) return;
  currentView?.destroy?.();
  app.current = name;
  renderedPage = name;
  document
    .querySelectorAll("[data-page]")
    .forEach((b) =>
      b.setAttribute(
        "aria-current",
        b.dataset.page === name ? "page" : "false",
      ),
    );
  root.replaceChildren();
  root.append(
    header(
      { console: "控制台", records: "跑步记录", settings: "设置" }[name] ||
        "账号",
    ),
  );
  try {
    currentView = nav[name](app);
    app.view = currentView;
    currentView.el.classList.remove("view");
    currentView.el.classList.add("desktop-content");
    root.append(currentView.el);
  } catch (e) {
    root.append(
      h("p", { class: "hint danger", text: `界面加载失败：${e.message}` }),
    );
  }
}
function login() {
  if (activeLoginView) return;
  const loginView = LoginView(app);
  activeLoginView = loginView;
  const body = h("div", { class: "col" }, [loginView.el]);
  loginModal = openModal({
    title: "添加账号",
    body,
    wide: true,
    onClose: () => {
      loginView.destroy();
      if (activeLoginView === loginView) {
        activeLoginView = null;
        loginModal = null;
      }
    },
  });
}
app.openAddAccount = login;
installLifecycle(app);
window.__TAURI__.event
  .listen("login-result", async ({ payload }) => {
    if (!logins.finish(payload)) return;
    const revision = logins.revision();
    if (payload.ok) {
      loginModal?.close();
      toast("登录成功");
      await refresh();
      if (logins.revision() !== revision) return;
      try {
        await api.zoneConfig(true);
        await refresh();
      } catch (e) {
        if (logins.revision() === revision)
          toast(`登录成功，跑区读取失败：${String(e)}`, "warn");
      }
      if (logins.revision() === revision) show("console");
    } else toast(payload.error || "登录失败", "danger");
  })
  .catch(() => toast("无法注册登录通知", "danger"));
function refreshAside() {
  const aside = document.querySelector("#aside");
  app.asideMap?.destroy?.();
  app.asideMap = null;
  aside.replaceChildren();
  const map = h("div", { class: "map", style: { height: "240px" } });
  aside.append(
    h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("h3", { text: "跑区与路线" }),
        h("span", {
          class: "head-note",
          text: app.state.zone?.name || "尚未获取跑区",
        }),
        h("button", {
          class: "btn btn-sm",
          text: "重新加载地图",
          onClick: () => refreshAside(),
        }),
      ]),
      map,
    ]),
  );
  requestAnimationFrame(() => {
    if (!map.isConnected) return;
    try {
      app.asideMap = new TrackMap(map, {
        track: app.state.route.points,
        fence: app.state.zone?.fence || [],
        center: app.state.zone?.center ||
          app.state.route.points[0] || [28.14, 112.99],
      });
    } catch (e) {
      map.textContent = "地图暂不可用，请点击重新加载地图";
    }
  });
}

for (const b of document.querySelectorAll("[data-icon]")) {
  const text = b.textContent;
  b.replaceChildren(svg(b.dataset.icon, 20), h("span", { text }));
}
for (const b of document.querySelectorAll("[data-page]"))
  b.onclick = () => {
    if (b.dataset.page === "schools") openSchoolPicker(app);
    else if (b.dataset.page === "account") openAccountSwitcher(app);
    else show(b.dataset.page);
  };
refresh()
  .then(async () => {
    show("console");
    if (app.state.loggedIn) {
      try {
        await api.refreshProfile();
        await api.zoneConfig(true);
        await refresh();
        show("console");
      } catch (e) {
        toast(`联网读取失败：${String(e)}`, "warn");
      }
    }
  })
  .catch((e) => (root.textContent = `本地数据读取失败：${String(e)}`));

// Independent background check: never wait for GitHub before rendering or logging in.
updates.startup();
