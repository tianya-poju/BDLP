import { invoke } from "./ipc.js";
export function mapError(error) {
  const text = String(error?.info || error?.message || error || "");
  const known = {
    INVALID_USER_KEY: "地图 Key 无效或已失效",
    INVALID_USER_SCODE: "地图安全密钥校验失败",
    INVALID_USER_DOMAIN: "地图域名限制不匹配",
    USERKEY_PLAT_NOMATCH: "地图 Key 服务平台类型不匹配",
    SERVICE_NOT_AVAILABLE: "地图服务未开通或无权限",
    DAILY_QUERY_OVER_LIMIT: "地图服务额度已用完",
    USER_DAILY_QUERY_OVER_LIMIT: "地图服务额度已用完",
  };
  for (const [code, msg] of Object.entries(known))
    if (text.includes(code)) return `${msg}（${code}）`;
  if (text.includes("容器")) return "地图容器尺寸异常，请重新打开页面";
  if (text.includes("配置未完成"))
    return "官方地图配置未完成，缺少 JS API Key 或配套安全密钥";
  return "官方地图加载失败或超时，请检查网络与高德授权配置";
}
let sdkPromise = null;
export function loadSdk() {
  if (!sdkPromise)
    sdkPromise = (async () => {
      const config = await invoke("map_config");
      if (!config.jsApiKey || !config.securityJsCode) throw Error("配置未完成");
      window._AMapSecurityConfig = { securityJsCode: config.securityJsCode };
      if (!window.AMapLoader) throw Error("官方加载器未就绪");
      return window.AMapLoader.load({
        key: config.jsApiKey,
        version: "2.0",
        plugins: ["AMap.ToolBar", "AMap.Scale"],
      });
    })().catch((error) => {
      sdkPromise = null;
      throw Error(mapError(error));
    });
  return sdkPromise;
}
const xy = (p) => [Number(p[1] ?? p.lng), Number(p[0] ?? p.lat)];
function ll(p) {
  return Array.isArray(p) ? { lat: Number(p[0]), lng: Number(p[1]) } : p;
}
export function distanceM(a, b) {
  a = ll(a);
  b = ll(b);
  const rad = Math.PI / 180,
    h =
      Math.sin(((a.lat - b.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) *
        Math.cos(b.lat * rad) *
        Math.sin(((a.lng - b.lng) * rad) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
class MapView {
  constructor(el, opts = {}) {
    this.el = el;
    this.dead = false;
    this.handlers = [];
    const position =
      globalThis.getComputedStyle?.(el)?.position ||
      el.style.position ||
      "static";
    if (position === "static") el.style.position = "relative";
    const message = document.createElement("div");
    message.className = "map-status";
    message.textContent = "正在加载高德官方地图…";
    message.setAttribute?.("role", "status");
    el.appendChild(message);
    this.message = message;
    this.sdkHost = document.createElement("div");
    this.sdkHost.className = "map-sdk-host";
    Object.assign(this.sdkHost.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
    });
    el.appendChild(this.sdkHost);
    this.dragging = {
      disable: () => this.status({ dragEnable: false }),
      enable: () => this.status({ dragEnable: true }),
    };
    const sized = this.watchSize();
    const initialize = sized
      .then(async (visible) => ({
        visible,
        A: visible && !this.dead ? await loadSdk() : null,
      }))
      .then(
        ({ A, visible }) =>
          new Promise((resolve, reject) => {
            if (this.dead || !visible) {
              resolve(null);
              return;
            }
            this.A = A;
            this.native = new A.Map(this.sdkHost, {
              viewMode: "2D",
              center: xy(opts.center || [35, 105]),
              zoom: opts.zoom || 5,
              resizeEnable: true,
              rotateEnable: false,
              pitchEnable: false,
            });
            this.timer = setTimeout(() => reject(Error("地图加载超时")), 20000);
            this.settle = () => resolve(null);
            this.native.on("complete", () => {
              clearTimeout(this.timer);
              if (this.dead) {
                resolve(null);
                return;
              }
              this.loaded = true;
              message.remove();
              if (A.ToolBar)
                this.native.addControl(
                  new A.ToolBar({
                    position: { bottom: "20px", right: "16px" },
                  }),
                );
              if (A.Scale) this.native.addControl(new A.Scale());
              this.scheduleResize();
              resolve(this.native);
            });
            this.native.on("error", reject);
          }),
      );
    const destroyed = new Promise((resolve) => (this.destroyResolve = resolve));
    this.ready = Promise.race([initialize, destroyed]).catch((error) => {
      this.cleanup();
      if (!this.dead) {
        this.native?.destroy();
        this.native = null;
        this.sdkHost.remove();
        message.textContent = mapError(error);
        el.style.minHeight = "80px";
        if (!el.contains(message)) el.appendChild(message);
      }
      return null;
    });
  }
  watchSize() {
    return new Promise((resolve, reject) => {
      let waiting = true;
      this.cancelSize = () => {
        if (waiting) {
          waiting = false;
          resolve(false);
        }
      };
      this.checkSize = () => {
        if (this.dead) return;
        const rect = this.el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        if (waiting) {
          waiting = false;
          clearTimeout(this.sizeTimer);
          clearInterval(this.sizePoll);
          resolve(true);
        }
        this.scheduleResize();
      };
      // Hidden responsive panels remain dormant until ResizeObserver sees a usable size.
      if (globalThis.ResizeObserver) {
        this.observer = new ResizeObserver(this.checkSize);
        this.observer.observe(this.el);
      } else {
        this.sizePoll = setInterval(this.checkSize, 100);
      }
      window.addEventListener?.("resize", this.checkSize);
      this.checkSize();
    });
  }
  scheduleResize() {
    if (this.dead || this.frame != null) return;
    const request =
      globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
    this.frame = request(() => {
      this.frame = null;
      if (!this.dead && this.loaded && this.native) {
        this.native.resize?.();
        const center = this.native.getCenter?.();
        if (center) this.native.setCenter(center);
      }
    });
  }
  cleanup() {
    clearTimeout(this.timer);
    clearTimeout(this.sizeTimer);
    clearInterval(this.sizePoll);
    this.observer?.disconnect();
    window.removeEventListener?.("resize", this.checkSize);
    this.cancelSize?.();
    if (this.frame != null)
      (globalThis.cancelAnimationFrame || clearTimeout)(this.frame);
    this.frame = null;
  }
  status(v) {
    this.ready.then((m) => {
      if (m && !this.dead) m.setStatus(v);
    });
  }
  on(name, fn) {
    if (name === "remove") {
      this.handlers.push(fn);
      return this;
    }
    this.ready.then((m) => {
      if (m && !this.dead)
        m.on(name, (e) =>
          fn(
            name === "click"
              ? { ...e, latlng: ll([e.lnglat.getLat(), e.lnglat.getLng()]) }
              : e,
          ),
        );
    });
    return this;
  }
  once(name, fn) {
    return this.on(name, fn);
  }
  getContainer() {
    return this.el;
  }
  distance(a, b) {
    return distanceM(a, b);
  }
  containerPointToLatLng(p) {
    if (!this.native) return null;
    const r = this.native.containerToLngLat(new this.A.Pixel(p[0], p[1]));
    return { lat: r.getLat(), lng: r.getLng() };
  }
  setView(center, zoom) {
    this.ready.then((m) => {
      if (m && !this.dead) m.setZoomAndCenter(zoom, xy(center));
    });
    return this;
  }
  fitBounds(points, { padding = [24, 24] } = {}) {
    if (!points?.length) return;
    this.ready.then((m) => {
      if (!m || this.dead) return;
      const ys = points.map((p) => ll(p).lat),
        xs = points.map((p) => ll(p).lng);
      const lo = [Math.min(...xs), Math.min(...ys)],
        hi = [Math.max(...xs), Math.max(...ys)];
      if (lo[0] === hi[0] && lo[1] === hi[1]) m.setCenter(lo);
      else
        m.setBounds(new this.A.Bounds(lo, hi), false, [
          padding[0],
          padding[1],
          padding[0],
          padding[1],
        ]);
    });
    return this;
  }
  invalidateSize() {
    this.checkSize?.();
    this.scheduleResize();
  }
  remove() {
    if (this.dead) return;
    this.dead = true;
    this.handlers.forEach((fn) => fn());
    this.handlers = [];
    this.cleanup();
    this.destroyResolve?.(null);
    this.settle?.();
    this.native?.destroy();
    this.native = null;
    this.sdkHost.remove();
    this.message.remove();
  }
}
class Overlay {
  constructor(kind, points, options = {}) {
    this.kind = kind;
    this.points = kind === "marker" || kind === "circle" ? [points] : points;
    this.options = options;
    this.dead = false;
  }
  addTo(target) {
    if (target instanceof Group) {
      target.add(this);
      return this;
    }
    this.map = target;
    target.ready.then((m) => {
      if (!m || target.dead || this.dead) return;
      const A = target.A,
        o = this.options;
      const common = {
        strokeColor: o.color,
        strokeWeight: o.weight,
        strokeOpacity: o.opacity ?? 1,
        strokeStyle: o.dashArray ? "dashed" : "solid",
        lineJoin: "round",
        lineCap: "round",
        bubble: true,
      };
      if (this.kind === "marker") {
        const content = document.createElement("div");
        content.innerHTML = o.icon?.html || "";
        if (this.title) content.title = this.title;
        this.native = new A.Marker({
          position: xy(this.points[0]),
          content,
          anchor: "center",
          bubble: true,
          clickable: o.interactive !== false,
        });
      } else if (this.kind === "circle")
        this.native = new A.CircleMarker({
          ...common,
          center: xy(this.points[0]),
          radius: o.radius || 5,
          fillColor: o.fillColor,
          fillOpacity: o.fillOpacity ?? 1,
        });
      else if (this.kind === "polygon")
        this.native = new A.Polygon({
          ...common,
          path: this.points.map(xy),
          fillColor: o.fillColor,
          fillOpacity: o.fillOpacity ?? 0.15,
        });
      else
        this.native = new A.Polyline({
          ...common,
          path: this.points.map(xy),
          showDir: false,
        });
      this.native.setMap(m);
    });
    return this;
  }
  bindTooltip(text) {
    this.title = String(text);
    this.map?.ready.then(() => {
      const el = this.native?.getContent?.();
      if (el && typeof el === "object") el.title = this.title;
    });
    return this;
  }
  getBounds() {
    return this.points;
  }
  remove() {
    this.dead = true;
    this.native?.setMap(null);
    this.native = null;
  }
}
class Group {
  constructor(layers = []) {
    this.layers = layers;
  }
  add(layer) {
    this.layers.push(layer);
    if (this.map) layer.addTo(this.map);
  }
  addTo(map) {
    this.map = map;
    for (const l of this.layers) l.addTo(map);
    return this;
  }
  clearLayers() {
    for (const l of this.layers) l.remove();
    this.layers = [];
  }
  remove() {
    this.clearLayers();
  }
}
export const Geo = {
  map: (el, opts) => new MapView(el, opts),
  polyline: (p, o) => new Overlay("line", p, o),
  polygon: (p, o) => new Overlay("polygon", p, o),
  marker: (p, o) => new Overlay("marker", p, o),
  circleMarker: (p, o) => new Overlay("circle", p, o),
  layerGroup: (p) => new Group(p),
  divIcon: (o) => o,
  latLngBounds: (p) => p,
  latLng: (p) => ({ ...ll(p), distanceTo: (q) => distanceM(p, q) }),
};
