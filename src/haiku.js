/* Claude Haiku client. No SDK: one fetch call. Everything it returns is treated as untrusted text. */
const { now } = require("./util");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

function extractJson(text) {
  const s = String(text || ""), start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

function createHaiku(cfg, db) {
  const enabled = () => !!cfg.anthropicKey;
  const used = () => { const r = db.get("SELECT input_tokens + output_tokens AS t FROM usage WHERE day = ?", today()); return r ? r.t : 0; };
  const record = (u) => db.run(`INSERT INTO usage(day, input_tokens, output_tokens, calls) VALUES(?, ?, ?, 1)
    ON CONFLICT(day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, calls = calls + 1`,
    today(), Number(u?.input_tokens) || 0, Number(u?.output_tokens) || 0);

  async function ask({ system, user, maxTokens = 400 }) {
    if (!enabled()) throw new Error("haiku_disabled");
    if (used() >= cfg.dailyTokenCap) throw new Error("haiku_budget");
    let lastErr = new Error("haiku_failed");
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const res = await fetch(`${cfg.anthropicBase}/v1/messages`, {
          method: "POST", signal: ctrl.signal,
          headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: cfg.haikuModel, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] })
        });
        if (res.status === 429 || res.status >= 500) { lastErr = new Error("haiku_http_" + res.status); await sleep(600 * 2 ** attempt); continue; }
        if (!res.ok) throw new Error("haiku_http_" + res.status);
        const data = await res.json();
        record(data.usage);
        return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      } catch (e) { lastErr = e.name === "AbortError" ? new Error("haiku_timeout") : e; if (!/haiku_http_(429|5)/.test(lastErr.message) && lastErr.message !== "haiku_timeout") throw lastErr; await sleep(600 * 2 ** attempt); }
      finally { clearTimeout(timer); }
    }
    throw lastErr;
  }
  async function askJson(args) {
    const obj = extractJson(await ask(args));
    if (!obj) throw new Error("haiku_bad_json");
    return obj;
  }
  const status = () => ({ configured: enabled(), model: cfg.haikuModel, usedToday: used(), dailyCap: cfg.dailyTokenCap,
    calls: (db.get("SELECT calls FROM usage WHERE day = ?", today()) || { calls: 0 }).calls });
  return { enabled, ask, askJson, status };
}
module.exports = { createHaiku, extractJson };
