const fs = require("node:fs");
const path = require("node:path");
const { HttpError } = require("./util");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const SECURITY = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cache-control": "no-store"
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === "object" && !Buffer.isBuffer(body);
  const data = isObj || body === null ? JSON.stringify(body ?? {}) : body;
  res.writeHead(status, { ...SECURITY, "content-type": isObj || body === null ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", ...headers });
  res.end(data);
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, "Request too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {}; } catch { throw new HttpError(400, "Body must be valid JSON"); }
}
const parseCookies = (h) => Object.fromEntries(String(h || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const isHttps = (req) => !!req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";

function serveStatic(root, urlPath, res) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) && file !== root) return false;
  let stat; try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, { ...SECURITY, "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

/* Minimal router: add(method, "/api/things/:id", handler). Handlers get {req, res, params, query, body}. */
function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = []; const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
    routes.push({ method, re, keys, handler, opts });
  };
  const match = (method, pathname) => {
    for (const r of routes) { if (r.method !== method) continue; const m = r.re.exec(pathname); if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; }
    return null;
  };
  const pathExists = (pathname) => routes.some((r) => r.re.test(pathname));
  return { add, match, pathExists, get: (p, h, o) => add("GET", p, h, o), post: (p, h, o) => add("POST", p, h, o), patch: (p, h, o) => add("PATCH", p, h, o), put: (p, h, o) => add("PUT", p, h, o), del: (p, h, o) => add("DELETE", p, h, o) };
}
module.exports = { send, readJson, parseCookies, isHttps, clientIp, serveStatic, createRouter };
