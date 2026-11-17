/* Accounts: pairing, health, warm-up stage, daily caps, state changes. */
const { now, DAY, HOUR, j, lc, clamp, HttpError } = require("./util");
const tzlib = require("./tz");

const WARM_DAYS = { new: 10, young: 6, established: 3 };
const EVENT_WEIGHT = { action_blocked: 40, checkpoint: 55, login_required: 3, selector_error: 1 };
const HARD_MAX_CAP = 40;

function createAccounts(ctx) {
  const { db, cfg, auth } = ctx;

  const byId = (id) => db.get("SELECT * FROM accounts WHERE id = ?", id);
  const byToken = (token) => (token ? db.get("SELECT * FROM accounts WHERE token_hash = ?", auth.hashToken(token)) : null);
  const clientFor = (a) => (a && a.client_id ? db.get("SELECT * FROM clients WHERE id = ?", a.client_id) : null);
  const defaults = () => { const w = db.setting("default_window", {}); return { tz: w.tz || cfg.defaultTz, send_start: w.start ?? 9, send_end: w.end ?? 20, daily_cap: 20 }; };
  const rulesFor = (a) => ({ ...defaults(), ...(clientFor(a) || {}) });

  function create({ kind, label, igUsername, clientId, igAge }) {
    if (!["sender", "finder"].includes(kind)) throw new HttpError(400, "Account kind must be sender or finder.");
    const user = lc(igUsername).replace(/^@/, "");
    if (!/^[a-z0-9._]{1,30}$/.test(user)) throw new HttpError(400, "Enter the Instagram username without spaces.");
    if (kind === "sender") {
      if (!clientId || !db.get("SELECT id FROM clients WHERE id = ?", clientId)) throw new HttpError(400, "A sender account needs a client.");
    }
    if (!WARM_DAYS[igAge || "young"]) throw new HttpError(400, "Account age must be new, young or established.");
    const token = auth.newToken();
    const r = db.run(`INSERT INTO accounts(kind, label, client_id, ig_username, token_hash, ig_age, warm_started_at, created_at) VALUES(?,?,?,?,?,?,?,?)`,
      kind, String(label || user).slice(0, 80), kind === "sender" ? clientId : null, user, auth.hashToken(token), igAge || "young", now(), now());
    return { account: byId(r.id), token };
  }
  function rotateToken(id) {
    const token = auth.newToken();
    db.run("UPDATE accounts SET token_hash = ? WHERE id = ?", auth.hashToken(token), id);
    return { account: byId(id), token };
  }
  function pairingCode(account, token, baseUrl) {
    const s = cfg.publicUrl || baseUrl;
    return "me1." + Buffer.from(JSON.stringify({ s, t: token, m: account.kind })).toString("base64url");
  }

  function health(a) {
    let score = 100; const t = now();
    for (const e of db.all("SELECT kind, at FROM events WHERE account_id = ? AND at > ?", a.id, t - 30 * DAY)) {
      const decay = Math.max(0, 1 - (t - e.at) / (14 * DAY));
      score -= (EVENT_WEIGHT[e.kind] || 0) * decay;
    }
    score = clamp(Math.round(score), 0, 100);
    return { score, level: score >= 70 ? "healthy" : score >= 40 ? "caution" : "risky" };
  }
  function warm(a, ts = now()) {
    const total = WARM_DAYS[a.ig_age] || 6, day = Math.floor((ts - a.warm_started_at) / DAY) + 1;
    return { stage: day > total ? "active" : "warming", day: Math.min(day, total), totalDays: total };
  }
  function effectiveState(a) {
    if (a.state === "cooldown" && a.cooldown_until <= now()) {
      db.run("UPDATE accounts SET state = 'active', reason = '', cooldown_until = 0 WHERE id = ?", a.id);
      a.state = "active"; a.reason = ""; a.cooldown_until = 0;
    }
    if (a.state !== "active") return { state: a.state, reason: a.reason || ({ paused: "Paused in the dashboard.", killed: "Switched off in the dashboard.", restricted: "Instagram restricted this account. Reset it in the dashboard once it is sorted out.", cooldown: "Resting after a warning." }[a.state] || "") };
    if (a.last_mode && a.last_mode !== a.kind && a.last_seen_at && now() - a.last_seen_at < 10 * 60_000)
      return { state: "paused", reason: `This is a ${a.kind} account but the extension is in ${a.last_mode} mode. Change the mode in the extension's Settings.` };
    return { state: "active", reason: "" };
  }
  const sentToday = (a) => {
    const r = rulesFor(a), start = tzlib.startOfDay(now(), r.tz);
    return db.get(`SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type IN ('dm','followup') AND status = 'done' AND result_code = 'sent' AND done_at >= ?`, a.id, start).n;
  };
  function capToday(a) {
    if (a.kind !== "sender") return 0;
    const w = warm(a); if (w.stage !== "active") return 0;
    const base = Math.min(a.daily_cap_override ?? rulesFor(a).daily_cap, HARD_MAX_CAP);
    const activeDays = Math.max(0, Math.floor((now() - (a.warm_started_at + w.totalDays * DAY)) / DAY));
    const ramp = activeDays < 3 ? 5 : activeDays < 7 ? 10 : activeDays < 14 ? 15 : HARD_MAX_CAP;
    const factor = { healthy: 1, caution: 0.5, risky: 0 }[health(a).level];
    return Math.floor(Math.min(base, ramp) * factor);
  }
  function profilesPerDay(a) {
    const factor = { healthy: 1, caution: 0.5, risky: 0.25 }[health(a).level];
    const recentBlock = db.get("SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND kind = 'action_blocked' AND at > ?", a.id, now() - 7 * DAY).n > 0;
    return Math.max(5, Math.floor(Math.min(a.profiles_per_day, recentBlock ? 20 : 999) * factor));
  }

  function recordEvent(a, kind, detail = "") {
    db.run("INSERT INTO events(account_id, kind, detail, at) VALUES(?,?,?,?)", a.id, kind, String(detail).slice(0, 300), now());
    if (kind === "action_blocked") db.run("UPDATE accounts SET state = 'cooldown', cooldown_until = ?, reason = ? WHERE id = ?", now() + 48 * HOUR, "Instagram showed an action block. Resting for 48 hours.", a.id);
    if (kind === "checkpoint") db.run("UPDATE accounts SET state = 'restricted', reason = ? WHERE id = ?", "Instagram asked for a security check. Complete it by hand, then reset this account in the dashboard.", a.id);
  }
  function act(id, action) {
    const a = byId(id); if (!a) throw new HttpError(404, "Account not found.");
    const set = (state, reason, cd = 0) => db.run("UPDATE accounts SET state = ?, reason = ?, cooldown_until = ? WHERE id = ?", state, reason, cd, id);
    if (action === "pause") set("paused", "Paused in the dashboard.");
    else if (action === "resume" || action === "reset") set("active", "");
    else if (action === "kill") set("killed", "Switched off in the dashboard.");
    else throw new HttpError(400, "Unknown action.");
    db.run("INSERT INTO events(account_id, kind, detail, at) VALUES(?,?,?,?)", id, "dashboard_" + action, "", now());
    return byId(id);
  }
  /* Finder replacement: switch the old account off and make a new one with the same settings. */
  function replaceFinder(id, { igUsername, label, igAge }) {
    const old = byId(id); if (!old || old.kind !== "finder") throw new HttpError(400, "Only finder accounts can be replaced.");
    const made = create({ kind: "finder", label: label || old.label + " (new)", igUsername, igAge: igAge || "new" });
    db.run("UPDATE accounts SET profiles_per_day = ? WHERE id = ?", old.profiles_per_day, made.account.id);
    db.run("UPDATE accounts SET state = 'killed', reason = 'Replaced by a new finder account.', replaced_by = ? WHERE id = ?", made.account.id, old.id);
    return made;
  }

  function config(a) {
    const st = effectiveState(a), w = warm(a), h = health(a);
    return {
      state: st.state, reason: st.reason, expectedUsername: a.ig_username, warm: { stage: w.stage, day: w.day },
      sentToday: a.kind === "sender" ? sentToday(a) : 0, capToday: capToday(a), health: h,
      selectors: db.setting("selectors", undefined), blockPhrases: db.setting("block_phrases", undefined)
    };
  }
  const summary = (a) => {
    const w = warm(a), h = health(a), st = effectiveState(a), c = clientFor(a);
    return { id: a.id, kind: a.kind, label: a.label, igUsername: a.ig_username, clientId: a.client_id, clientName: c ? c.name : "", igAge: a.ig_age,
      state: st.state, reason: st.reason, warm: w, health: h, lastSeenAt: a.last_seen_at, lastVersion: a.last_version, lastMode: a.last_mode,
      loggedInAs: a.logged_in_as, sentToday: a.kind === "sender" ? sentToday(a) : 0, capToday: capToday(a),
      profilesPerDay: a.kind === "finder" ? profilesPerDay(a) : null, profilesPerDaySetting: a.profiles_per_day, dailyCapOverride: a.daily_cap_override,
      replacedBy: a.replaced_by, createdAt: a.created_at };
  };
  return { WARM_DAYS, byId, byToken, clientFor, rulesFor, create, rotateToken, pairingCode, health, warm, effectiveState, sentToday, capToday, profilesPerDay, recordEvent, act, replaceFinder, config, summary };
}
module.exports = { createAccounts, WARM_DAYS };
