const crypto = require("node:crypto");
const { sha256, uid, now } = require("./util");

function createAuth(db, cfg) {
  let secret = db.setting("session_secret");
  if (!secret) { secret = crypto.randomBytes(32).toString("hex"); db.setSetting("session_secret", secret); }
  const hmac = (s) => crypto.createHmac("sha256", secret).update(s).digest("base64url");
  const SESSION_MS = 14 * 24 * 3600_000;

  const passwordOk = (given) => {
    if (!cfg.adminPassword) return false;
    const a = crypto.createHash("sha256").update(String(given || "")).digest();
    const b = crypto.createHash("sha256").update(cfg.adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const makeSession = () => { const exp = String(now() + SESSION_MS); return `${exp}.${hmac(exp)}`; };
  const sessionOk = (value) => {
    const [exp, sig] = String(value || "").split(".");
    if (!exp || !sig || Number(exp) < now()) return false;
    const want = hmac(exp);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  };
  // login throttling: 8 attempts per 10 minutes per IP
  const attempts = new Map();
  const throttled = (ip) => { const t = now(), list = (attempts.get(ip) || []).filter((x) => t - x < 600_000); attempts.set(ip, list); return list.length >= 8; };
  const noteFail = (ip) => { const l = attempts.get(ip) || []; l.push(now()); attempts.set(ip, l); };

  const newToken = () => "acc_" + uid(32);
  const hashToken = (t) => sha256(t);
  return { passwordOk, makeSession, sessionOk, throttled, noteFail, newToken, hashToken, SESSION_MS };
}
module.exports = { createAuth };
