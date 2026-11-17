/* Contact enrichment: read a lead's bio link and pull out emails, phone numbers and business links.
   The URL comes from a stranger's Instagram bio, so every request is guarded against server-side
   request forgery: public addresses only (checked again at connect time), web ports only,
   a few redirects, a short timeout and a size limit. */
const dns = require("node:dns");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const dotted = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    if (x.startsWith("::ffff:") || x.startsWith("64:ff9b:")) return true;
    const first = parseInt(x.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}
function safeLookup(allowPrivate) {
  return (hostname, opts, cb) => {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    const wantAll = !!(opts && opts.all);
    dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = addrs.filter((a) => allowPrivate || !isPrivateIp(a.address));
      if (!ok.length) return cb(new Error("blocked_address"));
      return wantAll ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
    });
  };
}

function fetchPage(rawUrl, { allowPrivate = false, timeoutMs = 8000, maxBytes = 1_500_000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (urlStr, hops) => {
      let u; try { u = new URL(urlStr); } catch { return reject(new Error("bad_url")); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("bad_protocol"));
      if (u.username || u.password) return reject(new Error("bad_url"));
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(host) && !allowPrivate && isPrivateIp(host)) return reject(new Error("blocked_address"));
      if (!allowPrivate && u.port && !["80", "443"].includes(u.port)) return reject(new Error("blocked_port"));
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(u, { method: "GET", lookup: safeLookup(allowPrivate), timeout: timeoutMs,
        headers: { "user-agent": "Mozilla/5.0 (compatible; MagnetEngineBot/1.0)", accept: "text/html,application/xhtml+xml" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= maxRedirects) return reject(new Error("too_many_redirects"));
          return go(new URL(res.headers.location, u).toString(), hops + 1);
        }
        if (res.statusCode >= 400) { res.resume(); return reject(new Error("http_" + res.statusCode)); }
        const type = String(res.headers["content-type"] || "");
        if (type && !/text\/html|xhtml|text\/plain/i.test(type)) { res.resume(); return reject(new Error("not_html")); }
        const chunks = []; let size = 0;
        res.on("data", (c) => { size += c.length; if (size > maxBytes) { res.destroy(); resolve({ url: u.toString(), html: Buffer.concat(chunks).toString("utf8") }); } else chunks.push(c); });
        res.on("end", () => resolve({ url: u.toString(), html: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    };
    go(rawUrl, 0);
  });
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$|^(sentry|noreply|no-reply|example|your|name|email|user)@|@(example\.com|sentry\.io|wixpress\.com|domain\.com)$/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g;
const SOCIAL = [["facebook", /facebook\.com\//i], ["linkedin", /linkedin\.com\//i], ["tiktok", /tiktok\.com\//i], ["youtube", /youtube\.com\//i], ["yelp", /yelp\.com\//i], ["google_maps", /(google\.com\/maps|maps\.app\.goo\.gl|g\.page)/i], ["x", /(^|\/\/)(www\.)?(twitter|x)\.com\//i], ["whatsapp", /(wa\.me|api\.whatsapp\.com)\//i], ["calendly", /calendly\.com\//i]];

function extractContacts(text, html = "") {
  const hay = String(text || "") + " " + String(html || "");
  const emails = [...new Set([...hay.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()).filter((e) => !BAD_EMAIL.test(e)))].slice(0, 5);
  const phones = new Set();
  for (const m of String(html || "").matchAll(/href=["']tel:([^"']+)["']/gi)) { const d = m[1].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); if (d.length === 10) phones.add(d); }
  for (const m of hay.matchAll(PHONE_RE)) phones.add(m[1] + m[2] + m[3]);
  const links = {};
  for (const m of String(html || "").matchAll(/href=["'](https?:\/\/[^"'#\s]+)["']/gi)) for (const [name, re] of SOCIAL) if (!links[name] && re.test(m[1])) links[name] = m[1].slice(0, 200);
  const title = (String(html || "").match(/<title[^>]*>([^<]{1,160})<\/title>/i) || [])[1] || "";
  return { emails, phones: [...phones].slice(0, 3).map((d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`), links, title: title.replace(/\s+/g, " ").trim() };
}

async function enrich({ bio = "", externalUrl = "", email = "" }, opts = {}) {
  const fromBio = extractContacts(`${bio} ${email}`);
  let site = null, error = "";
  if (externalUrl) {
    try {
      const url = /^https?:\/\//i.test(externalUrl) ? externalUrl : "https://" + externalUrl;
      const page = await fetchPage(url, opts);
      site = { url: page.url, ...extractContacts("", page.html) };
    } catch (e) { error = e.message; }
  }
  const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  return {
    emails: merge(fromBio.emails, site?.emails).slice(0, 5), phones: merge(fromBio.phones, site?.phones).slice(0, 3),
    links: site?.links || {}, site: site ? { url: site.url, title: site.title } : null, error, at: Date.now()
  };
}
module.exports = { isPrivateIp, fetchPage, extractContacts, enrich, safeLookup };
