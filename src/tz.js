/* Time zone helpers with no dependencies. */
const fmtCache = new Map();
function parts(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); fmtCache.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}
const validTz = (tz) => { try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; } catch { return false; } };
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (ts, tz) => { const p = parts(ts, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const localHour = (ts, tz) => { const p = parts(ts, tz); return p.h + p.mi / 60; };
function startOfDay(ts, tz) {
  const p = parts(ts, tz), guess = Date.UTC(p.y, p.m - 1, p.d);
  const lp = parts(guess, tz), offset = Date.UTC(lp.y, lp.m - 1, lp.d, lp.h, lp.mi) - guess;
  let start = guess - offset;
  const sp = parts(start, tz), minutes = sp.h * 60 + sp.mi;
  if (minutes) start += (sp.d === p.d ? -minutes : 24 * 60 - minutes) * 60000;
  return start;
}
module.exports = { parts, validTz, dayKey, localHour, startOfDay };
