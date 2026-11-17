"use strict";
/* MagnetEngine dashboard. Plain JavaScript. All text from leads or messages is inserted with textContent,
   never as HTML, because it comes from strangers. */
const $ = (id) => document.getElementById(id);
const state = { clientId: "", focus: null, flashing: false };
let uidn = 0;
const kidsOf = (k) => k.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
const put = (el, ...k) => el["replaceChildren"](...kidsOf(k));      // a real browser would print "null" for a null child
const add = (el, ...k) => el["append"](...kidsOf(k));

/* ---------------- small helpers ---------------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag), late = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (["value", "checked", "disabled", "hidden", "readOnly"].includes(k)) late[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  const flat = kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
  if (flat.length) add(el, ...flat);
  for (const [k, v] of Object.entries(late)) el[k] = v;
  return el;
}
const field = (label, control, help) => {
  const id = "f" + ++uidn; control.setAttribute("id", id);
  const kids = [h("label", { for: id, text: label }), control];
  if (help) { control.setAttribute("aria-describedby", id + "h"); kids.push(h("p", { class: "note", id: id + "h", text: help })); }
  return h("div", { class: "field" }, kids);
};
const check = (label, checked) => { const box = h("input", { type: "checkbox", checked: !!checked }); return { box, el: h("label", { class: "check" }, box, label) }; };
const select = (options, value, props) => { const s = h("select", props, options.map(([v, t]) => h("option", { value: String(v), text: t }))); s.value = String(value ?? options[0][0]); return s; };
const num = (el) => (el.value === "" ? undefined : Number(el.value));
const heading = (text) => { const el = h("h2", { tabindex: "-1", text }); state.focus = el; return el; };
const announce = (m) => { const l = $("live"); l.textContent = ""; setTimeout(() => { l.textContent = m; }, 50); };
const clearFlash = () => { const f = $("flash"); f.hidden = true; f.textContent = ""; };
const flash = (m) => { const f = $("flash"); f.textContent = m; f.hidden = false; announce(m); };
const act = (fn) => async (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); try { clearFlash(); await fn(ev); } catch (e) { flash(e.message || "Something went wrong."); } };
const LS = { get(k, d) { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };

function when(ts) {
  if (!ts) return "never";
  const d = Date.now() - ts, a = Math.abs(d), min = Math.round(a / 60000), hr = Math.round(a / 3600000), day = Math.round(a / 86400000);
  const span = min < 2 ? "a moment" : min < 90 ? `${min} minutes` : hr < 36 ? `${hr} hours` : `${day} days`;
  return d >= 0 ? `${span} ago` : `in ${span}`;
}
const STAGE = { new: "Approved, not messaged yet", contacted: "Messaged", replied: "Replied", interested: "Interested", booked: "Booked", customer: "Customer", cold: "Went cold", do_not_contact: "Do not contact" };
const stageOptions = (all) => [...(all ? [["", "All stages"]] : []), ...Object.entries(STAGE)];

async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: "same-origin", headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get("content-type") || "", data = type.includes("json") ? await res.json() : await res.text();
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error("Please sign in again."); }
  if (!res.ok) throw new Error((data && data.error) || "Something went wrong.");
  return data;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); announce("Copied"); return true; } catch { announce("Select the text and copy it by hand."); return false; }
}
function clientPicker(clients, onChange, label = "Client", extra = []) {
  const sel = h("select", {}, h("option", { value: "", text: "All clients" }), ...extra.map(([v, t]) => h("option", { value: v, text: t })), ...clients.map((c) => h("option", { value: String(c.id), text: c.name })));
  sel.value = state.clientId;
  sel.addEventListener("change", () => { state.clientId = sel.value; onChange(); });
  return field(label, sel);
}
const igLink = (u) => h("a", { href: `https://www.instagram.com/${encodeURIComponent(u)}/`, target: "_blank", rel: "noopener noreferrer", text: `@${u}` });
const tag = (text, kind) => h("span", { class: "tag" + (kind ? " " + kind : ""), text });

/* ---------------- overview ---------------- */
async function viewOverview(main) {
  const { clients } = await api("GET", "/api/clients");
  const box = h("div"), daysSel = select([["7", "Last 7 days"], ["30", "Last 30 days"]], "7");
  async function load() {
    const o = await api("GET", `/api/overview?days=${daysSel.value}${state.clientId ? "&clientId=" + state.clientId : ""}`), d = o.digest;
    const stat = (n, label) => h("li", { class: "stat" }, h("b", { text: String(n) }), label);
    const report = h("textarea", { readOnly: true, hidden: true, "aria-label": "Client report", rows: "12" });
    const reportBtn = h("button", { type: "button", class: "quiet", text: "Write the client report", onclick: act(async () => {
      report.value = await api("GET", `/api/report?days=${daysSel.value}${state.clientId ? "&clientId=" + state.clientId : ""}`); report.hidden = false; report.focus(); await copy(report.value);
    }) });
    put(box, 
      h("h3", { text: "Needs your attention" }),
      d && o.alerts.length ? h("ul", { class: "alerts" }, o.alerts.map((a) => h("li", { class: a.level }, tag({ bad: "Urgent", warn: "Warning", info: "To do" }[a.level] || "Note", a.level === "info" ? "" : a.level), " ", h("a", { href: a.to, text: a.text })))) : h("p", { text: "Nothing needs attention right now." }),
      h("h3", { text: `Last ${d.days} days` }),
      h("ul", { class: "stats" }, stat(d.found, "people found"), stat(d.pass, "good matches"), stat(d.approved, "approved"), stat(d.messagesSent + d.followupsSent, "messages sent"), stat(d.replies, "people replied"), stat(d.booked, "calls booked")),
      h("p", { class: "note", text: `${d.pendingReview} waiting for review. ${d.repliesWaiting} reply drafts waiting. ${d.rejected} rejected (${d.autoRejected} automatically by Haiku).` }),
      Object.keys(d.funnel).length ? h("p", { text: "Where leads stand: " + Object.entries(d.funnel).map(([k, v]) => `${v} ${(STAGE[k] || k).toLowerCase()}`).join(", ") + "." }) : null,
      d.topRejectReasons.length ? h("div", {}, h("h3", { text: "Why leads were rejected" }), h("ul", {}, d.topRejectReasons.map((r) => h("li", { text: `${r.reason}: ${r.count}` })))) : null,
      d.topSources.length ? h("div", {}, h("h3", { text: "Best sources" }), h("ul", {}, d.topSources.map((s) => h("li", { text: `${s.label}: ${s.approved} approved of ${s.ingested}` })))) : null,
      h("h3", { text: "Accounts" }), accountsTable(o.accounts),
      h("p", { class: "note", text: o.haiku.configured ? `Haiku (${o.haiku.model}) used ${o.haiku.usedToday.toLocaleString()} of ${o.haiku.dailyCap.toLocaleString()} tokens today in ${o.haiku.calls} calls.` : "Haiku is not connected." }),
      h("div", { class: "row" }, reportBtn), report);
  }
  daysSel.addEventListener("change", act(load));
  put(main, heading("Overview"), h("div", { class: "grid" }, clientPicker(clients, act(load)), field("Period", daysSel)), box);
  await load();
}
function accountsTable(accounts) {
  if (!accounts.length) return h("p", { text: "No accounts yet. Add one on the Accounts page." });
  return h("div", { class: "tablewrap" }, h("table", {}, h("caption", { text: "Instagram accounts" }),
    h("thead", {}, h("tr", {}, ["Account", "Type", "Status", "Health", "Warm-up", "Last seen"].map((t) => h("th", { scope: "col", text: t })))),
    h("tbody", {}, accounts.map((a) => h("tr", {},
      h("td", { text: `${a.label} (@${a.igUsername})` }), h("td", { text: a.kind === "finder" ? "Finder" : "Sender" }),
      h("td", {}, tag({ active: "Active", cooldown: "Resting", paused: "Paused", killed: "Off", restricted: "Restricted" }[a.state] || a.state, a.state === "active" ? "good" : a.state === "cooldown" || a.state === "paused" ? "warn" : "bad"), a.reason ? h("p", { class: "note", text: a.reason }) : null),
      h("td", { text: `${a.health.score} (${a.health.level})` }), h("td", { text: a.warm.stage === "active" ? "Finished" : `Day ${a.warm.day} of ${a.warm.totalDays}` }),
      h("td", { text: a.lastSeenAt ? when(a.lastSeenAt) : "Never" }))))));
}

