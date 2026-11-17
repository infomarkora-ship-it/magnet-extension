const http = require("node:http");
const path = require("node:path");
const { loadConfig } = require("./config");
const { openDb } = require("./db");
const { createJobs } = require("./jobs");
const { createAuth } = require("./auth");
const { createHaiku } = require("./haiku");
const { createAccounts } = require("./accounts");
const { createLeads } = require("./leads");
const { createScheduler } = require("./scheduler");
const { createFinder } = require("./finder");
const { registerExt } = require("./ext");
const { registerApi } = require("./api");
const { send, readJson, parseCookies, isHttps, clientIp, serveStatic, createRouter } = require("./http");
const { HttpError } = require("./util");

function createApp(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  const db = openDb(cfg.dbPath);
  const jobs = createJobs(overrides.logger || console);
  const auth = createAuth(db, cfg);
  const haiku = createHaiku(cfg, db);
  const ctx = { cfg, db, jobs, auth, haiku };
  ctx.accounts = createAccounts(ctx);
  ctx.leads = createLeads(ctx);
  ctx.finder = createFinder(ctx);
  ctx.scheduler = createScheduler(ctx);

  const ext = createRouter(), api = createRouter();
  registerExt(ext, ctx);
  registerApi(api, ctx);

  async function handle(req, res) {
    const url = new URL(req.url, "http://x"), pathname = url.pathname;
    try {
      if (pathname === "/health") return send(res, 200, { ok: true, db: !!db.get("SELECT 1 AS x") });

      const router = pathname.startsWith("/ext/") ? ext : pathname.startsWith("/api/") ? api : null;
      if (!router) {
        if (req.method === "GET" && serveStatic(path.join(__dirname, "..", "public"), pathname, res)) return;
        return send(res, 404, { error: "Not found" });
      }
      // dashboard auth
      const isApi = router === api;
      if (isApi && pathname !== "/api/login" && pathname !== "/api/session") {
        if (!auth.sessionOk(parseCookies(req.headers.cookie).me_session)) return send(res, 401, { error: "Please sign in." });
      }
      if (req.method !== "GET" && req.method !== "HEAD" && isApi && !String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "Send JSON." });

      if (isApi && pathname === "/api/session" && req.method === "GET") {
        const authed = auth.sessionOk(parseCookies(req.headers.cookie).me_session);
        return send(res, 200, { authed, setupNeeded: !cfg.adminPassword, ...(authed ? { haiku: haiku.status() } : {}) });
      }
      if (isApi && pathname === "/api/login" && req.method === "POST") {
        const ip = clientIp(req), body = await readJson(req);
        if (!cfg.adminPassword) return send(res, 503, { error: "Set the ADMIN_PASSWORD environment variable, then restart the server." });
        if (auth.throttled(ip)) return send(res, 429, { error: "Too many attempts. Try again in a few minutes." });
        if (!auth.passwordOk(body.password)) { auth.noteFail(ip); return send(res, 401, { error: "That password is not right." }); }
        return send(res, 200, { ok: true }, { "set-cookie": `me_session=${encodeURIComponent(auth.makeSession())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.SESSION_MS / 1000)}${isHttps(req) ? "; Secure" : ""}` });
      }
      if (isApi && pathname === "/api/logout" && req.method === "POST") return send(res, 200, { ok: true }, { "set-cookie": "me_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });

      const m = router.match(req.method, pathname);
      if (!m) return send(res, router.pathExists(pathname) ? 405 : 404, { error: "Not found" });
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
      const out = await m.route.handler({ req, res, params: m.params, query: url.searchParams, body });
      if (out && out.__text !== undefined) return send(res, 200, out.__text, { "content-type": "text/markdown; charset=utf-8" });
      return send(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
      console.error(`${req.method} ${pathname}:`, e);
      return send(res, 500, { error: "Something went wrong on the server." });
    }
  }

  const server = http.createServer(handle);
  let timer = null;
  const maintain = () => { try { ctx.scheduler.maintain(); } catch (e) { console.error("maintain:", e.message); } };
  return {
    cfg, db, jobs, ctx, server, maintain,
    listen(port = cfg.port) { return new Promise((r) => server.listen(port, () => { timer = setInterval(maintain, 60_000); timer.unref(); maintain(); r(server.address().port); })); },
    async close() { clearInterval(timer); await new Promise((r) => server.close(r)); await jobs.drain(); db.close(); }
  };
}

if (require.main === module) {
  const app = createApp();
  if (!app.cfg.adminPassword) console.warn("WARNING: ADMIN_PASSWORD is not set. Nobody can sign in to the dashboard until you set it.");
  if (!app.cfg.anthropicKey) console.warn("Note: ANTHROPIC_API_KEY is not set. Haiku scoring, openers and reply drafts are switched off.");
  app.listen().then((port) => console.log(`MagnetEngine server listening on ${port}`));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => app.close().then(() => process.exit(0)));
}
module.exports = { createApp };
