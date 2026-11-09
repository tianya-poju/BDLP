import { verifyCheckpointPreview } from "./checkpoint-preview.js";
import { prepareRun } from "./run-plan.js";
import { previewRoute, simulateSensor } from "./preview-core.js";
self.onmessage = ({ data }) => {
  try {
    const value =
      data.kind === "checkpoints"
        ? verifyCheckpointPreview(...data.args)
        : data.kind === "run"
          ? prepareRun(...data.args)
          : data.kind === "route"
            ? previewRoute(...data.args)
            : simulateSensor(...data.args);
    self.postMessage({ value });
  } catch (e) {
    self.postMessage({ error: e.message || "本地预览失败" });
  }
};
