import { Geo } from "./amap-adapter.js";
export function createBaseMap(el, opts = {}) {
  return Geo.map(el, opts);
}

/** 围栏多边形（iOS systemOrange，半透明填充） */
export function drawFence(map, fence) {
  if (!fence || fence.length < 3) return null;
  return Geo.polygon(
    fence.map((p) => [p[0], p[1]]),
    {
      color: "#FF9500",
      weight: 2,
      opacity: 0.85,
      fillColor: "#FF9500",
      fillOpacity: 0.15,
    },
  ).addTo(map);
}

/** 双描边轨迹线（白描边 + systemBlue 主线） */
export function drawPath(
  map,
  points,
  { color = "#007AFF", weight = 4, dash = null, fit = true } = {},
) {
  if (!points || points.length < 2) return null;
  const casing = Geo.polyline(points, {
    color: "#ffffff",
    weight: weight + 3,
    opacity: 0.85,
    lineJoin: "round",
  }).addTo(map);
  const line = Geo.polyline(points, {
    color,
    weight,
    lineJoin: "round",
    dashArray: dash,
  }).addTo(map);
  const group = Geo.layerGroup([casing, line]).addTo(map);
  if (fit) map.fitBounds(line.getBounds(), { padding: [28, 28] });
  return group;
}

export function startIcon() {
  return Geo.divIcon({
    className: "",
    html: '<div style="width:15px;height:15px;border-radius:50%;background:#34C759;border:2.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.25)"></div>',
    iconSize: [15, 15],
    iconAnchor: [7.5, 7.5],
  });
}

export function endIcon() {
  return Geo.divIcon({
    className: "",
    html: '<div style="width:15px;height:15px;border-radius:50%;background:#FF3B30;border:2.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.25)"></div>',
    iconSize: [15, 15],
    iconAnchor: [7.5, 7.5],
  });
}

export function pointIcon(text = "", tone = "default") {
  return Geo.divIcon({
    className: "",
    html: `<div style="width:19px;height:19px;border-radius:50%;background:${tone === "danger" ? "#FF3B30" : "#FF9500"};border:2px solid #fff;color:#fff;font-size:10px;font-weight:600;line-height:15px;text-align:center;font-family:ui-monospace,monospace;box-shadow:0 1px 3px rgba(0,0,0,.25)">${text}</div>`,
    iconSize: [19, 19],
    iconAnchor: [9.5, 9.5],
  });
}

/** 每度对应的米数（按纬度修正经度） */
function metersPerDeg(lat) {
  return { lat: 111320, lng: 111320 * Math.cos((lat * Math.PI) / 180) };
}

/** Douglas–Peucker 抽稀：抬手后压缩手绘点数，同时保住形状（容差按米） */
function simplifyDP(pts, tolM) {
  if (pts.length <= 3) return pts.slice();
  const per = metersPerDeg(pts[0][0]);
  const x = (p) => (p[1] - pts[0][1]) * per.lng;
  const y = (p) => (p[0] - pts[0][0]) * per.lat;
  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const sqTol = tolM * tolM;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    const x1 = x(pts[s]);
    const y1 = y(pts[s]);
    const x2 = x(pts[e]);
    const y2 = y(pts[e]);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let maxD2 = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i += 1) {
      const px = x(pts[i]);
      const py = y(pts[i]);
      let d2;
      if (len2 === 0) d2 = (px - x1) ** 2 + (py - y1) ** 2;
      else {
        const t = Math.max(
          0,
          Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2),
        );
        d2 = (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
      }
      if (d2 > maxD2) {
        maxD2 = d2;
        idx = i;
      }
    }
    if (maxD2 > sqTol) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Chaikin 切角平滑：手绘过程中的实时预览（不写回模型） */
