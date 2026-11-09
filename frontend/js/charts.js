/* Canvas 图表：速度曲线 / 传感器波形 / 配速与跑步强度区间条（iOS 系统色） */
'use strict';

function setup(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
  const h = height || canvas.clientHeight || 96;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const CSS = getComputedStyle(document.documentElement);
const col = (name, fallback) => (CSS.getPropertyValue(name) || fallback).trim() || fallback;
const AXIS_FONT = '9px ui-monospace, "SF Mono", Menlo, monospace';

/** #RRGGBB → rgba（canvas 渐变需要带 alpha 的颜色；色值仍取自 token，不新增配色） */
function alpha(color, a) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(color).trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** 速度曲线：横轴累计距离、纵轴速度；右轴标上下限，底部标起止距离，均速画虚线 */
export function drawSpeedCurve(canvas, curve, avgSpeed) {
  const { ctx, w, h } = setup(canvas);
  if (!curve || curve.length < 2) return;

  const pad = { l: 2, r: 38, t: 12, b: 14 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const vs = curve.map((p) => p.v);
  const minV = Math.min(...vs, avgSpeed > 0 ? avgSpeed : Infinity);
  const maxV = Math.max(...vs, avgSpeed > 0 ? avgSpeed : -Infinity);
  const spanV = Math.max(maxV - minV, 0.4);
  const x = (i) => pad.l + (i / (curve.length - 1)) * plotW;
  const y = (v) => pad.t + (1 - (v - minV) / spanV) * plotH;

  const grid = col('--axis-grid', 'rgba(60,60,67,0.10)');
  const mute = col('--text-mute', 'rgba(60,60,67,0.42)');
  const dim = col('--text-dim', 'rgba(60,60,67,0.60)');

  ctx.font = AXIS_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // 上下限参考线 + 右侧刻度值
  for (const tv of [maxV, minV]) {
    const yy = y(tv);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy);
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = mute;
    ctx.fillText(tv.toFixed(1), w - pad.r + 5, yy);
  }

  // 面积：竖向渐隐填充（曲线色 → 透明），仪表图的标准手法，比平涂更有纵深
  const accentCol = col('--accent', '#007AFF');
  const gArea = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
  gArea.addColorStop(0, alpha(accentCol, 0.30));
  gArea.addColorStop(0.55, alpha(accentCol, 0.11));
  gArea.addColorStop(1, alpha(accentCol, 0));
  ctx.beginPath();
  curve.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.v)) : ctx.lineTo(x(i), y(p.v))));
  ctx.lineTo(x(curve.length - 1), pad.t + plotH);
  ctx.lineTo(x(0), pad.t + plotH);
  ctx.closePath();
  ctx.fillStyle = gArea;
  ctx.fill();

  // 曲线
  ctx.beginPath();
  curve.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.v)) : ctx.lineTo(x(i), y(p.v))));
  ctx.strokeStyle = accentCol;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // 平均速虚线
  if (avgSpeed > 0) {
    const yy = y(avgSpeed);
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy);
    ctx.strokeStyle = mute; ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([]);
  }

  // 底部：起止累计距离
  ctx.fillStyle = dim;
  ctx.textAlign = 'left';
  ctx.fillText('0 km', pad.l, h - 5);
  ctx.textAlign = 'right';
  ctx.fillText(`${curve[curve.length - 1].d.toFixed(2)} km`, w - pad.r, h - 5);
}

/**
 * 传感器波形：ax / ay / az 三轴（ay 已去重力，三轴围绕 0 波动）
 * 首 3 秒原始采样 ≈50 点 @60ms；右轴标振幅上下限，底部标时间轴。
 * 与服务端预览一致：种子由参数指纹决定 —— 同参数波形稳定，改强度看振幅、改步频看波峰疏密。
 */
