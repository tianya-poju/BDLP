/* 共享组件：学校选择 / 跑区选择 / 人脸卡片 / 日志面板 / 指标 */
'use strict';

import { h, svg, toast, openModal, confirmDialog, promptDialog, fmtKm, fmtDuration, fmtPace, pref } from './util.js';
import {registrationClient} from './face-registration-client.js';
import { api, subscribeJob } from './api.js';
import { pickImage, captureFromCamera, normalizePhoto as randomizePhoto } from './face.js';

/* 试用版由构建开关控制（正式运行未定义 → 全部为 false） */

// ═══════════════ 指标 ═══════════════

export function statGrid(items, { two = false, big = false } = {}) {
  return h('div', { class: `stats${two ? ' two' : ''}` }, items.map((it) => h('div', { class: `stat${big ? ' big' : ''}${it.accent ? ' accent' : ''}` }, [
    h('div', { class: 'v', text: it.value }),
    h('div', { class: 'l', text: it.label }),
  ])));
}

export function kvList(pairs) {
  return h('div', {}, pairs.filter(Boolean).map(([k, v]) => h('div', { class: 'kv' }, [
    h('span', { class: 'k', text: k }),
    h('span', { class: 'v', text: v === null || v === undefined || v === '' ? '-' : String(v) }),
  ])));
}

/**
 * 常用机型下拉（最近发布的真实机型预设，见 src/devices.js）
 * 选中后回调 {name, model, osVersion, released}，随后自动复位，方便再次选择。
 */
export function devicePresetSelect(presets, onPick) {
  const sel = h('select', { class: 'input select' });
  sel.appendChild(h('option', { value: '', text: '选择机型 → 自动填入型号与系统版本' }));
  (presets || []).forEach((p, i) => {
    sel.appendChild(h('option', { value: String(i), text: `${p.name} · ${p.model} · Android ${p.osVersion}` }));
  });
  sel.addEventListener('change', () => {
    const p = (presets || [])[Number(sel.value)];
    sel.value = '';
    if (p) onPick(p);
  });
  return sel;
}

/**
 * 页面内分区标题（卡片组之上的一行小标题 + 右侧说明）
 * 用于把长页面切成可扫读的几段，不额外占高度
 */
export function sectionLabel(text, note = '') {
  return h('div', { class: 'section-label' }, [
    h('span', { class: 'sl-t', text }),
    note ? h('span', { class: 'sl-n', text: note }) : null,
  ].filter(Boolean));
}

/**
 * 账号切换面板：列表（备注名 / UID / 学校 / 登录状态）+ 切换 / 改名 / 删除 + 「添加账号」。
 * 每个账号独立保存：凭据 / 设备指纹 / 跑步参数 / 路线 / 跑区 / 人脸照片 / 上传留痕；切换即整套切换。
 */
