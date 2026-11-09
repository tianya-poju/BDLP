import { h, svg, fmtKm } from "../../util.js";

import { statGrid } from "../../components.js";

import { RouteEditor } from "../route.js";

export function createRoute({ app, routeCard, schedulePreview }) {
  function renderRoute() {
    const r = app.state.route;
    routeCard.innerHTML = "";
    routeCard.append(
      h("div", { class: "card-head" }, [
        h("h3", { text: "路线" }),
        h("span", {
          class: "head-note",
          text: `${r.points.length} 拐点 · ${fmtKm(r.distanceKm)} km`,
        }),
      ]),
      h("div", { class: "card-body" }, [
        statGrid([
          { value: `${fmtKm(r.distanceKm)} km`, label: "距离", accent: true },
          { value: String(r.points.length), label: "拐点数" },
        ]),
        r.points.length < 2
          ? h("p", { class: "hint warn", text: "路线为空，请先编辑路线" })
          : null,
        r.fitsSchool === false
          ? h("p", {
              class: "hint warn",
              text: "这条路线还是上一所学校时画的 —— 换校后建议重新绘制，否则可能不在新跑区围栏内。",
            })
          : null,
        !(app.state.zone && app.state.zone.id)
          ? h("p", {
              class: "hint warn",
              text: "先选择跑区，地图与围栏才会按校区定位（当前仅按路线 / 定位显示）。",
            })
          : null,
        h(
          "div",
          { class: "btn-row" },
          [
            h(
              "button",
              {
                class: "btn btn-primary",
                onClick: () => openRouteEditor(),
              },
              [svg("pen", 16), h("span", { text: "编辑路线" })],
            ),
            h("button", {
              class: "btn",
              text: "用历史记录导入",
              onClick: () =>
                app.navigate("records", {
                  hint: "在记录列表点击某条记录，进入详情后点「导入为路线」",
                }),
            }),
          ].filter(Boolean),
        ),
      ]),
    );

    function openRouteEditor() {
      const editor = RouteEditor(app, {
        onSaved: async () => {
          await app.refresh();
          schedulePreview();
        },
      });
      editor.mount();
    }
  }

  return { renderRoute };
}
