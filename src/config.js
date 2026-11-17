const path = require("node:path");
function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    dbPath: env.DB_PATH || path.join(process.cwd(), "data", "magnetengine.db"),
    adminPassword: env.ADMIN_PASSWORD || "",
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    anthropicBase: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    haikuModel: env.HAIKU_MODEL || "claude-haiku-5-5",
    dailyTokenCap: Number(env.HAIKU_DAILY_TOKEN_CAP) || 400_000,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),
    defaultTz: env.DEFAULT_TZ || "America/New_York",
    allowPrivateFetch: env.ALLOW_PRIVATE_FETCH === "1"      // tests only: lets enrichment reach localhost
  };
}
module.exports = { loadConfig };