/* ---------------- review ---------------- */
async function viewReview(main) {
  const [{ clients }, { sources }] = await Promise.all([api("GET", "/api/clients"), api("GET", "/api/sources/stats")]);
  const srcLabel = new Map(sources.map((s) => [s.id, s.label])), list = h("ul", { class: "cards", "aria-label": "Leads to review" }), count = h("p", { class: "note", role: "status" });
  async function load() {
    const q = state.clientId ? `&clientId=${state.clientId}` : "";
    const { leads, total } = await api("GET", "/api/leads?review=pending&limit=60" + q);
    count.textContent = total ? `${total} lead${total === 1 ? "" : "s"} waiting. Best matches first.` : "Nothing to review. New leads appear here as the finder works.";
    put(list, ...leads.map((l) => h("li", {}, leadCard(l, clients, srcLabel, () => { count.textContent = ""; }))));
    bulk.hidden = !leads.some((l) => l.clientId && l.verdict === "pass");
  }
  const bulk = h("button", { type: "button", class: "quiet", hidden: true, text: "Approve every good match shown", onclick: act(async () => {
    const q = state.clientId ? `&clientId=${state.clientId}` : "", { leads } = await api("GET", "/api/leads?review=pending&limit=100" + q);
    const ids = leads.filter((l) => l.clientId && l.verdict === "pass" && (l.haiku.fit === "" || l.haiku.fit === "yes")).map((l) => l.id);
    if (!ids.length) { flash("No good matches with a client to approve."); return; }
    if (!confirm(`Approve ${ids.length} lead${ids.length === 1 ? "" : "s"}? They will be queued to be messaged.`)) return;
    const r = await api("POST", "/api/leads/bulk", { ids, action: "approve" });
    announce(`Approved ${r.done.length}. ${r.failed.length ? r.failed.length + " could not be approved." : ""}`); await load();
  }) });
  put(main, heading("Review leads"), h("p", { text: "Approve the people you want messaged. Nothing is sent to anyone until you approve them." }), clientPicker(clients, act(load), "Client", [["none", "Not assigned to a client"]]), h("div", { class: "row" }, bulk), count, list);
  await load();
}
function leadCard(l, clients, srcLabel, onGone) {
  const hid = "lead-h-" + l.id, art = h("article", { class: "card", "aria-labelledby": hid });
  const opener = h("textarea", { value: l.opener, rows: "3" }), reason = select([["Not a fit", "Not a fit"], ["Wrong area", "Wrong area"], ["Already a customer", "Already a customer"], ["Competitor", "Competitor"], ["Other", "Other"]], "Not a fit");
  const clientSel = l.clientId ? null : select([["", "Choose a client"], ...clients.map((c) => [c.id, c.name])], "");
  const c = l.contact || {}, hz = l.haiku || {};
  const contactBits = [...(c.emails || []), ...(c.phones || []), ...Object.keys(c.links || {})];
  const remove = (msg) => { announce(msg); const next = art.parentElement && art.parentElement.nextElementSibling; art.parentElement && art.parentElement.remove(); onGone(); const hd = next && next.querySelector("h3"); if (hd) hd.focus(); };
  add(art, 
    h("div", { class: "top" }, h("h3", { id: hid, tabindex: "-1" }, igLink(l.username), l.name ? ` ${l.name}` : ""),
      h("span", {}, tag(l.verdict === "pass" ? "Good match" : "Needs a closer look", l.verdict === "pass" ? "good" : "warn"), " ", tag(`Score ${hz.score ?? l.rulesScore}`))),
    h("p", { class: "note", text: [l.leadTypeName, l.followers != null ? `${l.followers.toLocaleString()} followers` : "", l.category, l.location, srcLabel.get(l.sourceId) ? "Found through " + srcLabel.get(l.sourceId) : ""].filter(Boolean).join(" · ") }),
    l.bio ? h("p", { class: "bio", text: l.bio }) : null,
    l.reasons.length ? h("p", { text: "Why: " + l.reasons.join("; ") }) : null,
    hz.status === "done" ? h("p", {}, h("b", { text: `Haiku says ${hz.fit}: ` }), hz.reason) : hz.status === "queued" ? h("p", { class: "note", text: "Haiku is still looking at this one." }) : null,
    l.captions.length ? h("details", {}, h("summary", { text: "Recent posts" }), h("ul", {}, l.captions.map((x) => h("li", { text: x })))) : null,
    contactBits.length ? h("p", { text: "Contact: " + contactBits.join(" · ") }) : l.enrichStatus === "failed" ? h("p", { class: "note", text: "Could not read their website." }) : null,
    clientSel ? field("Which client is this lead for?", clientSel) : null,
    field("First message", opener, "Edit it if you like. It is sent as written."),
    h("div", { class: "row" },
      h("button", { type: "button", text: "Approve", "aria-label": `Approve @${l.username}`, onclick: act(async () => {
        if (clientSel && !clientSel.value) throw new Error("Choose which client this lead is for first.");
        await api("POST", `/api/leads/${l.id}/approve`, { clientId: clientSel ? Number(clientSel.value) : undefined, opener: opener.value.trim() && opener.value.trim() !== l.opener ? opener.value : undefined });
        remove(`Approved @${l.username}`);
      }) }),
      h("label", { class: "sr-only", for: "rr" + l.id, text: "Reason for rejecting" }), Object.assign(reason, { id: "rr" + l.id }),
      h("button", { type: "button", class: "danger", text: "Reject", "aria-label": `Reject @${l.username}`, onclick: act(async () => { await api("POST", `/api/leads/${l.id}/reject`, { reason: reason.value }); remove(`Rejected @${l.username}`); }) })));
  return art;
}

