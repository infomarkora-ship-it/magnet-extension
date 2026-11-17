/* Runs public/app.js against a tiny fake DOM and the real server: every page renders, key buttons work,
   and hostile text from a lead's bio never becomes an element. */
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createApp } = require("../src/server");

let bad = 0, total = 0;
const eq = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); };
const yes = (name, v) => eq(name, !!v, true);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- fake DOM ---- */
const byId = new Map(), created = [];
class Text { constructor(t) { this.text = t; } get textContent() { return this.text; } }
class El {
  constructor(tag) { this.tag = tag.toLowerCase(); this.attrs = {}; this._kids = []; this.listeners = {}; this.dataset = {}; this.className = ""; this.hidden = false; this.value = ""; this.checked = false; this.parent = null; this.open = false; created.push(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") byId.set(String(v), this); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...k) { for (const x of k) { const n = x instanceof El || x instanceof Text ? x : new Text(String(x)); /* like a browser: null becomes the text "null" */ n.parent = this; this._kids.push(n); } }
  replaceChildren(...k) { this._kids = []; this.append(...k); }
  set textContent(v) { this._kids = []; if (v !== "") this.append(String(v)); }
  get textContent() { return this._kids.map((k) => k.textContent).join(""); }
  get children() { return this._kids.filter((k) => k instanceof El); }
  get firstChild() { return this._kids[0] || null; }
  get parentElement() { return this.parent; }
  get nextElementSibling() { if (!this.parent) return null; const s = this.parent.children, i = s.indexOf(this); return s[i + 1] || null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  focus() { El.active = this; }
  remove() { if (this.parent) this.parent._kids = this.parent._kids.filter((k) => k !== this); }
  querySelector(sel) { return findAll(this, (e) => e.tag === sel)[0] || null; }
  set id(v) { this.setAttribute("id", v); } get id() { return this.attrs.id; }
}
const findAll = (root, pred, out = []) => { for (const k of root._kids || []) if (k instanceof El) { if (pred(k)) out.push(k); findAll(k, pred, out); } return out; };
const textOf = (el) => el.textContent;
const buttons = (root, text) => findAll(root, (e) => e.tag === "button" && (textOf(e) === text || (e.attrs["aria-label"] || "").startsWith(text)));
const click = async (el) => { for (const f of el.listeners.click || []) await f({ preventDefault() {} }); await wait(120); };
const submit = async (el) => { for (const f of el.listeners.submit || []) await f({ preventDefault() {} }); await wait(200); };
const fieldBy = (root, label) => { const l = findAll(root, (e) => e.tag === "label" && textOf(e).startsWith(label))[0]; if (!l) throw new Error("no label " + label); return byId.get(l.attrs.for); };
for (const id of ["live", "flash", "login", "loginMsg", "pw", "loginForm", "app", "nav", "main", "size", "contrast", "signout"]) { const e = new El("div"); e.setAttribute("id", id); }

(async () => {
  const app = createApp({ dbPath: ":memory:", adminPassword: "pw-for-tests", anthropicKey: "", logger: { error() {} } });
  const port = await app.listen(0), BASE = `http://127.0.0.1:${port}`, { db, ctx } = app;
  db.setSetting("default_window", { start: 0, end: 24 });
  const lr = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw-for-tests" }) });
  const cookie = lr.headers.get("set-cookie").split(";")[0];
  const j = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: { cookie, "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();

  /* seed */
  const c1 = await j("POST", "/api/clients", { name: "Acme Roofing", offer: "Free inspections", sendStart: 0, sendEnd: 24 });
  const lt = await j("POST", "/api/lead-types", { clientId: c1.id, name: "Roofers", description: "A local roofer.", include: ["roof*"] });
  await j("POST", "/api/sources", { leadTypeId: lt.id, kind: "hashtag", ref: "#roofing" });
  const fin = await j("POST", "/api/accounts", { kind: "finder", igUsername: "finder_a", igAge: "new" });
  const snd = await j("POST", "/api/accounts", { kind: "sender", igUsername: "acme_ig", clientId: c1.id, igAge: "established" });
  const FT = JSON.parse(Buffer.from(fin.pairingCode.slice(4), "base64url")).t;
  const ing = (o) => fetch(BASE + "/ext/leads/ingest", { method: "POST", headers: { authorization: "Bearer " + FT, "content-type": "application/json" }, body: JSON.stringify({ name: "Pat", bio: "Roofing", followers: 500, verdict: "pass", score: 80, reasons: ["Profile mentions roofing"], leadType: { id: "srv_lt_" + lt.id, name: "Roofers" }, source: { kind: "hashtag", ref: "#roofing" }, ...o }) }).then((r) => r.json());
  const evil = await ing({ username: "evil_one", name: "<script>alert(1)</script>", bio: '<img src=x onerror="alert(2)"> roofing', recentCaptions: ["<b>bold</b>"] });
  const okLead = await ing({ username: "good_one", name: "Gina Lopez" });
  const rejectMe = await ing({ username: "reject_me" });
  const loose = await ing({ username: "loose_one", leadType: { id: "x", name: "Unknown type" } });
  const done = await ing({ username: "done_deal" });
  await app.jobs.drain();
  await j("POST", `/api/leads/${done.id}/approve`, {});
  db.run("UPDATE leads SET stage = 'contacted', thread_ig = 'T1', last_activity_at = ? WHERE id = ?", Date.now(), done.id);
  ctx.leads.addMessage(done.id, "out", "Hey there", Math.floor(Date.now() / 1000) - 100);
  ctx.leads.addMessage(done.id, "in", "How much?", Math.floor(Date.now() / 1000) - 50);
  db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, text, status, not_before, inbound_at, created_at) VALUES(?,?,?,?,?,?,?,?,?)", snd.account.id, c1.id, done.id, "reply", "It depends on the job.", "draft", 0, Date.now() - 50000, Date.now());

  /* load app.js */
  const win = { addEventListener: (t, f) => { win.l ||= {}; win.l[t] = f; }, localStorage: { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = v; } } };
  const doc = { createElement: (t) => new El(t), getElementById: (id) => byId.get(id) || null, title: "", documentElement: { dataset: {} } };
  const location = { hash: "" };
  const ctxVm = { window: win, document: doc, location, navigator: { clipboard: { writeText: async () => {} } }, confirm: () => true, alert() {}, console, setTimeout, clearTimeout, URLSearchParams, encodeURIComponent, Date, JSON, Math, Promise, Object, Array, Set, Map, Number, String, Error, RegExp,
    fetch: (p, o = {}) => fetch(BASE + p, { ...o, headers: { ...(o.headers || {}), cookie } }) };
  vm.createContext(ctxVm);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8"), ctxVm, { filename: "app.js" });
  const main = byId.get("main"), nav = byId.get("nav");
  const settle = async () => { for (let i = 0; i < 60; i++) { await wait(50); if (textOf(main) && !/^Loading/.test(textOf(main))) { await wait(80); return; } } };
  const go = async (route) => { location.hash = "#/" + route; await win.l.hashchange(); await settle(); };
  await settle();

  eq("shell shown after sign-in", [byId.get("app").hidden, byId.get("login").hidden], [false, true]);
  eq("nav has every page", nav.children.map((li) => textOf(li)), ["Overview", "Review", "Replies", "Leads", "Finder", "Clients", "Accounts", "Settings"]);
  yes("overview renders with stats and accounts", /Overview/.test(textOf(main)) && /people found/.test(textOf(main)) && /Instagram accounts/.test(textOf(main)));
  yes("overview alerts mention Haiku and review", /Haiku is not connected/.test(textOf(main)) && /waiting for your review/.test(textOf(main)));
  yes("report button writes a report", (await click(buttons(main, "Write the client report")[0]), /# .*Last 7 days|Last 7 days/.test(textOf(main)) || findAll(main, (e) => e.tag === "textarea").some((t) => /People found/.test(t.value))));

  /* review */
  await go("review");
  yes("review lists leads best first", /Review leads/.test(textOf(main)) && /@good_one/.test(textOf(main)));
  yes("the word null never appears on a page", !/null|undefined|false/.test(textOf(main)));
  yes("hostile text is shown as text", /<script>alert\(1\)<\/script>/.test(textOf(main)) && /onerror/.test(textOf(main)));
  eq("no script or img elements were ever created from lead text", created.filter((e) => ["script", "img", "iframe"].includes(e.tag)).length, 0);
  yes("unassigned lead asks for a client", /Which client is this lead for/.test(textOf(main)));
  await click(buttons(main, "Approve @good_one")[0]);
  eq("approve button approves the lead", ctx.leads.get(okLead.id).review, "approved");
  eq("card is removed after approving", buttons(main, "Approve @good_one").length, 0);
  await click(buttons(main, "Approve @loose_one")[0]);
  eq("approving without a client is refused with a message", [ctx.leads.get(loose.id).review, /Choose which client/.test(textOf(byId.get("flash")))], ["pending", true]);
  await click(buttons(main, "Reject @reject_me")[0]);
  eq("reject button rejects with a reason", [ctx.leads.get(rejectMe.id).review, ctx.leads.get(rejectMe.id).review_reason], ["rejected", "Not a fit"]);

  /* replies */
  await go("replies");
  yes("reply draft shown with the conversation", /It depends on the job\./.test(findAll(main, (e) => e.tag === "textarea").map((t) => t.value).join()) && /How much\?/.test(textOf(main)));
  await click(buttons(main, "Approve reply to @done_deal")[0]);
  eq("approving a reply queues it", db.get("SELECT status FROM tasks WHERE type = 'reply'").status, "pending");

  /* leads */
  await go("leads");
  yes("leads page lists approved leads", /@good_one/.test(textOf(main)) && /@done_deal/.test(textOf(main)));
  const det = findAll(main, (e) => e.tag === "details")[0]; det.open = true; for (const f of det.listeners.toggle) await f(); await wait(150);
  yes("conversation loads when opened", findAll(main, (e) => e.tag === "details").some((d) => /How much\?|No messages yet/.test(textOf(d))));
  const stageSel = fieldBy(main, "Move to stage"); stageSel.value = "cold"; await click(buttons(main, "Change stage for")[0]);
  eq("stage can be changed", db.all("SELECT stage FROM leads WHERE review = 'approved' AND stage = 'cold'").length, 1);

  /* finder */
  await go("finder");
  yes("finder shows lead types and sources", /Roofers/.test(textOf(main)) && /#roofing/.test(textOf(main)));
  await click(buttons(main, "Add a lead type")[0]);
  const form = findAll(main, (e) => e.tag === "form" && /New lead type/.test(e.attrs["aria-label"] || ""))[0];
  fieldBy(form, "Name").value = "Plumbers"; fieldBy(form, "Describe who this person is").value = "A local plumber taking residential jobs."; fieldBy(form, "Words that show a fit").value = "plumb*\ndrain*"; fieldBy(form, "Where they should be").value = "Canada";
  await submit(form);
  yes("a bad location is explained, not saved", /use a US state or Canadian province/i.test(textOf(form)) && db.get("SELECT COUNT(*) AS n FROM lead_types WHERE name = 'Plumbers'").n === 0);
  fieldBy(form, "Where they should be").value = "Austin, TX\nToronto, ON"; await submit(form);
  eq("lead type saved with parsed regions", JSON.parse(db.get("SELECT regions FROM lead_types WHERE name = 'Plumbers'").regions).map((r) => r.label), ["Austin, TX", "Toronto, ON"]);
  const sform = findAll(main, (e) => e.tag === "form" && e.attrs["aria-label"] === "Add a source")[0];
  fieldBy(sform, "What kind of source").value = "location"; for (const f of fieldBy(sform, "What kind of source").listeners.change || []) f();
  const refEl = findAll(sform, (e) => e.tag === "input")[0]; refEl.value = "https://www.instagram.com/explore/locations/1/texas/"; await submit(sform);
  yes("a state-wide location is refused", /too broad/i.test(textOf(sform)));
  refEl.value = "https://www.instagram.com/explore/locations/213163/austin-texas/"; await submit(sform);
  eq("a city location is accepted", db.get("SELECT COUNT(*) AS n FROM sources WHERE kind = 'location' AND ref = '213163/austin-texas'").n, 1);
  await click(buttons(main, "Pause hashtag #roofing")[0]);
  eq("a source can be paused", db.get("SELECT enabled FROM sources WHERE ref = '#roofing'").enabled, 0);

  /* clients */
  await go("clients");
  yes("clients page lists the client", /Acme Roofing/.test(textOf(main)));
  await click(buttons(main, "Add a client")[0]);
  const cf = findAll(main, (e) => e.tag === "form" && e.attrs["aria-label"] === "New client")[0];
  fieldBy(cf, "Name").value = "Pipes Co"; fieldBy(cf, "Booking link").value = "javascript:alert(1)"; await submit(cf);
  yes("an unsafe booking link is refused with a message", /booking link must/i.test(textOf(cf)));
  fieldBy(cf, "Booking link").value = "https://cal.example/pipes"; await click(buttons(cf, "Add a follow-up")[0]); await submit(cf);
  eq("client saved with three follow-ups", [db.get("SELECT COUNT(*) AS n FROM clients WHERE name = 'Pipes Co'").n, JSON.parse(db.get("SELECT followups FROM clients WHERE name = 'Pipes Co'").followups).length], [1, 3]);

  /* accounts */
  await go("accounts");
  yes("accounts page shows both accounts and their health", /finder_a/.test(textOf(main)) && /acme_ig/.test(textOf(main)) && /Health 100/.test(textOf(main)));
  const af = findAll(main, (e) => e.tag === "form" && e.attrs["aria-label"] === "Add an account")[0];
  fieldBy(af, "Type").value = "finder"; for (const f of fieldBy(af, "Type").listeners.change || []) f();
  fieldBy(af, "Instagram username").value = "finder_b"; await submit(af);
  yes("pairing code is shown once after creating an account", findAll(main, (e) => e.tag === "textarea").some((t) => t.value.startsWith("me1.")));
  await click(buttons(main, "Pause: finder_b")[0]);
  yes("an account can be paused from the page", db.all("SELECT state FROM accounts WHERE state = 'paused'").length >= 1);

  /* settings */
  await go("settings");
  fieldBy(main, "Never look at these accounts").value = "@client_one\nfriend.two"; await submit(findAll(main, (e) => e.tag === "form")[0]);
  eq("settings save", db.setting("skip_list"), ["client_one", "friend.two"]);

  /* every page again, no errors anywhere */
  for (const r of ["", "review", "replies", "leads", "finder", "clients", "accounts", "settings"]) { await go(r); yes("no error on /" + r, !/Something went wrong/.test(textOf(main)) && !/Loading/.test(textOf(main))); }

  /* signed out */
  const si = await fetch(BASE + "/api/session"); eq("a visitor without a cookie is not signed in", (await si.json()).authed, false);

  await app.close();
  console.log(`\n${total - bad} of ${total} passed${bad ? `, ${bad} FAILED` : ""}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
