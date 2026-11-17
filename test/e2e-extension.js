/* The real extension background code (finder mode) talking to the real server over HTTP,
   with fake Chrome and fake Instagram pages. Proves the two halves agree on every request and response. */
const vm = require("node:vm"), fs = require("node:fs");
const { createApp } = require("../src/server");
const EXT = process.env.EXT_DIR || "/home/claude/magnetengine-extension/";
if (!fs.existsSync(EXT + "background.js")) { console.log("Skipped: set EXT_DIR to the folder of the unzipped extension, with a trailing slash."); process.exit(0); }
let bad = 0, total = 0;
const eq = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : `\n   got  ${JSON.stringify(g)}\n   want ${JSON.stringify(w)}`); };

(async () => {
  const app = createApp({ dbPath: ":memory:", adminPassword: "x", anthropicKey: "", logger: { error() {} } });
  const port = await app.listen(0), BASE = `http://127.0.0.1:${port}`, { db } = app;
  db.setSetting("default_window", { start: 0, end: 24 });
  const lr = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) });
  const cookie = lr.headers.get("set-cookie").split(";")[0];
  const J = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();
  const c = await J("POST", "/api/clients", { name: "Acme", sendStart: 0, sendEnd: 24 });
  const lt = await J("POST", "/api/lead-types", { clientId: c.id, name: "Roofers", description: "A local roofer.", include: ["roof*"], exclude: ["seo"], regions: ["Austin, TX"], borderline: "save" });
  await J("POST", "/api/sources", { leadTypeId: lt.id, kind: "location", ref: "https://www.instagram.com/explore/locations/213163/austin-texas/" });
  const acc = await J("POST", "/api/accounts", { kind: "finder", igUsername: "finder_x", igAge: "established" });
  const code = JSON.parse(Buffer.from(acc.pairingCode.slice(4), "base64url"));
  db.run("UPDATE accounts SET warm_started_at = ? WHERE id = ?", Date.now() - 30 * 86400e3, acc.account.id);

  /* fake Chrome around the real extension files */
  const store = { server: code.s, token: code.t, mode: code.m, prefs: { startHour: 0, endHour: 24 }, lastIdentityAt: Date.now() };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let winId = 0;
  const FR = require(EXT + "finder-rules.js");
  const pages = (msg) => {
    if (msg.type === "COLLECT") return { ok: true, code: "collected", users: [{ username: "joes_roofing", fullName: "Joe", context: "New roof today" }, { username: "austin_seo_guy", fullName: "SEO Guy" }, { username: "finder_x" }] };
    if (msg.type === "READ_PROFILE") return { ok: true, code: "read", profile: FR.finishProfile({ username: msg.task.username, followers: 900, following: 100, posts: 40, bio: "Roofing contractor in Austin, TX", isPrivate: false, isBusiness: true, recentPosts: [{ ts: Date.now() - 86400000, caption: "Finished a roof" }] }) };
    return { ok: true };
  };
  const chrome = {
    storage: { local: { get: async (d) => { const keys = typeof d === "string" ? [d] : Array.isArray(d) ? d : Object.keys(d); const out = Array.isArray(d) || typeof d === "string" ? {} : { ...d }; for (const k of keys) if (k in store) out[k] = clone(store[k]); return out; }, set: async (o) => Object.assign(store, clone(o)) }, onChanged: { addListener() {} } },
    alarms: { get: async () => ({}), create() {}, onAlarm: { addListener() {} } },
    runtime: { getManifest: () => ({ version: "4.0.0" }), onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    windows: { create: async ({ url }) => ({ id: ++winId, tabs: [{ id: winId, url }] }), remove: async () => {} },
    tabs: { query: async () => [], update: async () => {}, onUpdated: { addListener(fn) { setTimeout(() => fn(winId, { status: "complete" }), 0); }, removeListener() {} }, sendMessage: async (id, msg) => pages(msg) }
  };
  const ctx = { chrome, fetch, console, setTimeout, clearTimeout, Date, Math, JSON, atob, btoa, URL, Promise, importScripts: (...f) => { for (const x of f) vm.runInContext(fs.readFileSync(EXT + x, "utf8"), ctx, { filename: x }); } };
  vm.createContext(ctx);
  vm.runInContext("importScripts('shared.js','finder-rules.js','finder.js')", ctx);
  vm.runInContext(fs.readFileSync(EXT + "background.js", "utf8").replace('importScripts("shared.js", "finder-rules.js", "finder.js");', "").replace("const sleep = (ms) => new Promise((r) => setTimeout(r, ms));", "const sleep = () => Promise.resolve();"), ctx, { filename: "background.js" });
  const tick = () => vm.runInContext("tick()", ctx);

  await tick();
  eq("extension read the server's plan and looked at the location", [store.finder.collects, store.finder.queue.map((q) => q.username)], [1, ["joes_roofing"]]);
  eq("server-side skip list and exclude words were applied", [store.finder.rejected['Name says "seo"'], store.finder.queue.length], [1, 1]);
  store.finder.nextProfileAt = 0; await tick();
  const lead = db.get("SELECT username, review, verdict, client_id, lead_type_id, source_id, rules_score FROM leads");
  eq("the lead arrived on the server, matched to the right client and lead type", [lead.username, lead.review, lead.verdict, lead.client_id, lead.lead_type_id], ["joes_roofing", "pending", "pass", c.id, lt.id]);
  eq("it is linked to the server's source", db.get("SELECT kind, ref, origin FROM sources WHERE id = ?", lead.source_id), { kind: "location", ref: "213163/austin-texas", origin: "server" });
  eq("heartbeat reports the mode", db.get("SELECT last_mode, last_version FROM accounts WHERE id = ?", acc.account.id), { last_mode: "finder", last_version: "4.0.0" });
  eq("nothing pending locally to retry", store.finder.pending.length, 0);
  eq("the next plan tells the finder to skip people already found", (await (await fetch(BASE + "/ext/finder/plan", { headers: { authorization: "Bearer " + code.t } })).json()).skipUsernames.includes("joes_roofing"), true);

  /* a sender account through the same real code */
  const sacc = await J("POST", "/api/accounts", { kind: "sender", igUsername: "acme_ig", clientId: c.id, igAge: "established" });
  const sc = JSON.parse(Buffer.from(sacc.pairingCode.slice(4), "base64url"));
  db.run("UPDATE accounts SET warm_started_at = ? WHERE id = ?", Date.now() - 30 * 86400e3, sacc.account.id);
  const cfg = await (await fetch(BASE + "/ext/config", { headers: { authorization: "Bearer " + sc.t } })).json();
  eq("sender config has every field the extension reads", ["state", "reason", "expectedUsername", "warm", "sentToday", "capToday", "health"].every((k) => k in cfg), true);
  await app.close();
  console.log(`\n${total - bad} of ${total} passed${bad ? `, ${bad} FAILED` : ""}`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
