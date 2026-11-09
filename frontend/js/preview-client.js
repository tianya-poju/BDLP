const pending = new Map();
export function cancelPreviews() {
  for (const [kind, item] of [...pending.entries()])
    if (kind !== "run") item.cancel();
}
export function calculatePreview(kind, ...args) {
  pending.get(kind)?.cancel();
  return new Promise((resolve, reject) => {
    let worker,
      timer,
      finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker?.terminate();
      pending.delete(kind);
      error ? reject(error) : resolve(value);
    };
    try {
      worker = new Worker(new URL("./preview-worker.js", import.meta.url), {
        type: "module",
      });
      pending.set(kind, { cancel: () => finish(Error("预览已取消")) });
      timer = setTimeout(
        () => finish(Error("预览计算超时，请减少路线点数")),
        kind === "run" ? 60000 : 10000,
      );
      worker.onmessage = ({ data }) =>
        finish(data.error ? Error(data.error) : null, data.value);
      worker.onerror = () => finish(Error("无法启动本地预览计算"));
      worker.postMessage({ kind, args });
    } catch (e) {
      finish(e);
    }
  });
}