/* ---------------- replies ---------------- */
async function viewReplies(main) {
  const list = h("div");
  async function load() {
    const { replies, needsHuman } = await api("GET", "/api/replies");
    put(list, 
      replies.length ? h("ul", { class: "cards", "aria-label": "Reply drafts" }, replies.map((r) => h("li", {}, replyCard(r, load)))) : h("p", { text: "No reply drafts are waiting." }),
      needsHuman.length ? h("div", {}, h("h3", { text: "Conversations that need you" }), h("ul", { class: "cards" }, needsHuman.map((l) => h("li", { class: "card" }, h("h4", {}, igLink(l.username), ` ${l.name || ""}`), h("p", { class: "note", text: l.notes || "Please check this conversation by hand." }), h("button", { type: "button", class: "quiet", text: "Mark as handled", "aria-label": `Mark @${l.username} as handled`, onclick: act(async () => { await api("PATCH", `/api/leads/${l.id}`, { needsHuman: false }); announce("Marked as handled"); await load(); }) }))))) : null);
  }
  put(main, heading("Replies"), h("p", { text: "When someone answers, Haiku drafts a reply. Check it, edit it if you like, then approve. Replies are never sent instantly." }), list);
  await load();
}
function replyCard(r, reload) {
  const text = h("textarea", { value: r.draft, rows: "4" });
  return h("article", { class: "card", "aria-label": `Reply to @${r.username}` },
    h("h3", {}, igLink(r.username), ` ${r.name || ""}`, " ", tag(STAGE[r.stage] || r.stage)), convo(r.conversation),
    field("Your reply", text, r.draft ? "Written by Haiku. Links other than your booking link are removed." : "No draft was written. Please write one."),
    h("div", { class: "row" },
      h("button", { type: "button", text: "Approve and queue", "aria-label": `Approve reply to @${r.username}`, onclick: act(async () => { await api("POST", `/api/tasks/${r.taskId}/approve`, { text: text.value }); announce("Reply queued. It will go out after a natural delay."); await reload(); }) }),
      h("button", { type: "button", class: "danger", text: "Discard", "aria-label": `Discard reply to @${r.username}`, onclick: act(async () => { await api("POST", `/api/tasks/${r.taskId}/discard`, {}); announce("Draft discarded"); await reload(); }) })));
}
const convo = (msgs) => h("ul", { class: "convo", "aria-label": "Conversation" }, (msgs || []).map((m) => h("li", { class: m.direction }, h("b", { text: m.direction === "in" ? "Them" : "You" }), m.text)));

/* ---------------- leads ---------------- */
async function viewLeads(main) {
  const { clients } = await api("GET", "/api/clients");
  const q = h("input", { type: "search", autocomplete: "off" }), stageSel = select(stageOptions(true), ""), reviewSel = select([["approved", "Approved"], ["pending", "Waiting for review"], ["rejected", "Rejected"]], "approved");
  const list = h("ul", { class: "cards", "aria-label": "Leads" }), more = h("button", { type: "button", class: "quiet", hidden: true, text: "Show more" }), count = h("p", { class: "note", role: "status" });
  let offset = 0;
  async function load(append) {
    if (!append) offset = 0;
    const p = new URLSearchParams({ review: reviewSel.value, limit: "40", offset: String(offset) });
    if (stageSel.value && reviewSel.value === "approved") p.set("stage", stageSel.value);
    if (q.value.trim()) p.set("q", q.value.trim());
    if (state.clientId) p.set("clientId", state.clientId);
    const { leads, total } = await api("GET", "/api/leads?" + p);
    const cards = leads.map((l) => h("li", {}, leadRow(l)));
    if (append) add(list, ...cards); else put(list, ...cards);
    offset += leads.length; more.hidden = offset >= total; count.textContent = `Showing ${offset} of ${total}.`;
  }
  more.addEventListener("click", act(() => load(true)));
  const go = act(() => load(false));
  put(main, heading("Leads"),
    h("div", { class: "grid" }, clientPicker(clients, go), field("Status", reviewSel), field("Stage", stageSel), field("Search", q, "Name, username or bio")),
    h("div", { class: "row" }, h("button", { type: "button", text: "Search", onclick: go })), count, list, more);
  for (const el of [reviewSel, stageSel]) el.addEventListener("change", go);
  await load(false);
}
function leadRow(l) {
  const msgs = h("div"), stage = select(stageOptions(false), l.stage), notes = h("textarea", { value: l.notes, rows: "2" });
  const d = h("details", { ontoggle: act(async () => { if (!d.open || msgs.dataset.loaded) return; const r = await api("GET", `/api/leads/${l.id}`); msgs.dataset.loaded = "1"; put(msgs, r.messages.length ? convo(r.messages) : h("p", { class: "note", text: "No messages yet." })); }) },
    h("summary", { text: "Conversation and notes" }), msgs, field("Notes", notes),
    h("button", { type: "button", class: "quiet", text: "Save notes", onclick: act(async () => { await api("PATCH", `/api/leads/${l.id}`, { notes: notes.value }); announce("Notes saved"); }) }));
  return h("article", { class: "card", "aria-label": `@${l.username}` },
    h("div", { class: "top" }, h("h3", {}, igLink(l.username), ` ${l.name || ""}`), h("span", {}, l.needsHuman ? tag("Needs you", "warn") : null, " ", tag(l.leadTypeName || "No lead type"))),
    h("p", { class: "note", text: [l.review === "approved" ? STAGE[l.stage] : l.review === "rejected" ? "Rejected: " + (l.reviewReason || "no reason") : "Waiting for review", l.nextFollowAt ? `next follow-up ${when(l.nextFollowAt)}` : "", l.lastActivityAt ? `last activity ${when(l.lastActivityAt)}` : ""].filter(Boolean).join(" · ") }),
    l.review === "approved" ? h("div", { class: "row" }, field("Move to stage", stage), h("button", { type: "button", class: "quiet", text: "Change stage", "aria-label": `Change stage for @${l.username}`, onclick: act(async () => { await api("PATCH", `/api/leads/${l.id}`, { stage: stage.value }); announce("Stage changed"); }) })) : null, d);
}

