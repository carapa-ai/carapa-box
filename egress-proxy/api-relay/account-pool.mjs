// Chooses among several sign-in accounts that serve one provider route.
// A session keeps its account; a new session takes the account with quota left
// whose usage window resets soonest, and a session moves only when its account
// is exhausted. Nothing here reads or writes credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SESSION_HEADERS = ['session-id', 'session_id', 'x-claude-code-session-id'];
const SESSION_IDLE_MS = 24 * 3600_000;
const MAX_SESSIONS = 5000;
const SNAPSHOT_TTL_MS = 15_000;
// A full window without a known reset time is checked again after this long.
const UNKNOWN_RESET_MS = 5 * 60_000;

/** The session a request belongs to: the CLI's own session id, else its sandbox. */
export function requestSession(headers = {}, clientHostname = '') {
  for (const name of SESSION_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && /^[\w.:-]{8,128}$/.test(value)) return `${clientHostname}/${value}`;
  }
  return clientHostname || 'unknown';
}

/** When a refused request means the plan's allowance is used up, the time (ms)
 * it resets; null for an ordinary rate limit. */
export function quotaExhaustedUntil(provider, status, headers = {}, bodyText = '', now = Date.now()) {
  if (status !== 429) return null;
  if (provider === 'anthropic') {
    if (headers['anthropic-ratelimit-unified-status'] !== 'rejected') return null;
    const reset = Number(headers['anthropic-ratelimit-unified-reset']) * 1000;
    return reset > now ? reset : now + UNKNOWN_RESET_MS;
  }
  if (provider === 'codex') {
    let error;
    try { error = JSON.parse(bodyText)?.error; } catch { return null; }
    if (error?.type !== 'usage_limit_reached') return null;
    const reset = Number(error.resets_at) > 0 ? Number(error.resets_at) * 1000
      : Number(error.resets_in_seconds) > 0 ? now + Number(error.resets_in_seconds) * 1000 : 0;
    return reset > now ? reset : now + UNKNOWN_RESET_MS;
  }
  return null;
}

/** `directory` is the provider account store; Box records each account's usage
 * windows in its `quota/` folder. Without a directory every account looks unused. */
export function createAccountPool({ directory, now = Date.now, log = message => console.log(message) } = {}) {
  const sessionsFile = directory && path.join(directory, 'quota', 'sessions.json');
  const sessions = new Map(); // `${pool}|${session}` -> { file: credential basename, at }
  const exhausted = new Map(); // credential basename -> time it has quota again
  const snapshots = new Map(); // credential basename -> { at, windows }
  let saveTimer;

  try {
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')))) {
      if (typeof value?.file === 'string' && now() - value.at < SESSION_IDLE_MS) sessions.set(key, value);
    }
  } catch { /* None recorded yet. */ }

  // Sessions survive a relay reload, so a running conversation keeps its account.
  function save() {
    if (!sessionsFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      try {
        fs.mkdirSync(path.dirname(sessionsFile), { recursive: true, mode: 0o700 });
        const temporary = sessionsFile + '.' + crypto.randomUUID() + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
        fs.renameSync(temporary, sessionsFile);
      } catch { /* Stickiness then lasts only until the next reload. */ }
    }, 1000);
    saveTimer.unref?.();
  }

  function windows(name) {
    const cached = snapshots.get(name);
    if (cached && now() - cached.at < SNAPSHOT_TTL_MS) return cached.windows;
    let list = [];
    try {
      const recorded = JSON.parse(fs.readFileSync(path.join(directory, 'quota', name), 'utf8')).windows;
      if (Array.isArray(recorded)) list = recorded;
    } catch { /* No reading yet: treated as unused. */ }
    snapshots.set(name, { at: now(), windows: list });
    return list;
  }

  /** Until when the account is out of quota (0 when it has some), and its next reset. */
  function state(file) {
    const name = path.basename(file);
    let until = exhausted.get(name) > now() ? exhausted.get(name) : 0;
    let reset = Infinity;
    for (const w of directory ? windows(name) : []) {
      const resetsAt = Number(w?.resetsAt);
      const future = resetsAt > now();
      if (Number(w?.usedPercent) >= 100 && (future || !Number.isFinite(resetsAt))) until = Math.max(until, future ? resetsAt : now() + UNKNOWN_RESET_MS);
      // The longest window is the allowance that is lost when it resets.
      if (future) reset = reset === Infinity ? resetsAt : Math.max(reset, resetsAt);
    }
    return { file, until, reset };
  }

  /** The account for this session, never one in `skip`; null when none is left. */
  function choose(pool, files, session, skip = new Set()) {
    const key = `${pool}|${session}`;
    const previous = sessions.get(key);
    const states = files.filter(file => !skip.has(file)).map(state);
    if (!states.length) return null;
    const kept = previous && states.find(s => path.basename(s.file) === previous.file);
    const available = states.filter(s => !s.until);
    // Array.sort is stable: equal accounts keep the admin's order.
    const chosen = kept && !kept.until ? kept
      : available.length ? available.sort((a, b) => a.reset - b.reset)[0]
        : kept || states.sort((a, b) => a.until - b.until)[0];
    const name = path.basename(chosen.file);
    if (previous?.file !== name) {
      log(`[relay] ${pool}: session ${session} ${previous ? 'moved to' : 'uses'} account ${name.slice(0, 8)}` +
        (available.length ? '' : ' (every account is out of quota)'));
      save();
    }
    // Re-inserting moves the session last, so the cap below evicts the least recently used.
    sessions.delete(key);
    sessions.set(key, { file: name, at: now() });
    if (sessions.size > MAX_SESSIONS) {
      for (const [k, v] of sessions) if (now() - v.at > SESSION_IDLE_MS || sessions.size > MAX_SESSIONS) sessions.delete(k);
    }
    return chosen.file;
  }

  /** Records that the provider refused the account until `until`. */
  function markExhausted(file, until) {
    exhausted.set(path.basename(file), until);
  }

  /** Whether another account of the pool, outside `skip`, still has quota. */
  function hasAlternative(files, skip) {
    return files.some(file => !skip.has(file) && !state(file).until);
  }

  return { choose, markExhausted, hasAlternative };
}
