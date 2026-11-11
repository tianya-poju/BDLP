/* 记录页：本学期成绩 + 成绩排行榜 + 跑步记录列表 + 记录详情（轨迹地图 / 公里配速 / 导入为路线） */
"use strict";

import {
  h,
  svg,
  toast,
  confirmDialog,
  fmtKm,
  fmtDuration,
  fmtPace,
  fmtPaceFromSpeed,
  fmtShortTime,
  fmtClock,
  pref,
  openModal,
} from "../util.js";
import { api } from "../api.js";
import { statGrid, kvList, sectionLabel } from "../components.js";
import { TrackMap } from "../map.js";

/* 试用版由构建开关控制（正式运行未定义 → 全部为 false） */

export function RecordsView(app) {
  const root = h("div", { class: "view" });
  const scoreCard = h("div", { class: "card" });
  const rankCard = h("div", { class: "card" });
  const listCard = h("div", { class: "card" });
  let rankRequest = 0;
  const pending = app.state.running?.pending ? app.state.running.receipt : null;
  const receiptYear = pending
    ? new Date(pending.time * 1000).getFullYear()
    : null;
  const receiptOwner = app.state.activeUid;
  const reviewCard = pending ? h("div", { class: "card" }) : null;
  let year = receiptYear || pref.get("recordYear", new Date().getFullYear());
  let loading = false;
  // 记录列表按 20 条一页加载（官方接口 10 条/页，服务端合并两页）
  const recordState = {
    list: [],
    page: 0,
    hasMore: false,
    total: 0,
    loadingMore: false,
    moreError: "",
  };

  // ── 排行榜状态（官方 4.3.2）：category 1=成绩榜 / 2=乐跑榜；
  // 成绩榜 type 1/2/3=班级/院系/学校且不分周期；乐跑榜 type 2/3/4 且带周/月/年周期
  const savedRankScope = Number(
    pref.get("rankScope", (Number(pref.get("rankType", 1)) || 1) - 1),
  );
  const savedRankPeriod = Number(pref.get("rankPeriod", 1));
  const rankState = {
    category: Number(pref.get("rankCategory", 1)) === 2 ? 2 : 1,
    scope: [0, 1, 2].includes(savedRankScope) ? savedRankScope : 0,
    period: [1, 2, 3].includes(savedRankPeriod) ? savedRankPeriod : 1,
    page: 0,
    list: [],
    myRank: null,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: "",
  };

  if (reviewCard) root.append(reviewCard);
  root.append(
    scoreCard,
    sectionLabel("历史记录", "点击看详情 · 长按导入为路线"),
    listCard,
    rankCard,
  );
  load();
  renderRank();
  loadRank(true);

  /** 导入为路线（详情页按钮与列表长按共用）—— 结果只用 toast 提示 */
  async function doImport(recordId) {
    try {
      const res = await api.importRoute(recordId);
      if (Number(res.status) !== 1) {
        toast(res.info || "导入失败", "warn");
        await app.refresh();
        return false;
      }
      const warn = Boolean(res.fenceNote && res.fenceNote.startsWith("⚠"));
      toast(
        `✓ 已导入 ${res.points} 点路线（${fmtKm(res.distanceKm)}km）${res.fenceNote ? ` · ${res.fenceNote}` : ""}`,
        warn ? "warn" : "ok",
        6500,
      );
      await app.refresh();
      return true;
    } catch (e) {
      toast(e.message, "danger");
      await app.refresh();
      return false;
    }
  }

  async function askImport(recordId, distance) {
    const ok = await confirmDialog({
      title: "导入为路线",
      message: globalThis.LEPAO_TRIAL
        ? `将记录 #${recordId}（${Number(distance).toFixed(2)} km）的轨迹保存为跑步路线？\n导入后可在控制台预览该路线。`
        : `将记录 #${recordId}（${Number(distance).toFixed(2)} km）的轨迹保存为跑步路线？\n上传时将在此路线基础上微调。`,
      okText: "导入",
    });
    if (ok) await doImport(recordId);
  }

  function renderReview(canConfirm) {
    if (!reviewCard || !pending) return;
    const confirm = h("button", {
      class: "btn btn-block",
      text: "我已核对跑步记录",
      disabled: !canConfirm,
      onClick: async () => {
        confirm.disabled = true;
        try {
          await api.runResolve(receiptOwner, pending.jobId);
          reviewCard.remove();
          await app.refresh();
          toast("待确认状态已解除");
        } catch (error) {
          toast(error.message, "warn");
          confirm.disabled = false;
        }
      },
    });
    reviewCard.replaceChildren(
      h("div", { class: "card-head" }, [h("h3", { text: "上次提交待确认" })]),
      h("div", { class: "card-body" }, [
        h("p", {
          class: "hint",
          text: pending.recordId
            ? "请核对记录 #" +
              pending.recordId +
              "，确认上次提交结果后再开始新任务。"
            : "请先核对下方的近期记录，确认上次提交结果后再开始新任务。",
        }),
        confirm,
      ]),
    );
  }

  async function load() {
    if (loading) return;
    const requestedYear = year;
    loading = true;
    recordState.loadingMore = false;
    recordState.moreError = "";
    renderScore(null, true);
    renderReview(false);
    renderList(true);
    try {
      const res = await api.records(requestedYear, 1);
      if (Number(res.status) !== 1) {
        recordState.list = [];
        recordState.hasMore = false;
        recordState.total = 0;
        renderScore(null, false, res.info);
        renderList(false, res.info || "获取失败");
      } else {
        recordState.list = res.list || [];
        recordState.page = 1;
        recordState.hasMore = Boolean(res.hasMore);
        recordState.total = Number(res.total) || recordState.list.length;
        renderScore(res.score, false, res.scoreError);
        renderList(false);
        renderReview(
          requestedYear === year &&
            Number(requestedYear) === receiptYear &&
            app.state.activeUid === receiptOwner,
        );
      }
    } catch (e) {
      recordState.list = [];
      recordState.hasMore = false;
      recordState.total = 0;
      renderScore(null, false, e.message);
      renderList(false, e.message);
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    const st = recordState;
    if (st.loadingMore || !st.hasMore || loading) return;
    st.loadingMore = true;
    st.moreError = "";
    renderList(false);
    try {
      const res = await api.records(year, st.page + 1);
      if (Number(res.status) !== 1) {
        st.moreError = res.info || "加载更多失败";
      } else {
        st.page += 1;
        st.list = st.list.concat(res.list || []);
        st.hasMore = Boolean(res.hasMore);
        st.total = Number(res.total) || st.list.length;
      }
    } catch (e) {
      st.moreError = e.message;
    } finally {
      st.loadingMore = false;
      renderList(false);
    }
  }

  function renderScore(score, busy, error) {
    scoreCard.innerHTML = "";
    const body = [];
    if (busy) {
      body.push(
        h("div", { class: "row" }, [
          h("span", { class: "spinner" }),
          h("span", { class: "hint", text: "加载中…" }),
        ]),
      );
    } else if (error && !score) {
      body.push(
        h("p", { class: "hint danger", text: `成绩获取失败：${error}` }),
      );
      body.push(
        h("p", {
          class: "hint",
          text: "若是 token 失效，请到「设置」重新登录。",
        }),
      );
    } else if (!score) {
      body.push(h("p", { class: "hint", text: "暂无成绩数据" }));
    } else {
      if (error) body.push(h("p", { class: "hint danger", text: error }));
      body.push(
        statGrid([
          {
            value:
              score.completedCount == null
                ? "未获取"
                : `${score.completedCount} 次`,
            label: "已完成次数",
            accent: true,
          },
          {
            value:
              score.requiredCount == null
                ? "未获取"
                : `${score.requiredCount} 次`,
            label: "学期要求次数",
          },
          {
            value:
              score.remainingCount == null
                ? "未获取"
                : `${score.remainingCount} 次`,
            label: "剩余次数",
          },
          {
            value: `${Number(score.total_score_distance ?? score.distance ?? 0).toFixed(2)} km`,
            label: "累计距离",
            accent: true,
          },
        ]),
      );
    }
    scoreCard.append(
      h("div", { class: "card-head" }, [
        h("h3", { text: "本学期成绩" }),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            "aria-label": "刷新",
            onClick: () => load(),
          },
          [svg("refresh", 16)],
        ),
      ]),
      h("div", { class: "card-body" }, body),
    );
  }

  // ─────────── 排行榜 ───────────

  async function loadRank(reset) {
    const st = rankState;
    if (!reset && (st.loading || st.loadingMore)) return;
    const request = ++rankRequest;
    if (reset) {
      st.loading = true;
      st.page = 0;
      st.error = "";
    } else st.loadingMore = true;
    renderRank();
    try {
      const nextPage = reset ? 1 : st.page + 1;
      const type =
        st.category === 1 ? [1, 2, 3][st.scope] : [2, 3, 4][st.scope];
      const period = st.category === 1 ? null : st.period;
      const res = await api.rank(type, period, nextPage, st.category);
      if (request !== rankRequest) return;
      if (Number(res.status) !== 1) {
        st.error = res.info || "排行榜接口返回失败";
        if (reset) {
          st.list = [];
          st.myRank = null;
        }
      } else {
        st.page = nextPage;
        st.list = reset ? res.list : st.list.concat(res.list);
        st.myRank = res.myRank || (reset ? null : st.myRank);
        st.hasMore = Boolean(res.hasMore) && (res.list || []).length > 0;
        st.error = "";
      }
    } catch (e) {
      if (request !== rankRequest) return;
      st.error = e.message;
    } finally {
      if (request !== rankRequest) return;
      st.loading = false;
      st.loadingMore = false;
      renderRank();
    }
  }

  function rankChips(options, selected, onPick) {
    return h(
      "div",
      { class: "chips equal" },
      options.map((o) =>
        h(
          "button",
          {
            class: "chip",
            "aria-pressed": String(selected === o.v),
            onClick: () => {
              if (selected !== o.v) onPick(o.v);
            },
          },
          [h("span", { text: o.t })],
        ),
      ),
    );
  }

  function rankRow(r, idx) {
    const no = r.rank > 0 ? r.rank : idx + 1;
    const top = no >= 1 && no <= 3;
    const mine =
      rankState.myRank &&
      rankState.myRank.uid &&
      r.uid === rankState.myRank.uid;
    return h(
      "div",
      { class: `rank-row${top ? " top" : ""}${mine ? " me" : ""}` },
      [
        h("span", { class: "rank-no", text: String(no) }),
        h(
          "span",
          { class: "rank-main" },
          [
            h("span", { class: "rank-name", text: r.name || "—" }),
            r.schoolName && r.schoolName !== r.name
              ? h("span", { class: "rank-sub", text: r.schoolName })
              : null,
          ].filter(Boolean),
        ),
        h("span", { class: "rank-stats" }, [
          h("span", { text: `${r.scoreNum} 次` }),
          h("span", {
            class: "rank-times",
            text: `${r.distance.toFixed(2)} km`,
          }),
        ]),
      ],
    );
  }

  function renderRank() {
    const st = rankState;
    rankCard.innerHTML = "";

    const body = h(
      "div",
      { class: "card-body" },
      [
        rankChips(
          [
            { v: 1, t: "成绩榜" },
            { v: 2, t: "乐跑榜" },
          ],
          st.category,
          (v) => {
            st.category = v;
            pref.set("rankCategory", v);
            loadRank(true);
          },
        ),
        rankChips(
          [
            { v: 0, t: "班级" },
            { v: 1, t: "院系" },
            { v: 2, t: "学校" },
          ],
          st.scope,
          (v) => {
            st.scope = v;
            pref.set("rankScope", v);
            loadRank(true);
          },
        ),
        st.category === 2
          ? rankChips(
              [
                { v: 1, t: "周" },
                { v: 2, t: "月" },
                { v: 3, t: "年" },
              ],
              st.period,
              (v) => {
                st.period = v;
                pref.set("rankPeriod", v);
                loadRank(true);
              },
            )
          : null,
      ].filter(Boolean),
    );

    if (st.myRank) {
      // 班级/院系/学校榜的 my_rank 常常只回「昵称未知」，用本地账号昵称兜底（官方 App 同做法）
      const myName =
        st.myRank.name && st.myRank.name !== "昵称未知"
          ? st.myRank.name
          : (app.state.account || {}).nickname ||
            (app.state.account || {}).label ||
            "我";
      body.appendChild(
        h("div", { class: "rank-me" }, [
          h("span", { class: "rank-me-label", text: "我的排名" }),
          h("span", {
            class: "rank-me-no",
            text: st.myRank.rank > 0 ? `#${st.myRank.rank}` : "未上榜",
          }),
          h("span", {
            class: "rank-me-info",
            text: `${myName} · ${st.myRank.scoreNum} 次 · ${st.myRank.distance.toFixed(2)} km`,
          }),
        ]),
      );
    }

    if (st.loading && st.list.length === 0) {
      body.appendChild(
        h("div", { class: "row" }, [
          h("span", { class: "spinner" }),
          h("span", { class: "hint", text: "加载中…" }),
        ]),
      );
    } else if (st.error) {
      body.appendChild(
        h("p", { class: "hint danger", text: `排行榜获取失败：${st.error}` }),
      );
    } else if (st.list.length === 0) {
      body.appendChild(
        h("p", {
          class: "hint",
          text: "该榜单暂无数据（班级 / 院系榜需要学校侧维护对应关系）",
        }),
      );
    } else {
      body.appendChild(h("div", { class: "rank-list" }, st.list.map(rankRow)));
      if (st.hasMore) {
        body.appendChild(
          h("button", {
            class: "btn btn-sm btn-block",
            text: st.loadingMore ? "加载中…" : "加载更多",
            disabled: st.loadingMore,
            onClick: () => loadRank(false),
          }),
        );
      }
    }

    rankCard.append(
      h("div", { class: "card-head" }, [
        h("h3", { text: st.category === 1 ? "成绩排行榜" : "乐跑排行榜" }),
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            "aria-label": "刷新排行榜",
            onClick: () => loadRank(true),
          },
          [svg("refresh", 16)],
        ),
      ]),
      body,
    );
  }

  function renderList(busy, error) {
    const st = recordState;
    listCard.innerHTML = "";
    const yearSelect = h("select", {
      class: "select mono",
      style: { width: "110px" },
    });
    const nowYear = new Date().getFullYear();
    for (let y = nowYear; y >= nowYear - 5; y -= 1) {
      yearSelect.appendChild(
        h("option", {
          value: String(y),
          text: `${y} 年`,
          selected: y === Number(year),
        }),
      );
    }
    yearSelect.addEventListener("change", () => {
      year = Number(yearSelect.value);
      pref.set("recordYear", year);
      load();
    });

    const countText = busy
      ? ""
      : st.total
        ? `（${st.list.length} / ${st.total}）`
        : st.list.length
          ? `（${st.list.length}）`
          : "";
    listCard.append(
      h("div", { class: "card-head" }, [
        h("h3", { text: `跑步记录${countText}` }),
        h("div", { class: "row" }, [
          yearSelect,
          h(
            "button",
            {
              class: "btn btn-icon btn-ghost",
              "aria-label": "刷新",
              onClick: () => load(),
            },
            [svg("refresh", 16)],
          ),
        ]),
      ]),
    );

    if (busy) {
      listCard.appendChild(
        h("div", { class: "card-body" }, [
          h("div", { class: "row" }, [
            h("span", { class: "spinner" }),
            h("span", { class: "hint", text: "加载中…" }),
          ]),
        ]),
      );
      return;
    }
    if (error) {
      listCard.appendChild(
        h("div", { class: "card-body" }, [
          h("p", { class: "hint danger", text: `获取记录失败：${error}` }),
        ]),
      );
      return;
    }
    if (st.list.length === 0) {
      listCard.appendChild(
        h("div", { class: "empty", text: `${year} 年暂无跑步记录` }),
      );
      return;
    }

    const listEl = h("div", { class: "list" });
    st.list.forEach((r) => {
      const ok = String(r.recordStatus) === "1";
      const isCampus = String(r.type) === "1";
      const extra =
        !ok &&
        (String(r.recordStatus) === "23" || String(r.recordStatus) === "11")
          ? String(r.recordStatus) === "23"
            ? " · 时间异常"
            : " · 数据异常"
          : "";
      // 官方记录行的缩略图就是这次跑步的地图截图（记录列表的 file_img 是带签名的公网 URL）
      const shotUrl = typeof r.fileImg === "string" ? r.fileImg : "";
      const thumb = shotUrl
        ? h("img", {
            class: "li-thumb",
            src: shotUrl,
            alt: "截图",
            loading: "lazy",
            onError: (e) => {
              const wrap = (e.currentTarget || e.target).closest(
                ".li-thumb-wrap",
              );
              if (wrap) wrap.remove();
            },
          })
        : null;
      // 状态不再单独放一个圆圈：无效记录的副标题直接标红写原因，有效记录不额外加装饰
      const subText =
        fmtShortTime(r.startTime) +
        extra +
        (!ok && r.statusText
          ? ` · ${r.statusText.replace(/（.*?）/, "")}`
          : "");

      // 单击 = 详情；长按 = 导入为路线（对齐 Android 语义）
      let pressTimer = null;
      let longFired = false;
      const item = h(
        "button",
        {
          class: "list-item",
          style: { touchAction: "manipulation" },
          onClick: () => {
            if (longFired) {
              longFired = false;
              return;
            }
            openDetail(r.recordId, shotUrl);
          },
          onContextmenu: (e) => e.preventDefault(),
        },
        [
          thumb ? h("span", { class: "li-thumb-wrap" }, [thumb]) : null,
          h("span", { class: "li-main" }, [
            h("div", { class: "li-title" }, [
              h("span", {
                class: "li-dist",
                text: `${Number(r.distance).toFixed(2)} km`,
              }),
              h("span", {
                class: "li-meta",
                text: `${fmtDuration(r.usedTime)} · ${isCampus ? "校园跑" : "自由跑"}`,
              }),
            ]),
            h("span", {
              class: `li-sub${!ok || extra ? " danger" : ""}`,
              text: subText,
            }),
          ]),
        ],
      );
      const cancelPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };
      item.addEventListener("pointerdown", () => {
        longFired = false;
        cancelPress();
        pressTimer = setTimeout(() => {
          pressTimer = null;
          longFired = true;
          askImport(r.recordId, r.distance);
        }, 600);
      });
      ["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
        item.addEventListener(ev, cancelPress),
      );
      listEl.appendChild(item);
    });
    listCard.appendChild(listEl);
    if (st.moreError) {
      listCard.appendChild(
        h("div", { class: "card-body" }, [
          h("p", {
            class: "hint danger",
            text: `加载更多失败：${st.moreError}`,
          }),
        ]),
      );
    }
    if (st.hasMore) {
      listCard.appendChild(
        h("div", { class: "card-body" }, [
          h("button", {
            class: "btn btn-sm btn-block",
            text: st.loadingMore
              ? "加载中…"
              : `加载更多（已显示 ${st.list.length} / ${st.total || "?"}）`,
            disabled: st.loadingMore,
            onClick: () => loadMore(),
          }),
        ]),
      );
    }
  }

  // ─────────── 详情 ───────────

  async function openDetail(recordId, shotUrl = "") {
    const title = h("span", {
      class: "fullpage-title",
      text: `记录 #${recordId}`,
    });
    const panel = h("div", { class: "fullpage-panel" });
    const mapWrap = h("div", { class: "map-wrap" });
    const mapEl = h("div", { class: "map map-fill" });
    const headNote = h("span", { class: "head-note mono", text: "" });
    const rootPage = h("div", { class: "fullpage" }, [
      h("div", { class: "fullpage-head" }, [
        h(
          "button",
          {
            class: "btn btn-icon btn-ghost",
            "aria-label": "返回",
            onClick: () => destroy(),
          },
          [svg("back", 18)],
        ),
        title,
        headNote,
      ]),
      h("div", { class: "fullpage-body split" }, [mapWrap, panel]),
      h("div", { class: "fullpage-foot" }, [
        h("button", {
          class: "btn btn-primary btn-block",
          text: "导入为路线",
          onClick: async () => {
            destroy();
            await doImport(recordId);
          },
        }),
      ]),
    ]);
    mapWrap.appendChild(mapEl);
    document.body.appendChild(rootPage);
    document.body.style.overflow = "hidden";

    let trackMap = null;
    let destroyed = false;
    function destroy() {
      destroyed = true;
      if (trackMap) {
        trackMap.destroy();
        trackMap = null;
      }
      rootPage.remove();
      document.body.style.overflow = "";
      if (!document.querySelector(".fullpage"))
        document.body.style.overflow = "";
    }

    panel.innerHTML = `<div class="row"><span class="spinner"></span><span class="hint">正在加载记录详情…</span></div>`;
    try {
      const res = await api.recordDetail(recordId);
      if (destroyed) return;
      if (Number(res.status) !== 1) {
        panel.innerHTML = "";
        panel.appendChild(
          h("p", { class: "hint danger", text: res.info || "加载失败" }),
        );
        return;
      }
      const d = res.detail;
      title.textContent = `${String(d.type) === "1" ? "校园跑" : "自由跑"} · #${recordId}`;
      headNote.textContent = fmtShortTime(d.startTime);
      const ok =
        String(d.recordStatus) === "1" ||
        (String(d.recordStatus) === "0" && !d.failedReason);
      const statusText = ok ? "有效" : d.failedReason || d.statusText || "异常";
      const avgSpeed = d.usedTime > 0 ? (d.distance * 1000) / d.usedTime : 0;

      panel.innerHTML = "";
      panel.append(
        h("div", { class: "card" }, [
          h("div", { class: "card-head" }, [
            h("h3", { text: "基本信息" }),
            h("span", {
              class: `badge ${ok ? "ok" : "danger"}`,
              text: statusText,
            }),
          ]),
          h("div", { class: "card-body tight" }, [
            statGrid([
              {
                value: `${Number(d.distance).toFixed(2)} km`,
                label: "距离",
                accent: true,
              },
              { value: fmtDuration(d.usedTime), label: "时长" },
              { value: `${avgSpeed.toFixed(1)} m/s`, label: "均速" },
            ]),
            statGrid([
              { value: fmtPaceFromSpeed(avgSpeed), label: "配速 /km" },
              { value: `${d.stepNum} 步`, label: "步数" },
              { value: `${d.logNum} 点`, label: "打卡" },
            ]),
            kvList([["开始时间", fmtClock(d.startTime)]]),
          ]),
        ]),
      );

      // 跑步截图：官方记录详情接口不回 file_img，图片 URL 只在列表里（file_img 带签名，1 小时有效）
      const imgUrl =
        shotUrl || (d.fileImg && d.fileImg !== "1" ? d.fileImg : "");
      if (imgUrl) {
        const shot = h("img", {
          class: "shot-img",
          src: imgUrl,
          alt: "跑步截图",
          loading: "lazy",
          draggable: "false",
        });
        shot.addEventListener("error", () => {
          shot.replaceWith(
            h("p", {
              class: "hint",
              text: "截图加载失败（签名可能已过期，返回列表刷新即可）",
            }),
          );
        });
        shot.addEventListener("click", () =>
          openModal({
            title: "跑步截图",
            wide: true,
            body: [
              h("img", { class: "shot-full", src: imgUrl, alt: "跑步截图" }),
            ],
          }),
        );
        panel.appendChild(
          h("div", { class: "card" }, [
            h("div", { class: "card-head" }, [
              h("h3", { text: "跑步截图" }),
              h("span", { class: "head-note", text: "点击看原图" }),
            ]),
            h("div", { class: "card-body tight" }, [shot]),
          ]),
        );
      }

      // 抓拍照片（record_img）：只有学校开了抓拍、且本次有抓拍记录时才显示
      if (d.recordImg && d.recordImg !== "1") {
        const capUrl = `/api/records/capture?id=${encodeURIComponent(recordId)}`;
        const cap = h("img", {
          class: "shot-img",
          src: capUrl,
          alt: "抓拍照片",
          loading: "lazy",
          draggable: "false",
        });
        cap.addEventListener("error", () => {
          const card = cap.closest(".card");
          if (card) card.remove();
        });
        cap.addEventListener("click", () =>
          openModal({
            title: "抓拍照片",
            wide: true,
            body: [
              h("img", { class: "shot-full", src: capUrl, alt: "抓拍照片" }),
            ],
          }),
        );
        panel.appendChild(
          h("div", { class: "card" }, [
            h("div", { class: "card-head" }, [
              h("h3", { text: "抓拍照片" }),
              h("span", { class: "head-note", text: "学校抓拍 · 点击看原图" }),
            ]),
            h("div", { class: "card-body tight" }, [cap]),
          ]),
        );
      }

      // 公里分段（服务端轨迹含 b/c 字段时优先；否则按点序本地计算）
      const track = res.track;
      if (
        track &&
        track.length >= 2 &&
        track.every((p) => Number.isFinite(p.t))
      ) {
        const splits = computeSplits(track);
        if (splits.length) {
          const maxSec = Math.max(...splits.map((s) => s.seconds));
          // 默认展开；点击标题行仍可收起
          const note = h("span", { class: "head-note" });
          const detail = h(
            "details",
            {
              class: "card fold-card",
              open: true,
              onToggle: () => {
                note.textContent = `${splits.length} km · ${detail.open ? "点击收起" : "点击展开"}`;
              },
            },
            [
              h("summary", { class: "card-head" }, [
                h("h3", { text: "公里配速" }),
                note,
              ]),
              h(
                "div",
                { class: "card-body tight" },
                splits.map((s) =>
                  h("div", { class: "split-row" }, [
                    h("span", { class: "muted", text: `${s.km} km` }),
                    h("span", { class: "bar" }, [
                      h("i", {
                        style: {
                          width: `${Math.round((s.seconds / maxSec) * 100)}%`,
                        },
                      }),
                    ]),
                    h("span", {
                      text: `${fmtDuration(s.seconds)}  ${fmtPace(s.seconds)}/km`,
                    }),
                  ]),
                ),
              ),
            ],
          );
          note.textContent = `${splits.length} km · 点击收起`;
          panel.appendChild(detail);
        }
      }

      if (track && track.length >= 2) {
        requestAnimationFrame(() => {
          if (destroyed) return;
          trackMap = new TrackMap(mapEl, {
            track: track.map((p) => [p.lat, p.lng]),
            fence: res.fence || [],
            // 看的是某一次记录的轨迹：视图以轨迹为准（围栏可能属于换学校后的新跑区）
            fitTo: "track",
            center: [track[0].lat, track[0].lng],
          });
        });
      } else {
        panel.appendChild(
          h("p", { class: "hint", text: res.trackError || "该记录无轨迹文件" }),
        );
      }
    } catch (e) {
      if (!destroyed) {
        panel.innerHTML = "";
        panel.appendChild(
          h("p", { class: "hint danger", text: `加载失败：${e.message}` }),
        );
      }
    }
  }

  /** 从轨迹点算每公里分段（无 b/c 字段时按累计距离切分） */
  function computeSplits(track) {
    const splits = [];
    let cum = 0;
    let markIdx = 0;
    let km = 1;
    for (let i = 1; i < track.length; i += 1) {
      const dLat = (track[i].lat - track[i - 1].lat) * 111320;
      const dLng =
        (track[i].lng - track[i - 1].lng) *
        111320 *
        Math.cos((track[i].lat * Math.PI) / 180);
      cum += Math.sqrt(dLat * dLat + dLng * dLng);
      if (cum >= km * 1000) {
        const t0 = track[markIdx].t ?? markIdx * 2;
        const t1 = track[i].t ?? i * 2;
        splits.push({ km, seconds: Math.max(t1 - t0, 1) });
        markIdx = i;
        km += 1;
      }
    }
    return splits;
  }

  return {
    el: root,
    refresh: () => {
      load();
      loadRank(true);
    },
    destroy: () => {
      rankRequest++;
    },
  };
}