/* ---------------- finder: lead types, sources, suggestions ---------------- */
const KIND_HELP = {
  location: ["Location page address", "Open a city or neighborhood on Instagram's location page and paste its address. It has to be a city or smaller. States, provinces and countries are refused.", "https://www.instagram.com/explore/locations/213163/austin-texas/"],
  account: ["Instagram username", "A competitor or an account like the ones you want to reach. Reading commenters on their latest posts is the gentle option.", "@acmeroofing"],
  post: ["Post address", "A post whose commenters (or likers) are the kind of people you want.", "https://www.instagram.com/p/AbC123xyz/"],
  hashtag: ["Hashtag", "Hashtags are noisy. They only suggest people. Every profile still has to match the lead type's words, and a match in a post alone is not enough.", "#roofingaustin"]
};
const MODES = { account: [["commenters", "Commenters on their latest posts"], ["followers", "Their followers (riskier, at most once a day)"]], post: [["commenters", "Commenters"], ["likers", "Likers (not always available)"], ["both", "Commenters and likers"]] };

async function viewFinder(main) {
  const { clients } = await api("GET", "/api/clients");
  if (!clients.length) { put(main, heading("Finder"), h("p", { text: "Add a client first on the Clients page. Lead types belong to a client." })); return; }
  if (!clients.some((c) => String(c.id) === state.clientId)) state.clientId = String(clients[0].id);
  const box = h("div");
  const clientSel = select(clients.map((c) => [c.id, c.name]), state.clientId);
  clientSel.addEventListener("change", act(() => { state.clientId = clientSel.value; return load(); }));
  async function load() {
    const [{ leadTypes }, { sources }] = await Promise.all([api("GET", `/api/lead-types?clientId=${state.clientId}`), api("GET", "/api/sources/stats")]);
    const ids = new Set(leadTypes.map((t) => t.id)), mine = sources.filter((s) => ids.has(s.leadTypeId) && s.origin === "server");
    const suggestions = await Promise.all(leadTypes.map((t) => api("GET", `/api/lead-types/${t.id}/suggestions`).then((r) => r.excludeWords).catch(() => [])));
    const editor = h("div");
    const typeCards = leadTypes.map((t, i) => h("li", { class: "card" },
      h("div", { class: "top" }, h("h4", { text: t.name }), tag(t.enabled ? "On" : "Off", t.enabled ? "good" : "warn")),
      h("p", { text: t.description || "No description." }),
      h("p", { class: "note", text: [t.include.length ? "Looks for: " + t.include.join(", ") : "", t.exclude.length ? "Rules out: " + t.exclude.join(", ") : "", t.regions.length ? "Where: " + t.regions.map((r) => r.label).join("; ") : "Where: anywhere in the US and Canada"].filter(Boolean).join(". ") + "." }),
      suggestions[i].length ? h("div", {}, h("p", { class: "note", text: "Words common in rejected bios and never in approved ones:" }), h("div", { class: "row" }, suggestions[i].map((s) => h("button", { type: "button", class: "quiet", text: `Rule out "${s.word}" (${s.rejected})`, "aria-label": `Add ${s.word} to the rule-out words for ${t.name}`, onclick: act(async () => { await api("PATCH", `/api/lead-types/${t.id}`, { exclude: [...t.exclude, s.word] }); announce(`Added ${s.word}`); await load(); }) })))) : null,
      h("div", { class: "row" },
        h("button", { type: "button", class: "quiet", text: "Edit", "aria-label": `Edit ${t.name}`, onclick: () => { put(editor, typeForm(t, load, () => put(editor, ))); editor.querySelector("input").focus(); } }),
        h("button", { type: "button", class: "quiet", text: t.enabled ? "Switch off" : "Switch on", "aria-label": `${t.enabled ? "Switch off" : "Switch on"} ${t.name}`, onclick: act(async () => { await api("PATCH", `/api/lead-types/${t.id}`, { enabled: !t.enabled }); await load(); }) }),
        h("button", { type: "button", class: "danger", text: "Delete", "aria-label": `Delete ${t.name}`, onclick: act(async () => { if (!confirm(`Delete "${t.name}"? Its sources will be switched off.`)) return; await api("DELETE", `/api/lead-types/${t.id}`); await load(); }) }))));
    const srcRows = mine.map((s) => h("tr", {},
      h("td", { text: s.label }), h("td", { text: (leadTypes.find((t) => t.id === s.leadTypeId) || {}).name || "" }),
      h("td", { text: String(s.ingested) }), h("td", { text: `${s.approved} / ${s.rejected}` }), h("td", { text: String(s.replied) }),
      h("td", {}, tag(s.enabled ? "On" : "Paused", s.enabled ? "good" : "warn"), s.pauseReason ? h("p", { class: "note", text: s.pauseReason }) : null, s.suggestion ? h("p", { class: "note", text: s.suggestion }) : null),
      h("td", {}, h("div", { class: "row" },
        h("button", { type: "button", class: "quiet", text: s.enabled ? "Pause" : "Resume", "aria-label": `${s.enabled ? "Pause" : "Resume"} ${s.label}`, onclick: act(async () => { await api("PATCH", `/api/sources/${s.id}`, { enabled: !s.enabled }); await load(); }) }),
        h("button", { type: "button", class: "danger", text: "Delete", "aria-label": `Delete ${s.label}`, onclick: act(async () => { await api("DELETE", `/api/sources/${s.id}`); await load(); }) })))));
    put(box, 
      h("h3", { text: "Lead types" }), h("p", { text: "A lead type says who to look for. The finder keeps people who match its words and sends close calls to Haiku." }),
      typeCards.length ? h("ul", { class: "cards" }, typeCards) : h("p", { text: "No lead types yet for this client." }),
      h("button", { type: "button", text: "Add a lead type", onclick: () => { put(editor, typeForm(null, load, () => put(editor, ))); editor.querySelector("input").focus(); } }), editor,
      h("h3", { text: "Sources" }), h("p", { text: "Sources say where to look. Seen is how many people it produced. Approved and rejected are your decisions." }),
      srcRows.length ? h("div", { class: "tablewrap" }, h("table", {}, h("caption", { text: "Sources for this client" }),
        h("thead", {}, h("tr", {}, ["Source", "Lead type", "Seen", "Approved / rejected", "Replied", "Status", "Actions"].map((t) => h("th", { scope: "col", text: t })))), h("tbody", {}, srcRows))) : h("p", { text: "No sources yet." }),
      leadTypes.length ? sourceForm(leadTypes, load) : h("p", { class: "note", text: "Add a lead type before adding sources." }));
  }
  put(main, heading("Finder setup"), field("Client", clientSel), box);
  await load();
}
function typeForm(t, reload, close) {
  const v = t || { name: "", description: "", include: [], exclude: [], includeMode: "any", accountTypes: [], minFollowers: 0, maxFollowers: 0, activeWithinDays: 0, regions: [], requireContact: false, publicOnly: true, borderline: "haiku", enabled: true };
  const name = h("input", { value: v.name, autocomplete: "off" }), desc = h("textarea", { value: v.description }), inc = h("textarea", { value: v.include.join("\n") }), exc = h("textarea", { value: v.exclude.join("\n") });
  const mode = select([["any", "Any one of them"], ["all", "All of them"]], v.includeMode), reg = h("textarea", { value: v.regions.map((r) => r.label).join("\n") });
  const types = ["business", "creator", "personal"].map((k) => ({ k, ...check(k[0].toUpperCase() + k.slice(1), v.accountTypes.includes(k)) }));
  const min = h("input", { type: "number", min: "0", value: v.minFollowers || "" }), max = h("input", { type: "number", min: "0", value: v.maxFollowers || "" }), act_ = h("input", { type: "number", min: "0", max: "3650", value: v.activeWithinDays || 0 });
  const pub = check("Public accounts only", v.publicOnly), con = check("Must show a website or email", v.requireContact), on = check("This lead type is switched on", v.enabled);
  const border = select([["haiku", "Ask Haiku"], ["save", "Save it for me to review"], ["skip", "Skip it"]], v.borderline), err = h("p", { class: "msg err", role: "alert" });
  return h("form", { class: "editor", novalidate: true, "aria-label": t ? `Edit ${t.name}` : "New lead type", onsubmit: act(async () => {
    err.textContent = "";
    const body = { clientId: Number(state.clientId), name: name.value, description: desc.value, include: inc.value, exclude: exc.value, includeMode: mode.value, accountTypes: types.filter((x) => x.box.checked).map((x) => x.k),
      minFollowers: num(min) ?? 0, maxFollowers: num(max) ?? 0, activeWithinDays: num(act_) ?? 0, regions: reg.value.split("\n").map((x) => x.trim()).filter(Boolean), requireContact: con.box.checked, publicOnly: pub.box.checked, borderline: border.value, enabled: on.box.checked };
    try { if (t) await api("PATCH", `/api/lead-types/${t.id}`, body); else await api("POST", "/api/lead-types", body); } catch (e) { err.textContent = e.message; announce(e.message); return; }
    announce("Lead type saved"); close(); await reload();
  }) },
    h("h4", { text: t ? "Edit lead type" : "New lead type" }), field("Name", name, "For example: Local contractors"),
    field("Describe who this person is", desc, "Write it the way you would explain it to a new employee. Haiku reads this to judge close calls."),
    field("Words that show a fit", inc, "One per line. Whole words only. End with * to match forms: plumb* matches plumber and plumbing."), field("How many must match", mode),
    field("Words that rule them out", exc, "If their bio, name or username has one, they are dropped. If only their posts do, they get a closer look."),
    h("fieldset", {}, h("legend", { text: "Account type (leave all unticked for any)" }), types.map((x) => x.el)),
    h("div", { class: "grid" }, field("Fewest followers", min), field("Most followers", max), field("Must have posted within this many days (0 for any)", act_)),
    field("Where they should be (US and Canada only)", reg, 'One per line: "Austin, TX", "Toronto, ON" or a whole state like "Texas". Empty means anywhere in the US and Canada.'),
    pub.el, con.el, field("When a profile is close but not certain", border), on.el, err,
    h("div", { class: "row" }, h("button", { type: "submit", text: "Save lead type" }), h("button", { type: "button", class: "quiet", text: "Cancel", onclick: close })));
}
function sourceForm(leadTypes, reload) {
  const lt = select(leadTypes.map((t) => [t.id, t.name]), leadTypes[0].id), kind = select([["location", "Location page"], ["account", "Competitor or similar account"], ["post", "A specific post"], ["hashtag", "Hashtag"]], "location");
  const ref = h("input", { autocomplete: "off", spellcheck: "false" }), mode = select([["", ""]], ""), role = select([["peers", "Like the businesses I want (peers)"], ["customers", "Customers of a competitor (an audience)"]], "peers");
  const refLabel = h("label", { text: "Address" }), help = h("p", { class: "note" }), modeWrap = h("div", { class: "field" }), err = h("p", { class: "msg err", role: "alert" });
  const rid = "f" + ++uidn, mid = "f" + ++uidn; ref.setAttribute("id", rid); refLabel.setAttribute("for", rid); help.setAttribute("id", rid + "h"); ref.setAttribute("aria-describedby", rid + "h"); mode.setAttribute("id", mid);
  const modeLabel = h("label", { for: mid, text: "What to read" });
  add(modeWrap, modeLabel, mode);
  function sync() {
    const k = kind.value, [label, text, ph] = KIND_HELP[k]; refLabel.textContent = label; help.textContent = text; ref.setAttribute("placeholder", ph);
    const m = MODES[k], cur = mode.value; modeWrap.hidden = !m; put(mode, ...(m || [["", ""]]).map(([val, t]) => h("option", { value: val, text: t }))); mode.value = m && m.some(([val]) => val === cur) ? cur : (m ? m[0][0] : "");
  }
  kind.addEventListener("change", sync); sync();
  return h("form", { class: "editor", novalidate: true, "aria-label": "Add a source", onsubmit: act(async () => {
    err.textContent = "";
    try { await api("POST", "/api/sources", { leadTypeId: Number(lt.value), kind: kind.value, ref: ref.value, mode: mode.value, role: role.value }); } catch (e) { err.textContent = e.message; announce(e.message); return; }
    announce("Source added"); await reload();
  }) }, h("h4", { text: "Add a source" }), field("Lead type", lt), field("What kind of source", kind), h("div", { class: "field" }, refLabel, ref, help), modeWrap, field("These people are", role), err, h("button", { type: "submit", text: "Add source" }));
}

