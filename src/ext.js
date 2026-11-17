/* Endpoints the Chrome extension calls. Auth: "Authorization: Bearer <account token>". */
const { now, str, num, HttpError, j } = require("./util");

const EVENT_KINDS = ["action_blocked", "checkpoint", "login_required", "selector_error"];

function registerExt(router, ctx) {
  const { db, accounts, scheduler, leads, finder, auth } = ctx;
  const authed = (handler) => async (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(c.req.headers.authorization || ""));
    const account = m ? accounts.byToken(m[1]) : null;
    if (!account) throw new HttpError(401, "Unknown or expired token. Pair the extension again.");
    if (account.state === "killed" && account.replaced_by) { /* still answer, state is reported as killed */ }
    db.run("UPDATE accounts SET last_seen_at = ? WHERE id = ?", now(), account.id);
    return handler({ ...c, account });
  };
  const senderOnly = (a) => { if (a.kind !== "sender") throw new HttpError(403, "This is a finder account."); };
  const finderOnly = (a) => { if (a.kind !== "finder") throw new HttpError(403, "This is a sender account."); };

  router.get("/ext/config", authed(({ account }) => accounts.config(account)));

  router.post("/ext/heartbeat", authed(({ account, body }) => {
    db.run("UPDATE accounts SET last_version = ?, logged_in_as = ?, last_mode = ? WHERE id = ?", str(body.version, 20), str(body.loggedInAs, 40),
      ["sender", "finder"].includes(body.mode) ? body.mode : null, account.id);
    return { ok: true };
  }));

  router.post("/ext/event", authed(({ account, body }) => {
    if (!EVENT_KINDS.includes(body.kind)) throw new HttpError(400, "Unknown event.");
    accounts.recordEvent(account, body.kind, body.detail);
    return { ok: true };
  }));

  router.get("/ext/tasks/next", authed(({ account, query }) => {
    const exclude = String(query.get("exclude") || "").split(",").map(Number).filter(Number.isFinite);
    return scheduler.nextTask(account, exclude);
  }));
  router.post("/ext/tasks/result", authed(({ account, body }) => scheduler.result(account, body)));

  router.post("/ext/inbox/sync", authed(({ account, body }) => {
    senderOnly(account);
    return { newInbound: leads.processInbox(account, body.threads) };
  }));

  router.get("/ext/leads", authed(({ account, query }) => {
    senderOnly(account);
    const limit = Math.min(500, num(query.get("limit"), 300));
    const client = accounts.clientFor(account), seqLen = client ? j(client.followups, []).length : 0;
    const rows = db.all("SELECT * FROM leads WHERE client_id = ? AND review = 'approved' ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ?", account.client_id, limit);
    return { leads: rows.map((l) => ({ username: l.username, name: l.name, customerType: l.lead_type_name, stage: l.stage,
      nextFollowUpAt: l.next_follow_at || null, lastActivityAt: l.last_activity_at || null, followUpStep: l.follow_step, followUpTotal: l.no_followup ? 0 : seqLen })) };
  }));

  router.post("/ext/leads/ingest", authed(({ account, body }) => { finderOnly(account); return leads.ingest(account, body); }));
  router.get("/ext/finder/plan", authed(({ account }) => { finderOnly(account); return finder.plan(account); }));
}
module.exports = { registerExt };
