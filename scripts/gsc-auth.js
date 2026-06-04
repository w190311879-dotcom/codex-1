import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const scopes = [
  "https://www.googleapis.com/auth/webmasters.readonly"
];

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

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function exchangeCode({ client, code, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  const response = await fetch(client.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Token exchange failed: ${response.status}`);
  }
  return data;
}

loadDotEnvFile();

const clientFile = resolveProjectPath(process.env.GSC_OAUTH_CLIENT_FILE, "secret/google-oauth-client.json");
const tokenFile = resolveProjectPath(process.env.GSC_OAUTH_TOKEN_FILE, "secret/google-oauth-token.json");
const rawClient = JSON.parse(await fs.readFile(clientFile, "utf8"));
const client = rawClient.installed || rawClient.web;

if (!client?.client_id || !client?.client_secret) {
  throw new Error(`Invalid OAuth client file: ${clientFile}`);
}

const server = http.createServer();
const codeResult = new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const parsed = new URL(req.url || "/", "http://127.0.0.1");
    if (parsed.pathname !== "/oauth2callback") {
      res.writeHead(404).end("Not found");
      return;
    }
    const error = parsed.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(`授权失败：${error}`);
      server.close();
      reject(new Error(`OAuth error: ${error}`));
      return;
    }
    const code = parsed.searchParams.get("code");
    const callbackPort = server.address().port;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=\"utf-8\"><title>授权完成</title><h1>授权完成</h1><p>可以关闭这个页面，回到终端继续。</p>");
    server.close();
    resolve({ code, redirectUri: `http://127.0.0.1:${callbackPort}/oauth2callback` });
  });
  server.on("error", reject);
});
await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).on("error", reject));

const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
const authUrl = new URL(client.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", client.client_id);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", scopes.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("请在浏览器完成 Google 授权：");
console.log(authUrl.toString());
openBrowser(authUrl.toString());

const result = await codeResult;
if (!result.code) throw new Error("OAuth callback did not include a code");

const token = await exchangeCode({ client, code: result.code, redirectUri: result.redirectUri });
const output = {
  ...token,
  created_at: Date.now(),
  expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : 0
};

await fs.mkdir(path.dirname(tokenFile), { recursive: true });
await fs.writeFile(tokenFile, JSON.stringify(output, null, 2), { mode: 0o600 });
console.log(`Search Console OAuth token written to ${path.relative(projectRoot, tokenFile)}`);
