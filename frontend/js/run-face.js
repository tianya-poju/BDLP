// Recovered pure helper from supplied 1.2.0.

function middleDistances(faceConfig, minDistanceKm, actualDistanceKm = 0) {
  if (Number(faceConfig.middle_status || 0) !== 1) return [];
  const num = Number(faceConfig.middle_num || 1);
  if (num <= 0) return [];
  const startM = Math.max(Number(faceConfig.middle_distance || 0), 0);
  let endM;
  if (minDistanceKm > 0) endM = minDistanceKm * 1e3;
  else if (actualDistanceKm > 0) endM = actualDistanceKm * 1e3;
  else return [];
  if (startM > endM) return [];
  const span = endM - startM;
  if (num === 1) {
    const bound = Math.max(Math.trunc(span + 1), 1);
    return [Math.floor(Math.random() * bound) + startM];
  }
  const seg = span / num;
  const margin = 0.1 * seg;
  const out = [];
  for (let i = 0; i < num; i += 1) {
    let lo = i * seg + startM;
    let hi = (i + 1) * seg + startM;
    if (hi - margin > lo + margin) {
      lo += margin;
      hi -= margin;
    }
    let range = Math.trunc(hi - lo);
    if (range <= 0) range = 1;
    out.push(lo + Math.floor(Math.random() * range));
  }
  return out.sort((a, b) => a - b);
}
function toRouteIndices(distances, cumDist) {
  if (!distances || distances.length === 0 || !cumDist || cumDist.length === 0)
    return [];
  let cursor = 0;
  return distances.map((d) => {
    while (cursor < cumDist.length - 1 && cumDist[cursor] < d) cursor += 1;
    return cursor;
  });
}
function parseFaceInfo(resp) {
  const data = resp && resp.data;
  if (!data) return null;
  const status = Number(resp.status);
  if (status === 2)
    return {
      notOpened: true,
      hasFace: false,
      statusText: "\u8BE5\u6821\u672A\u5F00\u901A\u4EBA\u8138\u6CE8\u518C",
    };
  if (status !== 1) return null;
  const keys = [
    "student_face_url",
    "face_url",
    "face_img",
    "face_img_url",
    "student_face",
    "face_pic",
    "img",
    "url",
    "picture",
  ];
  let url = "";
  for (const k of keys) {
    if (data[k]) {
      url = String(data[k]);
      break;
    }
  }
  const faceStatus =
    data.student_face_status != null ? Number(data.student_face_status) : -1;
  const isRegister = data.is_register != null ? Number(data.is_register) : -1;
  const hasFace = url !== "" || isRegister === 1 || faceStatus >= 0;
  let statusText;
  if (!hasFace) statusText = "\u672A\u5F55\u5165";
  else if (faceStatus === 1)
    statusText = "\u5DF2\u5F55\u5165 \xB7 \u6B63\u5E38";
  else if (faceStatus === 0)
    statusText = "\u5DF2\u5F55\u5165 \xB7 \u5F85\u5BA1\u6838";
  else if (faceStatus === 2)
    statusText = "\u5DF2\u5F55\u5165 \xB7 \u5DF2\u6293\u62CD";
  else statusText = "\u5DF2\u5F55\u5165";
  return {
    faceUrl: url,
    studentName: String(data.student_name || ""),
    studentNum: String(data.student_num || ""),
    faceStatus,
    updateTime: String(data.update_time || ""),
    canEdit: data.canEdit == null ? true : Boolean(data.canEdit),
    notOpened: false,
    hasFace,
    statusText,
  };
}
export const Face = { middleDistances, toRouteIndices, parseFaceInfo };
