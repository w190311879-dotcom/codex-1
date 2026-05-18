import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import pg from "pg";
import bcrypt from "bcryptjs";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 8787);
const databaseUrl = process.env.DATABASE_URL || "";
const storageMode = databaseUrl ? "postgres" : (process.env.POSTWAVE_STORAGE || "file");
const dataDir = path.join(__dirname, "data");
const postsFile = path.join(dataDir, "posts.json");
const authorsFile = path.join(dataDir, "authors.json");
const commentsFile = path.join(dataDir, "comments.json");
const uploadsDir = path.join(dataDir, "uploads");
const tempVideoDir = path.join(dataDir, "tmp-videos");
const mediaRecordsFile = path.join(dataDir, "media.json");
const sessionSecret = process.env.SESSION_SECRET || "postwave-local-dev-secret";
const sessionCookieName = "postwave_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;
const uploadLimitMb = Number(process.env.POSTWAVE_UPLOAD_LIMIT_MB || 1024);
const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobeBin = process.env.FFPROBE_PATH || "ffprobe";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimitMb * 1024 * 1024 } });
const videoUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fsSync.mkdirSync(tempVideoDir, { recursive: true });
      callback(null, tempVideoDir);
    },
    filename(_req, file, callback) {
      callback(null, `${Date.now()}-${crypto.randomUUID()}-${safeFilename(file.originalname, file.mimetype)}`);
    }
  }),
  limits: { fileSize: uploadLimitMb * 1024 * 1024 }
});
const bunnyStorageZone = process.env.BUNNY_STORAGE_ZONE || "";
const bunnyStorageAccessKey = process.env.BUNNY_STORAGE_ACCESS_KEY || "";
const bunnyStorageHost = process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com";
const bunnyCdnBaseUrl = (process.env.BUNNY_CDN_BASE_URL || "").replace(/\/+$/, "");
const useBunnyStorage = Boolean(bunnyStorageZone && bunnyStorageAccessKey && bunnyCdnBaseUrl);
const publicSiteOrigin = (process.env.PUBLIC_SITE_ORIGIN || process.env.FRONTEND_ORIGIN || "").replace(/\/+$/, "");
const publicAdminOrigin = (process.env.PUBLIC_ADMIN_ORIGIN || "").replace(/\/+$/, "");
const publicApiBaseUrl = (process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || "").replace(/\/+$/, "");
const publicMediaBaseUrl = (process.env.PUBLIC_MEDIA_BASE_URL || bunnyCdnBaseUrl || "").replace(/\/+$/, "");
function originHost(value = "") {
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return String(value).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}
const adminHost = process.env.ADMIN_HOST || originHost(publicAdminOrigin);
const apiHost = process.env.API_HOST || originHost(publicApiBaseUrl);
const mediaHost = process.env.MEDIA_HOST || originHost(publicMediaBaseUrl);
const cookieDomain = process.env.SESSION_COOKIE_DOMAIN || "";
const defaultAdmins = [
  { id: "author-alun", name: "alun", account: "alun", status: "正常", passwordHash: "$2b$12$U92wyNFjRMMT8su0BmPkE.B6CxgnrR4NyjV0seeXmhTg..2Wwih6m" },
  { id: "author-editor1", name: "编辑一号", account: "editor1", status: "正常", passwordHash: "$2b$12$4hR.YJCe/cXyJF0jc1aqeOrV1OOaqjjLzljxDgUNoZmMBVwS2NP.2" }
];
const envAdmin = process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH
  ? [{
      id: "author-env-admin",
      name: process.env.ADMIN_NAME || process.env.ADMIN_USERNAME,
      account: process.env.ADMIN_USERNAME,
      status: "正常",
      passwordHash: process.env.ADMIN_PASSWORD_HASH
    }]
  : null;
const seedAdmins = envAdmin || defaultAdmins;

app.use(express.json({ limit: "80mb" }));