function chaikin(pts, iterations = 1) {
  let out = pts;
  for (let k = 0; k < iterations; k += 1) {
    if (out.length < 3) return out;
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i += 1) {
      const p = out[i];
      const q = out[i + 1];
      next.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      next.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/**
 * 路线编辑器地图 —— 手绘为主（按住拖动连续画线，实时平滑、抬手抽稀、整笔撤销），
 * 另有「精确加点」模式（点击地图逐点添加）。桌面 + 触屏通用。
 * @param {HTMLElement} el
 * @param {{points:Array, fence:Array, center:Array, mode:'draw'|'point', onChange:(points)=>void}} opts
 */
export class RouteEditorMap {
  #detachPointer = null;

  constructor(el, opts = {}) {
    this.onChange = opts.onChange || (() => {});
    this.points = (opts.points || []).map((p) => [Number(p[0]), Number(p[1])]);
    this.mode = opts.mode === "point" ? "browse" : "draw"; // draw = 手绘 | browse = 精确加点
    /** 每一笔的起始下标（手绘模式「撤销」= 撤销一整笔） */
    this.strokes = [];
    const hasCenter = Boolean(opts.center || this.points[0]);
    this.map = createBaseMap(el, {
      center: opts.center || this.points[0],
      zoom: hasCenter ? 17 : 5,
    });
    this.line = null;
    this.markers = Geo.layerGroup().addTo(this.map);
    this.fenceLayer =
      opts.fence && opts.fence.length >= 3
        ? drawFence(this.map, opts.fence)
        : null;
    this.#bind();
    this.redraw(opts.fit !== false);
    this.setMode(this.mode);
  }

  #bind() {
    const map = this.map;

    // 点击加点（浏览模式）
    map.on("click", (e) => {
      if (this.mode !== "browse") return;
      this.points.push([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]);
      this.redraw(false);
      this.onChange(this.points);
    });

    // 手绘（draw 模式）—— 触屏用 pointer 事件，鼠标同理；一笔 = 从按下到抬起
    const container = map.getContainer();
    let drawing = false;
    let lastLatLng = null;
    let strokeStart = 0;
    let capturedId = null;
    const activePointers = new Set();

    /**
     * 第二根手指落下 = 用户想双指缩放：把刚起笔的这一笔整笔撤掉，交给 地图 SDK 的 touchZoom。
     * 否则捏合时第一根手指会被当成手绘，缩放结束地图上多出一条乱线（之前的“放大手势很奇怪”）。
     */
    const abortStroke = () => {
      if (!drawing) return;
      drawing = false;
      this.strokes.pop();
      this.points = this.points.slice(0, strokeStart);
      lastLatLng = null;
      if (capturedId !== null) {
        try {
          container.releasePointerCapture(capturedId);
        } catch (_) {
          /* ignore */
        }
        capturedId = null;
      }
      this.redraw(false);
      this.onChange(this.points);
    };

    const onDown = (e) => {
      activePointers.add(e.pointerId);
      if (activePointers.size > 1) {
        abortStroke();
        return;
      }
      if (this.mode !== "draw") return;
      const pt = this.#latLngFromEvent(e);
      if (!pt) return;
      drawing = true;
      strokeStart = this.points.length;
      this.strokes.push(strokeStart);
      lastLatLng = pt;
      this.points.push([+pt.lat.toFixed(6), +pt.lng.toFixed(6)]);
      this.redraw(false, true);
      container.setPointerCapture && container.setPointerCapture(e.pointerId);
      capturedId = e.pointerId;
      map.dragging.disable();
    };
    const onMove = (e) => {
      // 双指 / 非主指针：这是缩放手势，不画线
      if (!drawing || activePointers.size > 1 || e.isPrimary === false) return;
      e.preventDefault();
      const pt = this.#latLngFromEvent(e);
      if (!pt) return;
      // 采样间隔：距上一点 > 3.5m 才记录，避免点数爆炸
      if (lastLatLng && this.map.distance(lastLatLng, pt) < 3.5) return;
      lastLatLng = pt;
      this.points.push([+pt.lat.toFixed(6), +pt.lng.toFixed(6)]);
      this.redraw(false, true); // 实时平滑预览
      this.onChange(this.points, { live: true }); // 只刷统计文字，避免每帧重建面板
    };
    const onUp = (e) => {
      activePointers.delete(e.pointerId);
      if (!drawing) return;
      // 双指缩放中先抬起一根手指：不结束这一笔，等真正抬手
      if (activePointers.size > 0) return;
      drawing = false;
      if (capturedId !== null) {
        try {
          container.releasePointerCapture(capturedId);
        } catch (_) {
          /* ignore */
        }
        capturedId = null;
      }
      map.dragging.enable();
      // 抬手：对本笔做 Douglas–Peucker 抽稀（3m 容差）——点数压下来，形状保住
      const start = this.strokes.length
        ? this.strokes[this.strokes.length - 1]
        : 0;
      const raw = this.points.slice(start);
      if (raw.length > 3) {
        this.points = this.points.slice(0, start).concat(simplifyDP(raw, 3));
      }
      this.redraw(false);
      this.onChange(this.points);
    };

    container.addEventListener("pointerdown", onDown);
    container.addEventListener("pointermove", onMove, { passive: false });
    container.addEventListener("pointerup", onUp);
    container.addEventListener("pointercancel", onUp);
    this.#detachPointer = () => {
      container.removeEventListener("pointerdown", onDown);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup", onUp);
      container.removeEventListener("pointercancel", onUp);
    };
  }

  #latLngFromEvent(e) {
    const rect = this.map.getContainer().getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return this.map.containerPointToLatLng([x, y]);
  }

  setMode(mode) {
    this.mode = mode;
    this.map.getContainer().style.cursor = mode === "draw" ? "crosshair" : "";
    if (mode === "draw") this.map.dragging.disable();
    else this.map.dragging.enable();
  }

  setPoints(points, fit = true) {
    this.points = (points || []).map((p) => [Number(p[0]), Number(p[1])]);
    this.strokes = [];
    this.redraw(fit);
    this.onChange(this.points);
  }

  getPoints() {
    return this.points;
  }

  /** 手绘模式下已有的笔画数（整笔撤销用） */
  getStrokeCount() {
    return this.strokes.length;
  }

  /** 撤销：手绘模式撤销一整笔；精确模式删掉最后一个点 */
  undo() {
    if (this.mode === "draw" && this.strokes.length) {
      const start = this.strokes.pop();
      this.points = this.points.slice(0, start);
    } else {
      this.points.pop();
    }
    this.redraw(false);
    this.onChange(this.points);
  }

  clear() {
    this.points = [];
    this.strokes = [];
    this.redraw(false);
    this.onChange(this.points);
  }

  fitToFence() {
    if (this.fenceLayer)
      this.map.fitBounds(this.fenceLayer.getBounds(), { padding: [24, 24] });
    else if (this.points.length >= 2)
      this.map.fitBounds(this.points, { padding: [24, 24] });
  }

  /**
   * 重绘路线
   * @param {boolean} fit 是否缩放到路线范围
   * @param {boolean} preview 手绘进行中：把当前这一笔做 Chaikin 平滑仅用于显示（模型仍是原始点）
   */
  redraw(fit = false, preview = false) {
    if (this.line) {
      this.line.remove();
      this.line = null;
    }
    this.markers.clearLayers();
    const pts = this.points;
    let display = pts;
    if (preview && this.mode === "draw" && this.strokes.length) {
      const start = this.strokes[this.strokes.length - 1];
      display = pts.slice(0, start).concat(chaikin(pts.slice(start), 1));
    }
    if (display.length >= 2) {
      const casing = Geo.polyline(display, {
        color: "#ffffff",
        weight: 8,
        opacity: 0.9,
        lineJoin: "round",
        lineCap: "round",
      });
      const line = Geo.polyline(display, {
        color: "#007AFF",
        weight: 4,
        lineJoin: "round",
        lineCap: "round",
      });
      this.line = Geo.layerGroup([casing, line]).addTo(this.map);
    }
    if (pts.length === 1) {
      Geo.circleMarker(pts[0], {
        radius: 5,
        color: "#007AFF",
        weight: 2,
        fillColor: "#007AFF",
        fillOpacity: 1,
      }).addTo(this.markers);
    } else if (pts.length >= 2) {
      Geo.marker(pts[0], { icon: startIcon(), interactive: false }).addTo(
        this.markers,
      );
      Geo.marker(pts[pts.length - 1], {
        icon: endIcon(),
        interactive: false,
      }).addTo(this.markers);
    }
    if (fit && pts.length >= 2) this.map.fitBounds(pts, { padding: [24, 24] });
  }

  destroy() {
    if (this.#detachPointer) this.#detachPointer();
    this.map.remove();
  }
}

