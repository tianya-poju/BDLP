/* 控制台：学校 / 跑区 / 路线 / 人脸 / 参数 / 数据预览 / 上传 */
'use strict';

import { h, svg, toast, fmtKm, fmtDuration, fmtPace, fmtPaceFromSpeed, pref, openModal } from '../util.js';
import { api, subscribeJob } from '../api.js';
import { openSchoolPicker, openZonePicker, createFaceSection, createLogPanel, statGrid, kvList } from '../components.js';
import { drawSpeedCurve, drawSensorWave, renderPaceBar, renderMadBar, madZone } from '../charts.js';
import { RouteEditor } from './route.js';

/* 试用版由构建开关控制（正式运行未定义 → 全部为 false） */

/** 图例项：色点 + 名称（色值来自 tokens，与图表同源） */
function legendItem(name, color) {
  return h('span', { class: 'legend-item' }, [h('i', { class: 'dot', style: { background: color } }), h('span', { text: name })]);
}

/** 跑区要求状态徽标 */
function reqBadge(text, tone = '') {
  return h('span', { class: `badge${tone ? ` ${tone}` : ''}`, text });
}

/** 秒/公里 → m'ss" */
function paceSecText(sec) {
  const s = Math.trunc(Number(sec) || 0);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`;
}

/** 配置缓存时间的人话（本跑区要求 12h 过期） */
function fmtCfgAge(ts) {
  const m = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 60000));
  if (m < 1) return '刚刚更新';
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

/** 传感器自检：MAD 强度区间条 + 实测读数（正常窗口占比是官方 runStatus 的核心指标） */
function sensorCheck(sc) {
  const zone = madZone(sc.median);
  const bar = h('div', { class: 'pacebar' });
  renderMadBar(bar, sc.median);
  return h('div', { class: 'col', style: { gap: '6px' } }, [
    h('div', { class: 'divider' }),
    h('div', { class: 'between' }, [
      h('span', { class: 'hint xs', text: `跑步强度 · MAD 中位 ${sc.median.toFixed(2)}` }),
      h('span', { class: `badge${zone.tone ? ` ${zone.tone}` : ''}`, text: zone.name }),
    ]),
    bar,
    h('span', { class: 'hint xs mono', text: `正常窗口 ${sc.status1Pct.toFixed(0)}% · ${sc.samples} 点 · MAD ${sc.min.toFixed(2)}~${sc.max.toFixed(2)}` }),
  ]);
}

export function ConsoleView(app) {
  const root = h('div', { class: 'view' });
  let preview = null;
  let previewTimer = null;
  let previewSeq=0;
  let cancelMad=()=>{};
  let runJob = app.state.running?.current?.id||null;
  let unsubscribe = null;
  let mode = pref.get('runMode', 'free');

  // ═══ 环境（学校 + 跑区合并为一张卡，减少卡片层级） ═══
  const envCard = h('div', { class: 'card' });
  const envHeadNote = h('span', { class: 'head-note', text: '' });
  const schoolSlot = h('div');
  const zoneSlot = h('div');
  // ═══ 本跑区要求（只读，来自学校/跑区配置） ═══
  const requirementCard = h('div', { class: 'card' });
  // ═══ 完整版可用性（仅试用版） ═══
  const compatCard = globalThis.LEPAO_TRIAL ? h('div', { class: 'card' }) : null;
  // ═══ 路线 ═══
  const routeCard = h('div', { class: 'card' });
  // ═══ 人脸 ═══
  const faceSection = createFaceSection(app, { onChanged: () => app.refreshAside() });
  const faceCard = h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, [
      h('h3', { text: '人脸验证照片' }),
      h('span', { class: 'head-note', text: '' }),
    ]),
    h('div', { class: 'card-body' }, [faceSection.el]),
  ]);
  // ═══ 参数 ═══
  const paramCard = h('div', { class: 'card' });
  // ═══ 预览 ═══
  const previewCard = h('div', { class: 'card' });
  // ═══ 上传（正式版） ═══
  const uploadCard = globalThis.LEPAO_TRIAL ? null : h('div', { class: 'card' });
  const logPanel = globalThis.LEPAO_TRIAL ? null : createLogPanel({ maxHeight: 240 });

  root.append(...[
    envCard,
    requirementCard,
    compatCard,
    routeCard,
    faceCard,
    paramCard,
    previewCard,
    globalThis.LEPAO_TRIAL ? null : uploadCard,
  ].filter(Boolean));

  // ─────────── 环境（学校 + 跑区，共用一张卡） ───────────
  function renderEnv() {
    const a = app.state.account;
    const z = app.state.zone || {};
    const fenceN = (z.fence || []).length;
    const bound = Boolean(z.id);

    envHeadNote.textContent = a.schoolName || '';
    schoolSlot.innerHTML = '';
    schoolSlot.append(...[
      h('div', { class: 'env-row' }, [
        h('span', { class: 'env-k', text: '学校' }),
        h('span', { class: 'env-v' }, [
          h('span', { class: 'env-main', text: a.schoolId ? (a.schoolName || `学校 ${a.schoolId}`) : '未设置' }),
          a.schoolId ? h('span', {
            class: 'env-sub',
            text: `ID ${a.schoolId}${a.studentNum ? ` · 学号 ${a.studentNum}` : ''}`,
          }) : null,
        ].filter(Boolean)),
        h('button', {
          class: 'btn btn-sm', text: a.schoolId ? '更换' : '选择',
          onClick: () => openSchoolPicker(app),
        }),
      ]),
      a.schoolId ? null : h('p', { class: 'hint danger', text: globalThis.LEPAO_TRIAL ? '未设置学校会导致人脸核验报「参数异常」。' : '未设置学校会导致上传、人脸核验报「参数异常」。' }),
    ].filter(Boolean));

    zoneSlot.innerHTML = '';
    zoneSlot.append(...[
      h('div', { class: 'env-row' }, [
        h('span', { class: 'env-k', text: '跑区' }),
        h('span', { class: 'env-v' }, [
          h('span', { class: 'env-main', text: bound ? (z.name || `跑区 ${z.id}`) : '未绑定' }),
          bound ? h('span', { class: 'env-sub', text: fenceN >= 3 ? `围栏 ${fenceN} 点` : '无围栏' }) : null,
        ].filter(Boolean)),
        h('span', { class: 'env-actions' }, [
          h('button', { class: 'btn btn-sm', text: bound ? '更换' : '选择', onClick: () => openZonePicker(app) }),
          bound && fenceN < 3 ? h('button', { class: 'btn btn-sm', text: '获取围栏', onClick: fetchFence }) : null,
        ].filter(Boolean)),
      ]),
      // 只在「没绑定 / 没围栏」时给一句必要提示
      !bound ? h('p', { class: 'hint warn', text: '未绑定跑区：会按自由跑提交，没有围栏校验。' })
        : (fenceN >= 3 ? null : h('p', { class: 'hint warn', text: '还没取到围栏，点「获取围栏」从 beforeRun 取一次。' })),
    ].filter(Boolean));
  }

  /** 环境卡的外壳只建一次，重渲染只换里面的两行 */
  function mountEnvCard() {
    envCard.innerHTML = '';
    envCard.append(
      h('div', { class: 'card-head' }, [h('h3', { text: '位置' }), envHeadNote]),
      h('div', { class: 'card-body tight' }, [schoolSlot, h('div', { class: 'divider' }), zoneSlot]),
    );
  }

  function showDiagnosis(res) {
    const d = res.diagnosis;
    const body = [
      h('div', { class: 'col' }, d.configLines.map((l) => h('div', { class: 'kv' }, [
        h('span', { class: 'k', text: '·' }), h('span', { class: 'v', text: l, style: { textAlign: 'left' } }),
      ]))),
      h('div', { class: 'divider' }),
      h('div', { class: 'col' }, [
        h('span', { class: 'small muted', text: '本次提交必发字段' }),
        h('p', { class: 'mono xs', text: d.neededFields.join(', '), style: { wordBreak: 'break-all', color: 'var(--text-dim)' } }),
        d.skippedFields.length ? h('span', { class: 'small muted', text: '按配置不发' }) : null,
        d.skippedFields.length ? h('p', { class: 'mono xs', text: d.skippedFields.join(', '), style: { wordBreak: 'break-all', color: 'var(--text-mute)' } }) : null,
      ].filter(Boolean)),
      d.unsupported.length ? h('div', { class: 'col' }, [
        h('span', { class: 'small', text: '⚠ 学校开了但我们扛不住', style: { color: 'var(--warn-text)' } }),
        ...d.unsupported.map((u) => h('p', { class: 'hint warn', text: `· ${u}` })),
      ]) : null,
      res.brData ? h('details', { class: 'fold' }, [
        h('summary', { text: 'beforeRun 关键字段' }),
        h('div', { class: 'fold-body' }, [kvList([
          ['跑区', `${res.brData.runZoneName}（game_id ${res.brData.gameId}）`],
          ['学期', `term_id ${res.brData.termId}`],
          ['距离区间', `${res.brData.minDistance.toFixed(2)} ~ ${res.brData.maxDistance.toFixed(2)} km`],
          ['配速区间', `${res.brData.maxPace || '-'} ~ ${res.brData.minPace || '-'}（秒/km，服务端口径见诊断行）`],
          ['打卡', `点 ${res.brData.pointNum} × 重复 ${res.brData.repeatNum}`],
          ['围栏顶点', String((res.brData.fence || []).length)],
        ])]),
      ]) : null,
    ].filter(Boolean);
    const modal = openModal({
      title: '跑区配置诊断',
      body,
      footer: [h('button', { class: 'btn btn-primary', text: '知道了', onClick: () => modal.close() })],
      wide: true,
    });
  }

  // ─────────── 跑区（已合并进环境卡） ───────────

  /** 获取围栏（走诊断链路：beforeRun 是围栏的唯一来源，且需要已绑定跑区） */
  async function fetchFence(ev) {
    const btn = ev.currentTarget;
    btn.disabled = true; btn.textContent = '获取中…';
    try {
      const res = await api.diagnose();
      await app.refresh();
      if (Number(res.status) !== 1) { toast(res.info || '获取失败', 'warn'); return; }
      const n = Number(res.fenceCount || 0);
      toast(n >= 3 ? `✓ 已获取围栏（${n} 顶点）` : '服务端未下发围栏（该跑区可能没有围栏）', n >= 3 ? 'ok' : 'warn');
    } catch (err) {
      toast(`获取失败：${err.message}`, 'danger');
    } finally {
      btn.disabled = false; btn.textContent = '获取围栏';
    }
  }

  // ─────────── 本跑区要求（只读） ───────────
  function renderRequirement() {
    const cfg = app.state.zoneConfig;
    const sum = (cfg && cfg.summary) || null;
    requirementCard.innerHTML = '';

    async function reload(ev) {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const res = await api.zoneConfig(true);
        if (Number(res.status) !== 1 || !res.config) {
          toast(res.info || '读取跑区要求失败', 'warn', 5600);
          return;
        }
        app.state.zoneConfig = res.config;
        renderRequirement();
        renderEnv();
        toast('✓ 已刷新本跑区要求', 'ok');
      } catch (e) {
        toast(`读取失败：${e.message}`, 'danger');
      } finally {
        btn.disabled = false;
      }
    }

    async function detailed(ev) {
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = '诊断中…';
      try {
        const res = await api.diagnose();
        await app.refresh();
        if (Number(res.status) === 1) showDiagnosis(res);
        else toast(res.info || '诊断失败', 'warn');
      } catch (e) {
        toast(e.message, 'danger');
      } finally {
        btn.disabled = false; btn.textContent = '查看完整诊断';
      }
    }

    const head = h('div', { class: 'card-head' }, [
      h('h3', { text: '本跑区要求' }),
      h('div', { class: 'row' }, [
        h('span', { class: 'head-note', text: cfg ? fmtCfgAge(cfg.fetchedAt) : '未加载' }),
        h('button', {
          class: 'btn btn-icon btn-ghost', 'aria-label': '刷新跑区要求',
          onClick: reload,
        }, [svg('refresh', 16)]),
      ]),
    ]);

    if (!cfg || !sum) {
      requirementCard.append(head, h('div', { class: 'card-body' }, [
        h('p', {
          class: 'hint',
          text: app.state.account.schoolId
            ? '登录后自动读取，12 小时内复用。'
            : '先选择学校，登录后会自动读取。',
        }),
        h('button', {
          class: 'btn btn-sm btn-block', text: '读取跑区要求',
          disabled: !app.state.account.schoolId, onClick: reload,
        }),
      ]));
      return;
    }

    const t = sum.time || {};
    const th = sum.thresholds || {};
    const ck = sum.checkins || {};
    const cap = sum.capture || {};
    const face = sum.face || {};
    const checks = sum.checks || {};

    const chips = [t.inWindow ? reqBadge('时段内', 'ok') : reqBadge('不在时段', 'danger')];
    if (cap.on) chips.push(cap.type === 1 ? reqBadge('抓拍 · 照片模拟', 'warn') : reqBadge('抓拍 · 可能漏拍', 'warn'));
    if (face.on) {
      const parts = [];
      if (face.start === 1) parts.push('开始');
      if (face.middle === 1) parts.push(`中途${face.num}次`);
      if (face.stop === 1) parts.push('结束');
      chips.push(face.type !== 1
        ? reqBadge('人脸 · 支付宝', 'danger')
        : reqBadge(`人脸 ${parts.join('/') || '开启'}`));
    }
    if (checks.time) chips.push(reqBadge('校时'));
    if (checks.device) chips.push(reqBadge('设备指纹'));
    if (checks.geetest || checks.geeDevice) chips.push(reqBadge('极验 · 需人工', 'warn'));
    if (checks.deepknow) chips.push(reqBadge('数美', 'warn'));
    if (checks.shumeng) chips.push(reqBadge('数盟', 'warn'));

    const distText = Number(th.maxDistance) > 0
      ? `${Number(th.minDistance).toFixed(1)}~${Number(th.maxDistance).toFixed(1)} km`
      : (Number(th.minDistance) > 0 ? `≥ ${Number(th.minDistance).toFixed(1)} km` : '距离不限');
    const paceText = Number(th.maxPace) > 0 && Number(th.minPace) > 0 && Number(th.maxPace) < Number(th.minPace)
      ? `${paceSecText(th.maxPace)}~${paceSecText(th.minPace)}/km` : '配速不限';
    const thresholdText = t.ruleText
      ? `${t.ruleText.dist} · ${t.ruleText.pace} · ${t.ruleText.points}`
      : `${distText} · ${paceText} · 打卡 ${ck.required || 0} 次`;

    // 只提示「当前设置与要求不匹配」，绝不自动改用户的路线 / 参数 —— 避免学校配置互相覆盖
    const hints = [];
    if (!t.inWindow) hints.push('当前不在锻炼时段，校园跑会中止；如需立即跑请用「自由跑」。');
    if (t.rule) {
      const r = t.rule;
      const routeKm = Number((app.state.route || {}).distanceKm || 0);
      if (r.minDistanceKm > 0 && routeKm > 0 && routeKm < r.minDistanceKm) {
        hints.push(`当前路线 ${routeKm.toFixed(2)}km 低于本时段最低 ${r.minDistanceKm.toFixed(1)}km`);
      }
      if (r.maxDistanceKm > 0 && routeKm > r.maxDistanceKm) {
        hints.push(`当前路线 ${routeKm.toFixed(2)}km 超过本时段最高 ${r.maxDistanceKm.toFixed(1)}km`);
      }
      if (r.hasPaceLimit) {
        const cfgRun = app.state.runConfig || {};
        [['直道', cfgRun.straightSpeed], ['弯道', cfgRun.curveSpeed]].forEach(([label, mps]) => {
          const speed = Number(mps || 0);
          if (speed <= 0) return;
          const pace = Math.trunc(1000 / speed);
          if (pace < r.maxPaceSec || pace > r.minPaceSec) {
            hints.push(`${label}配速 ${paceSecText(pace)}/km 超出本时段 ${paceSecText(r.maxPaceSec)}~${paceSecText(r.minPaceSec)}/km`);
          }
        });
      }
    }

    requirementCard.append(head, h('div', { class: 'card-body' }, [
      h('div', { class: 'req-chips' }, chips),
      h('div', { class: 'req-line' }, [h('span', { class: 'k', text: '时段' }), h('span', { class: 'v', text: t.message || '未限制锻炼时段' })]),
      h('div', { class: 'req-line' }, [h('span', { class: 'k', text: '阈值' }), h('span', { class: 'v', text: thresholdText })]),
      h('div', { class: 'req-line' }, [h('span', { class: 'k', text: '打卡' }), h('span', {
        class: 'v',
        text: ck.required ? `${ck.required} 次${Number(ck.logMode) === 2 ? ' · 定向顺序' : ''}` : '无要求',
      })]),
      ...hints.map((x) => h('p', { class: 'hint warn', text: `⚠ ${x}` })),
      (cfg.blocked || []).length ? h('p', { class: 'hint danger', text: `✕ ${cfg.blocked.join('；')}` }) : null,
      h('div', { class: 'btn-row' }, [
        h('button', { class: 'btn btn-sm', text: '查看完整诊断', onClick: detailed }),
        face.on && face.type !== 1
          ? h('button', { class: 'btn btn-sm', text: '去支付宝刷脸', onClick: goAlipay })
          : null,
        h('button', { class: 'btn btn-sm', text: '测试拉起', onClick: testAlipayLaunch }),
      ]),
    ]));
  }

  // ── 支付宝拉起辅助（Web 端只对手机浏览器有效，桌面需要扫码/复制链接） ──

  /** 本地生成深链二维码（含 token，不经过任何第三方） */
  function qrSvgOf(text) {
    try {
      const qr = window.qrcode(0, 'L');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: '支付宝拉起二维码' });
    } catch (_) { return ''; }
  }

  /** 当前环境能不能拉起支付宝 —— 按 UA 给事实结论，不做猜测 */
  function alipayEnvDiag() {
    const ua = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const inWeChat = /MicroMessenger/i.test(ua);
    const inWeCom = /wxwork/i.test(ua);
    const lines = [`环境：${mobile ? '手机浏览器' : '桌面浏览器'}`];
    if (inWeChat) lines.push('微信内置浏览器会拦截 alipays://：请点右上角「在浏览器打开」后再试。');
    if (inWeCom) lines.push('企业微信内置浏览器通常拦截自定义协议：请改用系统浏览器打开。');
    if (!mobile) lines.push('桌面浏览器没有支付宝客户端时无法拉起：用手机支付宝扫码，或复制链接到手机打开。');
    if (mobile && !inWeChat && !inWeCom) lines.push('手机浏览器支持 alipays://，点「尝试拉起」应能切到支付宝。');
    return lines.join('\n');
  }

  /** 尝试拉起：手机直接跳转；桌面用隐藏 iframe 尝试，未切走则给失败提示 */
  function openAlipayScheme(url, failText) {
    api.alipayLaunch(url).catch(e=>toast(e.message,'warn',9000));
  }

  /** 支付宝小程序刷脸深链（学校 face_verify_type != 1 时才显示按钮） */
  async function goAlipay(opts = {}) {
    let settled = false;
    const settle = (ok) => { if (settled) return; settled = true; if (opts.onResult) opts.onResult(ok); };
    try {
      const res = opts.ticket || await api.alipayFaceUrl(Number(opts.position || 0));
      if (Number(res.status) !== 1 || !res.url) {
        toast(res.info || '生成支付宝刷脸链接失败', 'warn');
        settle(false);
        return;
      }
      const input = h('input', { class: 'input mono', value: res.url, readOnly: true });
      const qrHtml = qrSvgOf(res.url);
      const checkBtn = h('button', {
        class: 'btn',
        text: '我已完成，查核验',
        onClick: async () => {
          checkBtn.disabled = true;
          checkBtn.textContent = '查询中…';
          try {
            const r = await api.alipayFaceCheck(Number(opts.position || 0));
            toast(r.info || (r.done ? '刷脸已完成' : '还没完成'), r.done ? 'ok' : 'warn', 6000);
            if (r.done) { settle(true); modal.close(); }
          } catch (e) {
            toast(`查询失败：${e.message}`, 'danger');
          } finally {
            checkBtn.disabled = false;
            checkBtn.textContent = '我已完成，查核验';
          }
        },
      });
      const modal = openModal({
        title: '支付宝刷脸',
        body: [
          h('p', {
            class: 'hint',
            text: '手机端可直接点「打开支付宝」；电脑端请用手机支付宝「扫一扫」下面的二维码，或复制链接到手机打开。刷完后点「我已完成，查核验」确认，再回来开跑。',
          }),
          ...(res.warning ? [h('p', { class: 'hint warn', text: res.warning })] : []),
          ...(qrHtml ? [h('div', { class: 'qr-box', html: qrHtml })] : []),
          input,
        ],
        footer: [
          h('button', {
            class: 'btn',
            text: '复制链接',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(res.url);
                toast('已复制刷脸链接', 'ok');
              } catch (_) {
                input.select();
                try { document.execCommand('copy'); toast('已复制刷脸链接', 'ok'); } catch (_) { toast('复制失败，请手动选择链接', 'warn'); }
              }
            },
          }),
          h('button', {
            class: 'btn btn-primary',
            text: '打开支付宝',
            onClick: () => {
              // 官方在跳转后补一条 updateZfbStatus(2)（纯通知，失败不影响刷脸）
              api.alipayFaceOpened().catch(() => {});
              openAlipayScheme(res.url, '这台电脑没有可接管 alipays:// 的支付宝客户端。'
                + '请点「复制链接」发到手机，用手机浏览器打开（微信内会拦截 alipays:// 链接）。');
            },
          }),
          checkBtn,
        ],
        onClose: () => settle(false),
      });
    } catch (e) {
      toast(`生成刷脸链接失败：${e.message}`, 'danger');
      settle(false);
    }
  }

  /**
   * 开跑前的支付宝刷脸闸门：需要支付宝刷脸且尚未完成核验时，先弹出刷脸弹窗。
   * 只有用户真的查到 status=1 的核验记录才放行（中途/结束刷脸后端会直接中止，不在这里拦）。
   * @returns {Promise<boolean>} 是否继续开跑
   */
  function ensureZfbFaceBeforeRun() {
    const sum = (app.state.zoneConfig && app.state.zoneConfig.summary) || null;
    const face = (sum && sum.face) || {};
    if (mode !== 'campus' || !face.on || Number(face.type) !== 2) return Promise.resolve(true);
    // 只有「开始前」刷脸需要在开跑前过闸门；中途/结束刷脸在任务触发点暂停处理
    if (Number(face.start) !== 1) return Promise.resolve(true);
    return api.alipayFaceCheck(0)
      .then((r) => (r && r.status === 1 && r.done ? true : new Promise((resolve) => {
        toast('该校要求支付宝刷脸 —— 先在支付宝里完成，再开始跑步', 'warn', 7000);
        goAlipay({ onResult: resolve });
      })))
      .catch(() => new Promise((resolve) => {
        toast('该校要求支付宝刷脸 —— 先在支付宝里完成，再开始跑步', 'warn', 7000);
        goAlipay({ onResult: resolve });
      }));
  }

  /**
   * 支付宝拉起自检 —— 对齐 Examate 的 launchTest：
   * 只构造深链验证「能不能拉起」，不建刷脸任务、不记录 face_time。
   */
  async function testAlipayLaunch() {
    let res;
    try {
      res = await api.alipayFaceUrl(0, true);
    } catch (e) {
      toast(`生成测试链接失败：${e.message}`, 'danger');
      return;
    }
    if (Number(res.status) !== 1 || !res.url) {
      toast(res.info || '生成测试链接失败', 'warn');
      return;
    }
    const diag = alipayEnvDiag();
    const resultLine = h('p', { class: 'hint' });
    const input = h('input', { class: 'input mono', value: res.url, readOnly: true });
    const qrHtml = qrSvgOf(res.url);
    openModal({
      title: '支付宝拉起自检',
      body: [
        h('p', { class: 'hint mono', text: diag, style: { whiteSpace: 'pre-wrap' } }),
        h('p', { class: 'hint', text: '测试链接只验证拉起，不会在服务端创建刷脸任务，也不记录 face_time。' }),
        ...(qrHtml ? [h('div', { class: 'qr-box', html: qrHtml })] : []),
        input,
        resultLine,
      ],
      footer: [
        h('button', {
          class: 'btn',
          text: '复制链接',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(res.url);
              toast('已复制测试链接', 'ok');
            } catch (_) {
              input.select();
              try { document.execCommand('copy'); toast('已复制测试链接', 'ok'); } catch (_) { toast('复制失败，请手动复制', 'warn'); }
            }
          },
        }),
        h('button', {
          class: 'btn btn-primary',
          text: '尝试拉起',
          onClick: () => {
            resultLine.className = 'hint';
            resultLine.textContent = '已发起跳转：若 2 秒内没有切到支付宝，说明当前环境不支持 alipays://（见上方环境判定）。';
            openAlipayScheme(res.url, '没有应用接管 alipays://：桌面上请用手机扫码，或复制链接到手机打开。');
          },
        }),
      ],
    });
  }

  // ─────────── 路线卡片 ───────────
  function renderRoute() {
    const r = app.state.route;
    routeCard.innerHTML = '';
    routeCard.append(
      h('div', { class: 'card-head' }, [
        h('h3', { text: '路线' }),
        h('span', { class: 'head-note', text: `${r.points.length} 拐点 · ${fmtKm(r.distanceKm)} km` }),
      ]),
      h('div', { class: 'card-body' }, [
        statGrid([
          { value: `${fmtKm(r.distanceKm)} km`, label: '距离', accent: true },
          { value: String(r.points.length), label: '拐点数' },
        ]),
        r.points.length < 2 ? h('p', { class: 'hint warn', text: '路线为空，请先编辑路线' }) : null,
        r.fitsSchool === false ? h('p', { class: 'hint warn', text: '这条路线还是上一所学校时画的 —— 换校后建议重新绘制，否则可能不在新跑区围栏内。' }) : null,
        !(app.state.zone && app.state.zone.id) ? h('p', { class: 'hint warn', text: '先选择跑区，地图与围栏才会按校区定位（当前仅按路线 / 定位显示）。' }) : null,
        h('div', { class: 'btn-row' }, [
          h('button', {
            class: 'btn btn-primary',
            onClick: () => openRouteEditor(),
          }, [svg('pen', 16), h('span', { text: '编辑路线' })]),
          h('button', {
            class: 'btn', text: '用历史记录导入',
            onClick: () => app.navigate('records', { hint: '在记录列表点击某条记录，进入详情后点「导入为路线」' }),
          }),
        ].filter(Boolean)),
      ]),
    );

    function openRouteEditor() {
      const editor = RouteEditor(app, { onSaved: async () => { await app.refresh(); schedulePreview(); } });
      editor.mount();
    }
  }

  // ─────────── 参数卡片 ───────────
  function slider({ label, value, min, max, step, unit, onChange, hint, decimals }) {
    /** 显示位数（如强度 1 → 1.00） */
    const disp = (v) => (decimals != null ? Number(v).toFixed(decimals) : String(v));
    const valEl = h('span', { class: 'field-val', text: `${disp(value)}${unit || ''}` });
    /** 已滑过部分高亮（CSS 用 --fill 画线性渐变） */
    const pctOf = (v) => `${((Number(v) - Number(min)) / Math.max(Number(max) - Number(min), 1e-6)) * 100}%`;
    const input = h('input', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
      style: { '--fill': pctOf(value) },
      onInput: (e) => {
        const v = Number(e.target.value);
        valEl.textContent = `${disp(v)}${unit || ''}`;
        e.target.style.setProperty('--fill', pctOf(v));
        onChange && onChange(v);
      },
    });
    return h('div', { class: 'field' }, [
      h('div', { class: 'field-row' }, [h('label', { text: label }), valEl]),
      input,
      hint ? h('span', { class: 'hint xs', text: hint }) : null,
    ].filter(Boolean));
  }

  function renderParams() {
    cancelMad();
    const cfg = app.state.runConfig;
    paramCard.innerHTML = '';
    const madBadge = h('span', { class: 'badge', text: '—' });
    const madDetail = h('span', { class: 'hint xs', text: '调参后按官方算法实算' });
    const madRow = h('div', { class: 'mad-row' }, [madBadge, madDetail]);
    /** 心跳节奏的「约 X 秒/次」提示：切档时立即更新，不等重渲染 */
    const heartbeatNote = h('span', {
      class: 'hint xs mono',
      text: `约 ${Math.round((Number(cfg.replayDelayMs ?? 20) * 30) / 1000)} 秒 / 次`,
    });
    let madTimer = null;
    let madSeq = 0;
    cancelMad=()=>{madSeq++;if(madTimer)clearTimeout(madTimer);};
    /**
     * 传感器 MAD 实算（对齐 nine 的做法）：防抖 420ms → 服务端真合成一段波形、
     * 按官方算法算窗口 MAD 统计，而不是「3.40 × 强度」的线性估算。
     */
    function scheduleMad() {
      if (madTimer) clearTimeout(madTimer);
      const seq=++madSeq;
      const c = app.state.runConfig;
      madBadge.className = 'badge';
      madBadge.textContent = '计算中';
      madDetail.textContent = '本地模拟计算…';
      madTimer = setTimeout(async () => {

        try {
          const res = await api.simulateSensor({ intensity: Number(c.sensorIntensity), cadenceSpm: Number(c.cadenceSpm) });
          if (seq !== madSeq) return;            // 过期响应丢弃（拖滑杆时不回跳）
          const m = res.mad || {};
          if (m.error) { madBadge.textContent = '—'; madDetail.textContent = m.error; return; }
          const tone = m.status === 1 ? 'ok' : m.status === 3 ? 'warn' : 'danger';
          madBadge.className = `badge ${tone}`;
          madBadge.textContent = `中位 ${m.median.toFixed(2)} · status ${m.status}`;
          madDetail.textContent = `窗口 ${m.min.toFixed(2)}~${m.max.toFixed(2)} · 正常占比 ${Math.round(m.status1Pct)}%（判定带 2.0~5.0）`;
        } catch (e) {
          if (seq !== madSeq) return;
          madBadge.textContent = '—';
          madDetail.textContent = `实算失败：${e.message}`;
        }
      }, 420);
    }

    const paceChips = h('div', { class: 'chips equal' }, app.state.paceOptions.map((o) => h('button', {
      class: 'chip',
      'aria-pressed': String(Number(cfg.paceLevel) === o.level),
      onClick: async () => {
        const res = await api.paceFor(o.level);
        Object.assign(app.state.runConfig, res.runConfig);
        renderParams();
        schedulePreview();
        toast(`已按「${o.name}」档生成参数：直道 ${res.paceResult.straightSpeed} / 弯道 ${res.paceResult.curveSpeed} m/s · ${res.paceResult.cadenceSpm} spm`, 'ok');
      },
    }, [
      h('span', { text: o.name }),
      h('span', { class: 'chip-sub', text: o.range }),
    ])));

    const headNote = h('span', { class: 'head-note' });
    const sumDetail = h('summary');
    const sumSpeed = h('summary');
    const sumSample = h('summary');
    const sumBody = h('summary');

    /** 折叠区摘要与顶部均速随参数变化同步刷新（否则改了滑块摘要仍是旧值） */
    function refreshSummaries(estimateMad = true) {
      const c = app.state.runConfig;
      headNote.textContent = `${((c.straightSpeed + c.curveSpeed) / 2).toFixed(2)} m/s 均速`;
      sumDetail.textContent = `高级参数 · 直道 ${c.straightSpeed} / 弯道 ${c.curveSpeed} · 采样 ${(c.gpsIntervalMs / 1000).toFixed(1)}s`;
      sumSpeed.textContent = `速度 · ${c.straightSpeed}/${c.curveSpeed} m/s · 加速度 ${c.maxAccel ?? 0.4}`;
      sumBody.textContent = `传感器 · ${c.cadenceSpm}spm · 强度 ${Number(c.sensorIntensity).toFixed(2)}×`;
      sumSample.textContent = `采样与节奏 · ${c.gpsIntervalMs}ms · 热身 ${c.warmupTime ?? 10}s / 冷却 ${c.cooldownTime ?? 8}s`;
      if (estimateMad) scheduleMad();
    }

    /** 真正会改变上传数据的字段（只有这些变时才需要重合成预览/重算传感器） */
    const PREVIEW_KEYS = new Set([
      'straightSpeed', 'curveSpeed', 'maxAccel', 'cadenceSpm',
      'sensorIntensity', 'gpsIntervalMs', 'warmupTime', 'cooldownTime', 'stepLengthM',
    ]);
    const MAD_KEYS = new Set(['sensorIntensity', 'cadenceSpm']);

    const update = async (rawPatch) => {
      const patch = { ...rawPatch };
      // 步长不单独暴露（不参与提交，只用来自洽校验）：速度或步频变化时按「速度 × 60 / 步频」自动更新
      if (patch.straightSpeed !== undefined || patch.curveSpeed !== undefined || patch.cadenceSpm !== undefined) {
        const merged = { ...app.state.runConfig, ...patch };
        const mean = (Number(merged.straightSpeed) + Number(merged.curveSpeed)) / 2;
        const cadence = Number(merged.cadenceSpm);
        if (mean > 0 && cadence > 0) {
          const len = Math.min(1.8, Math.max(1.0, (mean / cadence) * 60));
          patch.stepLengthM = Math.round(len * 100) / 100;
        }
      }
      const res = await api.saveConfig(patch);
      Object.assign(app.state.runConfig, res.runConfig);
      const touched = Object.keys(patch);
      const dataDirty = touched.some((k) => PREVIEW_KEYS.has(k));
      const madDirty = touched.some((k) => MAD_KEYS.has(k));
      refreshSummaries(madDirty);
      // 心跳节奏等纯回放参数不改变任何上传数据：不重合成预览（那是点击卡顿的真正来源）
      if (dataDirty) schedulePreview();
    };

    paramCard.append(
      h('div', { class: 'card-head' }, [h('h3', { text: '跑步参数' }), headNote]),
      h('div', { class: 'card-body' }, [
        paceChips,
        // 心跳节奏：控制回放时每个轨迹点的真实等待，间接决定 GPS 心跳的到达间隔
        h('div', { class: 'col', style: { gap: '6px' } }, [
          h('div', { class: 'between' }, [
            h('span', { class: 'hint', text: '心跳节奏' }),
            heartbeatNote,
          ]),
          h('div', { class: 'chips equal' }, [
            { v: 20, t: '瞬发', s: '几十秒' },
            { v: 500, t: '快速', s: '2~3 分钟' },
            { v: 2000, t: '拟真', s: '约 10 分钟' },
          ].map((o) => h('button', {
            class: 'chip',
            'aria-pressed': String(Number(cfg.replayDelayMs ?? 20) === o.v),
            onClick: (ev) => {
              // 立即反馈选中态与提示（update 只落盘配置，不重绘卡片）
              for (const b of Array.from(ev.currentTarget.parentElement.children)) {
                b.setAttribute('aria-pressed', 'false');
              }
              ev.currentTarget.setAttribute('aria-pressed', 'true');
              heartbeatNote.textContent = `约 ${Math.round((o.v * 30) / 1000)} 秒 / 次`;
              update({ replayDelayMs: o.v });
            },
          }, [h('span', { text: o.t }), h('span', { class: 'chip-sub', text: o.s })]))),
          h('p', {
            class: 'hint',
            text: '控制回放时每个轨迹点的等待（约 30 点 = 1 次 GPS 心跳）。瞬发最快；快速约 15 秒/次；'
              + '拟真约 60 秒/次。实际按学校返回的规则执行；参数预览不代表服务端已接受成绩。',
          }),
        ]),
        // 只保留会真正影响上传数据的项：速度（配速）/ 步频 / 传感器强度 / 采样与节奏。
        // 加速度、体重、步长不参与生成或提交（步长由速度与步频自动推导），不再占用界面。
        h('details', { class: 'fold' }, [
          sumDetail,
          h('div', { class: 'fold-body' }, [
            h('details', { class: 'fold', open: true }, [
              sumSpeed,
              h('div', { class: 'fold-body' }, [
                slider({ label: '直道速度', value: cfg.straightSpeed, min: 2.0, max: 5.0, step: 0.1, unit: ' m/s', onChange: (v) => update({ straightSpeed: v }) }),
                slider({ label: '弯道速度', value: cfg.curveSpeed, min: 1.5, max: 5.0, step: 0.1, unit: ' m/s', onChange: (v) => update({ curveSpeed: v }) }),
                slider({
                  label: '加速度', value: cfg.maxAccel ?? 0.4, min: 0.1, max: 2.0, step: 0.1, unit: ' m/s²',
                  hint: '限制每秒速度变化，越大越灵敏；影响直道/弯道之间的过渡',
                  onChange: (v) => update({ maxAccel: v }),
                }),
              ]),
            ]),
            h('details', { class: 'fold' }, [
              sumBody,
              h('div', { class: 'fold-body' }, [
                slider({ label: '步频', value: cfg.cadenceSpm, min: 140, max: 180, step: 1, unit: ' spm', onChange: (v) => update({ cadenceSpm: v }) }),
                slider({
                  label: '传感器强度', value: cfg.sensorIntensity, min: 0.70, max: 1.15, step: 0.01, unit: ' ×', decimals: 2,
                  hint: '建议 0.85~1.05 ×（提交时还有闭环自校准兜底）',
                  onChange: (v) => update({ sensorIntensity: v }),
                }),
                madRow,
              ]),
            ]),
            h('details', { class: 'fold' }, [
              sumSample,
              h('div', { class: 'fold-body' }, [
                slider({ label: '采样间隔', value: cfg.gpsIntervalMs, min: 500, max: 5000, step: 500, unit: ' ms', onChange: (v) => update({ gpsIntervalMs: v }) }),
                h('p', { class: 'hint', text: '点距超过服务端上限时会自动收紧' }),
                slider({ label: '热身时长', value: cfg.warmupTime ?? 10, min: 0, max: 30, step: 1, unit: ' s', onChange: (v) => update({ warmupTime: v }) }),
                slider({ label: '冷却时长', value: cfg.cooldownTime ?? 8, min: 0, max: 20, step: 1, unit: ' s', onChange: (v) => update({ cooldownTime: v }) }),
              ]),
            ]),
          ]),
        ]),
      ]),
    );
    refreshSummaries();
  }

  // ─────────── 数据预览 ───────────
  function schedulePreview() {
    previewSeq++;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(doPreview, 420);
  }

  async function doPreview() {
    const seq=++previewSeq;
    const r = app.state.route;
    if (!r.points || r.points.length < 2) {
      previewCard.innerHTML = '';
      previewCard.append(
        h('div', { class: 'card-head' }, [h('h3', { text: '全程数据预览 · 本地模拟' })]),
        h('div', { class: 'empty', text: '先设置路线（至少 2 个拐点）才能预览' }),
      );
      return;
    }
    previewCard.innerHTML = `<div class="card-body"><div class="row"><span class="spinner"></span><span class="hint">正在合成数据…</span></div></div>`;
    try {
      const res = await api.previewRoute(r.points, app.state.runConfig);
      if(seq!==previewSeq)return;
      if (res.status !== 1) {
        previewCard.innerHTML = '';
        previewCard.append(h('div', { class: 'card-body' }, [h('p', { class: 'hint danger', text: res.info || '预览失败' })]));
        return;
      }
      preview = res;
      renderPreview(res);
    } catch (e) {
      if(seq!==previewSeq)return;
      previewCard.innerHTML = '';
      previewCard.append(h('div', { class: 'card-body' }, [h('p', { class: 'hint danger', text: `预览失败：${e.message}` })]));
    }
  }

  function renderPreview(res) {
    const speedCanvas = h('canvas', { class: 'chart' });
    const waveCanvas = h('canvas', { class: 'chart sm' });
    const paceBar = h('div', { class: 'pacebar' });
    const warnBox = h('div', { class: 'col' });

    previewCard.innerHTML = '';
    previewCard.append(
      h('div', { class: 'card-head' }, [
        h('h3', { text: '全程数据预览 · 本地模拟' }),
        h('span', { class: 'head-note', text: `${res.pointCount} 轨迹点 · ${res.laps || 1} 圈` }),
      ]),
      h('div', { class: 'card-body' }, [
        // 配速卡：标签在上、数值在下，单位与均速同行对齐
        h('div', { class: 'col', style: { gap: '2px' } }, [
          h('span', { class: 'hint xs', text: '平均配速' }),
          h('div', { class: 'row', style: { alignItems: 'baseline', gap: '6px' } }, [
            h('span', { class: 'mono', text: fmtPace(res.paceSecPerKm), style: { fontSize: 'var(--fs-2xl)', fontWeight: '600', letterSpacing: '-0.5px' } }),
            h('span', { class: 'hint mono', text: '/km' }),
            h('span', { class: 'grow' }),
            h('span', { class: 'hint mono', text: `${res.avgSpeed.toFixed(2)} m/s` }),
          ]),
        ]),
        paceBar,
        h('div', { class: 'between' }, [
          h('span', { class: 'hint xs mono', text: `最快 ${fmtPaceFromSpeed(res.maxSpeed)}` }),
          h('span', { class: 'hint xs mono', text: `最慢 ${fmtPaceFromSpeed(res.minSpeed)}` }),
        ]),
        statGrid([
          { value: `${fmtKm(res.distanceKm)} km`, label: '距离' },
          { value: fmtDuration(res.durationS), label: '时长' },
          { value: `${res.steps} 步`, label: '步数' },
        ]),
        // 步频属于配置项（参数卡片已展示），这里只回显真正参与生成的一项
        h('div', { class: 'row-wrap' }, [
          h('span', { class: 'badge', text: `步频 ${app.state.runConfig.cadenceSpm} spm` }),
        ]),
        h('div', { class: 'col', style: { gap: '6px' } }, [
          h('div', { class: 'inst-head' }, [
            h('span', { class: 'name', text: '速度曲线 · 横轴累计距离' }),
            h('span', { class: 'unit', text: '纵轴 m/s' }),
          ]),
          h('div', { class: 'chart-panel' }, [speedCanvas]),
        ]),
        h('div', { class: 'col', style: { gap: '6px' } }, [
          h('div', { class: 'inst-head' }, [
            h('span', { class: 'name', text: '传感器波形 · 首 3 秒原采样（60ms）' }),
            h('span', { class: 'unit', text: '单位 m/s²' }),
          ]),
          h('div', { class: 'chart-panel' }, [waveCanvas]),
          h('div', { class: 'chart-legend' }, [
            legendItem('ax', 'var(--axis-x)'),
            legendItem('ay', 'var(--axis-y)'),
            legendItem('az', 'var(--axis-z)'),
          ]),
          res.sensorSelfCheck ? sensorCheck(res.sensorSelfCheck) : null,
        ].filter(Boolean)),
        warnBox,
      ]),
    );

    renderPaceBar(paceBar, res.paceSecPerKm);
    requestAnimationFrame(() => {
      drawSpeedCurve(speedCanvas, res.speedCurve, res.avgSpeed);
      drawSensorWave(waveCanvas, res.sensorWave);
    });

    warnBox.innerHTML = '';
    warnBox.appendChild(h('div', { class: 'checklist' },
      res.warnings.length === 0
        ? [h('div', { class: 'check-item ok' }, [svg('check', 15), h('span', { text: '本地参数检查通过' })])]
        : res.warnings.map((w) => h('div', { class: 'check-item warn' }, [svg('info', 15), h('span', { text: w })]))));
  }

  // ─────────── 完整版可用性（仅试用版，只读检测） ───────────
  function renderCompat() {
    if (!compatCard) return;
    compatCard.innerHTML = '';
    const resultBox = h('div', { class: 'col', style: { gap: '8px' } });
    const btn = h('button', {
      class: 'btn btn-sm btn-block', text: '检测本校正能否使用完整版',
      onClick: async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        b.textContent = '检测中…';
        resultBox.innerHTML = '';
        try {
          const res = await api.compat();
          renderCompatResult(resultBox, res);
        } catch (e) {
          resultBox.appendChild(h('p', { class: 'hint danger', text: `检测失败：${e.message}` }));
        } finally {
          b.disabled = false;
          b.textContent = '重新检测';
        }
      },
    });
    compatCard.append(
      h('div', { class: 'card-head' }, [
        h('h3', { text: '完整版可用性' }),
        h('span', { class: 'head-note', text: '仅试用版检测' }),
      ]),
      h('div', { class: 'card-body tight' }, [
        h('p', { class: 'hint', text: '读取该校 beforeRun 配置，做理论层面的可行性分析；不会生成轨迹、不会发起任何提交。' }),
        btn,
        resultBox,
      ]),
    );
  }

  function renderCompatResult(box, res) {
    box.innerHTML = '';
    if (Number(res.status) !== 1) {
      box.appendChild(h('p', { class: 'hint danger', text: res.info || '检测失败' }));
      return;
    }
    const r = res.result || {};
    const tone = r.level === 'ok' ? 'ok' : r.level === 'risk' ? 'warn' : 'danger';
    const s = res.summary || {};
    box.append(...[
      h('div', { class: 'between' }, [
        h('span', { class: `badge ${tone}`, text: r.title || '—' }),
        h('span', { class: 'hint xs', text: [s.schoolName, s.runZoneName].filter(Boolean).join(' · ') }),
      ]),
      r.blocked && r.blocked.length
        ? h('div', { class: 'col', style: { gap: '4px' } }, [
          h('span', { class: 'hint xs', text: '硬性阻断' }),
          ...r.blocked.map((t) => h('p', { class: 'hint danger', text: `· ${t}` })),
        ])
        : null,
      r.warnings && r.warnings.length
        ? h('div', { class: 'col', style: { gap: '4px' } }, [
          h('span', { class: 'hint xs', text: '风险提示' }),
          ...r.warnings.map((t) => h('p', { class: 'hint warn', text: `· ${t}` })),
        ])
        : null,
      r.level === 'ok'
        ? h('p', { class: 'hint ok', text: '配置层未发现硬性阻断；实际成绩还取决于照片库、路线与当前时段。' })
        : null,
      res.configLines && res.configLines.length
        ? h('details', { class: 'fold' }, [
          h('summary', { text: '查看配置依据' }),
          h('div', { class: 'fold-body' }, res.configLines.map((t) => h('p', { class: 'hint xs', text: t }))),
        ])
        : null,
    ].filter(Boolean));
  }

  // ─────────── 上传卡片（正式版） ───────────
  function renderUpload() {
    if (globalThis.LEPAO_TRIAL) return;
    const cfg = app.state.runConfig;
    const r = app.state.route;
    uploadCard.innerHTML = '';
    uploadCard.append(
      h('div', { class: 'card-head' }, [
        h('h3', { text: '上传跑步记录' }),
        runJob ? h('span', { class: 'live', text: '执行中' }) : null,
      ].filter(Boolean)),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'chips equal' }, [
          h('button', {
            class: 'chip', 'aria-pressed': String(mode === 'free'),
            onClick: () => { mode = 'free'; pref.set('runMode', mode); renderUpload(); },
          }, [h('span', { text: '自由跑' }), h('span', { class: 'chip-sub', text: '不关联成绩' })]),
          h('button', {
            class: 'chip', 'aria-pressed': String(mode === 'campus'),
            onClick: () => { mode = 'campus'; pref.set('runMode', mode); renderUpload(); },
          }, [h('span', { text: '校园跑' }), h('span', { class: 'chip-sub', text: '含打卡点+传感器' })]),
        ]),
        h('p', { class: 'hint', text: `距离 ${fmtKm(r.distanceKm)}km · 直道 ${cfg.straightSpeed} / 弯道 ${cfg.curveSpeed} m/s` }),
        h('p', { class: 'hint', text: '点击上传将启动联网任务，上传路线、统计数据及学校要求的本人照片。成绩以服务端返回和记录页复查为准。' }),
        h('button', {
          class: 'btn btn-primary btn-lg btn-block',
          disabled: Boolean(runJob) || r.points.length < 2,
          title: '主动启动后将向乐跑服务提交记录',
          onClick: () => startRun(),
        }, [svg('play', 16), h('span', { text: runJob ? '执行中…' : (mode === 'campus' ? '上传校园跑' : '上传自由跑') })]),
        runJob ? h('button', {
          class: 'btn btn-danger btn-block', text: '取消执行',
          onClick: async () => { await api.runCancel(runJob); toast('已请求取消', 'warn'); },
        }) : null,
        runJob || logPanel.count > 0 ? logPanel.el : null,
      ].filter(Boolean)),
    );
  }

  function watchRun(id,notify=true){
    unsubscribe?.();
    unsubscribe=subscribeJob(id,{
      onLog:e=>logPanel.append(e.msg),
      onFaceRequest:ticket=>goAlipay({position:ticket.position,ticket}),
      onDone:async d=>{
        runJob=null;
        const result=d.result||{};
        const message=d.status==='done'?(result.humanStatus||'已提交，请复查记录'):(d.error||'任务已结束');
        logPanel.append(message,d.status==='done'&&result.recordOk?'ok':'warn');
        if(notify)toast(message,d.status==='done'&&result.recordOk?'ok':'warn',9000);
        if(app.state.running)app.state.running.current=null;
        unsubscribe?.();unsubscribe=null;await app.refresh();renderUpload();
      }
    });
  }
  async function startRun(){
    if(runJob)return;
    try{
      if(logPanel.count===0)logPanel.clear();
      const res=await api.runStart({mode});runJob=res.jobId;app.state.running={...app.state.running,current:{id:runJob,mode},latest:{id:runJob,mode}};watchRun(runJob);renderUpload();
    }catch(e){toast(e.message||String(e),'danger');}
  }

  // ─────────── 渲染 ───────────
  function renderAll() {
    mountEnvCard();
    renderEnv();
    renderRequirement();
    renderCompat();
    renderRoute();
    renderParams();
    renderUpload();
    doPreview();
  }

  renderAll();
  if(runJob)watchRun(runJob);else if(app.state.running?.latest?.id)watchRun(app.state.running.latest.id,false);

  return {
    el: root,
    refresh: renderAll,
    destroy: () => { faceSection.destroy?.();previewSeq++; cancelMad(); api.cancelPreviews(); if (unsubscribe) unsubscribe(); if (previewTimer) clearTimeout(previewTimer); },
  };
}