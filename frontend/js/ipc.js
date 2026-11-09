export async function invoke(cmd, args) {
  try {
    return await window.__TAURI__.core.invoke(cmd, args);
  } catch (raw) {
    const data =
      raw && typeof raw === "object" ? raw : { message: String(raw) };
    const error = new Error(data.message || "操作失败");
    error.kind = data.kind || "business";
    error.code = data.code;
    if (
      error.kind === "auth_expired" &&
      typeof window.dispatchEvent === "function"
    ) {
      window.dispatchEvent(
        new CustomEvent("account-expired", { detail: error }),
      );
    }
    throw error;
  }
}