export function openAccountSwitcher(app) {
  const m = openModal({ title: '账号' });
  const body = m.bodyEl;
  render();

  function render() {
    const accounts = app.state.accounts || [];
    body.innerHTML = '';
    if (!accounts.length) {
      body.appendChild(h('p', { class: 'hint', text: '还没有账号 —— 登录一次就会自动创建账号档案。' }));
    }
    accounts.forEach((a) => {
      body.appendChild(h('div', { class: 'acc-row' }, [
        h('div', { class: 'acc-main' }, [
          h('div', { class: 'acc-name' }, [
            h('span', { text: a.label || `UID ${a.uid}` }),
            a.active ? h('span', { class: 'badge accent', text: '当前' }) : null,
            a.hasToken ? null : h('span', { class: 'badge warn', text: '未登录' }),
          ].filter(Boolean)),
          h('div', { class: 'acc-sub' }, [
            h('span', { class: 'mono', text: `UID ${a.uid}` }),
            h('span', { text: a.schoolName || '未设置学校' }),
            a.loginTypeText ? h('span', { class: 'badge', text: a.loginTypeText }) : null,
          ].filter(Boolean)),
        ]),
        h('div', { class: 'acc-ops' }, [
          a.active ? null : h('button', { class: 'btn btn-sm', text: '切换', onClick: () => doSelect(a) }),
          h('button', { class: 'btn btn-sm btn-ghost', text: '改名', onClick: () => doRename(a) }),
          h('button', { class: 'btn btn-sm btn-ghost', text: '删除', onClick: () => doRemove(a) }),
        ].filter(Boolean)),
      ]));
    });

    body.appendChild(h('div', { class: 'divider' }));
    body.appendChild(h('button', {
      class: 'btn btn-block btn-primary', text: '添加账号（登录另一个账号）',
      onClick: () => { m.close(); app.openAddAccount && app.openAddAccount(); },
    }));
    body.appendChild(h('p', { class: 'hint', text: globalThis.LEPAO_TRIAL ? '切换即整套切换（参数 / 路线 / 跑区 / 人脸）。' : '切换即整套切换（参数 / 路线 / 跑区 / 人脸 / 留痕）。' }));
  }

  async function doSelect(a) {
    try {
      await api.accountsSelect(a.uid);
      m.close();
      toast(`已切换到 ${a.label || a.uid}`, 'ok');
      app.current = 'console';
      await app.refresh();
      // 先对齐地图跑区（内部可能已顺带拉回本跑区要求），再按需补配置，避免重复请求 beforeRun
      ensureZoneForMap(app).finally(() => ensureZoneConfig(app));
    } catch (e) {
      toast(`切换失败：${e.message}`, 'danger', 5200);
    }
  }

  async function doRename(a) {
    const v = await promptDialog({
      title: '账号备注名',
      message: '仅本地显示，用来区分多个账号（留空恢复默认）。',
      value: a.label === `UID ${a.uid}` ? '' : (a.label || ''),
      placeholder: `UID ${a.uid}`,
    });
    if (v === null) return;
    try {
      await api.accountsRename(a.uid, v);
      await app.refresh();
      render();
      toast('备注名已更新', 'ok');
    } catch (e) { toast(`更新失败：${e.message}`, 'danger'); }
  }

  async function doRemove(a) {
    const ok = await confirmDialog({
      title: '删除账号',
      message: globalThis.LEPAO_TRIAL
        ? `将删除「${a.label || a.uid}」的全部本地档案：凭据、设备指纹、参数、路线、跑区与人脸照片（服务端账号不受影响）。不可恢复。`
        : `将删除「${a.label || a.uid}」的全部本地档案：凭据、设备指纹、参数、路线、跑区、人脸照片与上传留痕（服务端账号不受影响）。不可恢复。`,
      okText: '删除', danger: true,
    });
    if (!ok) return;
    try {
      await api.accountsRemove(a.uid);
      await app.refresh();
      render();
      toast('账号已删除', 'ok');
    } catch (e) { toast(`删除失败：${e.message}`, 'danger'); }
  }

  return m;
}

