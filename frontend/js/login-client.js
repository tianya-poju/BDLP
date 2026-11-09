import { invoke } from "./ipc.js";
export function createLoginClient(
  call = invoke,
  newId = () => crypto.randomUUID(),
) {
  let current = null,
    queue = Promise.resolve(),
    revision = 0;
  async function cancel(owner) {
    if (owner !== undefined && current?.owner !== owner) return;
    const old = current;
    current = null;
    revision++;
    if (old) {
      await old.ready.catch(() => {});
      await call("login_cancel", { id: old.id }).catch(() => {});
    }
  }
  async function start(platform, owner) {
    const old = current;
    if (old) void cancel(old.owner);
    const item = { id: newId(), platform, owner, ready: null };
    current = item;
    revision++;
    item.ready = queue.then(() =>
      call("login_begin", { id: item.id, platform }),
    );
    queue = item.ready.catch(() => {});
    try {
      await item.ready;
      if (current !== item) {
        await call("login_cancel", { id: item.id }).catch(() => {});
        throw Error("登录已取消");
      }
      const response = await call(
        platform === "qq" ? "qq_login_start" : "wechat_login_start",
        { attemptId: item.id },
      );
      if (current !== item) {
        await call("login_cancel", { id: item.id }).catch(() => {});
        throw Error("登录已取消");
      }
      return { ...response, attemptId: item.id };
    } catch (error) {
      if (current === item) {
        current = null;
        revision++;
        await call("login_cancel", { id: item.id }).catch(() => {});
      }
      throw error;
    }
  }
  return {
    start,
    cancel,
    revision: () => revision,
    finish(payload) {
      if (!current || current.id !== payload?.attemptId) return false;
      current = null;
      revision++;
      return true;
    },
  };
}
export const logins = createLoginClient();
