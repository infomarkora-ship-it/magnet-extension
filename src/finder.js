/* Finder side of the server: lead types, sources, the plan the finder downloads, source scoring,
   suggestions, the digest and the client report. */
const { now, DAY, j, lc, str, num, clamp, HttpError } = require("./util");
const FR = require("./finder-rules");

const STOP = new Set("with that this have from your they them there their what when will been were about would could which these those also just more most some than then into only over very like love life work best home year years team make made need want help please thank thanks dont cant i'm you're services service company business".split(" "));

function createFinder(ctx) {
  const { db, accounts } = ctx;

  /* ---- serializers ---- */
  const typeOut = (r) => ({ id: r.id, clientId: r.client_id, name: r.name, description: r.description, include: j(r.include, []), includeMode: r.include_mode,
    exclude: j(r.exclude, []), accountTypes: j(r.account_types, []), minFollowers: r.min_followers, maxFollowers: r.max_followers,
    activeWithinDays: r.active_within_days, regions: j(r.regions, []), requireContact: !!r.require_contact, publicOnly: !!r.public_only,
    borderline: r.borderline, enabled: !!r.enabled });
  const sourceOut = (r) => ({ id: r.id, leadTypeId: r.lead_type_id, kind: r.kind, ref: r.ref, mode: r.mode, role: r.role, enabled: !!r.enabled, pauseReason: r.pause_reason, origin: r.origin, label: FR.sourceLabel({ kind: r.kind, ref: r.ref, mode: r.mode }) });

  /* ---- input validation ---- */
  function parseType(b, partial) {
    const o = {};
    const has = (k) => b[k] !== undefined;
    if (!partial || has("name")) { o.name = str(b.name, 80).trim(); if (!o.name) throw new HttpError(400, "Give the lead type a name."); }
    if (has("description")) o.description = str(b.description, 600).trim();
    for (const [k, col] of [["include", "include"], ["exclude", "exclude"]]) if (has(k)) {
      const words = FR.splitWords(Array.isArray(b[k]) ? b[k].join("\n") : String(b[k])).slice(0, 80);
      o[col] = JSON.stringify(words);
    }
    if (has("includeMode")) o.include_mode = b.includeMode === "all" ? "all" : "any";
    if (has("accountTypes")) o.account_types = JSON.stringify((Array.isArray(b.accountTypes) ? b.accountTypes : []).filter((x) => ["business", "creator", "personal"].includes(x)));
    if (has("minFollowers")) o.min_followers = clamp(Math.round(num(b.minFollowers, 0)), 0, 1e9);
    if (has("maxFollowers")) o.max_followers = clamp(Math.round(num(b.maxFollowers, 0)), 0, 1e9);
    if (o.min_followers && o.max_followers && o.min_followers > o.max_followers) throw new HttpError(400, "Fewest followers can't be more than most followers.");
    if (has("activeWithinDays")) o.active_within_days = clamp(Math.round(num(b.activeWithinDays, 0)), 0, 3650);
    if (has("regions")) {
      const out = [];
      for (const x of Array.isArray(b.regions) ? b.regions : String(b.regions).split("\n")) {
        const line = typeof x === "object" && x ? (x.city ? `${x.city}, ${x.state}` : x.state) : x;
        const r = FR.parseRegionLine(line); if (!r) continue;
        if (r.error) throw new HttpError(400, r.error);
        out.push(r);
      }
      o.regions = JSON.stringify(out.slice(0, 40));
    }
    if (has("requireContact")) o.require_contact = b.requireContact ? 1 : 0;
    if (has("publicOnly")) o.public_only = b.publicOnly === false ? 0 : 1;
    if (has("borderline")) o.borderline = ["haiku", "save", "skip"].includes(b.borderline) ? b.borderline : "haiku";
    if (has("enabled")) o.enabled = b.enabled ? 1 : 0;
    return o;
  }
  function parseSource(b, partial) {
    const o = {};
    if (!partial || b.leadTypeId !== undefined) { if (!db.get("SELECT id FROM lead_types WHERE id = ?", num(b.leadTypeId))) throw new HttpError(400, "Choose a lead type."); o.lead_type_id = num(b.leadTypeId); }
    if (!partial || b.kind !== undefined || b.ref !== undefined) {
      if (!["location", "hashtag", "post", "account"].includes(b.kind)) throw new HttpError(400, "Unknown source type.");
      const n = FR.normalizeSourceRef(b.kind, b.ref);
      if (!n.ok) throw new HttpError(400, n.error);
      o.kind = b.kind; o.ref = n.ref;
    }
    const kind = o.kind || b.kind;
    if (b.mode !== undefined || !partial) {
      const allowed = kind === "account" ? ["commenters", "followers"] : kind === "post" ? ["commenters", "likers", "both"] : [""];
      o.mode = allowed.includes(b.mode) ? b.mode : allowed[0];
    }
    if (b.role !== undefined) o.role = b.role === "customers" ? "customers" : "peers";
    if (b.enabled !== undefined) { o.enabled = b.enabled ? 1 : 0; if (b.enabled) o.pause_reason = ""; }
    return o;
  }

  /* ---- the plan the finder downloads ---- */
  function plan(account) {
    const types = db.all("SELECT lt.* FROM lead_types lt JOIN clients c ON c.id = lt.client_id WHERE lt.enabled = 1 AND c.active = 1");
    const ids = new Set(types.map((t) => t.id));
    const leadTypes = types.map((r) => { const t = typeOut(r); return { id: "srv_lt_" + t.id, name: t.name, description: t.description, include: t.include, includeMode: t.includeMode,
      exclude: t.exclude, accountTypes: t.accountTypes, minFollowers: t.minFollowers, maxFollowers: t.maxFollowers, activeWithinDays: t.activeWithinDays,
      regions: t.regions, requireContact: t.requireContact, publicOnly: t.publicOnly, borderline: t.borderline, enabled: true }; });
    const sources = db.all("SELECT * FROM sources WHERE enabled = 1 AND origin = 'server' AND lead_type_id IS NOT NULL").filter((s) => ids.has(s.lead_type_id))
      .map((s) => ({ id: "srv_src_" + s.id, leadTypeId: "srv_lt_" + s.lead_type_id, kind: s.kind, ref: s.ref, role: s.role, ...(s.mode ? { mode: s.mode } : {}), enabled: true }));
    const skip = new Set(db.all("SELECT username FROM leads ORDER BY id DESC LIMIT 6000").map((r) => r.username));
    for (const a of db.all("SELECT ig_username FROM accounts")) skip.add(a.ig_username);
    for (const u of db.setting("skip_list", [])) skip.add(lc(u).replace(/^@/, ""));
    return { profilesPerDay: accounts.profilesPerDay(account), leadTypes, sources, skipUsernames: [...skip] };
  }

  /* ---- source scoring ---- */
  function sourceStats() {
    const rows = db.all(`SELECT s.*, COUNT(l.id) AS ingested, SUM(l.verdict = 'pass') AS passed, SUM(l.verdict = 'borderline') AS borderline,
      SUM(l.review = 'approved') AS approved, SUM(l.review = 'rejected') AS rejected,
      SUM(l.review = 'approved' AND l.stage IN ('replied','interested','booked','customer')) AS replied, SUM(l.stage = 'booked') AS booked
      FROM sources s LEFT JOIN leads l ON l.source_id = s.id GROUP BY s.id ORDER BY ingested DESC`);
    return rows.map((r) => {
      const approved = r.approved || 0, rejected = r.rejected || 0, decided = approved + rejected, rate = decided ? approved / decided : null;
      let suggestion = "";
      if (decided >= 12 && rate < 0.1) suggestion = "Pause: almost nothing from here gets approved.";
      else if (r.kind === "hashtag" && decided >= 10 && rate < 0.2) suggestion = "Pause: hashtags like this mostly bring the wrong people.";
      else if (decided >= 8 && rate >= 0.5) suggestion = "Working well: add similar sources.";
      else if ((r.ingested || 0) >= 25 && decided === 0) suggestion = "Review these leads: nothing has been approved or rejected yet.";
      return { ...sourceOut(r), ingested: r.ingested || 0, passed: r.passed || 0, borderline: r.borderline || 0, approved, rejected, replied: r.replied || 0, booked: r.booked || 0, approvalRate: rate, suggestion };
    });
  }
  function autoPause() {
    for (const s of sourceStats()) if (s.enabled && s.origin === "server" && s.suggestion.startsWith("Pause")) {
      db.run("UPDATE sources SET enabled = 0, pause_reason = ? WHERE id = ?", "Paused automatically: " + s.suggestion.replace(/^Pause: /, ""), s.id);
    }
  }
  /* Words that show up in rejected bios and never in approved ones: candidates for the rule-out list. */
  function excludeSuggestions(leadTypeId) {
    const lt = db.get("SELECT * FROM lead_types WHERE id = ?", leadTypeId); if (!lt) return [];
    const have = new Set([...j(lt.include, []), ...j(lt.exclude, [])].map((w) => lc(w).replace(/\*$/, "")));
    const tally = (review) => { const m = new Map(); for (const r of db.all("SELECT bio, category FROM leads WHERE lead_type_id = ? AND review = ?", leadTypeId, review)) {
      for (const w of new Set(`${r.bio} ${r.category}`.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [])) m.set(w, (m.get(w) || 0) + 1); } return m; };
    const bad = tally("rejected"), good = tally("approved");
    return [...bad].filter(([w, n]) => n >= 3 && !good.has(w) && !STOP.has(w) && !have.has(w)).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word, count]) => ({ word, rejected: count }));
  }

  /* ---- digest and client report ---- */
  function range(days) { const to = now(); return { from: to - clamp(Math.round(num(days, 7)), 1, 365) * DAY, to }; }
  function digest({ clientId, days = 7 } = {}) {
    const { from, to } = range(days), cw = clientId ? " AND client_id = ?" : "", cp = clientId ? [clientId] : [];
    const n = (sql, ...p) => (db.get(sql, ...p) || { n: 0 }).n || 0;
    const base = `FROM leads WHERE found_at >= ? AND found_at <= ?${cw}`;
    const found = n(`SELECT COUNT(*) AS n ${base}`, from, to, ...cp);
    const rejectedRows = db.all(`SELECT haiku_reason, review_reason, reasons FROM leads WHERE review = 'rejected' AND reviewed_at >= ? AND reviewed_at <= ?${cw}`, from, to, ...cp);
    const reasonCount = new Map();
    for (const r of rejectedRows) { const k = (r.review_reason || r.haiku_reason || j(r.reasons, [])[0] || "No reason given").replace(/^Haiku: /, "").slice(0, 80); reasonCount.set(k, (reasonCount.get(k) || 0) + 1); }
    const taskCw = clientId ? " AND client_id = ?" : "";
    const funnel = Object.fromEntries(db.all(`SELECT stage, COUNT(*) AS n FROM leads WHERE review = 'approved'${cw} GROUP BY stage`, ...cp).map((r) => [r.stage, r.n]));
    return {
      days: Math.round((to - from) / DAY), from, to,
      found, pass: n(`SELECT COUNT(*) AS n ${base} AND verdict = 'pass'`, from, to, ...cp), borderline: n(`SELECT COUNT(*) AS n ${base} AND verdict = 'borderline'`, from, to, ...cp),
      autoRejected: n(`SELECT COUNT(*) AS n ${base} AND review = 'rejected' AND review_reason LIKE 'Haiku:%'`, from, to, ...cp),
      approved: n(`SELECT COUNT(*) AS n FROM leads WHERE review = 'approved' AND reviewed_at >= ? AND reviewed_at <= ?${cw}`, from, to, ...cp),
      rejected: rejectedRows.length, pendingReview: n(`SELECT COUNT(*) AS n FROM leads WHERE review = 'pending'${cw}`, ...cp),
      messagesSent: n(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'dm' AND status = 'done' AND result_code = 'sent' AND done_at >= ? AND done_at <= ?${taskCw}`, from, to, ...cp),
      followupsSent: n(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'followup' AND status = 'done' AND result_code = 'sent' AND done_at >= ? AND done_at <= ?${taskCw}`, from, to, ...cp),
      replies: n(`SELECT COUNT(DISTINCT m.lead_id) AS n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.direction = 'in' AND m.ts * 1000 >= ? AND m.ts * 1000 <= ?${clientId ? " AND l.client_id = ?" : ""}`, from, to, ...cp),
      booked: n(`SELECT COUNT(*) AS n FROM leads WHERE booked_at >= ? AND booked_at <= ?${cw}`, from, to, ...cp),
      repliesWaiting: n(`SELECT COUNT(*) AS n FROM tasks WHERE type = 'reply' AND status = 'draft'${taskCw}`, ...cp),
      funnel, topRejectReasons: [...reasonCount].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, count]) => ({ reason, count })),
      topSources: sourceStats().filter((s) => s.approved > 0).sort((a, b) => b.approved - a.approved).slice(0, 5).map((s) => ({ label: s.label, approved: s.approved, ingested: s.ingested }))
    };
  }
  function report({ clientId, days = 7 }) {
    const client = clientId ? db.get("SELECT * FROM clients WHERE id = ?", clientId) : null;
    const d = digest({ clientId, days });
    const line = (k, v) => `- ${k}: ${v}`;
    return [`# ${client ? client.name + ": " : ""}Last ${d.days} days`, "",
      "## Finding", line("People found", d.found), line("Good matches", d.pass), line("Needed a closer look", d.borderline), line("Approved to contact", d.approved), line("Rejected", d.rejected), "",
      "## Conversations", line("First messages sent", d.messagesSent), line("Follow-ups sent", d.followupsSent), line("People who replied", d.replies), line("Calls booked", d.booked), "",
      "## Where things stand", ...Object.entries(d.funnel).map(([k, v]) => line(k.replace(/_/g, " "), v)), "",
      ...(d.topSources.length ? ["## Best sources", ...d.topSources.map((s) => line(s.label, `${s.approved} approved of ${s.ingested}`))] : [])].join("\n");
  }
  return { typeOut, sourceOut, parseType, parseSource, plan, sourceStats, autoPause, excludeSuggestions, digest, report };
}
module.exports = { createFinder };