/** 可关闭的状态提示条（等价 Android 的「导入状态条」） */
export function noticeCard({ message, kind = 'ok', busy = false, onClose }) {
  const tone = kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warn)' : 'var(--danger)';
  return h('div', {
    class: 'card',
    style: {
      borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`,
      background: kind === 'ok' ? 'var(--ok-soft)' : kind === 'warn' ? 'var(--warn-soft)' : 'var(--danger-soft)',
    },
  }, [
    h('div', { class: 'card-body tight' }, [
      h('div', { class: 'row' }, [
        busy ? h('span', { class: 'spinner' }) : null,
        h('span', { class: 'hint', text: message, style: { color: 'var(--text)', flex: '1' } }),
        h('button', {
          class: 'btn btn-sm btn-ghost', text: '关闭',
          onClick: () => onClose && onClose(),
        }),
      ].filter(Boolean)),
    ]),
  ]);
}

// ═══════════════ 日志面板 ═══════════════

export function createLogPanel({ maxHeight = 260 } = {}) {
  const box = h('div', { class: 'log', style: { maxHeight: `${maxHeight}px` } });
  let count = 0;
  const api_ = {
    el: box,
    append(msg, kind = '') {
      const now = new Date();
      const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      let cls = kind;
      if (!cls) {
        if (/^[✗]/.test(msg)) cls = 'err';
        else if (/^⚠/.test(msg)) cls = 'warn';
        else if (/^✓/.test(msg)) cls = 'ok';
      }
      box.appendChild(h('div', { class: `log-line ${cls}` }, [
        h('span', { class: 't', text: t }),
        h('span', { text: msg }),
      ]));
      count += 1;
      while(box.childElementCount>2000)box.firstElementChild.remove();
      box.scrollTop = box.scrollHeight;
    },
    clear() { box.innerHTML = ''; count = 0; },
    get count() { return count; },
  };
  return api_;
}

// ═══════════════ 学校表刷新 ═══════════════

/**
 * 官方 App 在拿不到定位时的兜底查询点（湖北/武汉）。
 * `School/nearbySchool` 要求 lat/lng/province/city 四个参数全部非空，缺一个就回 100；
 * 而全量表（all_school_list）与坐标无关，所以这里只用于凑齐参数。
 */
export const SCHOOL_QUERY_FALLBACK = { lat: 30.479948, lng: 114.422066, province: '湖北省', city: '武汉市' };

/** 联网刷新学校全量表（allOnly：只合并全量表，不覆盖「附近学校」） */
export async function refreshSchoolTable(app) {
  const s = app.state || {};
  const center = (s.zone && s.zone.center)
    || (Number.isFinite(s.geo && s.geo.lat) ? [s.geo.lat, s.geo.lng] : null);
  const lat = center ? Number(center[0]) : SCHOOL_QUERY_FALLBACK.lat;
  const lng = center ? Number(center[1]) : SCHOOL_QUERY_FALLBACK.lng;
  const res = await api.refreshSchools({
    lat: String(lat), lng: String(lng),
    province: SCHOOL_QUERY_FALLBACK.province,
    city: SCHOOL_QUERY_FALLBACK.city,
    allOnly: true,
  });
  await app.refresh();
  return res;
}

// ═══════════════ 跑区自动匹配 ═══════════════

/**
 * 登录 / 切号 / 启动后：如果这个账号还没有可用的跑区坐标（围栏或中心），
 * 静默拉一次本校跑区并落盘。地图随后会自动锚到该账号的跑区，而不是停在旧校区。
 * 同一账号同一时间只发一个请求；失败不阻塞页面，也不会在失败后反复刷。
 */
export function ensureZoneForMap(app) {
  const s = app.state || {};
  if (!s.loggedIn || !s.account || !s.account.schoolId) return Promise.resolve(false);
  const z = s.zone || {};
  if ((z.fence || []).length >= 3 || z.center) return Promise.resolve(true);
  const uid = s.account.uid || '';
  app.zoneSync = app.zoneSync || new Map();
  if (app.zoneSync.has(uid)) return app.zoneSync.get(uid);
  const task = api.zones()
    .then(async () => {
      await app.refresh();
      const z2 = app.state.zone || {};
      return (z2.fence || []).length >= 3 || Boolean(z2.center);
    })
    .catch(() => false)
    .finally(() => { app.zoneSync.delete(uid); });
  app.zoneSync.set(uid, task);
  return task;
}

/** 本跑区要求缓存与账号档案里的 zoneConfig 保持一致的时效（12h）；切学校 / 切跑区会由服务端作废 */
const ZONE_CONFIG_TTL_MS = 12 * 3600_000;

/**
 * 登录 / 切号 / 切跑区 / 启动后：静默读取本跑区要求（beforeRun 摘要）。
 * 缓存新鲜时不发请求；force=true 用于「刷新」按钮。
 * 只更新展示数据，不碰 runConfig / route —— 要求与用户参数互不影响。
 */
export function ensureZoneConfig(app, { force = false } = {}) {
  const s = app.state || {};
  if (!s.loggedIn || !s.account || !s.account.schoolId) return Promise.resolve(false);
  const cfg = s.zoneConfig;
  const expectedZone = String((s.zone && s.zone.id) || '');
  const cachedZone = String((cfg && cfg.zoneId) || '');
  const fresh = Boolean(cfg)
    && cfg.schoolId === s.account.schoolId
    && (!expectedZone || !cachedZone || cachedZone === expectedZone)
    && Date.now() - Number(cfg.fetchedAt || 0) < ZONE_CONFIG_TTL_MS;
  if (!force && fresh) return Promise.resolve(true);

  // 同一账号 + 同一学校 + 同一跑区才算同一份请求；切换后不会复用旧学校的在途请求
  const key = `${s.account.uid || ''}:${s.account.schoolId || ''}:${expectedZone}`;
  app.zoneConfigSync = app.zoneConfigSync || new Map();
  if (app.zoneConfigSync.has(key)) return app.zoneConfigSync.get(key);
  const task = api.zoneConfig(force)
    .then((res) => {
      if (!res || !res.config) return false;
      app.state.zoneConfig = res.config;
      // 只在控制台重绘（记录 / 设置页没有这张卡，重绘会白刷一次列表）
      if (app.current === 'console' && app.view && app.view.refresh) app.view.refresh();
      if (app.refreshAside) app.refreshAside();
      return true;
    })
    .catch(() => false)
    .finally(() => { app.zoneConfigSync.delete(key); });
  app.zoneConfigSync.set(key, task);
  return task;
}

// ═══════════════ 学校选择 ═══════════════

export async function openSchoolPicker(app) {
  const body = h('div', { class: 'col' });
  const listBox = h('div', { style: { border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden', maxHeight: '44dvh', overflowY: 'auto' } });
  const searchInput = h('input', { class: 'input', placeholder: '输入学校名称关键字' });
  const headNote = h('span', { class: 'head-note', text: '' });
  const errorLine = h('p', { class: 'hint danger hidden' });

  let all = [];
  let nearby = [];
  const total = h('span', { class: 'muted small', text: '' });

  const renderList = (query) => {
    listBox.innerHTML = '';
    const q = (query || '').trim();
    let shown = [];
    if (!q) {
      if (nearby.length) {
        listBox.appendChild(h('div', { class: 'rail-label', text: '附近学校' }));
        nearby.forEach((s) => listBox.appendChild(row(s)));
      }
      listBox.appendChild(h('div', { class: 'rail-label', text: `全部学校（输入关键字可筛选）　共 ${all.length} 所` }));
      shown = all.slice(0, 60);
    } else {
      shown = all.filter((s) => s.name.includes(q))
        .sort((a, b) => (a.name.startsWith(q) ? 0 : 1) - (b.name.startsWith(q) ? 0 : 1) || a.name.length - b.name.length)
        .slice(0, 200);
      listBox.appendChild(h('div', { class: 'rail-label', text: `搜索结果 ${shown.length} 条` }));
    }
    if (shown.length === 0 && !nearby.length) {
      listBox.appendChild(h('div', { class: 'empty', text: all.length === 0 ? '内置学校表为空' : `没有匹配「${q}」的学校` }));
    }
    shown.forEach((s) => listBox.appendChild(row(s)));

    function row(s) {
      const current = app.state.account.schoolId === s.id;
      return h('button', {
        class: `list-item${current ? ' current' : ''}`,
        onClick: async () => {
          const res = await api.selectSchool(s.id, s.name);
          await app.refresh();
          const z = res.zone || {};
          if (res.changed && z.center) toast(`✓ 已切到 ${s.name} · 跑区与地图已同步`, 'ok');
          else if (res.changed && res.warn) toast(`已切到 ${s.name} · 跑区未刷新：${res.warn}`, 'warn');
          else if (res.changed) toast(`已切到 ${s.name} · 该校未下发跑区（可点右栏「定位」或选跑区）`, '', 5200);
          else toast(`✓ 已选择学校：${s.name}（ID ${s.id}）`, 'ok');
          modal.close();
        },
      }, [
        h('span', { class: 'li-title', text: s.name }),
        h('span', { class: 'li-aux', text: `ID ${s.id}` }),
      ]);
    }
  };

  const modal = openModal({
    title: '选择学校',
    body: [
      h('p', { class: 'hint', text: globalThis.LEPAO_TRIAL ? '未选学校会导致人脸核验报「参数异常」。' : '未选学校会导致上传、人脸核验报「参数异常」。' }),
      searchInput,
      errorLine,
      listBox,
      h('div', { class: 'row' }, [h('span', { class: 'muted small', text: '共' }), total, h('span', { class: 'muted small', text: '所 · 离线内置表' }), h('span', { class: 'grow' }), headNote]),
    ],
    footer: [
      h('button', { class: 'btn btn-ghost', text: '关闭', onClick: () => modal.close() }),
      h('button', {
        class: 'btn',
        text: '刷新学校表',
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = '刷新中…';
          try {
            const res = await refreshSchoolTable(app);
            if (!res.all) {
              toast(res.info || '服务端未返回学校表', 'warn', 6000);
              return;
            }
            const fullRes = await api.schools('', 2000);
            all = fullRes.list || [];
            nearby = fullRes.nearby || [];
            total.textContent = String(fullRes.total || all.length);
            renderList(searchInput.value);
            toast(res.saved ? `已刷新：${res.all} 所学校（已写入内置表）` : `已刷新：${res.all} 所学校（仅本次运行）`, 'ok');
          } catch (err) {
            toast(`刷新失败：${err.message || '网络错误'}`, 'warn');
          } finally {
            btn.disabled = false;
            btn.textContent = '刷新学校表';
          }
        },
      }),
    ],
    wide: true,
  });

  searchInput.addEventListener('input', () => renderList(searchInput.value));
  try {
    const fullRes = await api.schools('', 2000);
    all = fullRes.list || [];
    nearby = fullRes.nearby || [];
    total.textContent = String(fullRes.total || all.length);
    renderList('');
  } catch (e) {
    errorLine.classList.remove('hidden');
    errorLine.textContent = `学校列表加载失败：${e.message}`;
  }
  setTimeout(() => searchInput.focus(), 60);
}

// ═══════════════ 跑区选择 ═══════════════

export async function openZonePicker(app) {
  const listBox = h('div', { style: { border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden', maxHeight: '46dvh', overflowY: 'auto' } });
  const status = h('p', { class: 'hint', text: '正在获取跑区列表…' });
  const modal = openModal({
    title: '选择跑区',
    body: [
      h('p', { class: 'hint', text: globalThis.LEPAO_TRIAL ? '选中即绑定到账号' : '选中即绑定到账号，下次上传生效' }),
      status,
      listBox,
    ],
    footer: [h('button', { class: 'btn btn-ghost', text: '关闭', onClick: () => modal.close() })],
  });

  try {
    const res = await api.zones();
    listBox.innerHTML = '';
    status.textContent = `共 ${res.list.length} 个跑区`;
    if (res.error) status.textContent += `　（${res.error}）`;
    if (res.list.length === 0) {
      listBox.appendChild(h('div', { class: 'empty', text: '没有拉到可用的跑区' }));
      return;
    }
    res.list.forEach((z) => {
      const current = app.state.zone.id === z.id;
      listBox.appendChild(h('button', {
        class: `list-item${current ? ' current' : ''}`,
        onClick: async () => {
          if (current) return;
          const r = await api.selectZone(z.id, z.name);
          if (Number(r.status) === 1) {
            const n = Number(r.fenceCount || 0);
            toast(n >= 3
              ? `✓ 已切换：${z.name} · 已获取围栏（${n} 顶点）`
              : (r.center ? `✓ 已切换：${z.name} · 已定位跑区（无围栏）` : `已切换：${z.name} · 该跑区未下发围栏`),
            n >= 3 || r.center ? 'ok' : 'warn', 5200);
            await app.refresh();
            modal.close();
          } else {
            toast(`✗ 切换跑区失败：${r.info || '未知原因'}`, 'danger');
          }
        },
      }, [
        h('span', { class: 'li-title', text: z.name }),
        h('span', { class: 'row' }, [
          z.isDefault ? h('span', { class: 'badge', text: '默认' }) : null,
          h('span', { class: 'li-aux', text: current ? '✓ 当前' : `ID ${z.id}` }),
        ].filter(Boolean)),
      ]));
    });
  } catch (e) {
    status.className = 'hint danger';
    status.textContent = e.message;
  }
}

// ═══════════════ 人脸验证照片 ═══════════════

export function createFaceSection(app, { onChanged } = {}) {
  const grid = h('div', { class: 'face-grid' });
  const countLine = h('span', { class: 'head-note' });
  const refBox = h('div');
  const validateBox = globalThis.LEPAO_TRIAL ? null : h('div', { class: 'col hidden' });
  const schoolLine = h('span', { class: 'v', text: '未查询' });
  let lastReferenceUrl = null;

  async function reload() {
    const res = await api.facePhotos();
    grid.innerHTML = '';
    countLine.textContent = `自建库 ${res.photos.length} 张`;
    countLine.className = res.photos.length === 0 ? 'head-note danger' : 'head-note ok';
    res.photos.forEach((p) => {
      grid.appendChild(h('div', { class: 'face-cell' }, [
        h('img', { src: p.url, alt: '人脸照片', loading: 'lazy' }),
        h('button', {
          class: 'del', title: '删除该张', text: '✕',
          onClick: async () => {
            const uid=app.state.activeUid;
            if (!(await confirmDialog({ title: '删除照片', message: '确定从人脸库删除这张照片吗？', okText: '删除', danger: true }))) return;
            await api.faceRemove(p.name,uid);
            await reload();
            onChanged && onChanged();
          },
        }),
        h('span', { class: 'tag', text: '本地照片' }),
        h('button',{class:'btn btn-sm',text:'替换',style:{position:'absolute',bottom:'5px',right:'5px',height:'25px',padding:'0 8px'},onClick:async()=>{const uid=app.state.activeUid;try{const source=await pickImage();if(!source)return;const norm=await randomizePhoto(source);await api.faceReplace(p.name,norm.dataUrl,uid);await reload();onChanged&&onChanged();toast('已替换本地照片','ok')}catch(e){toast(String(e),'danger')}}}),
      ]));
    });
    refBox.innerHTML = '';
    if (res.hasReference) {
      lastReferenceUrl = res.referenceUrl;
      refBox.appendChild(h('div', { class: 'col' }, [
        h('span', { class: 'hint', text: '登记照（仅对照，不参与提交）' }),
        h('img', { class: 'thumb-ref', src: lastReferenceUrl, alt: '登记照' }),
        h('button',{class:'btn btn-sm',text:'清除本机登记照',onClick:async()=>{const uid=app.state.activeUid;if(!await confirmDialog({title:'清除本机登记照',message:'只清除本机对照图，学校登记不受影响。',okText:'清除'}))return;try{await api.faceReferenceRemove(uid);await reload()}catch(e){toast(e.message,'danger')}}}),
      ]));
    }
  }

  async function addPhoto(source,uid=app.state.activeUid) {
    const picked = source || await pickImage();
    if (!picked) return;
    try {
      // 归一化照片用于本地预览与保存，尚未提交服务端核验。
      const norm = await randomizePhoto(picked);
      const res = await api.faceAdd(norm.dataUrl, norm.fingerprint,uid);
      toast(res.info || (res.status === 1 ? '✓ 已添加' : '添加失败'), res.status === 1 ? 'ok' : 'warn');
      await reload();
      onChanged && onChanged();
    } catch (e) {
      toast(`照片读取失败：${e.message || '请换一张'}`, 'danger');
    }
  }

  async function startValidate() {
    if (globalThis.LEPAO_TRIAL) return;
    validateBox.classList.remove('hidden');
    validateBox.innerHTML = '';
    const log = createLogPanel({ maxHeight: 150 });
    const spinner = h('span', { class: 'spinner' });
    const line = h('div', { class: 'row' }, [spinner, h('span', { class: 'hint', text: '正在校验…' })]);
    validateBox.append(line, log.el);
    try {
      const res = await api.faceValidate();
      if (res.status !== 1) { toast(res.info || '校验启动失败', 'warn'); line.remove(); return; }
      const stop = subscribeJob(res.jobId, {
        onLog: (e) => log.append(e.msg),
        onDone: (d) => {
          spinner.remove();
          const msg = (d.result && d.result.message) || d.error || '';
          line.lastChild.textContent = msg;
          line.lastChild.className = d.status === 'done' ? 'hint ok' : 'hint danger';
          if (d.status === 'done' && d.result && d.result.phase === 'retake') {
            const name = d.result.name;
            validateBox.appendChild(h('div', { class: 'btn-row' }, [
              h('button', {
                class: 'btn btn-sm', text: '重拍替换',
                onClick: async () => {
                  const src = await captureFromCamera() || await pickImage();
                  if (!src) return;
                  const norm = await randomizePhoto(src);
                  await api.faceReplace(name, norm.dataUrl,app.state.activeUid);
                  toast('✓ 已替换（已归一化），重新校验该张', 'ok');
                  await reload();
                  startValidate();
                },
              }),
              h('button', {
                class: 'btn btn-sm btn-danger', text: '删除该张',
                onClick: async () => {
                  await api.faceRemove(name,app.state.activeUid);
                  await reload();
                  startValidate();
                },
              }),
            ]));
          }
          stop();
        },
      });
      validateBox.appendChild(h('button', {
        class: 'btn btn-sm btn-ghost', text: '取消校验',
        onClick: async () => { await api.runCancel(res.jobId); stop(); line.remove(); },
      }));
    } catch (e) {
      line.remove();
      toast(e.message, 'danger');
    }
  }

  const registrationLine=h('p',{class:'hint'});
  const registration=registrationClient({open:()=>api.faceRegistrationOpen(),listen:cb=>window.__TAURI__.event.listen('face-registration-status',cb),currentAccount:()=>app.state.activeUid,onStatus:phase=>{
    registrationLine.textContent=({creating:'正在创建人脸窗口…',loading:'窗口已创建，正在加载页面…',loaded:'人脸页面已加载，请在窗口中本人操作。',timeout:'页面加载超过15秒，可关闭注册窗口后重试；主程序可继续使用。',failed:'人脸窗口未能打开或账号已改变，请重试。'})[phase]||'';
  }});
  const el = h('div', { class: 'col' }, [
    h('div', { class: 'divider' }),
    h('div', { class: 'between' }, [h('strong', { class: 'small', text: '人脸验证照片（该功能正在开发中）' }), countLine]),
    h('p', { class: 'hint', text: globalThis.LEPAO_TRIAL ? '试用版仅保存在本机照片库' : '照片加密保存在本机；主动开跑后按学校规则上传核验' }),
    grid,
    h('div', { class: 'btn-row' }, [
      h('button', { class: 'btn btn-sm', text: '选择照片', onClick: () => addPhoto() }),
      h('button', { class: 'btn btn-sm', text: '拍照', onClick: async () => {const uid=app.state.activeUid;const source=await captureFromCamera();if(source)await addPhoto(source,uid)} }),
    ]),
    h('div', { class: 'divider' }),
    h('div', { class: 'between' }, [h('span', { class: 'small muted', text: '学校库登记' }), schoolLine]),
    refBox,
    h('div', { class: 'btn-row' }, [
      h('button', {
        class: 'btn btn-sm', text: '拉取/刷新登记照',
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = '查询中…';
          try {
            const res = await api.faceInfo(true);
            if (res.status !== 1) {
              schoolLine.textContent = '未查询';
              toast(res.info || '拉取失败', 'warn');
            } else {
              schoolLine.textContent = res.info.statusText || '已查询';
              schoolLine.className = res.info.hasFace ? 'v ok' : 'v';
              toast(res.message, res.info.hasFace ? 'ok' : 'warn');
              await reload();
              onChanged && onChanged();
            }
          } catch (err) {
            toast(err.message, 'danger');
          } finally {
            btn.disabled = false; btn.textContent = '拉取/刷新登记照';
          }
        },
      }),
      h('button', {
        class: 'btn btn-sm', text: '人脸注册页',
        onClick: async e => {
          const button=e.currentTarget;button.disabled=true;button.textContent='打开中…';
          try {await registration.open();}catch(err){toast(err.message,'danger');}
          finally{button.disabled=false;button.textContent='人脸注册页';}
        },
      }),
      globalThis.LEPAO_TRIAL ? null : h('button', { class: 'btn btn-sm btn-primary', text: '逐张校验', onClick: startValidate }),
    ]),
    registrationLine,
    validateBox,
    h('details', { class: 'fold' }, [
      h('summary', { text: '拍照要求与轮换建议' }),
      h('div', { class: 'fold-body' }, [
        h('p', { class: 'hint', text: '正脸、无遮挡、光线充足；核验失败的那张删掉重拍。' }),
      ]),
    ]),
  ]);

  reload().catch(() => {countLine.textContent='照片库读取失败';countLine.className='head-note danger';});
  return { el, reload, destroy:()=>registration.destroy() };
}

export { promptDialog };