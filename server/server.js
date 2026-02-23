import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const cfgPath = path.join(__dirname, "config.json");
  const examplePath = path.join(__dirname, "config.example.json");
  const p = fs.existsSync(cfgPath) ? cfgPath : examplePath;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const cfg = loadConfig();

const app = express();

// Local-only by default
const HOST = cfg.host || "127.0.0.1";
const PORT = cfg.port || 8787;

const ALLOWED_HOSTS = new Set(cfg.allowedHosts || []);
const MAX_BYTES = Number(cfg.maxBytes ?? 2_000_000);
const TIMEOUT_MS = Number(cfg.timeoutMs ?? 10_000);

function isHttpUrl(u) {
  return u.protocol === "http:" || u.protocol === "https:";
}

async function fetchWithLimits(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: "manual",
      headers: {
        "User-Agent": "LocalFeedDashboard/1.0 (+http://localhost)"
      }
    });

    // Block redirects (prevents escaping allowlist via 30x)
    if (r.status >= 300 && r.status < 400) {
      throw new Error(`Redirect blocked (${r.status})`);
    }

    if (!r.ok) {
      throw new Error(`Upstream HTTP ${r.status}`);
    }

    // Stream + cap bytes
    const reader = r.body?.getReader();
    if (!reader) return await r.text();

    let total = 0;
    const chunks = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        throw new Error(`Response too large (> ${MAX_BYTES} bytes)`);
      }
      chunks.push(value);
    }

    const buf = Buffer.concat(chunks.map(v => Buffer.from(v)));
    return buf.toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  // Only return non-sensitive config fields
  res.json({
    feeds: (cfg.feeds || []).map(f => ({ name: f.name, url: f.url }))
  });
});

app.get("/api/fetch", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl || typeof rawUrl !== "string") {
      return res.status(400).json({ error: "Missing url param" });
    }

    const u = new URL(rawUrl);

    if (!isHttpUrl(u)) {
      return res.status(400).json({ error: "Only http/https allowed" });
    }

    if (ALLOWED_HOSTS.size && !ALLOWED_HOSTS.has(u.hostname)) {
      return res.status(403).json({ error: `Host not allowed: ${u.hostname}` });
    }

    const xml = await fetchWithLimits(u.toString());

    res.set("Content-Type", "text/xml; charset=utf-8");
    res.send(xml);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Start
app.listen(PORT, HOST, () => {
  console.log(`Proxy running at http://${HOST}:${PORT}`);
});