export function drawSensorWave(canvas, wave) {
  const { ctx, w, h } = setup(canvas);
  if (!wave || wave.length < 4) return;

  const pad = { l: 2, r: 34, t: 12, b: 14 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const all = wave.flatMap((s) => [s.ax, s.ay, s.az]);
  const minV = Math.min(...all, 0);
  const maxV = Math.max(...all, 0);
  const span = Math.max(maxV - minV, 1e-6);
  const x = (i) => pad.l + (i / (wave.length - 1)) * plotW;
  const y = (v) => pad.t + (1 - (v - minV) / span) * plotH;

  const grid = col('--axis-grid', 'rgba(60,60,67,0.10)');
  const mute = col('--text-mute', 'rgba(60,60,67,0.42)');
  const dim = col('--text-dim', 'rgba(60,60,67,0.60)');

  ctx.font = AXIS_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // 包络带：逐点取三轴上下界做竖向渐隐填充（信号带宽的仪表画法；单次填充，不会三色叠糊）
  const accentCol = col('--accent', '#007AFF');
  const gEnv = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
  gEnv.addColorStop(0, alpha(accentCol, 0.18));
  gEnv.addColorStop(1, alpha(accentCol, 0.01));
  ctx.beginPath();
  wave.forEach((p, i) => {
    const hi = y(Math.max(p.ax, p.ay, p.az));
    if (i === 0) ctx.moveTo(x(i), hi); else ctx.lineTo(x(i), hi);
  });
  for (let i = wave.length - 1; i >= 0; i -= 1) {
    const p = wave[i];
    ctx.lineTo(x(i), y(Math.min(p.ax, p.ay, p.az)));
  }
  ctx.closePath();
  ctx.fillStyle = gEnv;
  ctx.fill();

  // 振幅参考线：上限 / 零基线 / 下限（零基线加重，对应「静止/跑动」的判读基准）
  for (const tv of [maxV, 0, minV]) {
    const yy = y(tv);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy);
    if (tv === 0) { ctx.setLineDash([3, 3]); ctx.strokeStyle = mute; } else { ctx.strokeStyle = grid; }
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = mute;
    ctx.fillText(tv === 0 ? '0' : tv.toFixed(1), w - pad.r + 5, yy);
  }

  // 中位竖网格（半程）
  ctx.beginPath();
  const xm = pad.l + plotW / 2;
  ctx.moveTo(xm, pad.t); ctx.lineTo(xm, pad.t + plotH);
  ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.stroke();

  // 三轴曲线
  const series = [
    { key: 'ax', color: col('--axis-x', '#FF3B30') },
    { key: 'ay', color: col('--axis-y', '#34C759') },
    { key: 'az', color: col('--axis-z', '#007AFF') },
  ];
  for (const s of series) {
    ctx.beginPath();
    wave.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p[s.key])) : ctx.lineTo(x(i), y(p[s.key]))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.95;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 底部时间轴
  const secs = wave.length * 0.06;
  ctx.fillStyle = dim;
  ctx.textAlign = 'left';
  ctx.fillText('0s', pad.l, h - 5);
  ctx.textAlign = 'right';
  ctx.fillText(`${secs.toFixed(1)}s`, w - pad.r, h - 5);
}

/** MAD → 官方 runStatus 分区（0 静止 / 3 代步 / 1 正常 / 2 剧烈） */
export function madZone(mad) {
  if (mad > 5.0) return { code: 2, name: '剧烈摇晃', tone: 'warn' };
  if (mad > 2.0) return { code: 1, name: '正常跑步', tone: 'ok' };
  if (mad < 1.5) return { code: 0, name: '静止', tone: '' };
  return { code: 3, name: '代步嫌疑', tone: 'danger' };
}

/**
 * 跑步强度区间条（MAD 0~6）：正常区 2.0~5.0 高亮，阈值刻度 1.5 / 2.0 / 5.0，标记落在实测 MAD 上。
 * 与官方 xd/a.java 的 runStatus 判定对齐：<1.5 静止 · 1.5~2.0 代步 · 2.0~5.0 正常 · >5.0 剧烈。
 */
export function renderMadBar(container, mad) {
  const MIN = 0; const MAX = 6;
  const pct = (v) => `${Math.min(Math.max((v - MIN) / (MAX - MIN), 0), 1) * 100}%`;
  container.innerHTML = '';

  container.classList.add('zoned');
  const width = (lo, hi) => `${((hi - lo) / (MAX - MIN)) * 100}%`;

  const track = document.createElement('div');
  track.className = 'track';
  // 阈值分区底色：<1.5 静止 · 1.5~2 代步 · 2~5 正常 · >5 剧烈（把区间直接画出来）
  for (const [cls, lo, hi] of [['z0', 0, 1.5], ['z3', 1.5, 2.0], ['z1', 2.0, 5.0], ['z2', 5.0, MAX]]) {
    const z = document.createElement('div');
    z.className = `zone ${cls}`;
    z.style.left = pct(lo);
    z.style.width = width(lo, hi);
    track.appendChild(z);
  }

  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  for (const v of [1.5, 2.0, 5.0]) {
    const t = document.createElement('i');
    t.style.left = pct(v);
    ticks.appendChild(t);
  }

  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.style.left = pct(mad);

  const labels = document.createElement('div');
  labels.className = 'labels';
  labels.innerHTML = '<span>0</span><span>1.5–2.0 代步 · 2.0–5.0 正常</span><span>5.0+</span>';

  container.append(track, ticks, marker, labels);
}

/** 配速安全区间条（120~720 秒/km，安全区 180~600） */
export function renderPaceBar(container, paceSecPerKm) {
  const MIN = 120; const MAX = 720; const SAFE_LO = 180; const SAFE_HI = 600;
  const pct = (v) => `${Math.min(Math.max((v - MIN) / (MAX - MIN), 0), 1) * 100}%`;
  container.innerHTML = '';
  const track = document.createElement('div');
  track.className = 'track';
  const safe = document.createElement('div');
  safe.className = 'safe';
  safe.style.left = pct(SAFE_LO);
  safe.style.width = `calc(${pct(SAFE_HI)} - ${pct(SAFE_LO)})`;
  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.style.left = pct(paceSecPerKm);
  const labels = document.createElement('div');
  labels.className = 'labels';
  labels.innerHTML = '<span>偏快</span><span>安全区间 3\'00"~10\'00"/km</span><span>偏慢</span>';
  container.append(track, safe, marker, labels);
}
