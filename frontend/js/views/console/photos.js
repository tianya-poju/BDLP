import { h } from "../../util.js";

import { createFaceSection } from "../../components.js";

export function createPhotos(app) {
  const faceSection = createFaceSection(app, {
    onChanged: () => app.refreshAside(),
  });
  const faceCard = h("div", { class: "card" }, [
    h("div", { class: "card-head" }, [
      h("h3", { text: "人脸验证照片" }),
      h("span", { class: "head-note", text: "" }),
    ]),
    h("div", { class: "card-body" }, [faceSection.el]),
  ]);

  return { el: faceCard, destroy: () => faceSection.destroy?.() };
}