/* ---------------- clients ---------------- */
async function viewClients(main) {
  const box = h("div"), editor = h("div");
  async function load() {
    const { clients } = await api("GET", "/api/clients");
    put(box, clients.length ? h("ul", { class: "cards", "aria-label": "Clients" }, clients.map((c) => h("li", { class: "card" },
      h("div", { class: "top" }, h("h3", { text: c.name }), c.active ? tag("Active", "good") : tag("Off", "warn")),
      h("p", { class: "note", text: `${c.accounts} account${c.accounts === 1 ? "" : "s"} · ${c.pending} waiting for review · up to ${c.dailyCap} messages a day · sends ${c.sendStart}:00 to ${c.sendEnd}:00 (${c.tz})` }),
      h("p", { text: c.offer || "No offer written yet." }),
      h("div", { class: "row" }, h("button", { type: "button", class: "quiet", text: "Edit", "aria-label": `Edit ${c.name}`, onclick: () => { put(editor, clientForm(c, load, () => put(editor, ))); editor.querySelector("input").focus(); } }),
        h("button", { type: "button", class: "danger", text: "Delete", "aria-label": `Delete ${c.name}`, onclick: act(async () => { if (!confirm(`Delete ${c.name}? This only works if it has no leads or accounts.`)) return; await api("DELETE", `/api/clients/${c.id}`); await load(); }) }))))) : h("p", { text: "No clients yet." }));
  }
  put(main, heading("Clients"), h("p", { text: "A client is a business you find and message leads for. Their offer and tone guide the openers and replies Haiku writes." }), box,
    h("button", { type: "button", text: "Add a client", onclick: () => { put(editor, clientForm(null, load, () => put(editor, ))); editor.querySelector("input").focus(); } }), editor);
  await load();
}
function clientForm(c, reload, close) {
  const v = c || { name: "", tz: "America/New_York", offer: "", tone: "friendly, short, casual", bookingLink: "", openerTemplate: "", followups: [{ afterDays: 2, text: "Hey {first_name}, just bumping this in case it got buried. No pressure at all!" }, { afterDays: 5, text: "Last one from me, {first_name}. If now isn't the right time, no worries!" }], autoReply: false, autoApprovePass: false, autoRejectNo: true, dailyCap: 20, sendStart: 9, sendEnd: 20, active: true };
  const name = h("input", { value: v.name, autocomplete: "off" }), tz = h("input", { value: v.tz, autocomplete: "off" }), offer = h("textarea", { value: v.offer, rows: "3" }), tone = h("input", { value: v.tone }), link = h("input", { value: v.bookingLink, type: "url", autocomplete: "off" });
  const opener = h("textarea", { value: v.openerTemplate, rows: "3" }), cap = h("input", { type: "number", min: "1", max: "40", value: v.dailyCap }), start = h("input", { type: "number", min: "0", max: "23", value: v.sendStart }), end = h("input", { type: "number", min: "1", max: "24", value: v.sendEnd });
  const ar = check("Send Haiku's replies automatically (otherwise you approve each one)", v.autoReply), ap = check("Approve good matches automatically", v.autoApprovePass), rj = check("Reject leads Haiku says are clearly wrong", v.autoRejectNo), on = check("This client is switched on", v.active);
  let fus = v.followups.map((f) => ({ ...f })); const fuBox = h("div"), err = h("p", { class: "msg err", role: "alert" });
  function drawFus() {
    put(fuBox, ...fus.map((f, i) => { const d = h("input", { type: "number", min: "0.25", max: "30", step: "0.25", value: f.afterDays }), t = h("textarea", { value: f.text, rows: "2" });
      d.addEventListener("input", () => { f.afterDays = Number(d.value); }); t.addEventListener("input", () => { f.text = t.value; });
      return h("fieldset", {}, h("legend", { text: `Follow-up ${i + 1}` }), field("Send after this many days with no reply", d), field("Message", t), h("button", { type: "button", class: "danger", text: "Remove", "aria-label": `Remove follow-up ${i + 1}`, onclick: () => { fus.splice(i, 1); drawFus(); announce("Follow-up removed"); } })); }),
      fus.length < 6 ? h("button", { type: "button", class: "quiet", text: "Add a follow-up", onclick: () => { fus.push({ afterDays: 3, text: "" }); drawFus(); } }) : null);
  }
  drawFus();
  return h("form", { class: "editor", novalidate: true, "aria-label": c ? `Edit ${c.name}` : "New client", onsubmit: act(async () => {
    err.textContent = "";
    const body = { name: name.value, tz: tz.value, offer: offer.value, tone: tone.value, bookingLink: link.value, openerTemplate: opener.value, followups: fus, autoReply: ar.box.checked, autoApprovePass: ap.box.checked, autoRejectNo: rj.box.checked, dailyCap: num(cap), sendStart: num(start), sendEnd: num(end), active: on.box.checked };
    try { if (c) await api("PATCH", `/api/clients/${c.id}`, body); else await api("POST", "/api/clients", body); } catch (e) { err.textContent = e.message; announce(e.message); return; }
    announce("Client saved"); close(); await reload();
  }) }, h("h4", { text: c ? "Edit client" : "New client" }), field("Name", name), field("What this business offers", offer, "Haiku only uses facts written here. It will not invent prices or promises."), field("Tone", tone),
    field("Booking link", link, "The only link Haiku is allowed to include in a reply."), field("First message template", opener, "Used when Haiku is off or fails. You can use {first_name}, {name}, {username} and {booking_link}."),
    h("h4", { text: "Follow-ups" }), h("p", { class: "note", text: "Sent only if the person has not replied. A reply stops them." }), fuBox,
    h("h4", { text: "Sending" }), field("Time zone", tz, "A name like America/Toronto or America/Chicago."),
    h("div", { class: "grid" }, field("Most messages a day (up to 40)", cap), field("Start hour (0 to 23)", start), field("End hour (1 to 24)", end)), ar.el, ap.el, rj.el, on.el, err,
    h("div", { class: "row" }, h("button", { type: "submit", text: "Save client" }), h("button", { type: "button", class: "quiet", text: "Cancel", onclick: close })));
}