/**
 * 只读轨迹地图（记录详情 / 预览 / 右栏「跑区与路线」）
 *
 * fitTo 决定视图锚点（谁说了算）：
 * - 'auto'（默认）：有围栏就以围栏为准（围栏来自当前学校的跑区，是权威坐标），否则按轨迹
 * - 'fence' / 'track' / 'none'：强制指定 / 完全不自动缩放
 * 之所以要有这个开关：轨迹可能是**别的校区**留下的（换学校后没重画），
 * 以前无条件 fitBounds 到轨迹，地图就会永远钉在旧校区。
 */
export class TrackMap {
  constructor(
    el,
    {
      track = [],
      fence = [],
      checkpoints = [],
      center,
      zoom = 17,
      fitTo = "auto",
    } = {},
  ) {
    this.map = createBaseMap(el, {
      center: center || (track[0] ? [track[0][0], track[0][1]] : undefined),
      zoom,
    });
    const fenceOk = Boolean(fence && fence.length >= 3);
    if (fenceOk) drawFence(this.map, fence);
    if (track && track.length >= 2) {
      const pts = track.map((p) => [p[0], p[1]]);
      // 显示层抽稀：GPS 点很密时去掉抖动尖刺，形状不变（只影响画线，与上传数据无关）
      const shown = pts.length > 400 ? simplifyDP(pts, 3) : pts;
      drawPath(this.map, shown, { fit: false });
      Geo.marker(track[0].slice(0, 2), {
        icon: startIcon(),
        interactive: false,
      }).addTo(this.map);
      Geo.marker(track[track.length - 1].slice(0, 2), {
        icon: endIcon(),
        interactive: false,
      }).addTo(this.map);
    }
    (checkpoints || []).forEach((cp, i) => {
      Geo.marker([cp.lat, cp.lng], { icon: pointIcon(String(i + 1)) })
        .addTo(this.map)
        .bindTooltip(`打卡点 ${cp.id}`);
    });

    const anchor = fitTo === "auto" ? (fenceOk ? "fence" : "track") : fitTo;
    const bounds =
      anchor === "fence" && fenceOk
        ? Geo.latLngBounds(fence.map((p) => [p[0], p[1]]))
        : anchor === "track" && track && track.length >= 2
          ? Geo.latLngBounds(track.map((p) => [p[0], p[1]]))
          : null;
    if (bounds) this.map.fitBounds(bounds, { padding: [28, 28] });
  }

  fit() {
    this.map.invalidateSize();
  }

  destroy() {
    this.map.remove();
  }
}
