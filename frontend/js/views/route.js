import {Geo} from '../amap-adapter.js';
/* 路线编辑器（全屏）：手绘为主（连续画线，实时平滑、抬手抽稀、整笔撤销）/ 精确加点 / 打卡点与围栏叠加 */
'use strict';

import { h, svg, toast, fmtKm, confirmDialog } from '../util.js';
import { api } from '../api.js';
import { RouteEditorMap, pointIcon } from '../map.js';
import {autoRoute} from '../auto-route.js';

export function RouteEditor(app, { onSaved } = {}) {
  const route = app.state.route;
  let checkpoints = [];
  let editorMap = null;
  let alive=true,planning=null;
  let mode = 'draw'; // draw = 手绘（默认）| point = 精确加点

  const title = h('span', { class: 'fullpage-title', text: '手绘模式 · 按住拖动连续画线' });
  const statLine = h('div', { class: 'head-note mono' });
  const panel = h('div', { class: 'fullpage-panel' });
  const mapWrap = h('div', { class: 'map-wrap' });
  const mapEl = h('div', { class: 'map map-fill' });

  const chipDraw = h('button', { class: 'chip', 'aria-pressed': 'true', onClick: () => setMode('draw') }, [
    h('span', { text: '手绘' }), h('span', { class: 'chip-sub', text: '按住拖动连续画' }),
  ]);
  const chipPoint = h('button', { class: 'chip', 'aria-pressed': 'false', onClick: () => setMode('point') }, [
    h('span', { text: '精确加点' }), h('span', { class: 'chip-sub', text: '逐点点击定位' }),
  ]);
  const modeChips = h('div', { class: 'chips equal' }, [chipDraw, chipPoint]);

  const btnUndo = h('button', { class: 'btn btn-ghost', text: '撤销', onClick: () => { if (editorMap) { editorMap.undo(); updateStats(); } } });
  const btnClear = h('button', { class: 'btn btn-ghost', text: '清空', onClick: async () => {
    if (!editorMap || editorMap.getPoints().length === 0) return;
    if (await confirmDialog({ title: '清空路线', message: '确定清空当前绘制的全部笔迹吗？', okText: '清空', danger: true })) {
      editorMap.clear(); updateStats();
    }
  } });
  const btnSave = h('button', {
    class: 'btn btn-primary', text: '保存',
    onClick: async () => {
      const pts = editorMap ? editorMap.getPoints() : [];
      if (pts.length < 2) { toast('路线至少需要 2 个拐点', 'warn'); return; }
      btnSave.disabled = true;
      try {
        const res = await api.saveRoute(pts);
        toast(`✓ 已保存 ${res.points} 个拐点 · ${fmtKm(res.distanceKm)}km`, 'ok');
        await app.refresh();
        onSaved && onSaved();
        destroy();
      } catch (e) {
        toast(`保存失败：${e.message}`, 'danger');
      } finally {
        btnSave.disabled = false;
      }
    },
  });

  const root = h('div', { class: 'fullpage' }, [
    h('div', { class: 'fullpage-head' }, [
      h('button', {
        class: 'btn btn-icon btn-ghost', 'aria-label': '返回',
        onClick: () => destroy(),
      }, [svg('back', 18)]),
      title,
      statLine,
    ]),
    h('div', { class: 'fullpage-body split route-editor-layout' }, [mapWrap, panel]),
    h('div', { class: 'fullpage-foot' }, [btnUndo, btnClear, btnSave]),
  ]);
  mapWrap.appendChild(mapEl);

  function updateStats() {
    const pts = editorMap ? editorMap.getPoints() : [];
    updateStatsLine(pts);
    renderPanel(pts);
  }

  /** 只刷头部统计与按钮（手绘过程中每次采样都用，避免重建面板 DOM） */
  function updateStatsLine(pts) {
    const singleKm = calcKm(pts);
    const strokes = editorMap ? editorMap.getStrokeCount() : 0;
    statLine.textContent = `${pts.length} 点 · ${fmtKm(singleKm)}km`;
    btnUndo.textContent = mode === 'draw'
      ? (strokes ? `撤销这一笔（${strokes}）` : '撤销')
      : (pts.length ? '撤销上一个点' : '撤销');
    btnSave.disabled = pts.length < 2;
  }

  function calcKm(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const dLat = (pts[i][0] - pts[i - 1][0]) * 111320;
      const dLng = (pts[i][1] - pts[i - 1][1]) * 111320 * Math.cos((pts[i][0] * Math.PI) / 180);
      d += Math.sqrt(dLat * dLat + dLng * dLng);
    }
    return d / 1000;
  }

  function renderPanel(pts) {
    const singleKm = calcKm(pts);
    panel.innerHTML = '';

    panel.append(
      h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [h('h3', { text: '绘制方式' }), h('span', { class: 'head-note', text: mode === 'draw' ? '抬手自动抽稀' : '逐点精确' })]),
        h('div', { class: 'card-body tight' }, [modeChips]),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [h('h3', { text: '路线统计' })]),
        h('div', { class: 'card-body tight' }, [
          h('div', { class: 'stats two' }, [
            h('div', { class: 'stat' }, [h('div', { class: 'v', text: String(pts.length) }), h('div', { class: 'l', text: '拐点' })]),
            h('div', { class: 'stat accent' }, [h('div', { class: 'v', text: `${fmtKm(singleKm)}` }), h('div', { class: 'l', text: '距离 km' })]),
          ]),
          pts.length >= 2 && singleKm < 1.0
            ? h('p', { class: 'hint warn', text: '路线偏短：提交前自检会按学校要求（通常 ≥1~2 km）拦下' })
            : null,
        ].filter(Boolean)),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [
          h('h3', { text: '跑区叠加' }),
          h('span', { class: 'head-note', text: (app.state.zone.fence || []).length >= 3 ? '围栏已加载' : '无围栏' }),
        ]),
        h('div', { class: 'card-body tight' }, [
          h('p', { class: 'hint', text: '路线尽量落在橙色围栏内' }),
          h('button', {
            class: 'btn btn-sm btn-block', text: checkpoints.length ? `已载入 ${checkpoints.length} 个打卡点` : '载入跑区打卡点（校园跑用）',
            onClick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true; btn.textContent = '载入中…';
              try {
                const res = await api.zonePoints(app.state.zone.id);
                checkpoints = res.points || [];
                checkpoints.forEach((cp, i) => {
                  Geo.marker([cp.lat, cp.lng], { icon: pointIcon(String(i + 1)) }).addTo(editorMap.map).bindTooltip(`打卡点 ${cp.id}`);
                });
                toast(`已载入 ${checkpoints.length} 个打卡点（黄色标记）`, 'ok');
                renderPanel(editorMap.getPoints());
              } catch (err) {
                toast(`载入失败：${err.message}`, 'warn');
              } finally {
                btn.disabled = false;
              }
            },
          }),
          h('div', { class: 'btn-row' }, [
            h('button', { class: 'btn btn-sm', text: '自动规划路线', onClick: () => {if(planning)return;planning=autoRoute(app,{onApplied:points=>{if(alive&&editorMap)editorMap.setPoints(points);},onClose:()=>planning=null});} }),
            h('button', { class: 'btn btn-sm', text: '回到围栏范围', onClick: () => editorMap && editorMap.fitToFence() }),
          ]),
        ]),
      ]),
    );
  }

  function setMode(next) {
    mode = next === 'point' ? 'point' : 'draw';
    chipDraw.setAttribute('aria-pressed', String(mode === 'draw'));
    chipPoint.setAttribute('aria-pressed', String(mode === 'point'));
    title.textContent = mode === 'draw' ? '手绘模式 · 按住拖动连续画线' : '精确加点 · 点击地图追加拐点';
    if (editorMap) editorMap.setMode(mode === 'draw' ? 'draw' : 'browse');
    updateStats();
  }

  function destroy() {
    alive=false;planning?.close();planning=null;
    if (editorMap) { editorMap.destroy(); editorMap = null; }
    root.remove();
    document.body.style.overflow = '';
  }

  return {
    mount() {
      document.body.appendChild(root);
      document.body.style.overflow = 'hidden';
      // 初始点位：当前路线（不含圈数展开，保持单圈可编辑）
      const initial = (route.points && route.points.length >= 2) ? route.points : [];
      // 换过学校后旧路线属于别的校区：照样载入可编辑，但不拿它当地图中心
      // （由新学校跑区中心 / 上次定位兜底）
      const fitsSchool = app.state.route.fitsSchool !== false;
      const geo = Number.isFinite(app.state.geo && app.state.geo.lat)
        ? [app.state.geo.lat, app.state.geo.lng] : null;
      editorMap = new RouteEditorMap(mapEl, {
        points: initial,
        fence: app.state.zone.fence || [],
        center: app.state.zone.center || (fitsSchool && initial[0] ? initial[0] : undefined) || geo || undefined,
        mode,
        onChange: (pts, opts) => { if (opts && opts.live) updateStatsLine(pts); else updateStats(); },
        fit: fitsSchool && initial.length < 2,
      });
      updateStats();
      setTimeout(() => editorMap && editorMap.map.invalidateSize(), 80);
    },
    destroy,
  };
}