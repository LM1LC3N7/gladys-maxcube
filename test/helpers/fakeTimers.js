// -----------------------------------------------------------------------------
// Fake timers on a virtual clock: nothing fires by itself; `advance(ms)` moves
// the clock and runs every timer due on the way, in order. A timer's callback
// is started, not awaited: one that waits for a later timer (a timeout of the
// Cube) must not block the clock. A few turns of the event loop follow each
// one, so what it schedules on the way is seen. (From gladys-iskra, adapted.)
// -----------------------------------------------------------------------------

const turns = async (n) => {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const earliest = (target) => {
    let next;
    for (const [id, timer] of pending) {
      if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
    }
    return next;
  };
  async function advance(ms) {
    const target = clock.now + ms;
    for (let i = 0; i < 100_000; i += 1) {
      let next = earliest(target);
      if (!next) {
        await turns(4);
        next = earliest(target);
        if (!next) break;
      }
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      Promise.resolve()
        .then(() => next.timer.fn())
        .catch(() => {});
      await turns(4);
    }
    clock.now = Math.max(clock.now, target);
    await turns(4);
  }
  /** The delays of the pending timers from now, sorted. */
  const delays = () => [...pending.values()].map((t) => t.at - clock.now).sort((a, b) => a - b);
  return { clock, timers, pending, advance, delays };
}