/* ---------------- accounts ---------------- */
const CHECKLIST = ["Make a new Instagram account for the finder. Use a new email and phone number, a real photo and a short bio.", "Use a separate Chrome profile for it, and ideally a different network from every sender account.",
  "Install the extension there, set Mode to Finder in Settings, and paste the pairing code below.", "Leave it alone while it warms up. For the first days it only browses.", "The old finder is switched off. Its leads and history stay in your lists."];
async function viewAccounts(main) {
  const pairing = h("div"), table = h("div"), form = h("div");
  const showPairing = (code, title, replaced) => { put(pairing, h("section", { class: "editor", "aria-labelledby": "pc-h" }, h("h3", { id: "pc-h", tabindex: "-1", text: title }),
    h("p", { text: "On that account's Chrome profile, open the MagnetEngine extension, go to Settings, paste this code into the pairing box and press Pair. This code is shown only once." }),
    h("label", { for: "pc-code", text: "Pairing code" }), h("textarea", { id: "pc-code", readOnly: true, rows: "4", class: "code", value: code }),
    h("div", { class: "row" }, h("button", { type: "button", text: "Copy code", onclick: () => copy(code) })), replaced ? h("div", {}, h("h4", { text: "Replacing a finder: checklist" }), h("ol", {}, CHECKLIST.map((x) => h("li", { text: x })))) : null));
    pairing.querySelector("h3").focus(); };
  async function load() {
    const [{ accounts }, { clients }] = await Promise.all([api("GET", "/api/accounts"), api("GET", "/api/clients")]);
    put(table, accounts.length ? h("ul", { class: "cards", "aria-label": "Accounts" }, accounts.map((a) => accountCard(a, load, showPairing))) : h("p", { text: "No accounts yet. Add one below." }));
    put(form, accountForm(clients, load, showPairing));
  }
  put(main, heading("Accounts"), h("p", { text: "Each Instagram account runs in its own browser with the extension. A sender account messages leads for one client. A finder account only views pages to find leads." }), pairing, table, h("h3", { text: "Add an account" }), form);
  await load();
}
function accountCard(a, reload, showPairing) {
  const events = h("div"), name = a.label;
  const btn = (text, fn, cls) => h("button", { type: "button", class: cls || "quiet", text, "aria-label": `${text}: ${name}`, onclick: act(fn) });
  const post = (action) => async () => { await api("PATCH", `/api/accounts/${a.id}`, { action }); announce(`${name}: done`); await reload(); };
  const repUser = h("input", { autocomplete: "off", placeholder: "new_finder_username" }), repErr = h("p", { class: "msg err", role: "alert" });
  return h("li", { class: "card" },
    h("div", { class: "top" }, h("h3", { text: `${a.label} (@${a.igUsername})` }), h("span", {}, tag(a.kind === "finder" ? "Finder" : "Sender"), " ", tag({ active: "Active", cooldown: "Resting", paused: "Paused", killed: "Off", restricted: "Restricted" }[a.state] || a.state, a.state === "active" ? "good" : a.state === "restricted" || a.state === "killed" ? "bad" : "warn"))),
    a.reason ? h("p", { class: "err", text: a.reason }) : null,
    h("p", { class: "note", text: [a.clientName ? `For ${a.clientName}` : "", `Health ${a.health.score} (${a.health.level})`, a.warm.stage === "active" ? "Warm-up finished" : `Warm-up day ${a.warm.day} of ${a.warm.totalDays}`,
      a.kind === "sender" ? `${a.sentToday} of ${a.capToday} sent today` : `Looks at up to ${a.profilesPerDay} profiles a day`, a.lastSeenAt ? `Last seen ${when(a.lastSeenAt)}` : "Never connected", a.lastVersion ? `Extension ${a.lastVersion}` : ""].filter(Boolean).join(" · ") }),
    h("div", { class: "row" },
      a.state === "active" ? btn("Pause", post("pause")) : btn("Resume", post("resume")),
      a.state === "restricted" || a.state === "cooldown" ? btn("Reset", post("reset")) : null,
      a.state !== "killed" ? btn("Switch off", post("kill"), "danger") : null,
      btn("New pairing code", async () => { if (!confirm("The old code stops working. Continue?")) return; const r = await api("POST", `/api/accounts/${a.id}/rotate`); showPairing(r.pairingCode, `New pairing code for ${name}`); })),
    a.kind === "finder" && a.state !== "killed" ? h("details", {}, h("summary", { text: "Replace this finder" }), h("p", { class: "note", text: "Use this when the finder account is restricted or lost. The old one is switched off and a new one is set up with the same limits." }),
      field("New finder's Instagram username", repUser), repErr, h("button", { type: "button", class: "danger", text: "Replace finder", onclick: act(async () => { repErr.textContent = ""; try { const r = await api("POST", `/api/accounts/${a.id}/replace`, { igUsername: repUser.value }); showPairing(r.pairingCode, `Pairing code for the new finder`, true); await reload(); } catch (e) { repErr.textContent = e.message; announce(e.message); } }) })) : null,
    h("details", { ontoggle: act(async () => { if (!events.dataset.loaded && events.parentElement) { const r = await api("GET", `/api/accounts/${a.id}/events`); events.dataset.loaded = "1"; put(events, r.events.length ? h("ul", {}, r.events.map((e) => h("li", { text: `${when(e.at)}: ${e.kind.replace(/_/g, " ")}${e.detail ? " (" + e.detail + ")" : ""}` }))) : h("p", { class: "note", text: "Nothing has happened on this account." })); } }) }, h("summary", { text: "Recent events" }), events));
}
function accountForm(clients, reload, showPairing) {
  const kind = select([["sender", "Sender: warms up and messages leads"], ["finder", "Finder: only finds leads"]], "sender"), label = h("input", { autocomplete: "off" }), user = h("input", { autocomplete: "off", placeholder: "username without the @" });
  const age = select([["new", "Less than a month old"], ["young", "One to six months old"], ["established", "More than six months old"]], "young"), cl = select(clients.map((c) => [c.id, c.name]), clients[0] ? clients[0].id : "");
  const ppd = h("input", { type: "number", min: "5", max: "60", value: 40 }), clWrap = field("Client", cl, "The business this account messages for."), ppdWrap = field("Profiles it may look at per day", ppd), err = h("p", { class: "msg err", role: "alert" });
  const sync = () => { clWrap.hidden = kind.value !== "sender"; ppdWrap.hidden = kind.value !== "finder"; }; kind.addEventListener("change", sync); sync();
  return h("form", { class: "editor", novalidate: true, "aria-label": "Add an account", onsubmit: act(async () => {
    err.textContent = "";
    try { const r = await api("POST", "/api/accounts", { kind: kind.value, label: label.value, igUsername: user.value, igAge: age.value, clientId: kind.value === "sender" ? Number(cl.value) : undefined, profilesPerDay: kind.value === "finder" ? num(ppd) : undefined });
      showPairing(r.pairingCode, `Pairing code for ${r.account.label}`); label.value = ""; user.value = ""; await reload(); } catch (e) { err.textContent = e.message; announce(e.message); }
  }) }, field("Type", kind), field("Name for your list", label), field("Instagram username", user), field("How old is the Instagram account?", age, "Older accounts warm up faster. New accounts get a longer, gentler warm-up."), clWrap, ppdWrap, err, h("button", { type: "submit", text: "Add account" }));
}

