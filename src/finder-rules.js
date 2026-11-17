/* Finder rules. Pure functions only (no browser APIs), so the background worker, the page reader,
   the setup page and the Node tests all use exactly the same logic. */
const FinderRules = (() => {
  const US = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware",
    FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky",
    LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri",
    MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina",
    ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
    SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia",
    WI: "wisconsin", WY: "wyoming", DC: "district of columbia" };
  const CA = { AB: "alberta", BC: "british columbia", MB: "manitoba", NB: "new brunswick", NL: "newfoundland and labrador", NS: "nova scotia",
    NT: "northwest territories", NU: "nunavut", ON: "ontario", PE: "prince edward island", QC: "quebec", SK: "saskatchewan", YT: "yukon" };
  const ALL = { ...US, ...CA };
  const NAME_TO_CODE = Object.fromEntries(Object.entries(ALL).map(([c, n]) => [n, c]));
  const NON_NA = /(?:^|[^a-z])(united kingdom|england|scotland|wales|australia|new zealand|india|pakistan|bangladesh|nigeria|ghana|kenya|south africa|egypt|dubai|uae|saudi|turkey|germany|france|spain|italy|portugal|netherlands|ireland|brazil|argentina|colombia|philippines|indonesia|malaysia|singapore|london|sydney|melbourne|mumbai|delhi|lagos|manchester|berlin|paris|madrid|dubai)(?![a-z])/i;

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();

  /* A word matches whole words only. A trailing * means "starts with": roof* matches roofing and roofer. */
  function wordRe(w) {
    w = norm(w);
    const prefix = w.endsWith("*"); if (prefix) w = w.slice(0, -1).trim();
    if (!w) return null;
    return new RegExp(`(?:^|[^a-z0-9])${esc(w).replace(/ /g, "\\s+")}${prefix ? "[a-z0-9]*" : "(?![a-z0-9])"}`, "i");
  }
  const hits = (words, text) => { const out = []; for (const w of words || []) { const re = wordRe(w); if (re && re.test(text)) out.push(String(w).trim()); } return out; };
  const splitWords = (s) => [...new Set(String(s || "").split(/[\n,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

  const stateCode = (x) => { const u = String(x || "").trim().toUpperCase(); if (ALL[u]) return u; return NAME_TO_CODE[norm(x)] || ""; };

  /* "Austin, TX" -> city + state. "Texas" -> a whole state. Anything outside the US and Canada is refused. */
  function parseRegionLine(line) {
    const t = String(line || "").trim(); if (!t) return null;
    const parts = t.split(",").map((x) => x.trim()).filter(Boolean);
    const city = parts.length > 1 ? parts.slice(0, -1).join(", ") : "";
    const code = stateCode(parts[parts.length - 1]);
    if (!code) return { error: `"${t}": use a US state or Canadian province, like "Austin, TX", "Toronto, ON" or "Texas".` };
    return { city, state: code, label: city ? `${city}, ${code}` : ALL[code].replace(/\b\w/g, (c) => c.toUpperCase()) };
  }

  /* ---------- sources: what the person typed -> a page the finder can open ---------- */
  function normalizeSourceRef(kind, raw) {
    const t = String(raw || "").trim();
    if (!t) return { ok: false, error: "Enter something to look at." };
    if (kind === "location") {
      const m = t.match(/explore\/locations\/(\d+)(?:\/([^/?#]+))?/i) || t.match(/^(\d+)(?:\/([^/?#]+))?\/?$/);   // a pasted address, or the form saved earlier
      if (!m) return { ok: false, error: "Paste the Instagram location page address, like https://www.instagram.com/explore/locations/123456/austin-texas/" };
      const slug = (m[2] || "").toLowerCase();
      const broad = new Set(["united-states", "usa", "us", "canada", "north-america", "america", ...Object.values(ALL).map((n) => n.replace(/ /g, "-"))]);
      if (broad.has(slug)) return { ok: false, error: "That location is too broad. Pick a city or a smaller area." };
      return { ok: true, ref: m[1] + (slug ? "/" + slug : ""), path: `/explore/locations/${m[1]}/${slug ? slug + "/" : ""}` };
    }
    if (kind === "hashtag") {
      const tag = t.replace(/^.*explore\/tags\//i, "").replace(/^#/, "").replace(/[/?#].*$/, "");
      if (!/^[\p{L}\p{N}_]{2,60}$/u.test(tag)) return { ok: false, error: "A hashtag can only have letters, numbers and underscores." };
      return { ok: true, ref: "#" + tag.toLowerCase(), path: `/explore/tags/${encodeURIComponent(tag.toLowerCase())}/` };
    }
    if (kind === "post") {
      const m = t.match(/(?:^|\/)(?:p|reel)\/([\w-]{5,})/) || t.match(/^([\w-]{5,})$/);   // a pasted address, or the code saved earlier
      if (!m) return { ok: false, error: "Paste the post address, like https://www.instagram.com/p/AbC123xyz/" };
      return { ok: true, ref: m[1], path: `/p/${m[1]}/`, likedByPath: `/p/${m[1]}/liked_by/` };
    }
    if (kind === "account") {
      const u = t.replace(/^.*instagram\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
      if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) return { ok: false, error: "Enter an Instagram username, like @acmeroofing" };
      return { ok: true, ref: u.toLowerCase(), path: `/${u.toLowerCase()}/` };
    }
    return { ok: false, error: "Unknown source type." };
  }
  const KIND_LABEL = { location: "Location", hashtag: "Hashtag", post: "Post", account: "Account" };
  const sourceLabel = (s) => {
    const mode = s.kind === "account" ? (s.mode === "followers" ? "followers of" : "commenters on") : s.kind === "post" ? ({ likers: "likers of post", both: "commenters and likers of post" }[s.mode] || "commenters on post") : KIND_LABEL[s.kind]?.toLowerCase();
    return s.kind === "account" ? `${mode} @${s.ref}` : s.kind === "location" ? `location ${String(s.ref).split("/")[1] || s.ref}` : `${mode} ${s.ref}`;
  };

  /* ---------- reading what Instagram's own pages already loaded ---------- */
  function eachNode(root, fn) {
    const stack = [root]; let n = 0;
    while (stack.length && n++ < 80000) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      fn(o);
      if (Array.isArray(o)) { for (let i = o.length - 1; i >= 0; i--) stack.push(o[i]); }
      else for (const k in o) { const v = o[k]; if (v && typeof v === "object") stack.push(v); }
    }
  }
  const USER_RE = /^[A-Za-z0-9._]{1,30}$/;

  /* Finds people in a JSON payload, with the caption or comment that surfaced them (a hint for later). */
  function harvestUsers(root, out) {
    const ctx = new Map();
    eachNode(root, (o) => {
      const owner = o.user && o.user.username ? o.user : o.owner && o.owner.username ? o.owner : null;
      if (owner) {
        const t = o.caption && typeof o.caption.text === "string" ? o.caption.text : typeof o.text === "string" ? o.text : "";
        if (t) ctx.set(String(owner.username).toLowerCase(), t.replace(/\s+/g, " ").slice(0, 160));
      }
      if (typeof o.username === "string" && USER_RE.test(o.username) &&
          ("pk" in o || "pk_id" in o || "id" in o || "full_name" in o || "is_private" in o || "profile_pic_url" in o)) {
        const k = o.username.toLowerCase();
        if (!out.has(k)) out.set(k, { username: o.username, fullName: o.full_name || "", isPrivate: o.is_private === true, verified: o.is_verified === true, context: ctx.get(k) || "" });
      }
    });
    for (const [k, u] of out) if (!u.context && ctx.has(k)) u.context = ctx.get(k);
  }

  function parseCount(v) {
    if (typeof v === "number") return v;
    const m = String(v || "").trim().replace(/,/g, "").match(/^([\d.]+)\s*([kKmMbB])?$/);
    if (!m) return null;
    let n = parseFloat(m[1]); const u = (m[2] || "").toLowerCase();
    if (u === "k") n *= 1e3; else if (u === "m") n *= 1e6; else if (u === "b") n *= 1e9;
    return Math.round(n);
  }
  function parseOg(text) {
    const m = String(text || "").match(/([\d.,]+\s*[KkMmBb]?)\s+Followers?,\s*([\d.,]+\s*[KkMmBb]?)\s+Following,\s*([\d.,]+\s*[KkMmBb]?)\s+Posts?/i);
    return m ? { followers: parseCount(m[1].replace(/\s/g, "")), following: parseCount(m[2].replace(/\s/g, "")), posts: parseCount(m[3].replace(/\s/g, "")) } : null;
  }

  /* Builds one profile record from any JSON payloads that mention this user. Missing fields stay undefined. */
  function extractProfile(roots, username) {
    const target = String(username).toLowerCase();
    const p = { username }; const posts = [];
    const take = (k, v) => { if (v !== undefined && v !== null && p[k] === undefined) p[k] = v; };
    for (const root of roots) eachNode(root, (o) => {
      if (typeof o.username === "string" && o.username.toLowerCase() === target &&
          ("biography" in o || "follower_count" in o || "edge_followed_by" in o)) {
        take("bio", typeof o.biography === "string" ? o.biography : undefined);
        take("fullName", o.full_name);
        take("followers", o.follower_count ?? (o.edge_followed_by && o.edge_followed_by.count));
        take("following", o.following_count ?? (o.edge_follow && o.edge_follow.count));
        take("posts", o.media_count ?? (o.edge_owner_to_timeline_media && o.edge_owner_to_timeline_media.count));
        take("isPrivate", o.is_private);
        take("isVerified", o.is_verified);
        take("isBusiness", o.is_business_account ?? o.is_business);
        take("category", o.category_name ?? o.category ?? o.business_category_name);
        take("externalUrl", o.external_url ?? (Array.isArray(o.bio_links) && o.bio_links[0] && o.bio_links[0].url));
        take("email", o.public_email ?? o.business_email);
        if (typeof o.account_type === "number") take("accountType", { 1: "personal", 2: "business", 3: "creator" }[o.account_type]);
        take("city", o.city_name);
        if (typeof o.business_address_json === "string" && o.business_address_json) {
          try { const a = JSON.parse(o.business_address_json); take("address", [a.city_name, a.street_address, a.zip_code].filter(Boolean).join(", ")); } catch {}
        }
        const media = o.edge_owner_to_timeline_media;
        if (media && Array.isArray(media.edges)) for (const e of media.edges) {
          const n = e.node || {};
          posts.push({ ts: (n.taken_at_timestamp || 0) * 1000, caption: (n.edge_media_to_caption && n.edge_media_to_caption.edges && n.edge_media_to_caption.edges[0] && n.edge_media_to_caption.edges[0].node.text) || "", locationName: (n.location && n.location.name) || "" });
        }
      }
      if (Array.isArray(o.items) && o.items[0] && o.items[0].taken_at && o.items[0].user && String(o.items[0].user.username).toLowerCase() === target) {
        for (const it of o.items) posts.push({ ts: (it.taken_at || 0) * 1000, caption: (it.caption && it.caption.text) || "", locationName: (it.location && it.location.name) || "" });
      }
    });
    const seen = new Set();
    p.recentPosts = posts.filter((x) => { const k = x.ts + "|" + x.caption.slice(0, 30); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => b.ts - a.ts).slice(0, 6);
    return p;
  }
  function finishProfile(p) {
    p.lastPostAt = p.recentPosts && p.recentPosts.length && p.recentPosts[0].ts ? p.recentPosts[0].ts : undefined;
    p.dataLevel = typeof p.bio === "string" && p.followers != null ? "full" : "thin";
    return p;
  }

  /* ---------- deciding ---------- */
  function placesIn(original) {
    const codes = new Set();
    for (const m of String(original).matchAll(/,\s*([A-Z]{2})(?![A-Za-z])/g)) if (ALL[m[1]]) codes.add(m[1]);
    const low = norm(original);
    for (const [name, code] of Object.entries(NAME_TO_CODE)) if (low.includes(name) && wordRe(name).test(low)) codes.add(code);
    return codes;
  }
  function locationState(p, lt) {
    const regions = (lt.regions || []).filter((r) => r && r.state);
    if (!regions.length) return { state: "n/a", detail: "" };
    const original = [p.bio, p.fullName, p.city, p.address, ...(p.recentPosts || []).map((x) => x.locationName)].filter(Boolean).join(" | ");
    const low = norm(original), mentioned = placesIn(original);
    for (const r of regions) {
      const cityHit = r.city ? wordRe(r.city).test(low) : false;
      const stateTok = new RegExp(`(^|[^A-Za-z])${r.state}([^A-Za-z]|$)`).test(original);
      if (r.city) {
        const otherOnly = mentioned.size > 0 && !mentioned.has(r.state);
        if (cityHit && !otherOnly) return { state: "yes", detail: `mentions ${r.city}` };
        if (cityHit && stateTok) return { state: "yes", detail: `mentions ${r.city}` };
      } else if (mentioned.has(r.state)) return { state: "yes", detail: `mentions ${ALL[r.state]}` };
    }
    if (mentioned.size > 0 && !regions.some((r) => mentioned.has(r.state))) return { state: "no", detail: "names another state or province" };
    if (mentioned.size === 0 && NON_NA.test(low)) return { state: "no", detail: "looks outside the US and Canada" };
    return { state: "unknown", detail: "" };
  }

  /* Cheap check on a name and username before spending a profile view on someone. */
  function prefilter(c, lt) {
    const ex = lt.exclude || []; if (!ex.length) return "";
    const u = norm(String(c.username).replace(/[._]/g, " ")), n = norm(c.fullName), raw = String(c.username).toLowerCase();
    for (const w of ex) {
      const core = norm(w).replace(/\*$/, "").trim(); if (!core) continue;
      const re = wordRe(w);
      if ((re && (re.test(u) || re.test(n))) || (core.length >= 5 && raw.includes(core.replace(/\s+/g, "")))) return `Name says "${w}"`;
    }
    return "";
  }

  function evaluate(p, lt, now = Date.now()) {
    const inc = lt.include || [], exc = lt.exclude || [], fails = [], flags = {};
    const T = { bio: norm(p.bio), name: norm(p.fullName), cat: norm(p.category), user: norm(String(p.username || "").replace(/[._]/g, " ")),
      caps: norm((p.recentPosts || []).map((x) => x.caption).join(" | ")) };
    const head = [T.bio, T.cat, T.name, T.user].join(" | ");
    const f = p.followers, types = lt.accountTypes && lt.accountTypes.length ? lt.accountTypes : null;

    if (lt.publicOnly !== false && p.isPrivate) fails.push("Private account");
    if (f != null && lt.minFollowers && f < lt.minFollowers) fails.push(`Under ${lt.minFollowers} followers`);
    if (f != null && lt.maxFollowers && f > lt.maxFollowers) fails.push(`Over ${lt.maxFollowers} followers`);
    if (types && p.accountType && !types.includes(p.accountType)) fails.push(`Account type is ${p.accountType}`);
    if (types && p.isBusiness === false && !p.accountType && !types.includes("personal") && !types.includes("creator")) fails.push("Not a business account");
    if (types && p.isBusiness === true && !p.accountType && !types.includes("business") && !types.includes("creator")) fails.push("Business account");
    if (lt.activeWithinDays && p.lastPostAt && now - p.lastPostAt > lt.activeWithinDays * 86400000) fails.push(`No post in ${lt.activeWithinDays} days`);
    if (lt.requireContact && p.dataLevel === "full" && !(p.externalUrl || p.email)) fails.push("No website or email");
    const exHead = hits(exc, head), exCaps = hits(exc, T.caps);
    if (exHead.length) fails.push(`Profile says "${exHead[0]}"`);
    const loc = locationState(p, lt); flags.location = loc.state;
    if (loc.state === "no") fails.push(`Outside the target area (${loc.detail})`);
    if (fails.length) return { verdict: "fail", score: 0, reasons: fails, flags };
    if (p.dataLevel !== "full") return { verdict: "unreadable", score: 0, reasons: ["Could not read the profile"], flags };

    const incHead = hits(inc, head), incCaps = hits(inc, T.caps).filter((w) => !incHead.includes(w));
    const strong = inc.length ? (lt.includeMode === "all" ? inc.every((w) => incHead.includes(w)) : incHead.length > 0) : false;
    const locOk = loc.state === "yes" || loc.state === "n/a";

    let score = incHead.length ? Math.min(60, 40 + (incHead.length - 1) * 10) : incCaps.length ? 20 : 0;
    score += loc.state === "yes" ? 25 : loc.state === "n/a" ? 15 : 5;
    if (p.category || p.isBusiness) score += 5;
    if (p.externalUrl || p.email) score += 5;
    if (p.lastPostAt) score += 5;
    if (exCaps.length) score -= 25;
    score = Math.max(0, Math.min(100, score));

    if (strong && locOk && !exCaps.length)
      return { verdict: "pass", score, reasons: [`Profile mentions ${incHead.slice(0, 3).join(", ")}`, ...(loc.detail ? [`Location: ${loc.detail}`] : [])], flags };
    if (inc.length && !incHead.length && !incCaps.length)
      return { verdict: "fail", score: 0, reasons: [`No sign they are ${lt.name || "this lead type"}`], flags };

    const why = [];
    if (!inc.length) why.push("No keywords set, so it needs a closer look");
    else if (!incHead.length) why.push(`Only their posts mention ${incCaps[0]}`);
    else if (lt.includeMode === "all") why.push("Some required words are missing from the profile");
    if (loc.state === "unknown") why.push("Location is not clear");
    if (exCaps.length) why.push(`Posts mention "${exCaps[0]}"`);
    const policy = lt.borderline || "haiku";
    if (policy === "skip") return { verdict: "fail", score, reasons: ["Not clear enough: " + why.join("; ")], flags };
    return { verdict: "borderline", needsHaiku: policy === "haiku", score, reasons: why, flags };
  }

  function starterLeadType() {
    return { id: "lt_example", enabled: true, name: "Local contractors",
      description: "A local contractor or home-service business that takes jobs from homeowners (roofing, plumbing, HVAC, remodeling, landscaping). Not a marketer, coach, supplier or someone selling a course.",
      include: ["contractor*", "roofing", "roofer*", "plumb*", "hvac", "remodel*", "landscap*", "electrician*", "handyman", "painting", "construction"],
      includeMode: "any", exclude: ["seo", "marketing", "marketer", "agency", "coach", "course", "mentor", "consultant", "software", "leads"],
      accountTypes: [], minFollowers: 150, maxFollowers: 50000, activeWithinDays: 60, regions: [], requireContact: false, publicOnly: true, borderline: "haiku" };
  }

  return { ALL_REGIONS: ALL, norm, wordRe, hits, splitWords, stateCode, parseRegionLine, normalizeSourceRef, sourceLabel, KIND_LABEL,
    eachNode, harvestUsers, parseCount, parseOg, extractProfile, finishProfile, locationState, prefilter, evaluate, starterLeadType };
})();
if (typeof module !== "undefined") module.exports = FinderRules;