const allowedOrigins = new Set([
  publicSiteOrigin,
  publicAdminOrigin,
  publicApiBaseUrl,
  publicMediaBaseUrl,
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`
].filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.has(origin) || process.env.CORS_ALLOW_ALL === "1")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

let pool = null;

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.split(/[、,\s]+/).filter(Boolean);
  return [];
}

function normalizePost(post = {}, index = 0) {
  const categories = normalizeArray(post.categories || post.category);
  return {
    ...post,
    title: post.title || "未命名帖子",
    body: post.body || "",
    cover: post.cover || post.cover_url || "",
    video: post.video || post.video_url || "",
    bodyImages: normalizeArray(post.bodyImages || post.body_images || (post.bodyImage ? [post.bodyImage] : [])),
    category: post.category || categories.join("、") || "",
    categories,
    keywords: normalizeArray(post.keywords),
    tags: normalizeArray(post.tags),
    status: post.status || "已发布",
    author: post.author || "",
    date: post.date || post.date_text || "",
    sortOrder: Number.isFinite(Number(post.sortOrder ?? post.sort_order)) ? Number(post.sortOrder ?? post.sort_order) : index
  };
}

function normalizeComment(comment = {}, index = 0) {
  return {
    id: String(comment.id || comment.comment_id || `comment-${Date.now()}-${index}`),
    postId: String(comment.postId || comment.post_id || ""),
    postTitle: String(comment.postTitle || comment.post_title || ""),
    name: String(comment.name || comment.author || ""),
    text: String(comment.text || comment.body || ""),
    status: String(comment.status || "pending"),
    time: String(comment.time || comment.created_at || new Date().toISOString()),
    createdAt: String(comment.createdAt || comment.created_at || new Date().toISOString())
  };
}

function publicAuthor(author = {}) {
  return {
    id: String(author.id || author.account || ""),
    name: author.name || "",
    account: author.account || "",
    status: author.status || "正常"
  };
}

async function authorForStorage(author = {}, existing = null, index = 0) {
  const name = String(author.name || "").trim();
  const account = String(author.account || "").trim();
  const status = String(author.status || existing?.status || "正常").trim() || "正常";
  if (!name || !account) throw new Error("作者名和账号不能为空");

  let passwordHash = author.passwordHash || author.password_hash || existing?.passwordHash || "";
  const password = String(author.password || "").trim();
  if (password) passwordHash = await bcrypt.hash(password, 12);
  if (!passwordHash) throw new Error(`作者 ${account} 缺少登录密码`);

  return {
    id: String(author.id || existing?.id || `author-${Date.now()}-${index}`),
    name,
    account,
    status,
    passwordHash
  };
}

async function seedAuthors() {
  return Promise.all(seedAdmins.map((author, index) => authorForStorage(author, null, index)));
}

function mediaFolder(kind = "", mime = "") {
  const normalized = String(kind || "").toLowerCase();
  if (normalized.includes("video") || mime.startsWith("video/")) return "videos";
  if (normalized.includes("cover")) return "covers";
  if (normalized.includes("logo")) return "logos";
  if (normalized.includes("ad")) return "ads";
  return "images";
}

function extensionFromMime(mime = "") {
  return {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov"
  }[mime] || "";
}

function safeFilename(name = "", mime = "") {
  const parsed = path.parse(name);
  const base = (parsed.name || "media").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "media";
  const ext = (parsed.ext || extensionFromMime(mime) || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  return `${base}${ext}`;
}

function createMediaStoragePath(file, kind) {
  const folder = mediaFolder(kind, file.mimetype || "");
  const day = new Date().toISOString().slice(0, 10);
  return `${folder}/${day}/${crypto.randomUUID()}-${safeFilename(file.originalname, file.mimetype)}`;
}

async function uploadFileToBunny(file, storagePath) {
  const url = `https://${bunnyStorageHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${encodeURIComponent(bunnyStorageZone)}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      AccessKey: bunnyStorageAccessKey,
      "Content-Type": file.mimetype || "application/octet-stream"
    },
    body: file.buffer
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`bunny Storage 上传失败：${response.status} ${text}`.trim());
  }
  return `${bunnyCdnBaseUrl}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadFileLocally(file, storagePath) {
  const filePath = path.join(uploadsDir, storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, file.buffer);
  return publicUploadUrl(storagePath);
}

async function uploadLocalPathToBunny(localPath, mimeType, storagePath) {
  const buffer = await fs.readFile(localPath);
  return uploadFileToBunny({ buffer, mimetype: mimeType }, storagePath);
}

async function uploadLocalPathLocally(localPath, storagePath) {
  const filePath = path.join(uploadsDir, storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.copyFile(localPath, filePath);
  return publicUploadUrl(storagePath);
}

function publicUploadUrl(storagePath) {
  const relativePath = `/uploads/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  return publicMediaBaseUrl ? `${publicMediaBaseUrl}${relativePath}` : relativePath;
}

