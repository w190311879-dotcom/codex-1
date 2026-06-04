import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function loadDotEnvFile() {
  const envPath = path.join(projectRoot, ".env");
  try {
    const content = fsSync.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {}
}

function resolveProjectPath(value, fallback) {
  const target = value || fallback;
  return path.isAbsolute(target) ? target : path.join(projectRoot, target);
}

function isoDate(daysAgo) {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function refreshAccessToken({ client, token, tokenFile }) {
  if (token.access_token && token.expires_at && Date.now() < Number(token.expires_at) - 60_000) return token;
  if (!token.refresh_token) throw new Error("OAuth token is missing refresh_token; run npm run gsc:auth again");

  const body = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token"
  });
  const response = await fetch(client.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || `Token refresh failed: ${response.status}`);

  const next = {
    ...token,
    ...data,
    refresh_token: data.refresh_token || token.refresh_token,
    created_at: Date.now(),
    expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0
  };
  await fs.writeFile(tokenFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

async function googleJson({ url, token, method = "GET", body }) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.error_description || `Google API request failed: ${response.status}`);
  }
  return data;
}

async function searchAnalytics({ siteUrl, token, days }) {
  const endDate = isoDate(2);
  const startDate = isoDate(Math.max(3, days + 1));
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  const total = await googleJson({
    url,
    token,
    method: "POST",
    body: { startDate, endDate, rowLimit: 1 }
  });
  const keywords = await googleJson({
    url,
    token,
    method: "POST",
    body: { startDate, endDate, dimensions: ["query"], rowLimit: 20 }
  });

  const summary = total.rows?.[0] || {};
  return {
    startDate,
    endDate,
    clicks: Math.round(Number(summary.clicks || 0)),
    impressions: Math.round(Number(summary.impressions || 0)),
    keywords: (keywords.rows || []).map((row) => ({
      query: String(row.keys?.[0] || "").slice(0, 80),
      clicks: Math.round(Number(row.clicks || 0)),
      impressions: Math.round(Number(row.impressions || 0)),
      position: Number(Number(row.position || 0).toFixed(1))
    })).filter((item) => item.query)
  };
}

async function sitemapUrls(origin) {
  if (!origin) return [];
  const sitemap = new URL("/sitemap.xml", origin).toString();
  const response = await fetch(sitemap);
  if (!response.ok) return [];
  const xml = await response.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => match[1].trim());
  const postSitemaps = locs.filter((loc) => /\/sitemap-posts-\d+\.xml(?:$|\?)/.test(loc));
  const sources = postSitemaps.length ? postSitemaps : [sitemap];
  const urls = [];
  for (const source of sources) {
    const itemResponse = source === sitemap ? { ok: true, text: async () => xml } : await fetch(source);
    if (!itemResponse.ok) continue;
    const itemXml = await itemResponse.text();
    for (const match of itemXml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
      const loc = match[1].trim();
      if (!/\/detail\.html\?id=/.test(loc) && !/\/post\//.test(loc)) continue;
      urls.push(loc);
    }
  }
  return [...new Set(urls)];
}

async function inspectIndexedPages({ siteUrl, origin, token, limit }) {
  const urls = (await sitemapUrls(origin)).slice(0, limit);
  if (!urls.length) return { indexed: 0, checked: 0, urls: [] };

  let indexed = 0;
  const inspected = [];
  for (const inspectionUrl of urls) {
    try {
      const data = await googleJson({
        url: "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
        token,
        method: "POST",
        body: { inspectionUrl, siteUrl }
      });
      const result = data.inspectionResult?.indexStatusResult || {};
      const verdict = String(result.verdict || "");
      const coverageState = String(result.coverageState || "");
      const isIndexed = verdict === "PASS" || /indexed/i.test(coverageState);
      if (isIndexed) indexed += 1;
      inspected.push({ url: inspectionUrl, indexed: isIndexed, verdict, coverageState });
    } catch (error) {
      inspected.push({ url: inspectionUrl, indexed: false, error: error.message });
    }
  }
  return { indexed, checked: inspected.length, urls: inspected };
}

loadDotEnvFile();

const clientFile = resolveProjectPath(process.env.GSC_OAUTH_CLIENT_FILE, "secret/google-oauth-client.json");
const tokenFile = resolveProjectPath(process.env.GSC_OAUTH_TOKEN_FILE, "secret/google-oauth-token.json");
const snapshotFile = resolveProjectPath(process.env.GSC_SNAPSHOT_FILE, "data/search-console.json");
const rawClient = await readJson(clientFile);
const client = rawClient.installed || rawClient.web;
let token = await readJson(tokenFile);
token = await refreshAccessToken({ client, token, tokenFile });

const siteUrl = process.env.GSC_SITE_URL || "sc-domain:51cmtv.com";
const origin = (process.env.GSC_PUBLIC_ORIGIN || process.env.PUBLIC_SITE_ORIGIN || "").replace(/\/+$/, "");
const days = Number(process.env.GSC_LOOKBACK_DAYS || 28) || 28;
const inspectionLimit = Math.max(0, Math.min(200, Number(process.env.GSC_INSPECTION_LIMIT || 50) || 0));

const [analytics, inspection] = await Promise.all([
  searchAnalytics({ siteUrl, token, days }),
  inspectIndexedPages({ siteUrl, origin, token, limit: inspectionLimit })
]);

const snapshot = {
  connected: true,
  updatedAt: new Date().toISOString(),
  siteUrl,
  origin,
  period: { startDate: analytics.startDate, endDate: analytics.endDate },
  indexedPages: inspection.indexed,
  inspectedPages: inspection.checked,
  searchClicks: analytics.clicks,
  searchImpressions: analytics.impressions,
  keywords: analytics.keywords,
  inspectedUrls: inspection.urls
};

await fs.mkdir(path.dirname(snapshotFile), { recursive: true });
await fs.writeFile(snapshotFile, JSON.stringify(snapshot, null, 2));
console.log(`Search Console snapshot written to ${path.relative(projectRoot, snapshotFile)}`);
