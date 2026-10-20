// Scheduled agent runs: { id, name, enabled, prompt, workspace, mode, model, kind: 'interval'|'daily'|'once',
// everyMinutes, time: 'HH:MM', days: [0-6] (daily, optional), at: epoch ms (once), lastRun, newConversation }.
let timer = null;

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? { h, mi } : null;
}

/** Next due time (ms) for a schedule strictly after `after`, or null. */
function nextRun(s, after = Date.now()) {
  if (!s || s.enabled === false) return null;
  if (s.kind === 'once') {
    const at = Number(s.at);
    return at && !s.lastRun ? at : null;
  }
  if (s.kind === 'daily') {
    const hm = parseHM(s.time);
    if (!hm) return null;
    const days = Array.isArray(s.days) && s.days.length ? s.days.map(Number) : null;
    const d = new Date(after);
    for (let i = 0; i < 8; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hm.h, hm.mi, 0, 0);
      if (c.getTime() > after && (!days || days.includes(c.getDay()))) return c.getTime();
    }
    return null;
  }
  const every = Math.max(1, Number(s.everyMinutes) || 0) * 60000;
  if (!Number(s.everyMinutes)) return null;
  const base = Number(s.lastRun) || Number(s.createdAt) || after;
  let n = base + every;
  if (n <= after && !s.lastRun) n = after; // never ran: due now
  return n;
}

/** Schedules due at `now` (missed runs fire once, not repeatedly). */
function due(schedules, now = Date.now()) {
  return (schedules || []).filter((s) => {
    if (!s || s.enabled === false || !String(s.prompt || '').trim()) return false;
    const ref = Number(s.lastRun) || Number(s.createdAt) || now - 1;
    const n = nextRun(s, ref);
    return n !== null && n <= now;
  });
}

/**
 * start({ getSchedules, onDue(schedule), markRan(id, time), intervalMs })
 * onDue may be async; a schedule is marked as ran before onDue to avoid double firing.
 */
function start({ getSchedules, onDue, markRan, intervalMs = 30000 }) {
  stop();
  const tick = () => {
    let list;
    try {
      list = getSchedules() || [];
    } catch {
      return;
    }
    const now = Date.now();
    for (const s of due(list, now)) {
      try {
        markRan(s.id, now);
      } catch {}
      Promise.resolve()
        .then(() => onDue(s))
        .catch(() => {});
    }
  };
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, 5000).unref?.();
  return tick;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function describe(s) {
  if (s.kind === 'daily') return `매일 ${s.time}${Array.isArray(s.days) && s.days.length ? ' (' + s.days.map((d) => '일월화수목금토'[d]).join('') + ')' : ''}`;
  if (s.kind === 'once') return `1회 ${new Date(Number(s.at)).toLocaleString()}`;
  return `${s.everyMinutes}분마다`;
}

module.exports = { nextRun, due, start, stop, describe, parseHM };