async function uploadProcessedVideo(localPath, originalFile, metadata = {}) {
  const outputName = `${path.parse(originalFile.originalname || "video").name || "video"}.mp4`;
  const storagePath = createMediaStoragePath({ originalname: outputName, mimetype: "video/mp4" }, "video");
  const stats = await fs.stat(localPath);
  const url = useBunnyStorage
    ? await uploadLocalPathToBunny(localPath, "video/mp4", storagePath)
    : await uploadLocalPathLocally(localPath, storagePath);
  const record = {
    id: crypto.randomUUID(),
    kind: "video",
    type: "video",
    originalName: originalFile.originalname || "",
    name: outputName,
    mimeType: "video/mp4",
    size: stats.size,
    storagePath,
    storageProvider: useBunnyStorage ? "bunny" : "local",
    url,
    status: "ready",
    progress: 100,
    format: "H.264 MP4",
    quality: "medium",
    aspect: metadata.height > metadata.width ? "9-16" : "16-9",
    width: metadata.width || 0,
    height: metadata.height || 0,
    duration: metadata.duration || 0,
    segments: 1,
    createdAt: new Date().toISOString(),
    date: new Date().toLocaleString()
  };
  await saveMediaRecord(record);
  return record;
}

async function uploadMediaFile(file, kind) {
  if (!file) throw new Error("没有收到上传文件");
  const storagePath = createMediaStoragePath(file, kind);
  const url = useBunnyStorage
    ? await uploadFileToBunny(file, storagePath)
    : await uploadFileLocally(file, storagePath);
  const record = {
    id: crypto.randomUUID(),
    kind: kind || mediaFolder("", file.mimetype || ""),
    originalName: file.originalname || "",
    mimeType: file.mimetype || "application/octet-stream",
    size: file.size || file.buffer?.length || 0,
    storagePath,
    storageProvider: useBunnyStorage ? "bunny" : "local",
    url,
    createdAt: new Date().toISOString()
  };
  await saveMediaRecord(record);
  return record;
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${command} 执行失败：${stderr || `退出码 ${code}`}`));
    });
  });
}

async function probeVideo(localPath) {
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(ffprobeBin, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,duration",
        "-of", "json",
        localPath
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `ffprobe 退出码 ${code}`));
      });
    });
    const data = JSON.parse(output || "{}");
    const stream = data.streams?.[0] || {};
    return {
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      duration: Number(stream.duration) || 0
    };
  } catch {
    return { width: 0, height: 0, duration: 0 };
  }
}

async function transcodeVideoToH264(inputPath, outputPath) {
  await runProcess(ffmpegBin, [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath
  ]);
}

function parseCookies(header = "") {
  return header.split(";").reduce((cookies, item) => {
    const index = item.indexOf("=");
    if (index === -1) return cookies;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function createSession(author) {
  const payload = base64Url(JSON.stringify({
    account: author.account,
    name: author.name,
    exp: Date.now() + sessionMaxAgeSeconds * 1000
  }));
  return `${payload}.${signPayload(payload)}`;
}

function readSession(req) {
  const token = parseCookies(req.headers.cookie || "")[sessionCookieName];
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = signPayload(payload);
  const valid = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!valid) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || Date.now() > session.exp) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionCookie(value, maxAge = sessionMaxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const domain = cookieDomain ? `; Domain=${cookieDomain}` : "";
  return `${sessionCookieName}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${domain}${secure}`;
}

function requireAdminApi(req, res, next) {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.admin = session;
  next();
}

function requireAdminPage(req, res, next) {
  const session = readSession(req);
  if (!session) {
    res.redirect(`/admin-login.html?next=${encodeURIComponent(req.originalUrl || "/admin.html")}`);
    return;
  }
  req.admin = session;
  next();
}

function requestHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
}

function hostMatches(req, expectedHost) {
  if (!expectedHost) return false;
  return requestHost(req) === String(expectedHost).toLowerCase();
}

async function findAdmin(account, password) {
  const authors = await readAuthors(true);
  const author = authors.find((item) => item.account === account && item.status !== "禁用");
  if (!author?.passwordHash) return null;
  const valid = await bcrypt.compare(password, author.passwordHash);
  return valid ? publicAuthor(author) : null;
}

async function initPostgres() {
  pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      client_id TEXT UNIQUE,
      title TEXT NOT NULL DEFAULT '未命名帖子',
      body TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      video_url TEXT NOT NULL DEFAULT '',
      body_images JSONB NOT NULL DEFAULT '[]'::jsonb,
      category TEXT NOT NULL DEFAULT '',
      categories JSONB NOT NULL DEFAULT '[]'::jsonb,
      keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT '已发布',
      author TEXT NOT NULL DEFAULT '',
      date_text TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS posts_sort_order_idx ON posts (sort_order ASC, id ASC)");
  await pool.query("CREATE INDEX IF NOT EXISTS posts_status_idx ON posts (status)");
  await pool.query("CREATE INDEX IF NOT EXISTS posts_payload_gin_idx ON posts USING GIN (payload)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS authors (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      account TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '正常',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS authors_account_idx ON authors (account)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_files (
      id BIGSERIAL PRIMARY KEY,
      media_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT '',
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      storage_provider TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      duration DOUBLE PRECISION NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE media_files ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'");
  await pool.query("ALTER TABLE media_files ADD COLUMN IF NOT EXISTS width INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE media_files ADD COLUMN IF NOT EXISTS height INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE media_files ADD COLUMN IF NOT EXISTS duration DOUBLE PRECISION NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE media_files ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("CREATE INDEX IF NOT EXISTS media_files_kind_idx ON media_files (kind)");
  await pool.query("CREATE INDEX IF NOT EXISTS media_files_created_at_idx ON media_files (created_at DESC)");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id BIGSERIAL PRIMARY KEY,
      comment_id TEXT NOT NULL UNIQUE,
      post_id TEXT NOT NULL,
      post_title TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS comments_post_status_idx ON comments (post_id, status)");
  await pool.query("CREATE INDEX IF NOT EXISTS comments_status_created_at_idx ON comments (status, created_at DESC)");
  await ensureAuthorsSeeded();
}

async function initFileStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(tempVideoDir, { recursive: true });
  try {
    await fs.access(postsFile);
  } catch {
    await fs.writeFile(postsFile, "[]");
  }
  try {
    await fs.access(authorsFile);
  } catch {
    await fs.writeFile(authorsFile, "[]");
  }
  try {
    await fs.access(commentsFile);
  } catch {
    await fs.writeFile(commentsFile, "[]");
  }
  try {
    await fs.access(mediaRecordsFile);
  } catch {
    await fs.writeFile(mediaRecordsFile, "[]");
  }
  await ensureAuthorsSeeded();
}

async function readPosts() {
  if (pool) {
    const { rows } = await pool.query("SELECT payload FROM posts ORDER BY sort_order ASC, id ASC");
    return rows.map((row, index) => normalizePost(row.payload, index));
  }
  try {
    const posts = JSON.parse(await fs.readFile(postsFile, "utf8"));
    return Array.isArray(posts) ? posts.map(normalizePost) : [];
  } catch {
    return [];
  }
}

async function replacePosts(posts) {
  const nextPosts = Array.isArray(posts) ? posts.map(normalizePost) : [];
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM posts");
      for (const [index, post] of nextPosts.entries()) {
        const clientId = String(post.id || `post-${index}`);
        await client.query(
          `INSERT INTO posts
            (client_id, title, body, cover_url, video_url, body_images, category, categories, keywords, tags, status, author, date_text, sort_order, payload, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15::jsonb,NOW())`,
          [
            clientId,
            post.title,
            post.body,
            post.cover,
            post.video,
            JSON.stringify(post.bodyImages || []),
            post.category,
            JSON.stringify(post.categories || []),
            JSON.stringify(post.keywords || []),
            JSON.stringify(post.tags || []),
            post.status,
            post.author,
            post.date,
            index,
            JSON.stringify(post)
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return nextPosts;
  }
  await fs.writeFile(postsFile, JSON.stringify(nextPosts, null, 2));
  return nextPosts;
}

async function readAuthors(includeSecrets = false) {
  if (pool) {
    const { rows } = await pool.query("SELECT id::text, name, account, password_hash AS \"passwordHash\", status FROM authors ORDER BY id ASC");
    return rows.map((author) => includeSecrets ? author : publicAuthor(author));
  }
  try {
    const authors = JSON.parse(await fs.readFile(authorsFile, "utf8"));
    if (!Array.isArray(authors)) return [];
    return authors.map((author) => includeSecrets ? author : publicAuthor(author));
  } catch {
    return [];
  }
}

async function replaceAuthors(authors) {
  if (!Array.isArray(authors)) throw new Error("作者数据格式错误");
  const existingAuthors = await readAuthors(true);
  const existingById = new Map(existingAuthors.map((author) => [String(author.id), author]));
  const existingByAccount = new Map(existingAuthors.map((author) => [author.account, author]));
  const seenAccounts = new Set();
  const nextAuthors = [];

  for (const [index, author] of authors.entries()) {
    const existing = existingById.get(String(author.id || "")) || existingByAccount.get(String(author.account || ""));
    const nextAuthor = await authorForStorage(author, existing, index);
    if (seenAccounts.has(nextAuthor.account)) throw new Error(`作者账号 ${nextAuthor.account} 重复`);
    seenAccounts.add(nextAuthor.account);
    nextAuthors.push(nextAuthor);
  }

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM authors");
      for (const author of nextAuthors) {
        await client.query(
          `INSERT INTO authors (name, account, password_hash, status, updated_at)
           VALUES ($1,$2,$3,$4,NOW())`,
          [author.name, author.account, author.passwordHash, author.status]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return readAuthors(false);
  }

  await fs.writeFile(authorsFile, JSON.stringify(nextAuthors, null, 2));
  return nextAuthors.map(publicAuthor);
}

async function readComments({ postId = "", status = "" } = {}) {
  if (pool) {
    const clauses = [];
    const values = [];
    if (postId) {
      values.push(postId);
      clauses.push(`post_id = $${values.length}`);
    }
    if (status) {
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT comment_id AS id, post_id AS "postId", post_title AS "postTitle", name, body AS text, status, created_at AS "createdAt"
       FROM comments
       ${where}
       ORDER BY created_at DESC, id DESC`,
      values
    );
    return rows.map((row, index) => normalizeComment({
      ...row,
      time: relativeCommentTime(row.createdAt)
    }, index));
  }
  try {
    const comments = JSON.parse(await fs.readFile(commentsFile, "utf8"));
    return (Array.isArray(comments) ? comments : [])
      .map(normalizeComment)
      .filter((comment) => (!postId || comment.postId === postId) && (!status || comment.status === status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch {
    return [];
  }
}

function relativeCommentTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "刚刚";
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleString();
}

async function createComment(input = {}) {
  const comment = normalizeComment({
    ...input,
    id: crypto.randomUUID(),
    status: "pending",
    createdAt: new Date().toISOString(),
    time: "刚刚"
  });
  if (!comment.postId || !comment.text || !comment.name) throw new Error("评论信息不完整");
  if (comment.text.length > 2000) throw new Error("评论内容过长");
  if (pool) {
    await pool.query(
      `INSERT INTO comments (comment_id, post_id, post_title, name, body, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [comment.id, comment.postId, comment.postTitle, comment.name, comment.text, comment.status]
    );
    return comment;
  }
  const comments = await readComments();
  comments.unshift(comment);
  await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2));
  return comment;
}

async function updateCommentStatus(commentId, status) {
  if (pool) {
    const { rowCount } = await pool.query("UPDATE comments SET status = $1, updated_at = NOW() WHERE comment_id = $2", [status, commentId]);
    return rowCount > 0;
  }
  const comments = await readComments();
  const comment = comments.find((item) => item.id === commentId);
  if (!comment) return false;
  comment.status = status;
  await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2));
  return true;
}

async function deleteComment(commentId) {
  if (pool) {
    const { rowCount } = await pool.query("DELETE FROM comments WHERE comment_id = $1", [commentId]);
    return rowCount > 0;
  }
  const comments = await readComments();
  const nextComments = comments.filter((item) => item.id !== commentId);
  await fs.writeFile(commentsFile, JSON.stringify(nextComments, null, 2));
  return nextComments.length !== comments.length;
}

async function ensureAuthorsSeeded() {
  const currentAuthors = await readAuthors(true);
  if (currentAuthors.length) return;
  await replaceAuthors(await seedAuthors());
}

async function saveMediaRecord(record) {
  if (pool) {
    await pool.query(
      `INSERT INTO media_files
        (media_id, kind, original_name, mime_type, size_bytes, storage_provider, storage_path, url, status, width, height, duration, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (media_id) DO UPDATE SET
        kind = EXCLUDED.kind,
        original_name = EXCLUDED.original_name,
        mime_type = EXCLUDED.mime_type,
        size_bytes = EXCLUDED.size_bytes,
        storage_provider = EXCLUDED.storage_provider,
        storage_path = EXCLUDED.storage_path,
        url = EXCLUDED.url,
        status = EXCLUDED.status,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        duration = EXCLUDED.duration,
        metadata = EXCLUDED.metadata`,
      [
        record.id,
        record.kind,
        record.originalName,
        record.mimeType,
        record.size,
        record.storageProvider,
        record.storagePath,
        record.url,
        record.status || "ready",
        Number(record.width) || 0,
        Number(record.height) || 0,
        Number(record.duration) || 0,
        JSON.stringify(record)
      ]
    );
    return;
  }
  let records = [];
  try {
    const data = JSON.parse(await fs.readFile(mediaRecordsFile, "utf8"));
    records = Array.isArray(data) ? data : [];
  } catch {}
  records.unshift(record);
  await fs.writeFile(mediaRecordsFile, JSON.stringify(records.slice(0, 1000), null, 2));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, storage: storageMode, postgres: Boolean(pool), mediaStorage: useBunnyStorage ? "bunny" : "local" });
});

app.get("/config.js", (_req, res) => {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "no-store");
  res.send(`window.POSTWAVE_CONFIG=${JSON.stringify({
    siteOrigin: publicSiteOrigin,
    adminOrigin: publicAdminOrigin,
    apiBaseUrl: publicApiBaseUrl,
    mediaBaseUrl: publicMediaBaseUrl
  })};`);
});

app.get("/api/session", (req, res) => {
  const session = readSession(req);
  res.json({ authenticated: Boolean(session), user: session ? { account: session.account, name: session.name } : null });
});

app.post("/api/login", async (req, res, next) => {
  try {
    const account = String(req.body?.account || "").trim();
    const password = String(req.body?.password || "").trim();
    const admin = await findAdmin(account, password);
    if (!admin) {
      res.status(401).json({ error: "账号或密码错误" });
      return;
    }
    res.setHeader("Set-Cookie", sessionCookie(createSession(admin)));
    res.json({ ok: true, user: { account: admin.account, name: admin.name } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.json({ ok: true });
});

app.get("/api/posts", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ posts: await readPosts() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/posts", requireAdminApi, async (req, res, next) => {
  try {
    const posts = Array.isArray(req.body) ? req.body : req.body?.posts;
    res.json({ ok: true, posts: await replacePosts(posts) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/authors", requireAdminApi, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ authors: await readAuthors(false) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/authors", requireAdminApi, async (req, res, next) => {
  try {
    const authors = Array.isArray(req.body) ? req.body : req.body?.authors;
    res.json({ ok: true, authors: await replaceAuthors(authors) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/comments", async (req, res, next) => {
  try {
    const postId = String(req.query.postId || "");
    const status = String(req.query.status || "approved");
    res.setHeader("Cache-Control", "no-store");
    res.json({ comments: await readComments({ postId, status }) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/comments", async (req, res, next) => {
  try {
    const comment = await createComment({
      postId: String(req.body?.postId || ""),
      postTitle: String(req.body?.postTitle || ""),
      name: String(req.body?.name || "").trim(),
      text: String(req.body?.text || "").trim()
    });
    res.json({ ok: true, comment });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/comments", requireAdminApi, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ comments: await readComments() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/admin/comments/:id", requireAdminApi, async (req, res, next) => {
  try {
    const status = String(req.body?.status || "approved");
    if (!["pending", "approved"].includes(status)) throw new Error("评论状态无效");
    const ok = await updateCommentStatus(req.params.id, status);
    if (!ok) {
      res.status(404).json({ error: "评论不存在" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/admin/comments/:id", requireAdminApi, async (req, res, next) => {
  try {
    const ok = await deleteComment(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "评论不存在" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/upload", requireAdminApi, upload.single("file"), async (req, res, next) => {
  try {
    const media = await uploadMediaFile(req.file, String(req.body?.kind || "asset"));
    res.json({ ok: true, url: media.url, media });
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/video/transcode", requireAdminApi, videoUpload.single("file"), async (req, res, next) => {
  let inputPath = req.file?.path || "";
  let outputPath = "";
  try {
    if (!req.file) throw new Error("没有收到视频文件");
    if (!String(req.file.mimetype || "").startsWith("video/")) throw new Error("请上传视频文件");
    outputPath = path.join(tempVideoDir, `${crypto.randomUUID()}-h264.mp4`);
    await transcodeVideoToH264(inputPath, outputPath);
    const metadata = await probeVideo(outputPath);
    const media = await uploadProcessedVideo(outputPath, req.file, metadata);
    res.json({ ok: true, url: media.url, media });
  } catch (error) {
    next(error);
  } finally {
    await Promise.all([inputPath, outputPath].filter(Boolean).map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
  }
});

app.get("/", (req, res, next) => {
  if (hostMatches(req, adminHost)) {
    res.redirect("/admin.html");
    return;
  }
  if (hostMatches(req, apiHost)) {
    res.redirect("/api/health");
    return;
  }
  next();
});

app.use((req, res, next) => {
  if (hostMatches(req, mediaHost) && !req.path.startsWith("/uploads/") && req.path !== "/config.js") {
    res.status(404).send("Media host only serves uploaded files.");
    return;
  }
  next();
});

app.get(["/admin.html", "/admin"], requireAdminPage, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use("/uploads", express.static(uploadsDir, { maxAge: "7d" }));
app.use(express.static(__dirname, { extensions: ["html"] }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Server error" });
});

if (storageMode === "postgres") {
  if (!databaseUrl) {
    console.error("POSTWAVE_STORAGE=postgres 需要设置 DATABASE_URL");
    process.exit(1);
  }
  await initPostgres();
} else {
  await initFileStorage();
}

app.listen(port, () => {
  console.log(`PostWave server running at http://localhost:${port}`);
  console.log(`Posts storage mode: ${storageMode}`);
});
