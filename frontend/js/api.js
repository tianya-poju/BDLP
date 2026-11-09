import { toast } from "./util.js";
import { Geo } from "./amap-adapter.js";
import { pickTerm, normalizeTermScore } from "./term-score.js";
import { startRun, cancelRun, subscribeRun } from "./run-client.js";
import { calculatePreview, cancelPreviews } from "./preview-client.js";
import { PACE_OPTIONS, calculate } from "./pace.js";
import { DEVICE_PRESETS } from "./devices.js";
import { diagnose as diagnoseRules } from "./diagnosis.js";
import { invoke } from "./ipc.js";

export const API_BASE = "";
const defaults = {
  straightSpeed: 4.1,
  curveSpeed: 3.3,
  maxAccel: 0.4,
  gpsIntervalMs: 2000,
  stepLengthM: 1.5,
  cadenceSpm: 160,
  weightKg: 65,
  sensorIntensity: 1,
  middleFaceType: 2,
  paceLevel: 1,
  warmupTime: 10,
  cooldownTime: 8,
};
function distance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++)
    d += Geo.latLng(points[i - 1]).distanceTo(Geo.latLng(points[i]));
  return d / 1000;
}
const read = (kind, params = {}) => invoke("network_read", { kind, params });
let cachedRules = null;
async function accountMutation(command, args) {
  const result = await invoke(command, args);
  if (result?.cleanupPending)
    toast("账号已删除；部分照片清理待重试，重启后继续处理", "warn");
  return result;
}
const endpoints = {
  saveMapCenter: (lat, lng) => invoke("map_center_save", { lat, lng }),
  compat: async () => {
    const r = await api.zoneConfig(true);
    return {
      status: 1,
      level: "warn",
      summary: r.config.summary,
      blocked: r.diagnosis.blocked || [],
      warnings: ["配置检查不代表真实提交已通过，仍需本人验收"],
      configLines: r.config.lines,
    };
  },

  refreshSchools: () => invoke("schools_refresh"),
  checkSession: () => invoke("session_check"),
  alipayFaceUrl: (position = 0, dryRun = false) =>
    invoke("alipay_url", { position, dryRun }),
  alipayFaceCheck: (position = 0) => invoke("alipay_check", { position }),
  alipayFaceOpened: () => invoke("alipay_opened"),
  alipayLaunch: (url) => invoke("alipay_launch", { url }),
  faceValidate: () => invoke("face_validate"),
  faceReferenceRemove: (uid) => invoke("face_reference_remove", { uid }),

  rank: async (type, period, page = 1, category = 1) => {
    const r = await read("rank", {
      type: String(type),
      category: String(category),
      page: String(page),
      period: period == null ? "" : String(period),
    });
    const d = r.data || {};
    const row = (r) => ({
      rank: Number(r.rank) || 0,
      uid: String(r.uid ?? ""),
      name: String(r.name || ""),
      distance: Number(r.distance) || 0,
      scoreNum: Number(r.score_num) || 0,
      schoolName: String(r.school_name || ""),
    });
    const list = Array.isArray(d.rank_list) ? d.rank_list.map(row) : [];
    const mine = Array.isArray(d.my_rank) ? d.my_rank[0] : d.my_rank;
    return {
      status: 1,
      list,
      myRank: mine ? row(mine) : null,
      rules: d.rank_rules || null,
      page,
      hasMore: list.length > 0,
    };
  },

  runStart: async (params) => {
    const state = await api.state();
    return startRun({ ...params, uid: state.activeUid });
  },
  runCancel: cancelRun,
  runResolve: (uid) => invoke("run_resolve", { uid }),
  previewRoute: (points, config, rules = null) =>
    calculatePreview("route", points, config, rules),
  simulateSensor: (config) => calculatePreview("sensor", config),
  cancelPreviews,
  paceFor: async (level) => {
    if (!Number.isInteger(level) || level < 0 || level > 3)
      throw Error("速度档位无效");
    const state = await api.state();
    const runConfig = {
      ...state.runConfig,
      ...calculate(level),
      paceLevel: level,
    };
    await api.saveConfig(runConfig);
    return { runConfig, paceResult: runConfig };
  },
  saveDeviceExtra: (oaid, mac) => invoke("device_extra_save", { oaid, mac }),
  saveDevice: (device) => invoke("device_save", { device }),
  newDeviceId: () => invoke("device_new_id"),
  deviceHistoryRemove: (id) =>
    invoke("device_history_update", { id, clear: false }),
  deviceHistoryClear: () =>
    invoke("device_history_update", { id: "", clear: true }),
  refreshProfile: () => read("profile"),
  logout: (removeLocal = false) => {
    cachedRules = null;
    return accountMutation("account_logout", { removeLocal });
  },
  accountsSelect: (uid) => {
    cachedRules = null;
    return invoke("account_select", { uid: String(uid) });
  },
  accountsRename: (uid, label) =>
    invoke("account_rename", { uid: String(uid), label }),
  accountsRemove: (uid) =>
    accountMutation("account_remove", { uid: String(uid) }),
  wechatLoginStart: () => invoke("wechat_login_start"),
  wechatLoginPoll: (sid) => invoke("wechat_login_poll", { sid }),
  wechatLoginCancel: (sid) => invoke("wechat_login_cancel", { sid }),
  qqLoginStart: () => invoke("qq_login_start"),
  records: async (year, page = 1) => {
    const reply = await read("records", {
      year: String(year),
      page: String(page),
    });
    let score = null,
      scoreError = "";
    try {
      const all = await read("scores");
      const terms = all.data?.term_list || [];
      const term = pickTerm(terms);
      if (term) {
        const id =
          term.term_info?.term_id || term.score_info?.term_id || term.term_id;
        let detail = null;
        if (id)
          detail = (await read("term_score", { termId: String(id) })).data;
        let requirements = null;
        try {
          requirements = (await read("term_requirements")).data;
        } catch (e) {
          scoreError = "学期要求获取失败：" + e.message;
        }
        score = normalizeTermScore(term, detail, requirements);
      } else scoreError = "未返回学期列表";
    } catch (e) {
      scoreError = String(e);
    }
    return {
      status: 1,
      year,
      page,
      list: (reply.data?.list || []).map((r) => ({
        recordId: String(r.record_id ?? r.id ?? ""),
        distance: Number(r.distance ?? 0),
        usedTime: Number(r.used_time ?? 0),
        startTime: Number(r.start_time ?? 0),
        type: String(r.type ?? ""),
        recordStatus: String(r.record_status ?? ""),
        statusText:
          Number(r.record_status) === 1
            ? "有效成绩"
            : `状态 ${r.record_status ?? "未获取"}`,
        title: r.title || "",
        logNum: Number(r.log_num || 0),
        stepNum: Number(r.step_num || 0),
      })),
      score,
      scoreError,
      total: Number(reply.data?.total_num || 0),
      hasMore:
        (reply.data?.list || []).length > 0 &&
        (!Number(reply.data?.total_num) ||
          page * (reply.data?.list || []).length <
            Number(reply.data.total_num)),
    };
  },

  state: async () => {
    const d = await invoke("local_state");
    const running = await invoke("run_current").catch(() => ({}));
    if (cachedRules?.uid !== d.account?.uid) cachedRules = null;
    return {
      cleanupPending: !!d.cleanup_pending,
      version: d.version,
      running,
      loggedIn: !!d.account?.hasToken,
      activeUid: d.account?.uid || "",
      accounts: d.accounts || [],
      account: {
        ...d.account,
        schoolId: d.school_id,
        schoolName: d.school_name,
        label:
          d.account?.label || d.account?.realName || d.account?.nickname || "",
      },
      device: d.device || {},
      loginDevice: d.login_device || {},
      devicePresets: DEVICE_PRESETS,
      deviceHistory: d.device_history || [],
      zone: d.zone?.id ? d.zone : { id: "", name: "", center: null, fence: [] },
      zoneConfig: cachedRules?.config || null,
      geo: d.zone?.mapCenter
        ? { lat: d.zone.mapCenter[0], lng: d.zone.mapCenter[1] }
        : null,
      route: {
        points: d.route,
        distanceKm: distance(d.route),
        fitsSchool: true,
      },
      runConfig: { ...defaults, ...(d.run_config || {}) },
      faces: { count: 0, max: 8, hasReference: false },
      paceOptions: PACE_OPTIONS,
      uploads: running.receipt?.time
        ? [
            {
              time: running.receipt.time * 1000,
              mode: running.receipt.mode,
              ok: !!running.receipt.result?.recordOk,
              recordId: running.receipt.recordId || "",
              status: running.receipt.result?.humanStatus || "请求已发送",
            },
          ]
        : [],
      lastDiagnosis: null,
    };
  },
  schools: async (q = "", limit = 2000) => {
    const r = await invoke("schools_list");
    return { list: r.list.filter((s) => s.name.includes(q)).slice(0, limit) };
  },
  saveConfig: async (runConfig) => {
    await invoke("config_save", { config: runConfig });
    return { runConfig };
  },
  selectSchool: async (schoolId) => {
    cachedRules = null;
    await invoke("school_save", { id: String(schoolId) });
    return { status: 1 };
  },
  getRoute: async () => {
    const d = await invoke("local_state");
    return {
      points: d.route,
      distanceKm: distance(d.route),
      fence: d.zone?.fence || [],
    };
  },
  saveRoute: async (points) => {
    await invoke("route_save", { points });
    return {
      status: 1,
      ok: true,
      points: points.length,
      distanceKm: distance(points),
    };
  },
  zoneConfig: async (force = false) => {
    const local = await invoke("local_state");
    let context = JSON.stringify([
      local.account?.uid,
      local.school_id,
      local.zone?.id,
    ]);
    if (cachedRules?.context !== context) cachedRules = null;
    if (
      cachedRules &&
      !force &&
      Date.now() - cachedRules.config.fetchedAt < 300000
    )
      return cachedRules;
    const response = await read("rules");
    const br = response.data || {};
    const current = await invoke("local_state");
    if (
      current.account?.uid !== local.account?.uid ||
      current.school_id !== local.school_id ||
      (local.zone?.id && current.zone?.id !== local.zone.id)
    )
      throw Error("账号或跑区已切换，旧规则已丢弃");
    const returnedZone = String(br.game_id || br.run_zone_id || "");
    if (current.zone?.id && returnedZone && current.zone.id !== returnedZone)
      throw Error("服务端跑区已改变，请重新读取");
    context = JSON.stringify([
      current.account?.uid,
      current.school_id,
      current.zone?.id,
    ]);
    const diagnosis = diagnoseRules(br);
    const config = {
      schoolId: String(br.school_id || ""),
      zoneId: String(br.game_id || br.run_zone_id || ""),
      zoneName: br.run_zone_name || "",
      fetchedAt: Date.now(),
      lines: diagnosis.configLines,
      summary: diagnosis.summary,
      unsupported: diagnosis.unsupported,
      blocked: diagnosis.blocked || [],
    };
    cachedRules = {
      status: 1,
      context,
      uid: local.account?.uid,
      config,
      brData: br,
      diagnosis,
    };
    return cachedRules;
  },
  diagnose: async () => {
    const r = await api.zoneConfig(true);
    return { status: 1, diagnosis: r.diagnosis };
  },
  zonePoints: async (zoneId) => {
    const r = await read("zone_points", { zoneId: String(zoneId) });
    const points = (r.data?.point_list || r.data?.pointList || [])
      .map((p) => {
        const [lat, lng] = String(p.jingwei || "")
          .split(",")
          .map(Number);
        return {
          id: String(p.point_id ?? p.id ?? ""),
          lat,
          lng,
          isOnline: String(p.is_online ?? 1),
        };
      })
      .filter(
        (p) =>
          Number.isFinite(p.lat) &&
          Number.isFinite(p.lng) &&
          Math.abs(p.lat) <= 90 &&
          Math.abs(p.lng) <= 180,
      );
    return { points };
  },
  selectZone: async (zoneId) => {
    await read("zone_select", { zoneId: String(zoneId) });
    cachedRules = null;
    await api.zoneConfig(true);
    return { status: 1 };
  },
  zones: async () => {
    const r = await api.zoneConfig(true);
    return {
      list: (r.brData.run_zone_list || []).map((z) => ({
        id: String(z.id ?? z.run_zone_id),
        name: z.name || z.run_zone_name || "",
        schoolId: String(r.brData.school_id || ""),
      })),
      current: {
        id: String(r.brData.game_id || r.brData.run_zone_id || ""),
        name: r.brData.run_zone_name || "",
      },
    };
  },
  importRoute: async (recordId) => {
    const res = await invoke("record_import", { id: String(recordId) });
    const route = await api.getRoute();
    return {
      ...res,
      distanceKm: route.distanceKm,
      fenceNote: "请核对导入路线是否符合当前跑区要求",
    };
  },
  recordDetail: async (id) => {
    const r = await read("record_detail", { id: String(id) });
    const d = r.data || {};
    let track = null,
      trackError = "";
    try {
      track = (await invoke("record_track", { id: String(id) })).track;
    } catch (e) {
      trackError = String(e);
    }
    return {
      status: 1,
      detail: {
        recordId: String(id),
        type: String(d.type || ""),
        distance: Number(d.distance || 0),
        usedTime: Number(d.time ?? d.used_time ?? 0),
        startTime: Number(d.start_time || 0),
        stepNum: Number(d.step_num || 0),
        logNum: Number(d.log_num || 0),
        recordStatus: String(d.record_status ?? ""),
        failedReason: d.record_failed_reason || d.failed_reason || "",
        statusText: `状态 ${d.record_status ?? "未获取"}`,
        fileImg: "",
        recordImg: "",
        pointList: d.point_list || [],
      },
      track,
      trackError,
    };
  },
  facePhotos: () => invoke("face_photos"),
  faceAdd: (dataBase64, fingerprint, uid) =>
    invoke("face_add", { dataBase64, fingerprint, uid }),
  faceReplace: (name, dataBase64, uid) =>
    invoke("face_replace", { name, dataBase64, uid }),
  faceRemove: (name, uid) => invoke("face_remove", { name, uid }),
  faceInfo: (autoPull = true) => invoke("face_info", { autoPull }),
  faceRegistrationOpen: () => invoke("face_registration_open"),
};
export const api = Object.freeze(endpoints);
export const subscribeJob = subscribeRun;
