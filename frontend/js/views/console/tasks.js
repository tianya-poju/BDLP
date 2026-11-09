import { h, svg, toast, fmtKm, pref } from "../../util.js";
import { api, subscribeJob, subscribeJobs } from "../../api.js";

export function createTasks({ app, uploadCard, logPanel, goAlipay }) {
  let runJob = app.state.running?.current?.id || null;
  let unsubscribe = null;
  let stopRegistry = null,
    watchedId = null;
  let destroyed = false,
    starting = false,
    watchSeq = 0;
  const ownerUid = app.state.activeUid;
  const alive = () => !destroyed && app.state.activeUid === ownerUid;
  let mode = pref.get("runMode", "free");
  function renderUpload() {
    if (globalThis.LEPAO_TRIAL) return;
    const cfg = app.state.runConfig;
    const r = app.state.route;
    uploadCard.innerHTML = "";
    uploadCard.append(
      h(
        "div",
        { class: "card-head" },
        [
          h("h3", { text: "上传跑步记录" }),
          runJob ? h("span", { class: "live", text: "执行中" }) : null,
        ].filter(Boolean),
      ),
      h(
        "div",
        { class: "card-body" },
        [
          h("div", { class: "chips equal" }, [
            h(
              "button",
              {
                class: "chip",
                "aria-pressed": String(mode === "free"),
                onClick: () => {
                  mode = "free";
                  pref.set("runMode", mode);
                  renderUpload();
                },
              },
              [
                h("span", { text: "自由跑" }),
                h("span", { class: "chip-sub", text: "不关联成绩" }),
              ],
            ),
            h(
              "button",
              {
                class: "chip",
                "aria-pressed": String(mode === "campus"),
                onClick: () => {
                  mode = "campus";
                  pref.set("runMode", mode);
                  renderUpload();
                },
              },
              [
                h("span", { text: "校园跑" }),
                h("span", { class: "chip-sub", text: "含打卡点+传感器" }),
              ],
            ),
          ]),
          h("p", {
            class: "hint",
            text: `距离 ${fmtKm(r.distanceKm)}km · 直道 ${cfg.straightSpeed} / 弯道 ${cfg.curveSpeed} m/s`,
          }),
          h("p", {
            class: "hint",
            text: "点击上传将启动联网任务，上传路线、统计数据及学校要求的本人照片。成绩以服务端返回和记录页复查为准。",
          }),
          h(
            "button",
            {
              class: "btn btn-primary btn-lg btn-block",
              disabled: starting || Boolean(runJob) || r.points.length < 2,
              title: "主动启动后将向乐跑服务提交记录",
              onClick: () => startRun(),
            },
            [
              svg("play", 16),
              h("span", {
                text: starting
                  ? "准备中…"
                  : runJob
                    ? "执行中…"
                    : mode === "campus"
                      ? "上传校园跑"
                      : "上传自由跑",
              }),
            ],
          ),
          runJob
            ? h("button", {
                class: "btn btn-danger btn-block",
                text: "取消执行",
                onClick: async () => {
                  await api.runCancel(runJob);
                  toast("已请求取消", "warn");
                },
              })
            : null,
          runJob || logPanel.count > 0 ? logPanel.el : null,
        ].filter(Boolean),
      ),
    );
  }

  function watchRun(id, notify = true) {
    watchedId = id;
    unsubscribe?.();
    const seq = ++watchSeq;
    const live = () => alive() && watchSeq === seq;
    if (!live()) return;
    unsubscribe = subscribeJob(id, {
      onLog: (e) => {
        if (live()) logPanel.append(e.msg);
      },
      onFaceRequest: (ticket) => {
        if (live()) goAlipay({ position: ticket.position, ticket });
      },
      onDone: async (d) => {
        if (!live()) return;
        const completionSeq = ++watchSeq;
        runJob = null;
        const result = d.result || {};
        const message =
          d.status === "done"
            ? result.humanStatus || "已提交，请复查记录"
            : d.error || "任务已结束";
        logPanel.append(
          message,
          d.status === "done" && result.recordOk ? "ok" : "warn",
        );
        if (notify)
          toast(
            message,
            d.status === "done" && result.recordOk ? "ok" : "warn",
            9000,
          );
        if (app.state.running) app.state.running.current = null;
        unsubscribe?.();
        unsubscribe = null;
        await app.refresh();
        if (alive() && watchSeq === completionSeq) renderUpload();
      },
    });
  }
  async function startRun() {
    if (!alive() || runJob || starting) return;
    starting = true;
    renderUpload();
    try {
      if (logPanel.count === 0) logPanel.clear();
      const res = await api.runStart({ mode });
      if (!alive()) return;
      runJob = res.jobId;
      app.state.running = {
        ...app.state.running,
        current: { id: runJob, mode },
        latest: { id: runJob, mode },
      };
      if (watchedId !== runJob || !unsubscribe) watchRun(runJob);
      renderUpload();
    } catch (e) {
      if (alive()) toast(e.message || String(e), "danger");
    } finally {
      starting = false;
      if (alive()) renderUpload();
    }
  }

  return {
    renderUpload,
    startWatching: () => {
      if (runJob) watchRun(runJob);
      else if (app.state.running?.latest?.id)
        watchRun(app.state.running.latest.id, false);
      stopRegistry?.();
      stopRegistry = subscribeJobs((state) => {
        if (!alive() || state.uid !== ownerUid) return;
        app.state.running = state;
        if (state.current && state.current.id !== runJob) {
          runJob = state.current.id;
          watchRun(runJob);
          renderUpload();
        } else if (
          !runJob &&
          state.latest?.id &&
          state.latest.id !== watchedId
        ) {
          watchRun(state.latest.id, false);
        }
      });
    },
    destroy: () => {
      destroyed = true;
      watchSeq++;
      unsubscribe?.();
      unsubscribe = null;
      stopRegistry?.();
      stopRegistry = null;
    },
  };
}