/* ---------------- settings ---------------- */
async function viewSettings(main) {
  const s = await api("GET", "/api/settings");
  const skip = h("textarea", { value: s.skipList.join("\n"), rows: "5" }), ex = check("A lead can belong to only one client (stops two clients messaging the same person)", s.exclusiveClaims), ap = check("Pause sources automatically when almost nothing from them is approved", s.autoPauseSources);
  const ws = h("input", { type: "number", min: "0", max: "23", value: s.defaultWindow.start }), we = h("input", { type: "number", min: "1", max: "24", value: s.defaultWindow.end }), wz = h("input", { value: s.defaultWindow.tz });
  const sel = h("textarea", { value: JSON.stringify(s.selectors || {}, null, 2), rows: "5", class: "code" }), bp = h("textarea", { value: (s.blockPhrases || []).join("\n"), rows: "4" }), msg = h("p", { class: "msg", role: "status" });
  put(main, heading("Settings"),
    h("p", {}, s.haiku.configured ? `Haiku is connected (${s.haiku.model}). It has used ${s.haiku.usedToday.toLocaleString()} of ${s.haiku.dailyCap.toLocaleString()} tokens today.` : "Haiku is not connected. Add ANTHROPIC_API_KEY in your hosting settings and restart. Until then, close calls, openers and reply drafts are not written for you."),
    s.jobErrors.length ? h("div", {}, h("p", { class: "err", text: "Recent background errors:" }), h("ul", {}, s.jobErrors.map((e) => h("li", { text: e })))) : null,
    h("form", { novalidate: true, onsubmit: act(async () => {
      let selectors; try { selectors = JSON.parse(sel.value || "{}"); } catch { throw new Error("The selectors box must be valid JSON, like {}."); }
      await api("PUT", "/api/settings", { skipList: skip.value, exclusiveClaims: ex.box.checked, autoPauseSources: ap.box.checked, defaultWindow: { start: num(ws), end: num(we), tz: wz.value || undefined }, selectors, blockPhrases: bp.value.split("\n").map((x) => x.trim()).filter(Boolean) });
      msg.className = "msg good"; msg.textContent = "Saved."; announce("Settings saved");
    }) }, field("Never look at these accounts", skip, "Your clients, competitors, friends. One username per line."), ex.el, ap.el,
      h("h3", { text: "Finder hours" }), h("p", { class: "note", text: "Finder accounts have no client, so they follow these hours." }), h("div", { class: "grid" }, field("Start hour", ws), field("End hour", we), field("Time zone", wz)),
      h("details", {}, h("summary", { text: "Advanced: if Instagram changes its pages" }), field("Page selectors (JSON)", sel, "Sent to every extension. Example: {\"messageButtonText\": \"Message\"}"), field("Warning phrases (one per line)", bp, "Text that means Instagram is blocking an action.")),
      h("div", { class: "row" }, h("button", { type: "submit", text: "Save settings" })), msg));
}

