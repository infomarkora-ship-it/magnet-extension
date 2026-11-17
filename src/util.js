const crypto = require("node:crypto");
const now = () => Date.now();
const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const j = (v, d) => { try { const x = JSON.parse(v); return x === null || x === undefined ? d : x; } catch { return d; } };
const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const uid = (n = 16) => crypto.randomBytes(n).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const firstName = (name) => {
  const n = String(name || "").trim().split(/\s+/)[0] || "";
  return /^[\p{L}'’-]{2,20}$/u.test(n) ? n : "there";
};
const fill = (tpl, vars) => String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
const str = (v, max = 500) => String(v == null ? "" : v).replace(/\u0000/g, "").slice(0, max);
const num = (v, d = null) => { if (v === null || v === undefined || v === "") return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
module.exports = { now, DAY, HOUR, MIN, j, lc, clamp, rand, uid, sha256, HttpError, firstName, fill, str, num };
