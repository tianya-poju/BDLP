import { calculatePreview } from "./preview-client.js";
import { Geo } from "./amap-adapter.js";
import { h, openModal, toast } from "./util.js";
import { invoke } from "./ipc.js";
import { createBaseMap, drawFence, drawPath, pointIcon } from "./map.js";
export function autoRoute(app, { onApplied, onClose } = {}) {
  const id = crypto.randomUUID();
  let closed = false,
    map = null,
    progressTimer = null,
    appliedPoints = null;
  let progressBusy = false;
  const status = h("p", {
    class: "hint",
    text: "正在读取学校规则和全部打卡点…",
  });
  const warning = h("p", {
    class: "hint",
    text: "直线闭环，可能经过建筑或不可通行区域，请核对实际环境。",
  });
  const mapEl = h("div", { class: "map route-preview-map" });
  const issues = h("div", { class: "route-preview-issues" });
  const detail = h("div", { class: "route-preview-detail-scroll" });
  const details = h(
    "details",
    { class: "route-preview-details", onToggle: () => map?.invalidateSize() },
    [h("summary", { text: "查看详情" }), detail],
  );
  const requestStats = h("p", { class: "hint" });
  detail.append(requestStats);
  const apply = h("button", {
    class: "btn btn-primary",
    text: "应用路线",
    disabled: true,
    onClick: async () => {
      apply.disabled = true;
      status.textContent = "正在重新核对账号、打卡点和学校规则…";
      try {
        await invoke("route_plan_apply", { id });
        if (closed) return;
        if (onApplied) await onApplied(appliedPoints);
        modal.close();
        await app.refresh();
        toast("已应用打卡点闭环路线", "ok");
      } catch (e) {
        if (!closed) {
          status.textContent = e.message;
          status.className = "hint danger";
        }
      }
    },
  });
  const cancel = h("button", {
    class: "btn",
    text: "取消",
    onClick: () => modal.close(),
  });
  const modal = openModal({
    title: "自动规划路线",
    className: "route-preview-modal",
    body: [warning, status, mapEl, issues, details],
    footer: [cancel, apply],
    onClose: () => {
      if (closed) return;
      closed = true;
      clearInterval(progressTimer);
      invoke("route_plan_cancel", { id }).catch(() => {});
      map?.remove();
      onClose?.();
    },
  });
  // Map initialization and result rendering are discarded when the dialog is closed.
  Promise.resolve().then(async () => {
    if (closed) return;
    map = createBaseMap(mapEl);
    try {
      progressTimer = setInterval(async () => {
        if (closed || progressBusy) return;
        progressBusy = true;
        try {
          const p = await invoke("route_plan_status", { id });
          if (!closed) {
            status.textContent = `${p.phase} · ${p.completed}/${p.total} 段`;
            requestStats.textContent = `请求 ${p.requests} 次 · 缓存命中 ${p.cacheHits} 段`;
          }
        } catch {
        } finally {
          progressBusy = false;
        }
      }, 500);
      const r = await invoke("route_plan", { id });
      clearInterval(progressTimer);
      if (closed) return;
      appliedPoints = r.points;
      drawFence(map, r.fence || []);
      for (const segment of r.roadSegments || [r.points])
        drawPath(map, segment, { fit: false });
      map.fitBounds?.(r.points);
      for (const i of r.outsideSegments)
        Geo.polyline([r.points[i], r.points[i + 1]], {
          color: "#FF3B30",
          weight: 7,
        }).addTo(map);
      const missed = (r.coverage || []).filter((cp) => !cp.covered);
      const missedIds = new Set(missed.map((cp) => cp.id));
      r.order.forEach((cp, i) =>
        Geo.marker(cp.point, {
          icon: pointIcon(
            String(i + 1),
            missedIds.has(cp.id) ? "danger" : "default",
          ),
        })
          .addTo(map)
          .bindTooltip(
            `${missedIds.has(cp.id) ? "未覆盖点" : "打卡点"} ${cp.id}`,
          ),
      );
      for (const cp of missed)
        issues.append(
          h("p", {
            class: "hint danger",
            text: `未覆盖点 ${cp.id}：距路线 ${cp.distanceM.toFixed(1)} 米（检查半径 ${cp.radiusM} 米），不能应用。`,
          }),
        );
      status.textContent = `${(r.distanceM / 1000).toFixed(3)} km · 已覆盖 ${r.covered}/${r.coverage?.length || r.order.length} 个打卡点 · 直线闭环`;
      detail.append(
        h("p", {
          class: "hint",
          text:
            "访问顺序：" +
            r.order.map((cp) => cp.id).join(" → ") +
            " → 返回起点",
        }),
      );
      if (!r.fenceAvailable)
        issues.append(
          h("p", {
            class: "hint warn",
            text: "学校未返回可用围栏，无法核对是否越界，请自行检查。",
          }),
        );
      if (r.outsideSegments.length)
        issues.append(
          h("p", {
            class: "hint danger",
            text: `有 ${r.outsideSegments.length} 条越界线段，已标红，不能应用。`,
          }),
        );
      if (r.minimumM > 0 && r.distanceM < r.minimumM)
        issues.append(
          h("p", {
            class: "hint warn",
            text: `短于当前或下一时段最低距离 ${(r.minimumM / 1000).toFixed(2)} km；不自动延长，请在使用前自行调整。`,
          }),
        );
      for (const cp of r.coverage || [])
        detail.append(
          h("p", {
            class: cp.covered ? "hint" : "hint danger",
            text: `点 ${cp.id}：距路线 ${cp.distanceM.toFixed(1)} 米 / 检查半径 ${cp.radiusM} 米 · ${cp.covered ? "已覆盖" : "未覆盖"}`,
          }),
        );
      if (r.continuous === false)
        issues.append(
          h("p", {
            class: "hint danger",
            text: "路线不连续或未形成闭环，不能应用。",
          }),
        );
      if ((r.coverage || []).some((cp) => cp.radiusSource === "local_default"))
        detail.append(
          h("p", {
            class: "hint",
            text: "未返回明确米制半径的点，采用本地30米检查；不代表服务端认可。",
          }),
        );
      detail.append(
        h("p", {
          class: "hint",
          text: `${r.orderExact ? "12点以内精确访问排序" : "近似优化访问排序"}；直线闭环不代表可通行道路，本操作不提交跑步。`,
        }),
      );
      requestStats.textContent = `本地直线规划 · 不调用道路吸附`;
      let sampled = true;
      if (r.canApply) {
        const check = await calculatePreview(
          "checkpoints",
          r.points,
          r.order,
          r.coverage || [],
          r.fence || [],
          app.state?.runConfig || {},
          r.samplingRules,
        );
        if (closed) return;
        sampled = check.canApply;
        if (!sampled)
          issues.append(
            h("p", {
              class: "hint danger",
              text: `预览重采样：覆盖 ${check.passed}/${check.total}，${check.outsideCount} 个采样点、${check.outsideSegments || 0} 条采样连线越界，不能应用。`,
            }),
          );
        detail.append(
          h("p", {
            class: "hint",
            text: `预览采样 ${check.samples} 点 · 覆盖 ${check.passed}/${check.total}`,
          }),
        );
      }
      detail.append(
        h("p", {
          class: "hint",
          text: `精确锚点 ${r.anchorCount ?? r.order.length} 个 · 辅助偏移最大 ${(r.jitterMaxM ?? 0).toFixed(2)} 米`,
        }),
      );
      const ready = map.ready ? await map.ready : true;
      if (closed) return;
      if (!ready)
        issues.append(
          h("p", {
            class: "hint danger",
            text: "官方地图未加载，不能确认应用。请检查高德地图授权与网络。",
          }),
        );
      apply.disabled = !r.canApply || !ready || !sampled || missed.length > 0;
    } catch (e) {
      clearInterval(progressTimer);
      if (!closed) {
        status.textContent = e.message;
        status.className = "hint danger";
      }
    }
  });
  return modal;
}