/* ---------------- shell ---------------- */
const ROUTES = [["", "Overview", viewOverview], ["review", "Review", viewReview], ["replies", "Replies", viewReplies], ["leads", "Leads", viewLeads], ["finder", "Finder", viewFinder], ["clients", "Clients", viewClients], ["accounts", "Accounts", viewAccounts], ["settings", "Settings", viewSettings]];
let navBuilt = false;
function buildNav() {
  if (navBuilt) return; navBuilt = true;
  put($("nav"), ...ROUTES.map(([path, label]) => h("li", {}, h("a", { href: "#/" + path, "data-route": path, text: label }))));
}
async function render() {
  const route = (location.hash.replace(/^#\/?/, "") || "").split("?")[0], found = ROUTES.find((r) => r[0] === route) || ROUTES[0];
  for (const a of $("nav").children) { const link = a.firstChild || a; if (link.getAttribute && link.getAttribute("data-route") === found[0]) link.setAttribute("aria-current", "page"); else if (link.removeAttribute) link.removeAttribute("aria-current"); }
  const main = $("main"); clearFlash(); state.focus = null;
  put(main, h("p", { text: "Loading…" }));
  try { await found[2](main); } catch (e) { if (!/sign in/i.test(e.message)) put(main, heading("Something went wrong"), h("p", { class: "err", text: e.message })); }
  document.title = `${found[1]} · MagnetEngine`;
  if (state.focus) state.focus.focus();
}
function showLogin(setup) { $("app").hidden = true; $("login").hidden = false; $("loginMsg").textContent = setup === true ? "The server has no ADMIN_PASSWORD yet. Add it in your hosting settings and restart." : ""; $("pw").focus(); }
function showApp() { $("login").hidden = true; $("app").hidden = false; buildNav(); render(); }
function applyPrefs() {
  const size = LS.get("me_size", "m"), contrast = LS.get("me_contrast", "off");
  document.documentElement.dataset.size = size; document.documentElement.dataset.contrast = contrast; $("size").value = size; $("contrast").checked = contrast === "on";
}
async function boot() {
  applyPrefs();
  $("size").addEventListener("change", () => { LS.set("me_size", $("size").value); applyPrefs(); });
  $("contrast").addEventListener("change", () => { LS.set("me_contrast", $("contrast").checked ? "on" : "off"); applyPrefs(); });
  $("signout").addEventListener("click", act(async () => { await api("POST", "/api/logout", {}); showLogin(); }));
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); const msg = $("loginMsg"); msg.textContent = ""; msg.className = "msg";
    try { await api("POST", "/api/login", { password: $("pw").value }); $("pw").value = ""; showApp(); } catch (err) { msg.className = "msg err"; msg.textContent = err.message; }
  });
  window.addEventListener("hashchange", render);
  const s = await (await fetch("/api/session", { credentials: "same-origin" })).json();
  if (s.authed) showApp(); else showLogin(s.setupNeeded);
}
boot();
