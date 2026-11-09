// Subscribe before opening: a fast page may finish before the command returns.
export function registrationClient({ open, listen, currentAccount, onStatus }) {
  let dead = false,
    pending = null,
    unlisten = null,
    id = null,
    account = null,
    events = [];
  const emit = (s) => {
    if (!dead && account === currentAccount()) onStatus(s.phase);
  };
  return {
    open() {
      if (pending) return pending;
      pending = (async () => {
        account = currentAccount();
        id = null;
        events = [];
        if (!unlisten)
          unlisten = await listen((e) => {
            const s = e.payload;
            if (!id) events.push(s);
            else if (s.id === id) emit(s);
          });
        if (dead) {
          unlisten?.();
          return;
        }
        emit({ phase: "creating" });
        try {
          const s = await open();
          if (dead || account !== currentAccount()) return;
          id = s.id;
          emit(s);
          for (const e of events) if (e.id === id) emit(e);
          events = [];
          return s;
        } catch (e) {
          emit({ phase: "failed" });
          throw e;
        }
      })().finally(() => (pending = null));
      return pending;
    },
    destroy() {
      dead = true;
      events = [];
      unlisten?.();
    },
  };
}
