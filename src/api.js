/* Dashboard API (cookie session). Everything returns JSON except the report. */
const { now, DAY, j, lc, str, num, clamp, HttpError } = require("./util");
const { validTz } = require("./tz");
const { DEFAULT_OPENER } = require("./leads");

const DEFAULT_FOLLOWUPS = [
  { afterDays: 2, text: "Hey {first_name}, just bumping this in case it got buried. No pressure at all!" },
  { afterDays: 5, text: "Last one from me, {first_name}. If now isn't the right time, no worries. Wishing you a great week!" }
];

function registerApi(router, ctx) {
  const { db, cfg, accounts, leads, finder, haiku, auth, jobs } = ctx;
  const base = (req) => cfg.publicUrl || `${req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").startsWith("https") ? "https" : "http"}://${req.headers.host}`;

  /* ---------- clients ---------- */
  const clientOut = (r) => ({ id: r.id, name: r.name, tz: r.tz, offer: r.offer, tone: r.tone, bookingLink: r.booking_link, openerTemplate: r.opener_template || DEFAULT_OPENER,
    followups: j(r.followups, []), autoReply: !!r.auto_reply, autoApprovePass: !!r.auto_approve_pass, autoRejectNo: !!r.auto_reject_no, dailyCap: r.daily_cap,
    sendStart: r.send_start, sendEnd: r.send_end, active: !!r.active,
    pending: db.get("SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND review = 'pending'", r.id).n,
    accounts: db.get("SELECT COUNT(*) AS n FROM accounts WHERE client_id = ?", r.id).n });
  function parseClient(b, partial) {
    const o = {}, has = (k) => b[k] !== undefined;
    if (!partial || has("name")) { o.name = str(b.name, 80).trim(); if (!o.name) throw new HttpError(400, "Give the client a name."); }
    if (has("tz")) { if (!validTz(b.tz)) throw new HttpError(400, "That time zone is not recognised. Use a name like America/Toronto."); o.tz = b.tz; }
    if (has("offer")) o.offer = str(b.offer, 800).trim();
    if (has("tone")) o.tone = str(b.tone, 200).trim() || "friendly, short, casual";
    if (has("bookingLink")) {
      const v = str(b.bookingLink, 300).trim();
      if (v) { let u; try { u = new URL(v); } catch { throw new HttpError(400, "The booking link must be a full web address."); } if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "The booking link must start with http or https."); }
      o.booking_link = v;
    }
    if (has("openerTemplate")) o.opener_template = str(b.openerTemplate, 400).trim();
    if (has("followups")) {
      if (!Array.isArray(b.followups) || b.followups.length > 6) throw new HttpError(400, "Use up to 6 follow-ups.");
      o.followups = JSON.stringify(b.followups.map((f) => ({ afterDays: clamp(num(f.afterDays, 3), 0.25, 30), text: str(f.text, 500).trim() })));
    }
    for (const [k, col] of [["autoReply", "auto_reply"], ["autoApprovePass", "auto_approve_pass"], ["autoRejectNo", "auto_reject_no"], ["active", "active"]]) if (has(k)) o[col] = b[k] ? 1 : 0;
    if (has("dailyCap")) o.daily_cap = clamp(Math.round(num(b.dailyCap, 20)), 1, 40);
    if (has("sendStart")) o.send_start = clamp(Math.round(num(b.sendStart, 9)), 0, 23);
    if (has("sendEnd")) o.send_end = clamp(Math.round(num(b.sendEnd, 20)), 1, 24);
    return o;
  }
  const insert = (table, o) => { const k = Object.keys(o); return db.run(`INSERT INTO ${table}(${k.join(",")}) VALUES(${k.map(() => "?").join(",")})`, ...k.map((x) => o[x])); };
  const patch = (table, id, o) => { const k = Object.keys(o); if (k.length) db.run(`UPDATE ${table} SET ${k.map((x) => x + " = ?").join(", ")} WHERE id = ?`, ...k.map((x) => o[x]), id); };

  router.get("/api/clients", () => ({ clients: db.all("SELECT * FROM clients ORDER BY name").map(clientOut) }));
  router.post("/api/clients", ({ body }) => {
    const o = parseClient(body, false);
    const c = { tz: cfg.defaultTz, followups: JSON.stringify(DEFAULT_FOLLOWUPS), opener_template: DEFAULT_OPENER, ...o, created_at: now() };
    return clientOut(db.get("SELECT * FROM clients WHERE id = ?", insert("clients", c).id));
  });
  router.patch("/api/clients/:id", ({ params, body }) => {
    if (!db.get("SELECT id FROM clients WHERE id = ?", params.id)) throw new HttpError(404, "Client not found.");
    const o = parseClient(body, true);
    const cur = db.get("SELECT * FROM clients WHERE id = ?", params.id);
    if ((o.send_end ?? cur.send_end) <= (o.send_start ?? cur.send_start)) throw new HttpError(400, "Sending must end after it starts.");
    patch("clients", params.id, o);
    return clientOut(db.get("SELECT * FROM clients WHERE id = ?", params.id));
  });
  router.del("/api/clients/:id", ({ params }) => {
    if (db.get("SELECT 1 AS x FROM leads WHERE client_id = ?", params.id) || db.get("SELECT 1 AS x FROM accounts WHERE client_id = ?", params.id)) throw new HttpError(409, "This client has leads or accounts. Switch them off instead of deleting.");
    db.run("DELETE FROM sources WHERE lead_type_id IN (SELECT id FROM lead_types WHERE client_id = ?)", params.id);
    db.run("DELETE FROM lead_types WHERE client_id = ?", params.id); db.run("DELETE FROM clients WHERE id = ?", params.id);
    return { ok: true };
  });

  /* ---------- accounts ---------- */
  router.get("/api/accounts", () => ({ accounts: db.all("SELECT * FROM accounts ORDER BY kind, id").map(accounts.summary) }));
  router.post("/api/accounts", ({ req, body }) => {
    const made = accounts.create({ kind: body.kind, label: body.label, igUsername: body.igUsername, clientId: num(body.clientId), igAge: body.igAge });
    if (made.account.kind === "finder" && body.profilesPerDay !== undefined) db.run("UPDATE accounts SET profiles_per_day = ? WHERE id = ?", clamp(Math.round(num(body.profilesPerDay, 40)), 5, 60), made.account.id);
    return { account: accounts.summary(accounts.byId(made.account.id)), pairingCode: accounts.pairingCode(made.account, made.token, base(req)) };
  });
  router.patch("/api/accounts/:id", ({ params, body }) => {
    const a = accounts.byId(params.id); if (!a) throw new HttpError(404, "Account not found.");
    if (body.action) accounts.act(a.id, body.action);
    const o = {};
    if (body.label !== undefined) o.label = str(body.label, 80);
    if (body.profilesPerDay !== undefined) o.profiles_per_day = clamp(Math.round(num(body.profilesPerDay, 40)), 5, 60);
    if (body.dailyCapOverride !== undefined) o.daily_cap_override = body.dailyCapOverride === null || body.dailyCapOverride === "" ? null : clamp(Math.round(num(body.dailyCapOverride, 20)), 0, 40);
    if (body.igAge !== undefined) { if (!accounts.WARM_DAYS[body.igAge]) throw new HttpError(400, "Account age must be new, young or established."); o.ig_age = body.igAge; }
    patch("accounts", a.id, o);
    return accounts.summary(accounts.byId(a.id));
  });
  router.post("/api/accounts/:id/rotate", ({ req, params }) => {
    if (!accounts.byId(params.id)) throw new HttpError(404, "Account not found.");
    const r = accounts.rotateToken(params.id);
    return { pairingCode: accounts.pairingCode(r.account, r.token, base(req)) };
  });
  router.post("/api/accounts/:id/replace", ({ req, params, body }) => {
    const r = accounts.replaceFinder(+params.id, { igUsername: body.igUsername, label: body.label, igAge: body.igAge });
    return { account: accounts.summary(accounts.byId(r.account.id)), pairingCode: accounts.pairingCode(r.account, r.token, base(req)) };
  });
  router.get("/api/accounts/:id/events", ({ params }) => ({ events: db.all("SELECT kind, detail, at FROM events WHERE account_id = ? ORDER BY at DESC LIMIT 40", params.id) }));

  /* ---------- lead types and sources ---------- */
  router.get("/api/lead-types", ({ query }) => ({ leadTypes: db.all(`SELECT * FROM lead_types ${query.get("clientId") ? "WHERE client_id = ?" : ""} ORDER BY id`, ...(query.get("clientId") ? [query.get("clientId")] : [])).map(finder.typeOut) }));
  router.post("/api/lead-types", ({ body }) => {
    if (!db.get("SELECT id FROM clients WHERE id = ?", num(body.clientId))) throw new HttpError(400, "Choose a client.");
    const o = { ...finder.parseType(body, false), client_id: num(body.clientId), created_at: now() };
    return finder.typeOut(db.get("SELECT * FROM lead_types WHERE id = ?", insert("lead_types", o).id));
  });
  router.patch("/api/lead-types/:id", ({ params, body }) => {
    if (!db.get("SELECT id FROM lead_types WHERE id = ?", params.id)) throw new HttpError(404, "Lead type not found.");
    patch("lead_types", params.id, finder.parseType(body, true));
    return finder.typeOut(db.get("SELECT * FROM lead_types WHERE id = ?", params.id));
  });
  router.del("/api/lead-types/:id", ({ params }) => {
    db.run("UPDATE leads SET lead_type_id = NULL WHERE lead_type_id = ?", params.id);
    db.run("UPDATE sources SET lead_type_id = NULL, enabled = 0, pause_reason = 'Lead type deleted' WHERE lead_type_id = ?", params.id);
    db.run("DELETE FROM lead_types WHERE id = ?", params.id);
    return { ok: true };
  });
  router.get("/api/lead-types/:id/suggestions", ({ params }) => ({ excludeWords: finder.excludeSuggestions(+params.id) }));

  router.get("/api/sources", () => ({ sources: db.all("SELECT * FROM sources WHERE origin = 'server' ORDER BY id").map(finder.sourceOut) }));
  router.get("/api/sources/stats", () => ({ sources: finder.sourceStats() }));
  router.post("/api/sources", ({ body }) => {
    const o = { ...finder.parseSource(body, false), origin: "server", created_at: now() };
    if (db.get("SELECT 1 AS x FROM sources WHERE lead_type_id = ? AND kind = ? AND ref = ? AND mode = ? AND origin = 'server'", o.lead_type_id, o.kind, o.ref, o.mode)) throw new HttpError(409, "That source is already in the list.");
    return finder.sourceOut(db.get("SELECT * FROM sources WHERE id = ?", insert("sources", o).id));
  });
  router.patch("/api/sources/:id", ({ params, body }) => {
    if (!db.get("SELECT id FROM sources WHERE id = ?", params.id)) throw new HttpError(404, "Source not found.");
    patch("sources", params.id, finder.parseSource(body, true));
    return finder.sourceOut(db.get("SELECT * FROM sources WHERE id = ?", params.id));
  });
  router.del("/api/sources/:id", ({ params }) => { db.run("UPDATE leads SET source_id = NULL WHERE source_id = ?", params.id); db.run("DELETE FROM sources WHERE id = ?", params.id); return { ok: true }; });

  /* ---------- leads ---------- */
  router.get("/api/leads", ({ query }) => leads.list({ clientId: query.get("clientId") || undefined, review: query.get("review") || undefined, stage: query.get("stage") || undefined,
    q: query.get("q") || undefined, limit: num(query.get("limit"), 100), offset: num(query.get("offset"), 0) }));
  router.get("/api/leads/:id", ({ params }) => { const l = leads.must(params.id); return { lead: leads.leadOut(l), messages: leads.messagesFor(l.id) }; });
  router.post("/api/leads/:id/approve", ({ params, body }) => ({ lead: leads.leadOut(leads.approve(+params.id, { clientId: body.clientId, opener: body.opener })) }));
  router.post("/api/leads/:id/reject", ({ params, body }) => ({ lead: leads.leadOut(leads.reject(+params.id, body.reason)) }));
  router.patch("/api/leads/:id", ({ params, body }) => ({ lead: leads.leadOut(leads.update(+params.id, body)) }));
  router.post("/api/leads/:id/opener", ({ params }) => { const l = leads.must(params.id); leads.touch(l.id, { opener_edited: 0 }); jobs.add(() => leads.makeOpener(l.id), "opener"); return { ok: true, queued: haiku.enabled() }; });
  router.post("/api/leads/bulk", ({ body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 200), done = [], failed = [];
    for (const id of ids) {
      try { if (body.action === "approve") leads.approve(+id, { clientId: body.clientId }); else if (body.action === "reject") leads.reject(+id, body.reason); else throw new HttpError(400, "Unknown action."); done.push(id); }
      catch (e) { failed.push({ id, error: e.message }); }
    }
    return { done, failed };
  });

  /* ---------- replies waiting for a person ---------- */
  router.get("/api/replies", () => {
    const rows = db.all(`SELECT t.id, t.text, t.lead_id, t.inbound_at, t.created_at, l.username, l.name, l.stage, l.client_id FROM tasks t JOIN leads l ON l.id = t.lead_id WHERE t.type = 'reply' AND t.status = 'draft' ORDER BY t.created_at`);
    return { replies: rows.map((r) => ({ taskId: r.id, leadId: r.lead_id, username: r.username, name: r.name, stage: r.stage, draft: r.text, inboundAt: r.inbound_at,
      conversation: leads.messagesFor(r.lead_id).slice(-8) })),
      needsHuman: db.all(`SELECT * FROM leads WHERE needs_human = 1 AND id NOT IN (SELECT lead_id FROM tasks WHERE type = 'reply' AND status = 'draft' AND lead_id IS NOT NULL) ORDER BY updated_at DESC LIMIT 50`).map(leads.leadOut) };
  });
  router.post("/api/tasks/:id/approve", ({ params, body }) => {
    const t = db.get("SELECT * FROM tasks WHERE id = ? AND type = 'reply' AND status = 'draft'", params.id); if (!t) throw new HttpError(404, "That reply is no longer waiting.");
    const l = leads.must(t.lead_id), text = leads.cleanText(body.text !== undefined ? body.text : t.text, db.get("SELECT * FROM clients WHERE id = ?", l.client_id), true);
    if (!text) throw new HttpError(400, "Write the reply first.");
    db.run("UPDATE tasks SET text = ?, status = 'pending', not_before = ? WHERE id = ?", text, now(), t.id);
    leads.touch(l.id, { needs_human: 0 });
    return { ok: true };
  });
  router.post("/api/tasks/:id/discard", ({ params }) => {
    const t = db.get("SELECT * FROM tasks WHERE id = ? AND type = 'reply' AND status = 'draft'", params.id); if (!t) throw new HttpError(404, "That reply is no longer waiting.");
    db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE id = ?", now(), t.id); leads.touch(t.lead_id, { needs_human: 0 });
    return { ok: true };
  });

  /* ---------- overview, report, settings ---------- */
  router.get("/api/digest", ({ query }) => finder.digest({ clientId: num(query.get("clientId")), days: num(query.get("days"), 7) }));
  router.get("/api/report", ({ query }) => ({ __text: finder.report({ clientId: num(query.get("clientId")), days: num(query.get("days"), 7) }) }));
  router.get("/api/overview", ({ query }) => {
    const clientId = num(query.get("clientId")), days = num(query.get("days"), 7);
    const accs = db.all("SELECT * FROM accounts WHERE state != 'killed' OR replaced_by IS NULL ORDER BY kind, id").map(accounts.summary);
    const alerts = [];
    for (const a of accs) {
      if (a.state === "restricted") alerts.push({ level: "bad", text: `${a.label}: ${a.reason}`, to: "#/accounts" });
      else if (a.state === "cooldown") alerts.push({ level: "warn", text: `${a.label} is resting: ${a.reason}`, to: "#/accounts" });
      else if (a.state === "paused" && a.reason.startsWith("This is a")) alerts.push({ level: "warn", text: `${a.label}: ${a.reason}`, to: "#/accounts" });
      if (a.state === "active" && a.health.level === "risky") alerts.push({ level: "bad", text: `${a.label} has a risky health score (${a.health.score}). Its limits were cut.`, to: "#/accounts" });
      if (a.state === "active" && a.lastSeenAt && now() - a.lastSeenAt > 30 * 60_000) alerts.push({ level: "warn", text: `${a.label} has not checked in for ${Math.round((now() - a.lastSeenAt) / 60000)} minutes. Is its browser open?`, to: "#/accounts" });
      if (db.get("SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND kind = 'selector_error' AND at > ?", a.id, now() - DAY).n) alerts.push({ level: "warn", text: `${a.label} could not read Instagram's pages. The layout may have changed.`, to: "#/accounts" });
    }
    const d = finder.digest({ clientId, days });
    if (d.pendingReview) alerts.push({ level: "info", text: `${d.pendingReview} lead${d.pendingReview === 1 ? "" : "s"} waiting for your review.`, to: "#/review" });
    if (d.repliesWaiting) alerts.push({ level: "info", text: `${d.repliesWaiting} reply draft${d.repliesWaiting === 1 ? "" : "s"} waiting for approval.`, to: "#/replies" });
    const weak = finder.sourceStats().filter((s) => s.enabled && s.suggestion.startsWith("Pause")).length;
    if (weak) alerts.push({ level: "info", text: `${weak} source${weak === 1 ? " is" : "s are"} bringing mostly the wrong people.`, to: "#/finder" });
    if (!haiku.enabled()) alerts.push({ level: "warn", text: "Haiku is not connected (no ANTHROPIC_API_KEY). Borderline leads, openers and reply drafts will not be written for you.", to: "#/settings" });
    return { digest: d, accounts: accs, alerts, haiku: haiku.status() };
  });
  router.get("/api/settings", () => ({ skipList: db.setting("skip_list", []), exclusiveClaims: db.setting("exclusive_claims", true), autoPauseSources: db.setting("auto_pause_sources", false),
    selectors: db.setting("selectors", {}), blockPhrases: db.setting("block_phrases", []), defaultWindow: { start: 9, end: 20, tz: cfg.defaultTz, ...db.setting("default_window", {}) },
    haiku: haiku.status(), jobErrors: jobs.errors.slice(0, 5) }));
  router.put("/api/settings", ({ body }) => {
    if (body.skipList !== undefined) {
      const list = [...new Set((Array.isArray(body.skipList) ? body.skipList : String(body.skipList).split(/[\s,;]+/)).map((x) => lc(x).replace(/^@/, "")).filter(Boolean))];
      const bad = list.find((x) => !/^[a-z0-9._]{1,30}$/.test(x)); if (bad) throw new HttpError(400, `"${bad}" is not a valid username.`);
      db.setSetting("skip_list", list.slice(0, 2000));
    }
    if (body.exclusiveClaims !== undefined) db.setSetting("exclusive_claims", !!body.exclusiveClaims);
    if (body.autoPauseSources !== undefined) db.setSetting("auto_pause_sources", !!body.autoPauseSources);
    if (body.selectors !== undefined) {
      const o = {}; for (const [k, v] of Object.entries(body.selectors || {})) if (/^[A-Za-z]{2,30}$/.test(k) && typeof v === "string" && v.length <= 200) o[k] = v;
      db.setSetting("selectors", o);
    }
    if (body.defaultWindow !== undefined) {
      const w = body.defaultWindow || {}, start = clamp(Math.round(num(w.start, 9)), 0, 23), end = clamp(Math.round(num(w.end, 20)), 1, 24);
      if (end <= start) throw new HttpError(400, "The window must end after it starts.");
      if (w.tz && !validTz(w.tz)) throw new HttpError(400, "That time zone is not recognised.");
      db.setSetting("default_window", { start, end, ...(w.tz ? { tz: w.tz } : {}) });
    }
    if (body.blockPhrases !== undefined) db.setSetting("block_phrases", (Array.isArray(body.blockPhrases) ? body.blockPhrases : []).map((x) => str(x, 120)).filter(Boolean).slice(0, 30));
    return { ok: true };
  });
}
module.exports = { registerApi };
