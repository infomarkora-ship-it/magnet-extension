/* End-to-end tests: real HTTP server, in-memory database, fake Anthropic API, fake website. */
const http = require("node:http");
const { createApp } = require("../src/server");
const { fetchPage, isPrivateIp } = require("../src/enrich");

let bad = 0, total = 0;
const eq = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); };
const yes = (name, v) => eq(name, !!v, true);
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); });

(async () => {
  /* ---- fakes ---- */
  const claudeCalls = [];
  const claude = await listen((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const b = JSON.parse(raw); claudeCalls.push({ key: req.headers["x-api-key"], model: b.model, system: b.system, user: b.messages[0].content });
      const sys = b.system, user = b.messages[0].content; let out;
      if (/decide whether one Instagram profile/.test(sys)) out = /agency/i.test(user) ? { fit: "no", score: 5, reason: "Marketing agency, not a contractor" } : { fit: "maybe", score: 62, reason: "Plumber, location unclear" };
      else if (/first Instagram DM/.test(sys)) out = { opener: "Loved your recent roof post, Joe! Taking on new jobs? https://spam.example/x" };
      else if (/draft the next Instagram DM reply/.test(sys)) {
        const last = ([...user.matchAll(/THEM: ([^\n]*)/g)].pop() || [])[1] || "";
        if (/bot|real person/i.test(last)) out = { intent: "question", reply: "Yes, a real person here.", handoff: true };
        else if (/stop/i.test(last)) out = { intent: "stop", reply: "", handoff: false };
        else if (/how much/i.test(last)) out = { intent: "question", reply: "It depends on the job. Want a quick call? https://book.example/call or https://evil.example/phish", handoff: false };
        else out = { intent: "interested", reply: "Great! Want to grab a time?", handoff: false };
      } else out = {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "Here you go: " + JSON.stringify(out) }], usage: { input_tokens: 100, output_tokens: 30 } }));
    });
  });
  const site = await listen((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>Joe's Roofing</title><a href="mailto:joe@joesroofing.com">mail</a> Call (512) 555-0134 <a href="https://www.facebook.com/joesroofing">fb</a>`); });
  const sitePort = site.address().port;

  const app = createApp({ dbPath: ":memory:", adminPassword: "hunter2-pass", anthropicKey: "test-key", anthropicBase: `http://127.0.0.1:${claude.address().port}`, allowPrivateFetch: true, logger: { error() {} } });
  const port = await app.listen(0), U = `http://127.0.0.1:${port}`;
  const { db, ctx } = app;
  let cookie = "";
  const call = async (method, path, { body, token, headers = {} } = {}) => {
    const h = { ...(body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}), ...headers };
    if (cookie) h.cookie = cookie; if (token) h.authorization = "Bearer " + token;
    const r = await fetch(U + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const api = (m, p, b) => call(m, p, { body: b }), ext = (m, p, token, b) => call(m, p, { token, body: b });
  db.setSetting("default_window", { start: 0, end: 24 });

  /* ---- A. auth ---- */
  eq("A dashboard needs sign-in", (await api("GET", "/api/clients")).status, 401);
  eq("A wrong password", (await api("POST", "/api/login", { password: "nope" })).status, 401);
  const login = await api("POST", "/api/login", { password: "hunter2-pass" });
  eq("A right password", login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  yes("A cookie is HttpOnly + SameSite", /HttpOnly/.test(login.headers.get("set-cookie")) && /SameSite=Strict/.test(login.headers.get("set-cookie")));
  eq("A form posts are refused (CSRF)", (await fetch(U + "/api/clients", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" })).status, 415);
  eq("A extension without a token", (await ext("GET", "/ext/config")).status, 401);
  eq("A extension with a bad token", (await ext("GET", "/ext/config", "acc_nope")).status, 401);
  yes("A security headers", (await fetch(U + "/health")).headers.get("content-security-policy").includes("default-src 'self'"));
  for (let i = 0; i < 9; i++) await fetch(U + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) });
  eq("A login is throttled", (await fetch(U + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "hunter2-pass" }) })).status, 429);

  /* ---- B. setup ---- */
  const c1 = (await api("POST", "/api/clients", { name: "Acme Roofing", offer: "Free roof inspections and fair quotes.", bookingLink: "https://book.example/call", sendStart: 0, sendEnd: 24, tz: "America/Toronto" })).body;
  const c2 = (await api("POST", "/api/clients", { name: "Pipes Co", offer: "Plumbing repair", sendStart: 0, sendEnd: 24 })).body;
  eq("B client has default follow-ups", c1.followups.length, 2);
  eq("B bad time zone refused", (await api("POST", "/api/clients", { name: "x", tz: "Mars/Base" })).status, 400);
  eq("B bad booking link refused", (await api("PATCH", `/api/clients/${c1.id}`, { bookingLink: "javascript:alert(1)" })).status, 400);
  const lt1 = (await api("POST", "/api/lead-types", { clientId: c1.id, name: "Local contractors", description: "A local roofer taking jobs from homeowners.", include: "roof*\nshingle*", exclude: ["agency", "seo"], regions: ["Austin, TX", "Texas"], minFollowers: 100 })).body;
  const lt2 = (await api("POST", "/api/lead-types", { clientId: c2.id, name: "Plumbers", description: "A local plumber.", include: ["plumb*"] })).body;
  eq("B regions parsed", lt1.regions.map((r) => r.label), ["Austin, TX", "Texas"]);
  eq("B country-wide region refused", (await api("POST", "/api/lead-types", { clientId: c1.id, name: "x", regions: ["Canada"] })).status, 400);
  eq("B broad location refused", (await api("POST", "/api/sources", { leadTypeId: lt1.id, kind: "location", ref: "https://www.instagram.com/explore/locations/1/texas/" })).status, 400);
  const src1 = (await api("POST", "/api/sources", { leadTypeId: lt1.id, kind: "location", ref: "https://www.instagram.com/explore/locations/213163/austin-texas/" })).body;
  const src2 = (await api("POST", "/api/sources", { leadTypeId: lt1.id, kind: "hashtag", ref: "#RoofingAustin" })).body;
  eq("B source normalized", [src1.ref, src2.ref], ["213163/austin-texas", "#roofingaustin"]);
  eq("B duplicate source refused", (await api("POST", "/api/sources", { leadTypeId: lt1.id, kind: "hashtag", ref: "roofingaustin" })).status, 409);
  const fin = (await api("POST", "/api/accounts", { kind: "finder", label: "Finder 1", igUsername: "@finder_one", igAge: "new" })).body;
  const snd = (await api("POST", "/api/accounts", { kind: "sender", label: "Acme sender", igUsername: "acme_roofing", clientId: c1.id, igAge: "young" })).body;
  eq("B sender needs a client", (await api("POST", "/api/accounts", { kind: "sender", igUsername: "nobody" })).status, 400);
  const decode = (code) => JSON.parse(Buffer.from(code.slice(4), "base64url").toString());
  const finTok = decode(fin.pairingCode), sndTok = decode(snd.pairingCode);
  eq("B pairing code format", [fin.pairingCode.startsWith("me1."), finTok.m, sndTok.m, finTok.s], [true, "finder", "sender", U]);
  const F = finTok.t, S = sndTok.t;

  /* ---- C. finder plan ---- */
  const plan = (await ext("GET", "/ext/finder/plan", F)).body;
  eq("C plan lead types", plan.leadTypes.map((x) => [x.id, x.name]), [[`srv_lt_${lt1.id}`, "Local contractors"], [`srv_lt_${lt2.id}`, "Plumbers"]]);
  eq("C plan sources", plan.sources.map((x) => [x.id, x.kind, x.ref]), [[`srv_src_${src1.id}`, "location", "213163/austin-texas"], [`srv_src_${src2.id}`, "hashtag", "#roofingaustin"]]);
  yes("C plan skips our own accounts", plan.skipUsernames.includes("finder_one") && plan.skipUsernames.includes("acme_roofing"));
  eq("C plan regions in the extension's shape", plan.leadTypes[0].regions[0], { city: "Austin", state: "TX", label: "Austin, TX" });
  eq("C a sender cannot download the plan", (await ext("GET", "/ext/finder/plan", S)).status, 403);
  eq("C finder config", (({ state, warm, expectedUsername, health }) => ({ state, warm, expectedUsername, health }))((await ext("GET", "/ext/config", F)).body),
    { state: "active", warm: { stage: "warming", day: 1 }, expectedUsername: "finder_one", health: { score: 100, level: "healthy" } });
  eq("C sender cannot send while warming", (await ext("GET", "/ext/config", S)).body.capToday, 0);

  /* ---- D. warm-up scheduling ---- */
  let n1 = (await ext("GET", "/ext/tasks/next", F)).body;
  eq("D warm sessions are booked a little later, not instantly", n1.task, null);
  eq("D two warm sessions booked on day one", db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type = 'warm'", fin.account.id).n, 2);
  db.run("UPDATE tasks SET not_before = 0 WHERE type = 'warm'");
  n1 = (await ext("GET", "/ext/tasks/next", F)).body;
  eq("D warm task with the gentle style on day one", [n1.task.type, n1.task.payload.variant], ["warm", "gentle"]);
  eq("D warm result accepted", (await ext("POST", "/ext/tasks/result", F, { id: n1.task.id, ok: true, code: "sent", liked: 2 })).body.ok, true);
  eq("D a finder never gets messages to send", db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type != 'warm'", fin.account.id).n, 0);
  db.run("UPDATE accounts SET warm_started_at = ? WHERE id IN (?, ?)", Date.now() - 20 * 86400e3, fin.account.id, snd.account.id);
  eq("D warmed account reports active", (await ext("GET", "/ext/config", F)).body.warm.stage, "active");
  eq("D sender cap after warm-up", (await ext("GET", "/ext/config", S)).body.capToday, 20);

  /* ---- E. ingest ---- */
  const prof = (o) => ({ name: "Joe Smith", bio: "Roofing in Austin, TX", followers: 900, source: { id: `srv_src_${src1.id}`, kind: "location", ref: "213163/austin-texas" },
    leadType: { id: `srv_lt_${lt1.id}`, name: "Local contractors", description: "x", regions: ["Austin, TX"] }, verdict: "pass", score: 80, reasons: ["Profile mentions roofing"], ...o });
  const joe = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "Joes_Roofing", externalUrl: `http://127.0.0.1:${sitePort}/`, recentCaptions: ["New roof today"] }))).body;
  yes("E pass lead stored", joe.ok && joe.id);
  eq("E duplicate recognised", (await ext("POST", "/ext/leads/ingest", F, prof({ username: "joes_roofing" }))).body.duplicate, true);
  const ag = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "seo_agency_tx", name: "Best Agency", bio: "agency for roofers", verdict: "borderline", needsHaiku: true, reasons: ["Only their posts mention roofing"] }))).body;
  const maybe = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "plumb_dallas", name: "Dan", bio: "Plumbing", verdict: "borderline", needsHaiku: true, score: 40, leadType: { id: "lt_localid", name: "Plumbers", description: "x" } }))).body;
  const unassigned = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "mystery_biz", leadType: { id: "lt_other", name: "Something else", description: "A thing" }, verdict: "pass", score: 70, source: { id: "src_local1", kind: "hashtag", ref: "#mystery" } }))).body;
  eq("E our own account is never a lead", (await ext("POST", "/ext/leads/ingest", F, prof({ username: "acme_roofing" }))).body.duplicate, true);
  eq("E bad username refused", (await ext("POST", "/ext/leads/ingest", F, prof({ username: "bad name!" }))).status, 400);
  await app.jobs.drain();
  const L = (id) => ctx.leads.leadOut(ctx.leads.get(id));
  eq("E enrichment found the contact details", [L(joe.id).contact.emails, L(joe.id).contact.phones, L(joe.id).enrichStatus], [["joe@joesroofing.com"], ["(512) 555-0134"], "done"]);
  eq("E Haiku auto-rejected the agency", [L(ag.id).review, L(ag.id).haiku.fit], ["rejected", "no"]);
  eq("E Haiku left the plumber for review", [L(maybe.id).review, L(maybe.id).haiku.fit, L(maybe.id).haiku.score, L(maybe.id).clientId], ["pending", "maybe", 62, c2.id]);
  eq("E a local lead type is matched to the server's by name", L(maybe.id).leadTypeId, lt2.id);
  eq("E unknown lead type stays unassigned", [L(unassigned.id).clientId, L(unassigned.id).leadTypeName], [null, "Something else"]);
  yes("E opener written by Haiku with the link stripped", L(joe.id).opener.startsWith("Loved your recent roof post") && !/spam\.example/.test(L(joe.id).opener));
  yes("E Haiku calls used the key and the Haiku model", claudeCalls.length >= 3 && claudeCalls.every((c) => c.key === "test-key" && c.model === "claude-haiku-5-5"));
  yes("E untrusted text is fenced in tags and Haiku is told to ignore it", claudeCalls[0].system.includes("untrusted") && claudeCalls[0].user.includes("<profile>"));
  eq("E local source recorded so its stats work", db.get("SELECT kind, ref, origin FROM sources WHERE id = ?", L(unassigned.id).sourceId), { kind: "hashtag", ref: "#mystery", origin: "finder" });
  eq("E Haiku usage counted", app.ctx.haiku.status().calls >= 3, true);

  /* ---- F. review and claims ---- */
  eq("F pending list is ordered best first", (await api("GET", `/api/leads?review=pending`)).body.leads.map((l) => l.username)[0], "joes_roofing");
  eq("F unassigned lead needs a client", (await api("POST", `/api/leads/${unassigned.id}/approve`, {})).status, 400);
  const ap = (await api("POST", `/api/leads/${joe.id}/approve`, {})).body.lead;
  eq("F approved lead", [ap.review, ap.stage, ap.clientId], ["approved", "new", c1.id]);
  eq("F a send task is queued with the opener", db.get("SELECT type, status, text FROM tasks WHERE lead_id = ? AND type = 'dm'", joe.id).text, ap.opener);
  eq("F claim recorded", db.get("SELECT client_id FROM claims WHERE username = 'joes_roofing'").client_id, c1.id);
  const rival = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "joes_roofing", leadType: { id: `srv_lt_${lt2.id}`, name: "Plumbers" } }))).body;
  eq("F a second client cannot pick up a claimed lead", [rival.duplicate, rival.claimedBy], [true, "Acme Roofing"]);
  const taken = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "other_roofer", leadType: { id: "lt_other", name: "Something else" } }))).body;
  const ap2 = (await api("POST", `/api/leads/${taken.id}/approve`, { clientId: c1.id })).body.lead;
  eq("F unassigned lead approved for a client", [ap2.clientId, ap2.review], [c1.id, "approved"]);
  const clash = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "clash_user", leadType: { id: "lt_other", name: "Something else" } }))).body;
  db.run("INSERT INTO claims(username, client_id, claimed_at) VALUES('clash_user', ?, ?)", c1.id, Date.now());
  eq("F claim conflict on approve is a 409", (await api("POST", `/api/leads/${clash.id}/approve`, { clientId: c2.id })).status, 409);
  const rej = (await api("POST", `/api/leads/${maybe.id}/reject`, { reason: "Not in our area" })).body.lead;
  eq("F rejected lead", [rej.review, rej.reviewReason], ["rejected", "Not in our area"]);
  const bulk = (await api("POST", "/api/leads/bulk", { ids: [unassigned.id, clash.id], action: "approve", clientId: c2.id })).body;
  eq("F bulk approve reports failures", [bulk.done, bulk.failed.length], [[unassigned.id], 1]);

  /* ---- G. sending ---- */
  eq("G warm tasks are never mixed in before messages", (await ext("GET", "/ext/tasks/next", S)).body.task.type, "dm");
  let t1 = (await ext("GET", "/ext/tasks/next", S)).body;
  eq("G first message", [t1.task.username, t1.task.text === ap.opener], ["joes_roofing", true]);
  eq("G sent result", (await ext("POST", "/ext/tasks/result", S, { id: t1.task.id, ok: true, code: "sent" })).body.ok, true);
  const afterSend = L(joe.id);
  eq("G lead is contacted and a follow-up is booked", [afterSend.stage, afterSend.followStep, afterSend.nextFollowAt > Date.now() + 86400e3], ["contacted", 0, true]);
  eq("G sent count", (await ext("GET", "/ext/config", S)).body.sentToday, 1);
  eq("G the next message waits for pacing", (await ext("GET", "/ext/tasks/next", S)).body, { task: null, reason: "pacing" });
  db.run("UPDATE tasks SET done_at = ? WHERE type = 'dm' AND status = 'done'", Date.now() - 10 * 60e3);
  const t2 = (await ext("GET", "/ext/tasks/next", S)).body;
  eq("G second message goes after the gap", t2.task.username, "other_roofer");
  eq("G private account is a terminal failure", (await ext("POST", "/ext/tasks/result", S, { id: t2.task.id, ok: false, code: "private_cant_message" })).body.ok, true);
  eq("G lead marked cold and unreachable", [L(taken.id).stage, L(taken.id).noFollowup], ["cold", true]);
  eq("G the same task is not handed out twice", (await ext("POST", "/ext/tasks/result", S, { id: t2.task.id, ok: true, code: "sent" })).body.ignored, true);
  db.run("UPDATE clients SET daily_cap = 1 WHERE id = ?", c1.id);
  const extra = (await ext("POST", "/ext/leads/ingest", F, prof({ username: "third_roofer" }))).body; await app.jobs.drain();
  await api("POST", `/api/leads/${extra.id}/approve`, {});
  eq("G daily cap stops more sending", (await ext("GET", "/ext/tasks/next", S)).body.task, null);
  db.run("UPDATE clients SET daily_cap = 20 WHERE id = ?", c1.id);
  const t3 = (await ext("GET", "/ext/tasks/next", S)).body;
  eq("G a retryable failure goes back on the list later", [(await ext("POST", "/ext/tasks/result", S, { id: t3.task.id, ok: false, code: "error", safeToRetry: true })).body.ok, db.get("SELECT status, tries FROM tasks WHERE id = ?", t3.task.id).status, db.get("SELECT tries FROM tasks WHERE id = ?", t3.task.id).tries], [true, "pending", 1]);
  db.run("UPDATE tasks SET not_before = 0 WHERE id = ?", t3.task.id);
  const t3b = (await ext("GET", "/ext/tasks/next", S)).body;
  eq("G unconfirmed send is flagged for a person, never retried", [(await ext("POST", "/ext/tasks/result", S, { id: t3b.task.id, ok: false, code: "unconfirmed" })).body.ok, L(extra.id).needsHuman, L(extra.id).noFollowup], [true, true, true]);

  /* ---- H. follow-ups, inbox, replies ---- */
  db.run("UPDATE leads SET next_follow_at = ? WHERE id = ?", Date.now() - 1000, joe.id);
  app.maintain();
  eq("H no follow-up until the conversation has been seen in the inbox", db.get("SELECT COUNT(*) AS n FROM tasks WHERE type = 'followup'").n, 0);
  const T = (msgs) => [{ igThreadId: "T-100", username: "Joes_Roofing", messages: msgs }];
  eq("H inbox sync with only our own message", (await ext("POST", "/ext/inbox/sync", S, { threads: T([{ from: "me", text: ap.opener, ts: Math.floor(Date.now() / 1000) - 600 }]) })).body, { newInbound: 0 });
  eq("H thread id learned", L(joe.id) && ctx.leads.get(joe.id).thread_ig, "T-100");
  app.maintain();
  const fu = db.get("SELECT * FROM tasks WHERE type = 'followup'");
  yes("H follow-up booked with the template filled in", fu && fu.text.startsWith("Hey Joe,"));
  db.run("UPDATE tasks SET not_before = 0 WHERE id = ?", fu.id); db.run("UPDATE tasks SET done_at = ? WHERE type = 'dm'", Date.now() - 20 * 60e3);
  const tf = (await ext("GET", "/ext/tasks/next", S)).body;
  eq("H follow-up handed to the extension with the thread", [tf.task.type, tf.task.threadIg, tf.threadIg], ["followup", "T-100", "T-100"]);
  await ext("POST", "/ext/tasks/result", S, { id: tf.task.id, ok: true, code: "sent" });
  eq("H second follow-up scheduled", [L(joe.id).followStep, L(joe.id).nextFollowAt > Date.now() + 86400e3 * 2], [1, true]);

  db.run("UPDATE messages SET ts = ts - 900 WHERE direction = 'out'");   // our earlier messages happened a while ago
  const now = Math.floor(Date.now() / 1000) - 5;
  const incoming = async (text, ts) => (await ext("POST", "/ext/inbox/sync", S, { threads: T([{ from: "me", text: ap.opener, ts: now - 600 }, { from: "them", text, ts }]) })).body;
  eq("H a reply is counted once", await incoming("how much is it?", now - 30), { newInbound: 1 });
  eq("H the same message is not counted twice", await incoming("how much is it?", now - 30), { newInbound: 0 });
  await app.jobs.drain();
  const dr = db.get("SELECT * FROM tasks WHERE type = 'reply' ORDER BY id DESC");
  eq("H draft waits for approval by default", [dr.status, L(joe.id).stage, L(joe.id).needsHuman], ["draft", "replied", true]);
  yes("H the booking link is kept, other links are stripped", dr.text.includes("https://book.example/call") && !dr.text.includes("evil.example"));
  eq("H follow-ups were cancelled by the reply", [db.get("SELECT COUNT(*) AS n FROM tasks WHERE type = 'followup' AND status IN ('pending','draft')").n, L(joe.id).nextFollowAt], [0, null]);
  const replies = (await api("GET", "/api/replies")).body.replies;
  eq("H dashboard lists the draft with the conversation", [replies.length, replies[0].username, replies[0].conversation.at(-1).text], [1, "joes_roofing", "how much is it?"]);
  eq("H draft is not handed to the extension", (await ext("GET", "/ext/tasks/next", S)).body.task, null);
  eq("H approve with an edit", (await api("POST", `/api/tasks/${dr.id}/approve`, { text: "Depends on the roof! Can I call you tomorrow?" })).status, 200);
  const tr = (await ext("GET", "/ext/tasks/next", S)).body;
  eq("H approved reply goes out with the time of the message it answers", [tr.task.type, tr.task.text, tr.task.inboundAt > 1e12], ["reply", "Depends on the roof! Can I call you tomorrow?", true]);
  await ext("POST", "/ext/tasks/result", S, { id: tr.task.id, ok: true, code: "sent" });
  eq("H needs-a-person flag cleared after sending", L(joe.id).needsHuman, false);
  eq("H conversation log", db.all("SELECT direction FROM messages WHERE lead_id = ? ORDER BY ts, id", joe.id).map((m) => m.direction).includes("in"), true);

  await incoming("are you a bot or a real person?", now - 20);
  await app.jobs.drain();
  eq("H a question about being a bot is always handed to a person", [db.get("SELECT status FROM tasks WHERE type = 'reply' ORDER BY id DESC").status, L(joe.id).needsHuman], ["draft", true]);
  db.run("UPDATE clients SET auto_reply = 1 WHERE id = ?", c1.id);
  await incoming("sounds interesting, tell me more", now - 10); await app.jobs.drain();
  eq("H with auto-reply on, a normal reply is queued to send", db.get("SELECT status FROM tasks WHERE type = 'reply' ORDER BY id DESC").status, "pending");
  eq("H stage follows the conversation", L(joe.id).stage, "interested");
  await incoming("please stop messaging me", now - 5); await app.jobs.drain();
  eq("H asking to stop ends contact", [L(joe.id).stage, db.get("SELECT COUNT(*) AS n FROM tasks WHERE lead_id = ? AND status IN ('pending','draft')", joe.id).n], ["do_not_contact", 0]);

  /* ---- I. safety events and health ---- */
  await ext("POST", "/ext/heartbeat", S, { version: "4.0.0", loggedInAs: "acme_roofing", mode: "sender" });
  eq("I heartbeat recorded", db.get("SELECT last_version, last_mode FROM accounts WHERE id = ?", snd.account.id), { last_version: "4.0.0", last_mode: "sender" });
  await ext("POST", "/ext/event", S, { kind: "action_blocked" });
  let cfgS = (await ext("GET", "/ext/config", S)).body;
  eq("I an action block means 48 hours of rest, lower health, half the cap", [cfgS.state, cfgS.health.level, cfgS.capToday], ["cooldown", "caution", 10]);
  eq("I nothing is handed out while resting", (await ext("GET", "/ext/tasks/next", S)).body.task, null);
  db.run("UPDATE accounts SET cooldown_until = ? WHERE id = ?", Date.now() - 1000, snd.account.id);
  cfgS = (await ext("GET", "/ext/config", S)).body;
  eq("I rest ends by itself", [cfgS.state, cfgS.capToday], ["active", 10]);
  await ext("POST", "/ext/event", S, { kind: "checkpoint" });
  eq("I a security check needs a person to reset it", (await ext("GET", "/ext/config", S)).body.state, "restricted");
  await api("PATCH", `/api/accounts/${snd.account.id}`, { action: "reset" });
  eq("I reset from the dashboard", (await ext("GET", "/ext/config", S)).body.state, "active");
  eq("I bad event refused", (await ext("POST", "/ext/event", S, { kind: "nope" })).status, 400);
  await ext("POST", "/ext/event", F, { kind: "action_blocked" });
  db.run("UPDATE accounts SET state = 'active', cooldown_until = 0, reason = '' WHERE id = ?", fin.account.id);
  eq("I the finder's daily profile limit is cut after a block", (await ext("GET", "/ext/finder/plan", F)).body.profilesPerDay <= 20, true);
  await ext("POST", "/ext/heartbeat", F, { version: "4.0.0", loggedInAs: "finder_one", mode: "sender" });
  eq("I a finder account running in sender mode is paused", [(await ext("GET", "/ext/config", F)).body.state], ["paused"]);
  await ext("POST", "/ext/heartbeat", F, { version: "4.0.0", loggedInAs: "finder_one", mode: "finder" });
  eq("I and resumes when the mode is fixed", (await ext("GET", "/ext/config", F)).body.state, "active");

  /* ---- J. sources, suggestions, digest, report ---- */
  for (let i = 0; i < 12; i++) {
    const r = (await ext("POST", "/ext/leads/ingest", F, prof({ username: `bad_lead_${i}`, bio: i < 4 ? "franchise roofing owner" : "roofing", source: { id: `srv_src_${src2.id}`, kind: "hashtag", ref: "#roofingaustin" }, verdict: "pass" }))).body;
    await api("POST", `/api/leads/${r.id}/reject`, { reason: "Not a fit" });
  }
  const st = (await api("GET", "/api/sources/stats")).body.sources.find((s) => s.id === src2.id);
  eq("J source stats", [st.ingested, st.rejected, st.approvalRate], [12, 12, 0]);
  yes("J weak hashtag source is flagged", st.suggestion.startsWith("Pause"));
  eq("J rule-out words suggested from rejected bios", (await api("GET", `/api/lead-types/${lt1.id}/suggestions`)).body.excludeWords[0], { word: "franchise", rejected: 4 });
  await api("PUT", "/api/settings", { autoPauseSources: true });
  app.maintain();
  eq("J auto-pause switches the weak source off", [(await api("GET", "/api/sources")).body.sources.find((s) => s.id === src2.id).enabled, (await ext("GET", "/ext/finder/plan", F)).body.sources.length], [false, 1]);
  await api("PUT", "/api/settings", { skipList: ["@client_one", "friend.two"], exclusiveClaims: true });
  yes("J skip list reaches the finder", (await ext("GET", "/ext/finder/plan", F)).body.skipUsernames.includes("client_one"));
  eq("J bad skip entry refused", (await api("PUT", "/api/settings", { skipList: ["not valid!"] })).status, 400);
  const dg = (await api("GET", `/api/digest?clientId=${c1.id}&days=7`)).body;
  yes("J digest numbers add up", dg.found >= 14 && dg.messagesSent >= 1 && dg.replies >= 1 && dg.rejected >= 12 && dg.approved >= 2);
  const rep = (await call("GET", `/api/report?clientId=${c1.id}&days=7`)).body;
  yes("J report is readable text", typeof rep === "string" && rep.includes("Acme Roofing") && rep.includes("People found"));
  const ov = (await api("GET", "/api/overview")).body;
  yes("J overview has alerts and account health", Array.isArray(ov.alerts) && ov.accounts.length === 2 && ov.haiku.configured);
  eq("J exclusive claims can be switched off", (await api("PUT", "/api/settings", { exclusiveClaims: false })).status, 200);

  /* ---- K. replace a finder, rotate a token, delete rules ---- */
  const rp = (await api("POST", `/api/accounts/${fin.account.id}/replace`, { igUsername: "finder_two", label: "Finder 2" })).body;
  eq("K old finder is switched off, new one is paired", [(await ext("GET", "/ext/config", F)).body.state, decode(rp.pairingCode).m, rp.account.warm.stage], ["killed", "finder", "warming"]);
  const rot = (await api("POST", `/api/accounts/${snd.account.id}/rotate`)).body;
  eq("K rotating a token locks out the old one", [(await ext("GET", "/ext/config", S)).status, (await ext("GET", "/ext/config", decode(rot.pairingCode).t)).status], [401, 200]);
  eq("K a client with data cannot be deleted", (await api("DELETE", `/api/clients/${c1.id}`)).status, 409);

  /* ---- L. SSRF guard (real, with private fetching switched off) ---- */
  for (const u of ["http://127.0.0.1/", `http://127.0.0.1:${sitePort}/`, "http://localhost/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.1/", "http://example.com:8080/", "file:///etc/passwd", "ftp://example.com/"]) {
    let err = ""; try { await fetchPage(u, { allowPrivate: false, timeoutMs: 1500 }); } catch (e) { err = e.message; }
    yes("L blocked " + u, /blocked_address|blocked_port|bad_protocol/.test(err));
  }
  yes("L private ranges recognised", ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"].every(isPrivateIp) && !isPrivateIp("8.8.8.8"));

  /* ---- M. dashboard files ---- */
  const idx = await fetch(U + "/");
  eq("M dashboard page is served", [idx.status, (idx.headers.get("content-type") || "").startsWith("text/html")], [200, true]);
  eq("M no path traversal", (await fetch(U + "/..%2f..%2fetc/passwd")).status, 404);
  eq("M health check", (await fetch(U + "/health")).status, 200);

  await app.close(); claude.close(); site.close();
  console.log(`\n${total - bad} of ${total} passed${bad ? `, ${bad} FAILED` : ""}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
