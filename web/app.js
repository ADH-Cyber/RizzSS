// web/app.js

const PROXY_BASE = ""; // same-origin (since web is served by the proxy server)

function parseXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("XML parse error");
  return doc;
}

function parseDateSafe(s) {
  if (!s) return new Date(0);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function text(node, selector) {
  return node.querySelector(selector)?.textContent?.trim() || "";
}

function parseRssItems(doc, sourceName) {
  const items = Array.from(doc.querySelectorAll("item"));
  return items.map((it) => {
    const title = text(it, "title");
    const link = text(it, "link");
    const pubDate = parseDateSafe(text(it, "pubDate"));
    const guid = text(it, "guid") || link || title;

    return { id: guid, source: sourceName, title, link, date: pubDate };
  });
}

function parseAtomEntries(doc, sourceName) {
  const entries = Array.from(doc.querySelectorAll("entry"));
  return entries.map((en) => {
    const title = text(en, "title");
    const updated = text(en, "updated") || text(en, "published");
    const date = parseDateSafe(updated);

    // Atom link: <link href="...">
    const linkEl = en.querySelector("link");
    const link = linkEl?.getAttribute("href") || text(en, "link");

    const id = text(en, "id") || link || title;

    return { id, source: sourceName, title, link, date };
  });
}

function parseFeed(xmlText, sourceName) {
  const doc = parseXml(xmlText);

  // RSS
  if (doc.querySelector("rss, channel, item")) {
    const rss = parseRssItems(doc, sourceName);
    if (rss.length) return rss;
  }

  // Atom
  if (doc.querySelector("feed, entry")) {
    const atom = parseAtomEntries(doc, sourceName);
    if (atom.length) return atom;
  }

  return [];
}

async function getConfig() {
  const res = await fetch(`${PROXY_BASE}/api/config`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Config HTTP ${res.status}`);
  return res.json();
}

async function fetchFeed(url, name) {
  const encoded = encodeURIComponent(url);
  const res = await fetch(`${PROXY_BASE}/api/fetch?url=${encoded}`, { cache: "no-store" });
  if (!res.ok) {
    // server errors are JSON; try to show the message
    let msg = `Fetch HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  const xmlText = await res.text();
  return parseFeed(xmlText, name);
}

function renderStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function renderItems(items) {
  const container = document.getElementById("feed");
  container.innerHTML = "";

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "item";

    const a = document.createElement("a");
    a.href = it.link || "#";
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = it.title || "(no title)";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.source} • ${it.date.toLocaleString()}`;

    div.appendChild(a);
    div.appendChild(meta);
    container.appendChild(div);
  }
}

async function refresh() {
  renderStatus("Loading...");
  document.getElementById("feed").innerHTML = "";

  try {
    const config = await getConfig();

    if (!config.feeds || !config.feeds.length) {
      renderStatus("No feeds configured (check /api/config).");
      return;
    }

    let all = [];
    const errors = [];

    for (const f of config.feeds) {
      try {
        const items = await fetchFeed(f.url, f.name);
        all.push(...items);
      } catch (e) {
        errors.push(`${f.name}: ${e.message || e}`);
      }
    }

    // Deduplicate
    const seen = new Set();
    all = all.filter((x) => (seen.has(x.id) ? false : seen.add(x.id)));

    // Sort newest first
    all.sort((a, b) => b.date - a.date);

    renderItems(all);

    if (errors.length) {
      renderStatus(`Loaded ${all.length} items (some feeds failed; open console for details).`);
      console.error("Feed errors:", errors);
    } else {
      renderStatus(`Loaded ${all.length} items`);
    }
  } catch (e) {
    renderStatus(`Error: ${e.message || e}`);
    console.error(e);
  }
}

document.getElementById("refreshBtn").addEventListener("click", refresh);
refresh();