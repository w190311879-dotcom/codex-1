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
import { runMigrations } from "./scripts/db-migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fsSync.existsSync(envPath)) return;
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
}

loadDotEnvFile();

const app = express();
app.disable("x-powered-by");
const port = Number(process.env.PORT || 8787);
const databaseUrl = process.env.DATABASE_URL || "";
const storageMode = databaseUrl ? "postgres" : (process.env.POSTWAVE_STORAGE || "file");
const dataDir = path.join(__dirname, "data");
const postsFile = path.join(dataDir, "posts.json");
const authorsFile = path.join(dataDir, "authors.json");
const usersFile = path.join(dataDir, "users.json");
const commentsFile = path.join(dataDir, "comments.json");
const siteSettingsFile = path.join(dataDir, "site-settings.json");
const analyticsFile = path.join(dataDir, "analytics.json");
const searchConsoleFile = path.join(dataDir, "search-console.json");
const uploadsDir = path.join(dataDir, "uploads");
const tempUploadDir = path.join(dataDir, "tmp-uploads");
const tempVideoDir = path.join(dataDir, "tmp-videos");
const tempVideoChunkDir = path.join(dataDir, "tmp-video-chunks");
const mediaRecordsFile = path.join(dataDir, "media.json");
const isProduction = process.env.NODE_ENV === "production";
const defaultSessionSecret = "postwave-local-dev-secret";
const sessionSecret = process.env.SESSION_SECRET || (isProduction ? "" : defaultSessionSecret);
const sessionCookieName = "postwave_session";
const userSessionCookieName = "postwave_user_session";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;
const legacyUploadLimitMb = Number(process.env.POSTWAVE_UPLOAD_LIMIT_MB || 0);
const imageUploadLimitMb = Number(process.env.POSTWAVE_IMAGE_UPLOAD_LIMIT_MB || legacyUploadLimitMb || 100);
const videoUploadLimitMb = Number(process.env.POSTWAVE_VIDEO_UPLOAD_LIMIT_MB || legacyUploadLimitMb || 5120);
const videoChunkLimitMb = Math.max(5, Number(process.env.POSTWAVE_VIDEO_CHUNK_MB || 50) || 50);
const videoChunkBytes = Math.floor(videoChunkLimitMb * 1024 * 1024 * 0.9);
const transcodeConcurrency = Math.max(1, Number(process.env.POSTWAVE_TRANSCODE_CONCURRENCY || 1) || 1);
const hlsSegmentSeconds = Math.max(2, Number(process.env.POSTWAVE_HLS_SEGMENT_SECONDS || 10) || 10);
const bunnyHlsUploadConcurrency = Math.min(12, Math.max(1, Number(process.env.POSTWAVE_BUNNY_UPLOAD_CONCURRENCY || 8) || 8));
const hlsLandscapeMaxWidth = 1280;
const hlsLandscapeMaxHeight = 720;
const hlsPortraitMaxWidth = 720;
const hlsPortraitMaxHeight = 1280;
const loginRateWindowMs = Math.max(60, Number(process.env.POSTWAVE_LOGIN_RATE_WINDOW_SECONDS || 900) || 900) * 1000;
const loginRateMaxAttempts = Math.max(3, Number(process.env.POSTWAVE_LOGIN_RATE_MAX || 10) || 10);
const analyticsRetentionDays = Math.max(1, Number(process.env.POSTWAVE_ANALYTICS_RETENTION_DAYS || 14) || 14);
const analyticsMaxEvents = Math.max(1000, Number(process.env.POSTWAVE_ANALYTICS_MAX_EVENTS || 50000) || 50000);
const analyticsOnlineWindowMs = Math.max(60, Number(process.env.POSTWAVE_ANALYTICS_ONLINE_SECONDS || 300) || 300) * 1000;
const siteStatusCacheMs = Math.max(10, Number(process.env.POSTWAVE_SITE_STATUS_CACHE_SECONDS || 30) || 30) * 1000;
const demoSeedEnabled = process.env.POSTWAVE_ENABLE_DEMO_SEED === undefined
  ? !isProduction
  : ["1", "true", "yes", "on"].includes(String(process.env.POSTWAVE_ENABLE_DEMO_SEED).toLowerCase());
const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobeBin = process.env.FFPROBE_PATH || "ffprobe";
const allowedImageMimes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"]);
const allowedVideoMimes = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "application/octet-stream"]);
const imageUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fsSync.mkdirSync(tempUploadDir, { recursive: true });
      callback(null, tempUploadDir);
    },
    filename(_req, file, callback) {
      callback(null, `${Date.now()}-${crypto.randomUUID()}-${safeFilename(file.originalname, file.mimetype)}`);
    }
  }),
  limits: { fileSize: imageUploadLimitMb * 1024 * 1024 },
  fileFilter(_req, file, callback) {
    callback(allowedImageMimes.has(file.mimetype) ? null : new Error("只允许上传 JPG、PNG、WEBP、GIF、SVG 图片"), allowedImageMimes.has(file.mimetype));
  }
});
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
  limits: { fileSize: videoUploadLimitMb * 1024 * 1024 },
  fileFilter(_req, file, callback) {
    const allowed = isAllowedVideoFile(file.originalname, file.mimetype);
    callback(allowed ? null : new Error("只允许上传 MP4、MOV、WEBM、MKV 视频"), allowed);
  }
});
const videoChunkUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fsSync.mkdirSync(tempUploadDir, { recursive: true });
      callback(null, tempUploadDir);
    },
    filename(_req, _file, callback) {
      callback(null, `${Date.now()}-${crypto.randomUUID()}.part`);
    }
  }),
  limits: { fileSize: videoChunkLimitMb * 1024 * 1024 }
});
const bunnyStorageZone = process.env.BUNNY_STORAGE_ZONE || "";
const bunnyStorageAccessKey = process.env.BUNNY_STORAGE_ACCESS_KEY || "";
const bunnyStorageHost = process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com";
const bunnyCdnBaseUrl = (process.env.BUNNY_CDN_BASE_URL || "").replace(/\/+$/, "");
const useBunnyStorage = Boolean(bunnyStorageZone && bunnyStorageAccessKey && bunnyCdnBaseUrl);
const publicSiteOrigin = (process.env.PUBLIC_SITE_ORIGIN || process.env.FRONTEND_ORIGIN || "").replace(/\/+$/, "");
function splitList(value = "") {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function uniqueList(items = []) {
  return Array.from(new Set(items.filter(Boolean)));
}
function normalizeOrigin(value = "") {
  return String(value || "").replace(/\/+$/, "");
}
function normalizeHost(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\[([^\]]+)\](?::\d+)?$/, "$1")
    .replace(/:\d+$/, "");
}
const publicSiteOrigins = uniqueList([
  publicSiteOrigin,
  ...splitList(process.env.PUBLIC_SITE_ORIGINS).map(normalizeOrigin)
]);
const publicAdminOrigin = (process.env.PUBLIC_ADMIN_ORIGIN || "").replace(/\/+$/, "");
const publicApiBaseUrl = (process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || "").replace(/\/+$/, "");
const publicMediaBaseUrl = (process.env.PUBLIC_MEDIA_BASE_URL || bunnyCdnBaseUrl || "").replace(/\/+$/, "");
const publicUploadOrigin = (process.env.PUBLIC_UPLOAD_ORIGIN || "").replace(/\/+$/, "");
const routeSelectorOrigin = normalizeOrigin(process.env.ROUTE_SELECTOR_ORIGIN || "");
const routeSelectorTitle = process.env.ROUTE_SELECTOR_TITLE || "51春梦";
const routeSelectorSubtitle = process.env.ROUTE_SELECTOR_SUBTITLE || "看片吃瓜，把心动留给你。";
const routeSelectorEmail = String(process.env.ROUTE_SELECTOR_EMAIL || "").trim();
const routeLineOrigins = uniqueList(splitList(process.env.ROUTE_LINE_ORIGINS).map(normalizeOrigin));
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
const uploadHost = process.env.UPLOAD_HOST || originHost(publicUploadOrigin);
const routeSelectorHost = process.env.ROUTE_SELECTOR_HOST || originHost(routeSelectorOrigin);
const fixedRouteEntryHosts = uniqueList(splitList(process.env.ROUTE_ENTRY_HOSTS || process.env.ENTRY_HOSTS).map(normalizeHost));
const siteHosts = uniqueList([
  ...publicSiteOrigins.map(originHost),
  ...routeLineOrigins.map(originHost),
  ...splitList(process.env.SITE_HOSTS).map(normalizeHost)
]);
const routeLines = (routeLineOrigins.length ? routeLineOrigins : publicSiteOrigins).map((origin, index) => ({
  label: `线路${["一", "二", "三", "四", "五"][index] || index + 1}`,
  origin,
  host: originHost(origin)
}));
let cachedRoutingSettings = { entryHosts: [] };
const cookieDomain = process.env.SESSION_COOKIE_DOMAIN || "";
const cspConnectSources = ["'self'", publicApiBaseUrl, publicMediaBaseUrl, publicAdminOrigin, publicUploadOrigin, routeSelectorOrigin, ...publicSiteOrigins, ...routeLineOrigins].filter(Boolean);
const cspMediaSources = ["'self'", "blob:", "data:", publicMediaBaseUrl].filter(Boolean);
const cspImageSources = ["'self'", "data:", "blob:", publicMediaBaseUrl, "https://images.unsplash.com"].filter(Boolean);
const cspScriptSources = ["'self'", "'unsafe-inline'"];
const cspStyleSources = ["'self'", "'unsafe-inline'"];
const defaultAdmins = [
  { id: "author-alun", name: "alun", account: "alun", status: "正常", passwordHash: "$2b$12$U92wyNFjRMMT8su0BmPkE.B6CxgnrR4NyjV0seeXmhTg..2Wwih6m" },
  { id: "author-editor1", name: "编辑一号", account: "editor1", status: "正常", passwordHash: "$2b$12$4hR.YJCe/cXyJF0jc1aqeOrV1OOaqjjLzljxDgUNoZmMBVwS2NP.2" }
];
const defaultAdminHashes = new Set(defaultAdmins.map((admin) => admin.passwordHash));
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

function validateProductionSecurityConfig() {
  if (!isProduction) return;
  const errors = [];
  const adminHash = process.env.ADMIN_PASSWORD_HASH || "";
  if (!sessionSecret || sessionSecret === defaultSessionSecret || sessionSecret.includes("change-this") || sessionSecret.length < 32) {
    errors.push("SESSION_SECRET 必须设置为至少 32 位的随机密钥，不能使用默认开发密钥。");
  }
  if (!process.env.ADMIN_USERNAME || !adminHash) {
    errors.push("生产环境必须设置 ADMIN_USERNAME 和 ADMIN_PASSWORD_HASH，不能使用内置默认后台账号。");
  }
  if (adminHash && (adminHash.includes("replace-with") || defaultAdminHashes.has(adminHash) || !/^\$2[aby]\$\d{2}\$/.test(adminHash))) {
    errors.push("ADMIN_PASSWORD_HASH 必须是你自己生成的 bcrypt 哈希，不能使用占位值或内置默认哈希。");
  }
  if (process.env.CORS_ALLOW_ALL === "1") {
    errors.push("生产环境不能开启 CORS_ALLOW_ALL=1，请显式配置允许的站点域名。");
  }
  if (errors.length) {
    console.error("生产环境安全配置不完整：");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
}

validateProductionSecurityConfig();
const defaultSiteSettings = {
  siteConfig: {
    siteName: "51春梦",
    logoImage: "",
    commentLogoText: "51暗网",
    tabs: [
      { name: "首页", subtitle: "精选图文与视频内容，按发布时间聚合展示。" },
      { name: "视频", subtitle: "视频内容列表，适合接入媒体 CDN 和在线播放。" },
      { name: "图文", subtitle: "图片、长文和专题内容的展示入口。" },
      { name: "影评", subtitle: "影评、片单和内容推荐的聚合页面。" },
      { name: "旅行", subtitle: "旅行路线、风景图集和短视频合集。" },
      { name: "科技", subtitle: "科技资讯、工具教程和产品观察。" },
      { name: "专题", subtitle: "按主题整理的合集页面。" }
    ]
  },
  ads: [
    { title: "长条广告位 01", desc: "这里可以放活动、App 下载、商务合作或频道推广。", link: "app.html", placement: "home-banner" },
    { title: "长条广告位 02", desc: "后台可以新增、删除和调整这些广告内容。", link: "admin.html", placement: "detail-banner" }
  ],
  adConfig: { station: 10, latest: 10, friend: 10 },
  routing: {
    entryHosts: []
  },
  emailAutoReply: {
    from: "51视频最新地址 <get@51cmtv.com>",
    subject: "51视频最新地址",
    text: "最新地址 🍉🍉🍉 (本信息更新时间 2026-05-20)\n\n\n\n51视频最新官网 https://51cmtv.com  请把网址或者群分享给身边有需要的人，您的转发、分享是我们前进的动力😘～"
  },
  footer: {
    introText: "51春梦是一个内容展示站，页面结构包含频道导航、搜索、分页内容流、热门推荐、可控广告位、App 与社群入口，以及合规与版权说明区域。",
    quickLinks: [
      { label: "首页", href: "/", icon: "home" },
      { label: "App", href: "app.html", icon: "smartphone", action: "app-placeholder" },
      { label: "Q群", href: "qq.html", icon: "message-circle" },
      { label: "网站导航", href: "#site-map", icon: "map" }
    ],
    footerLinks: [
      { label: "往期回顾", href: "#archive" },
      { label: "回家的路", href: "/" },
      { label: "我要投稿", href: "admin-login.html" },
      { label: "商务合作", href: "mailto:business@example.com" },
      { label: "加入我们", href: "mailto:join@example.com" },
      { label: "关于我们", href: "#about" }
    ],
    topLinks: {
      app: { href: "app.html", action: "app-placeholder" },
      group: { href: "qq.html" },
      telegram: { href: "https://t.me/example_group" },
      x: { href: "https://x.com/example" }
    },
    socialLinks: [
      { label: "X", href: "https://x.com/example", icon: "text:x" },
      { label: "Telegram", href: "https://t.me/example_group", icon: "send" }
    ],
    legalLinks: [
      { label: "用户协议", href: "#terms" },
      { label: "隐私政策", href: "#privacy" },
      { label: "DMCA", href: "#dmca" },
      { label: "2257合规声明", href: "#compliance" }
    ]
  },
  notice: "欢迎来到51春梦。公告内容可在后台维护，适合放置站点说明、更新提醒和重要通知。"
};

app.use(express.json({ limit: "80mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    `script-src ${cspScriptSources.join(" ")}`,
    `style-src ${cspStyleSources.join(" ")}`,
    `img-src ${cspImageSources.join(" ")}`,
    `media-src ${cspMediaSources.join(" ")}`,
    `connect-src ${cspConnectSources.join(" ")}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "));
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

const allowedOrigins = new Set([
  ...publicSiteOrigins,
  ...routeLineOrigins,
  routeSelectorOrigin,
  publicAdminOrigin,
  publicApiBaseUrl,
  publicMediaBaseUrl,
  publicUploadOrigin,
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CSRF-Token");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(enforceHostBoundary);

let pool = null;

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.split(/[、,\s]+/).filter(Boolean);
  return [];
}

function normalizePost(post = {}, index = 0) {
  const source = post && typeof post === "object" ? post : {};
  const categories = normalizeArray(source.categories || source.category);
  return {
    ...source,
    id: String(source.id || source.clientId || source.client_id || `post-${index}`),
    title: source.title || "未命名帖子",
    body: source.body || "",
    cover: source.cover || source.cover_url || "",
    video: source.video || source.video_url || "",
    bodyImages: normalizeArray(source.bodyImages || source.body_images || (source.bodyImage ? [source.bodyImage] : [])),
    category: source.category || categories.join("、") || "",
    categories,
    keywords: normalizeArray(source.keywords),
    tags: normalizeArray(source.tags),
    status: source.status || "已发布",
    author: source.author || "",
    date: source.date || source.date_text || "",
    sortOrder: Number.isFinite(Number(source.sortOrder ?? source.sort_order)) ? Number(source.sortOrder ?? source.sort_order) : index
  };
}

function normalizeSiteSettings(input = {}) {
  const incomingConfig = input.siteConfig || input.config || {};
  const tabs = normalizeArray(incomingConfig.tabs)
    .map((tab) => ({
      name: String(tab?.name || "").trim(),
      subtitle: String(tab?.subtitle || "").trim()
    }))
    .filter((tab) => tab.name);
  const ads = Array.isArray(input.ads) ? input.ads.map((ad) => ({
    title: String(ad?.title || ""),
    desc: String(ad?.desc || ""),
    link: String(ad?.link || "app.html"),
    image: String(ad?.image || ""),
    imageKey: String(ad?.imageKey || ""),
    slot: Number(ad?.slot) || 0,
    placement: String(ad?.placement || "home-banner")
  })) : defaultSiteSettings.ads;
  const adConfig = input.adConfig || {};
  const routing = input.routing || {};
  const entryHosts = normalizeArray(routing.entryHosts || input.routeEntryHosts || input.entryHosts)
    .map(normalizeHost)
    .filter(Boolean);
  const emailAutoReply = input.emailAutoReply || {};
  const replyText = String(emailAutoReply.text ?? defaultSiteSettings.emailAutoReply.text).trim();
  const incomingFooter = input.footer || {};
  const normalizeLink = (link, fallback = {}) => ({
    label: String(link?.label || fallback.label || "").trim(),
    href: String(link?.href || fallback.href || "#").trim() || "#",
    icon: String(link?.icon || fallback.icon || "").trim(),
    action: String(link?.action || fallback.action || "").trim()
  });
  const normalizeLinks = (links, fallbackLinks) => {
    const source = Array.isArray(links) ? links : fallbackLinks;
    const fallback = Array.isArray(fallbackLinks) ? fallbackLinks : [];
    const normalized = source.map((link, index) => normalizeLink(link, fallback[index])).filter((link) => link.label);
    return normalized.length ? normalized : fallback.map((link) => normalizeLink(link));
  };
  const normalizeTopLink = (key) => normalizeLink(incomingFooter.topLinks?.[key], defaultSiteSettings.footer.topLinks[key]);
  return {
    siteConfig: {
      siteName: String(incomingConfig.siteName || defaultSiteSettings.siteConfig.siteName).trim() || defaultSiteSettings.siteConfig.siteName,
      logoImage: "",
      commentLogoText: String(incomingConfig.commentLogoText || defaultSiteSettings.siteConfig.commentLogoText).trim() || defaultSiteSettings.siteConfig.commentLogoText,
      tabs: tabs.length ? tabs : defaultSiteSettings.siteConfig.tabs
    },
    ads,
    adConfig: {
      station: Math.max(0, Number(adConfig.station ?? defaultSiteSettings.adConfig.station) || defaultSiteSettings.adConfig.station),
      latest: Math.max(0, Number(adConfig.latest ?? defaultSiteSettings.adConfig.latest) || defaultSiteSettings.adConfig.latest),
      friend: Math.max(0, Number(adConfig.friend ?? defaultSiteSettings.adConfig.friend) || defaultSiteSettings.adConfig.friend)
    },
    routing: {
      entryHosts: uniqueList(entryHosts)
    },
    emailAutoReply: {
      from: String(emailAutoReply.from || defaultSiteSettings.emailAutoReply.from).trim() || defaultSiteSettings.emailAutoReply.from,
      subject: String(emailAutoReply.subject || defaultSiteSettings.emailAutoReply.subject).trim() || defaultSiteSettings.emailAutoReply.subject,
      text: replyText || defaultSiteSettings.emailAutoReply.text
    },
    footer: {
      introText: String(incomingFooter.introText ?? defaultSiteSettings.footer.introText),
      quickLinks: normalizeLinks(incomingFooter.quickLinks, defaultSiteSettings.footer.quickLinks),
      footerLinks: normalizeLinks(incomingFooter.footerLinks, defaultSiteSettings.footer.footerLinks),
      topLinks: {
        app: normalizeTopLink("app"),
        group: normalizeTopLink("group"),
        telegram: normalizeTopLink("telegram"),
        x: normalizeTopLink("x")
      },
      socialLinks: normalizeLinks(incomingFooter.socialLinks, defaultSiteSettings.footer.socialLinks),
      legalLinks: normalizeLinks(incomingFooter.legalLinks, defaultSiteSettings.footer.legalLinks)
    },
    notice: String(input.notice ?? defaultSiteSettings.notice)
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
    userId: String(comment.userId || comment.user_id || ""),
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

function publicUser(user = {}) {
  return {
    id: String(user.id || user.userId || user.account || ""),
    account: String(user.account || ""),
    name: String(user.name || user.displayName || user.account || ""),
    status: user.status || "正常"
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

async function userForStorage(user = {}, existing = null) {
  const account = String(user.account || existing?.account || "").trim().toLowerCase();
  const name = String(user.name || user.displayName || existing?.name || account).trim().slice(0, 40) || account;
  const status = String(user.status || existing?.status || "正常").trim() || "正常";
  if (!account || account.length < 3 || account.length > 64) throw new Error("账号长度需为 3-64 个字符");

  let passwordHash = user.passwordHash || user.password_hash || existing?.passwordHash || "";
  const password = String(user.password || "").trim();
  if (password) {
    if (password.length < 6) throw new Error("密码至少需要 6 位");
    passwordHash = await bcrypt.hash(password, 12);
  }
  if (!passwordHash) throw new Error("用户密码不能为空");

  return {
    id: String(user.id || existing?.id || crypto.randomUUID()),
    account,
    name,
    status,
    passwordHash,
    createdAt: existing?.createdAt || user.createdAt || new Date().toISOString()
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
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv"
  }[mime] || "";
}

function safeFilename(name = "", mime = "") {
  const parsed = path.parse(name);
  const base = (parsed.name || "media").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "media";
  const ext = (parsed.ext || extensionFromMime(mime) || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
  return `${base}${ext}`;
}

function isAllowedVideoFile(name = "", mime = "") {
  const ext = path.extname(name || "").toLowerCase();
  return allowedVideoMimes.has(mime) || [".mp4", ".mov", ".webm", ".mkv"].includes(ext);
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

async function uploadPathToBunny(localPath, mimeType, storagePath) {
  const url = `https://${bunnyStorageHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${encodeURIComponent(bunnyStorageZone)}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const stats = await fs.stat(localPath);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      AccessKey: bunnyStorageAccessKey,
      "Content-Type": mimeType || "application/octet-stream",
      "Content-Length": String(stats.size)
    },
    body: fsSync.createReadStream(localPath),
    duplex: "half"
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`bunny Storage 上传失败：${response.status} ${text}`.trim());
  }
  return `${bunnyCdnBaseUrl}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function deletePathFromBunny(storagePath) {
  if (!storagePath || !useBunnyStorage) return;
  const url = `https://${bunnyStorageHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${encodeURIComponent(bunnyStorageZone)}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: { AccessKey: bunnyStorageAccessKey }
  });
  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => "");
    throw new Error(`bunny Storage 删除失败：${response.status} ${text}`.trim());
  }
}

async function uploadFileLocally(file, storagePath) {
  const filePath = path.join(uploadsDir, storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (file.path) await fs.copyFile(file.path, filePath);
  else await fs.writeFile(filePath, file.buffer);
  return publicUploadUrl(storagePath);
}

async function uploadLocalPathToBunny(localPath, mimeType, storagePath) {
  return uploadPathToBunny(localPath, mimeType, storagePath);
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

async function deletePathLocally(storagePath) {
  if (!storagePath) return;
  const filePath = path.resolve(uploadsDir, storagePath);
  const uploadsRoot = path.resolve(uploadsDir);
  if (!filePath.startsWith(`${uploadsRoot}${path.sep}`)) throw new Error("媒体路径无效");
  await fs.rm(filePath, { recursive: true, force: true }).catch(() => {});
}

async function deleteStoredObject(storageProvider, storagePath) {
  if (!storagePath) return;
  if (storageProvider === "bunny") await deletePathFromBunny(storagePath);
  else await deletePathLocally(storagePath);
}

async function deleteStoredMediaObjects(record) {
  const provider = record.storageProvider || record.storage_provider || "local";
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  const hlsFiles = Array.isArray(record.hlsFiles) ? record.hlsFiles : (Array.isArray(metadata.hlsFiles) ? metadata.hlsFiles : []);
  const primaryPaths = provider === "bunny" && hlsFiles.length ? hlsFiles : [record.storagePath || record.storage_path];
  const paths = [
    ...primaryPaths,
    record.posterStoragePath,
    metadata.posterStoragePath
  ].filter(Boolean);
  for (const storagePath of Array.from(new Set(paths))) {
    await deleteStoredObject(provider, storagePath);
  }
}

function hlsMimeType(filename = "") {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".m3u8") return "application/vnd.apple.mpegurl";
  if (ext === ".ts") return "video/mp2t";
  if (ext === ".bin") return "application/octet-stream";
  return "application/octet-stream";
}

async function readHlsOutputFiles(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name !== "key_info.txt")
    .map((entry) => entry.name)
    .sort((left, right) => {
      if (left === "index.m3u8") return -1;
      if (right === "index.m3u8") return 1;
      if (left === "key.bin") return -1;
      if (right === "key.bin") return 1;
      return left.localeCompare(right);
    });
}

function hlsStorageDir(mediaId) {
  const day = new Date().toISOString().slice(0, 10);
  return `videos/${day}/${mediaId}`;
}

async function runConcurrent(items, limit, worker) {
  if (!items.length) return;
  const concurrency = Math.min(Math.max(1, limit), items.length);
  let nextIndex = 0;
  let firstError = null;
  const workers = Array.from({ length: concurrency }, async () => {
    while (!firstError) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      try {
        await worker(items[currentIndex], currentIndex);
      } catch (error) {
        firstError = error;
      }
    }
  });
  await Promise.allSettled(workers);
  if (firstError) throw firstError;
}

async function uploadHlsDirectory(outputDir, storageDir, onProgress) {
  const filenames = await readHlsOutputFiles(outputDir);
  const fileInfos = await Promise.all(filenames.map(async (filename) => {
    const localPath = path.join(outputDir, filename);
    const stats = await fs.stat(localPath);
    return {
      filename,
      localPath,
      size: stats.size,
      storagePath: `${storageDir}/${filename}`,
      mimeType: hlsMimeType(filename)
    };
  }));
  const totalSize = fileInfos.reduce((sum, item) => sum + item.size, 0);
  const storagePaths = fileInfos.map((item) => item.storagePath);
  let playlistUrl = "";
  let uploadedSize = 0;
  let uploadedFiles = 0;
  let lastProgress = 90;
  const uploadConcurrency = useBunnyStorage ? bunnyHlsUploadConcurrency : 4;
  const playlist = fileInfos.find((item) => item.filename === "index.m3u8");
  const keyFiles = fileInfos.filter((item) => item.filename === "key.bin");
  const segmentFiles = fileInfos.filter((item) => item.filename !== "index.m3u8" && item.filename !== "key.bin");
  async function markUploaded(item, fileUrl) {
    uploadedSize += item.size;
    uploadedFiles += 1;
    if (item.filename === "index.m3u8") playlistUrl = fileUrl;
    if (!totalSize || !onProgress) return;
    const progress = Math.min(99, Math.max(90, 90 + Math.floor((uploadedSize / totalSize) * 9)));
    if (progress <= lastProgress) return;
    lastProgress = progress;
    await onProgress(progress, {
      filename: item.filename,
      uploadedSize,
      totalSize,
      uploadedFiles,
      totalFiles: fileInfos.length
    });
  }
  async function uploadOne(item) {
    const fileUrl = useBunnyStorage
      ? await uploadLocalPathToBunny(item.localPath, item.mimeType, item.storagePath)
      : await uploadLocalPathLocally(item.localPath, item.storagePath);
    await markUploaded(item, fileUrl);
  }
  for (const item of keyFiles) await uploadOne(item);
  await runConcurrent(segmentFiles, uploadConcurrency, uploadOne);
  if (playlist) await uploadOne(playlist);
  return {
    url: playlistUrl || publicUploadUrl(`${storageDir}/index.m3u8`),
    storagePaths,
    totalSize,
    playlistStoragePath: `${storageDir}/index.m3u8`,
    keyStoragePath: storagePaths.find((item) => item.endsWith("/key.bin")) || ""
  };
}

async function uploadProcessedHls(outputDir, originalFile, metadata = {}, mediaId = crypto.randomUUID(), onUploadProgress) {
  const outputName = `${path.parse(originalFile.originalname || "video").name || "video"}.m3u8`;
  const storagePath = hlsStorageDir(mediaId);
  const uploaded = await uploadHlsDirectory(outputDir, storagePath, onUploadProgress);
  const record = {
    id: mediaId,
    kind: "video",
    type: "video",
    originalName: originalFile.originalname || "",
    name: outputName,
    mimeType: "application/vnd.apple.mpegurl",
    size: uploaded.totalSize,
    storagePath,
    storageProvider: useBunnyStorage ? "bunny" : "local",
    url: uploaded.url,
    status: "ready",
    progress: 100,
    format: "HLS",
    quality: "720P",
    aspect: metadata.height > metadata.width ? "9-16" : "16-9",
    width: metadata.width || 0,
    height: metadata.height || 0,
    duration: metadata.duration || 0,
    posterUrl: metadata.posterUrl || "",
    posterStoragePath: metadata.posterStoragePath || "",
    posterMediaId: metadata.posterMediaId || "",
    segments: metadata.segments || 0,
    playbackType: "hls",
    encrypted: true,
    playlistStoragePath: uploaded.playlistStoragePath,
    keyStoragePath: uploaded.keyStoragePath,
    hlsFiles: uploaded.storagePaths,
    processingMode: metadata.processingMode || "transcode",
    hlsSegmentSeconds,
    createdAt: new Date().toISOString(),
    date: new Date().toLocaleString()
  };
  await saveMediaRecord(record);
  return record;
}

async function uploadMediaFile(file, kind) {
  if (!file) throw new Error("没有收到上传文件");
  if (!allowedImageMimes.has(file.mimetype)) throw new Error("只允许上传图片/GIF 文件");
  const storagePath = createMediaStoragePath(file, kind);
  const url = useBunnyStorage
    ? (file.path ? await uploadPathToBunny(file.path, file.mimetype, storagePath) : await uploadFileToBunny(file, storagePath))
    : await uploadFileLocally(file, storagePath);
  const record = {
    id: crypto.randomUUID(),
    kind: kind || mediaFolder("", file.mimetype || ""),
    type: "image",
    originalName: file.originalname || "",
    name: file.originalname || "",
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
        "-show_entries", "stream=index,codec_type,codec_name,pix_fmt,width,height,duration:format=duration,format_name",
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
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const stream = streams.find((item) => item.codec_type === "video") || streams[0] || {};
    const audio = streams.find((item) => item.codec_type === "audio") || {};
    const format = data.format || {};
    return {
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      duration: Number(stream.duration) || Number(format.duration) || 0,
      videoCodec: String(stream.codec_name || ""),
      audioCodec: String(audio.codec_name || ""),
      pixFmt: String(stream.pix_fmt || ""),
      formatName: String(format.format_name || "")
    };
  } catch {
    return { width: 0, height: 0, duration: 0, videoCodec: "", audioCodec: "", pixFmt: "", formatName: "" };
  }
}

function parseFfmpegProgressTime(line = "") {
  const [key, value] = String(line).trim().split("=");
  if (key === "out_time_ms" || key === "out_time_us") return Number(value) / 1000000;
  if (key !== "out_time") return null;
  const match = String(value || "").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function fitHls720Dimensions(width = 0, height = 0) {
  const sourceWidth = Number(width) || 0;
  const sourceHeight = Number(height) || 0;
  if (!sourceWidth || !sourceHeight) return { width: 0, height: 0 };
  const landscape = sourceWidth >= sourceHeight;
  const maxWidth = landscape ? hlsLandscapeMaxWidth : hlsPortraitMaxWidth;
  const maxHeight = landscape ? hlsLandscapeMaxHeight : hlsPortraitMaxHeight;
  const ratio = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(2, Math.floor((sourceWidth * ratio) / 2) * 2),
    height: Math.max(2, Math.floor((sourceHeight * ratio) / 2) * 2)
  };
}

function hlsScaleFilter() {
  const ratio = `if(gte(iw,ih),min(1,min(${hlsLandscapeMaxWidth}/iw,${hlsLandscapeMaxHeight}/ih)),min(1,min(${hlsPortraitMaxWidth}/iw,${hlsPortraitMaxHeight}/ih)))`;
  return `scale='trunc(iw*${ratio}/2)*2':'trunc(ih*${ratio}/2)*2'`;
}

function canCopyToHls(metadata = {}) {
  const { width, height } = fitHls720Dimensions(metadata.width, metadata.height);
  const originalWidth = Number(metadata.width) || 0;
  const originalHeight = Number(metadata.height) || 0;
  const videoOk = String(metadata.videoCodec || "").toLowerCase() === "h264";
  const audioCodec = String(metadata.audioCodec || "").toLowerCase();
  const audioOk = !audioCodec || audioCodec === "aac";
  const pixFmt = String(metadata.pixFmt || "").toLowerCase();
  const pixOk = !pixFmt || pixFmt === "yuv420p";
  const sizeOk = width === originalWidth && height === originalHeight;
  return Boolean(videoOk && audioOk && pixOk && sizeOk);
}

async function prepareHlsEncryption(outputDir) {
  const keyPath = path.join(outputDir, "key.bin");
  const keyInfoPath = path.join(outputDir, "key_info.txt");
  const iv = crypto.randomBytes(16).toString("hex").toUpperCase();
  await fs.writeFile(keyPath, crypto.randomBytes(16));
  await fs.writeFile(keyInfoPath, `key.bin\n${keyPath}\n${iv}\n`);
  return keyInfoPath;
}

async function generateHlsVideo(inputPath, outputDir, metadata = {}, onProgress, jobId = "") {
  await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(outputDir, { recursive: true });
  const playlistPath = path.join(outputDir, "index.m3u8");
  const segmentPattern = path.join(outputDir, "segment_%05d.ts");
  const keyInfoPath = await prepareHlsEncryption(outputDir);
  const copyMode = canCopyToHls(metadata);
  const args = [
    "-y",
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-sn"
  ];
  if (copyMode) {
    args.push("-c", "copy");
  } else {
    args.push(
      "-vf", hlsScaleFilter(),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "24",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-max_muxing_queue_size", "1024"
    );
  }
  args.push(
    "-hls_time", String(hlsSegmentSeconds),
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", segmentPattern,
    "-hls_key_info_file", keyInfoPath,
    "-progress", "pipe:2",
    "-nostats",
    playlistPath
  );
  const durationSeconds = Number(metadata.duration) || 0;
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    if (jobId) activeTranscodeChildren.set(jobId, child);
    let stderr = "";
    let lastProgress = 10;
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      if (!durationSeconds) return;
      for (const line of text.split(/\r?\n/)) {
        const seconds = parseFfmpegProgressTime(line);
        if (seconds === null) continue;
        const progress = Math.max(10, Math.min(89, Math.round((seconds / durationSeconds) * 80) + 10));
        if (progress >= lastProgress + 2) {
          lastProgress = progress;
          onProgress?.(progress);
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (jobId) activeTranscodeChildren.delete(jobId);
      if (code === 0) resolve(stderr);
      else reject(new Error(`${ffmpegBin} 执行失败：${stderr || `退出码 ${code}`}`));
    });
  });
  const files = await readHlsOutputFiles(outputDir);
  const dimensions = copyMode ? { width: metadata.width || 0, height: metadata.height || 0 } : fitHls720Dimensions(metadata.width, metadata.height);
  return {
    ...metadata,
    ...dimensions,
    segments: files.filter((file) => file.endsWith(".ts")).length,
    processingMode: copyMode ? "copy" : "transcode"
  };
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

function sessionTokenFromRequest(req, cookieName = sessionCookieName) {
  return parseCookies(req.headers.cookie || "")[cookieName] || "";
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function createSession(entity, role = "admin") {
  const payload = base64Url(JSON.stringify({
    id: entity.id || "",
    account: entity.account,
    name: entity.name,
    role,
    exp: Date.now() + sessionMaxAgeSeconds * 1000
  }));
  return `${payload}.${signPayload(payload)}`;
}

function createCsrfToken(sessionToken) {
  return crypto.createHmac("sha256", sessionSecret).update(`csrf:${sessionToken}`).digest("base64url");
}

function timingSafeStringEqual(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readSession(req, cookieName = sessionCookieName, expectedRole = "") {
  const token = sessionTokenFromRequest(req, cookieName);
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  const expected = signPayload(payload);
  const valid = timingSafeStringEqual(signature, expected);
  if (!valid) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || Date.now() > session.exp) return null;
    if (expectedRole && session.role !== expectedRole) return null;
    return session;
  } catch {
    return null;
  }
}

function cookieDomainForRequest(req) {
  if (!cookieDomain || !req) return cookieDomain;
  const host = hostWithoutPort(requestHost(req));
  const normalizedDomain = String(cookieDomain).replace(/^\./, "").toLowerCase();
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`) ? cookieDomain : "";
}

function sessionCookie(value, maxAge = sessionMaxAgeSeconds, cookieName = sessionCookieName, req = null) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const requestCookieDomain = cookieDomainForRequest(req);
  const domain = requestCookieDomain ? `; Domain=${requestCookieDomain}` : "";
  return `${cookieName}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${domain}${secure}`;
}

function requireAdminApi(req, res, next) {
  const sessionToken = sessionTokenFromRequest(req, sessionCookieName);
  const session = readSession(req, sessionCookieName, "admin");
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const token = String(req.headers["x-csrf-token"] || "");
    const expected = createCsrfToken(sessionToken);
    if (!token || !timingSafeStringEqual(token, expected)) {
      res.status(403).json({ error: "CSRF token invalid" });
      return;
    }
  }
  req.admin = session;
  next();
}

function requireAdminPage(req, res, next) {
  const session = readSession(req, sessionCookieName, "admin");
  if (!session) {
    res.redirect(`/admin-login.html?next=${encodeURIComponent(req.originalUrl || "/admin.html")}`);
    return;
  }
  req.admin = session;
  next();
}

function requireUserApi(req, res, next) {
  const session = readSession(req, userSessionCookieName, "user");
  if (!session) {
    res.status(401).json({ error: "请先登录/注册后评论" });
    return;
  }
  req.user = session;
  next();
}

const loginAttempts = new Map();

function clientIp(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0]
    .trim()
    .toLowerCase() || "unknown";
}

function loginRateKeys(req, scope) {
  const account = String(req.body?.account || "").trim().toLowerCase();
  const keys = [`${scope}:ip:${clientIp(req)}`];
  if (account) keys.push(`${scope}:account:${account}`);
  return keys;
}

function currentLoginAttempts(key) {
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter((time) => now - time < loginRateWindowMs);
  if (attempts.length) loginAttempts.set(key, attempts);
  else loginAttempts.delete(key);
  return attempts;
}

function loginRateLimit(scope) {
  return (req, res, next) => {
    const keys = loginRateKeys(req, scope);
    if (keys.some((key) => currentLoginAttempts(key).length >= loginRateMaxAttempts)) {
      res.status(429).json({ error: "登录尝试过多，请稍后再试" });
      return;
    }
    req.loginRateKeys = keys;
    next();
  };
}

function recordLoginFailure(req) {
  const now = Date.now();
  for (const key of req.loginRateKeys || []) {
    const attempts = currentLoginAttempts(key);
    attempts.push(now);
    loginAttempts.set(key, attempts);
  }
}

function clearLoginFailures(req) {
  for (const key of req.loginRateKeys || []) loginAttempts.delete(key);
}

function requestHost(req) {
  return String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
}

function requestProtocol(req) {
  return String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim().toLowerCase();
}

function hostMatches(req, expectedHost) {
  if (!expectedHost) return false;
  return requestHost(req) === String(expectedHost).toLowerCase();
}

function hostInList(req, hosts = []) {
  const host = hostWithoutPort(requestHost(req));
  return hosts.some((item) => hostWithoutPort(item) === host);
}

function hostWithoutPort(host = "") {
  return String(host).toLowerCase().replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");
}

function isLocalRequest(req) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostWithoutPort(requestHost(req)));
}

function configuredHostMatches(req, expectedHost) {
  return Boolean(expectedHost) && hostMatches(req, expectedHost);
}

let analyticsWriteChain = Promise.resolve();
let siteStatusCache = { checkedAt: 0, data: [] };

function shanghaiDayStart(time = Date.now()) {
  const offset = 8 * 60 * 60 * 1000;
  return Math.floor((time + offset) / 86400000) * 86400000 - offset;
}

function stableHash(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function sanitizeAnalyticsText(value = "", maxLength = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function analyticsPath(value = "/") {
  const raw = String(value || "/").trim();
  try {
    const parsed = new URL(raw, "https://local.invalid");
    return `${parsed.pathname || "/"}${parsed.search || ""}`.slice(0, 240);
  } catch {
    return raw.startsWith("/") ? raw.slice(0, 240) : `/${raw}`.slice(0, 240);
  }
}

function analyticsHost(value = "") {
  return hostWithoutPort(normalizeHost(value || "")).slice(0, 120);
}

function detectDevice(userAgent = "", width = 0) {
  const ua = String(userAgent || "").toLowerCase();
  if (/ipad|tablet/.test(ua)) return "平板";
  if (/mobile|iphone|android/.test(ua)) return "手机";
  if (Number(width) && Number(width) < 820) return "手机";
  return "电脑";
}

function detectBrowser(userAgent = "") {
  const ua = String(userAgent || "");
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/MicroMessenger\//.test(ua)) return "微信";
  return "其他";
}

function detectOs(userAgent = "") {
  const ua = String(userAgent || "").toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) return "iOS";
  if (ua.includes("android")) return "Android";
  if (ua.includes("mac os")) return "macOS";
  if (ua.includes("windows")) return "Windows";
  return "其他";
}

function sourceFromReferrer(referrer = "", currentHost = "") {
  const value = String(referrer || "").trim();
  if (!value) return "直接访问";
  try {
    const refHost = hostWithoutPort(new URL(value).host);
    const host = hostWithoutPort(currentHost);
    if (refHost && host && (refHost === host || refHost.endsWith(`.${host}`) || host.endsWith(`.${refHost}`))) return "站内跳转";
    if (/google\./i.test(refHost)) return "Google";
    if (/bing\./i.test(refHost)) return "Bing";
    if (/baidu\./i.test(refHost)) return "百度";
    if (/yandex\./i.test(refHost)) return "Yandex";
    if (/t\.me|telegram/i.test(refHost)) return "Telegram";
    if (/x\.com|twitter\.com/i.test(refHost)) return "X";
    return refHost || "外部来源";
  } catch {
    return "外部来源";
  }
}

function searchQueryFromReferrer(referrer = "") {
  const value = String(referrer || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (/baidu\./.test(host)) return sanitizeAnalyticsText(parsed.searchParams.get("wd") || parsed.searchParams.get("word") || "", 80);
    if (/google\.|bing\.|yandex\./.test(host)) return sanitizeAnalyticsText(parsed.searchParams.get("q") || parsed.searchParams.get("text") || "", 80);
  } catch {}
  return "";
}

function numberMetric(value, min = 0, max = 60 * 60 * 1000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function readAnalyticsStore() {
  try {
    const store = JSON.parse(await fs.readFile(analyticsFile, "utf8"));
    return { events: Array.isArray(store.events) ? store.events : [] };
  } catch {
    return { events: [] };
  }
}

async function readSearchConsoleSnapshot() {
  try {
    const data = JSON.parse(await fs.readFile(searchConsoleFile, "utf8"));
    const keywords = Array.isArray(data.keywords) ? data.keywords : [];
    return {
      connected: true,
      updatedAt: data.updatedAt || "",
      indexedPages: Number(data.indexedPages || data.indexed || 0) || 0,
      searchClicks: Number(data.searchClicks || data.clicks || 0) || 0,
      searchImpressions: Number(data.searchImpressions || data.impressions || 0) || 0,
      keywords: keywords.slice(0, 12).map((item) => ({
        query: sanitizeAnalyticsText(item.query || item.keyword || "", 80),
        position: Number(item.position || item.avgPosition || 0) || 0,
        clicks: Number(item.clicks || 0) || 0,
        impressions: Number(item.impressions || 0) || 0
      })).filter((item) => item.query)
    };
  } catch {
    return { connected: false, updatedAt: "", indexedPages: 0, searchClicks: 0, searchImpressions: 0, keywords: [] };
  }
}

async function writeAnalyticsStore(store) {
  await fs.mkdir(path.dirname(analyticsFile), { recursive: true });
  await fs.writeFile(analyticsFile, JSON.stringify(store, null, 2));
}

async function ensureAnalyticsStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(analyticsFile);
  } catch {
    await writeAnalyticsStore({ events: [] });
  }
}

function normalizeAnalyticsEvent(req, input = {}) {
  const now = Date.now();
  const userAgent = String(req.headers["user-agent"] || "");
  const screen = input.screen && typeof input.screen === "object" ? input.screen : {};
  const metrics = input.metrics && typeof input.metrics === "object" ? input.metrics : {};
  const host = analyticsHost(input.host || requestHost(req));
  const clientId = sanitizeAnalyticsText(input.clientId, 128);
  const clientSessionId = sanitizeAnalyticsText(input.sessionId, 128);
  const visitorBasis = clientId || `${clientIp(req)}:${userAgent}`;
  const event = sanitizeAnalyticsText(input.event || "pageview", 32) || "pageview";
  const pathValue = analyticsPath(input.path || req.originalUrl || req.path || "/");
  const referrer = sanitizeAnalyticsText(input.referrer || req.headers.referer || "", 400);
  const allowedEvents = new Set(["pageview", "heartbeat", "redirect", "post_impression", "post_click", "performance", "video_play"]);
  return {
    id: crypto.randomUUID(),
    ts: now,
    event: allowedEvents.has(event) ? event : "pageview",
    host,
    path: pathValue,
    title: sanitizeAnalyticsText(input.title || "", 140),
    referrer,
    source: sourceFromReferrer(referrer, host),
    searchQuery: searchQueryFromReferrer(referrer),
    ipId: stableHash(clientIp(req)).slice(0, 20),
    visitorId: stableHash(`${visitorBasis}:${host}`).slice(0, 20),
    sessionId: stableHash(`${clientSessionId || visitorBasis}:${host}`).slice(0, 20),
    country: sanitizeAnalyticsText(req.headers["cf-ipcountry"] || input.country || "未知", 40) || "未知",
    device: detectDevice(userAgent, Number(screen.width || 0)),
    browser: detectBrowser(userAgent),
    os: detectOs(userAgent),
    language: sanitizeAnalyticsText(input.language || req.headers["accept-language"] || "", 60),
    viewport: {
      width: Number(screen.width || 0) || 0,
      height: Number(screen.height || 0) || 0
    },
    pageType: sanitizeAnalyticsText(input.pageType || "", 40),
    postId: sanitizeAnalyticsText(input.postId || "", 80),
    videoId: sanitizeAnalyticsText(input.videoId || "", 80),
    durationSeconds: numberMetric(input.durationSeconds, 0, 7200),
    metrics: {
      ttfbMs: numberMetric(metrics.ttfbMs, 0, 120000),
      domReadyMs: numberMetric(metrics.domReadyMs, 0, 120000),
      loadMs: numberMetric(metrics.loadMs, 0, 120000),
      fcpMs: numberMetric(metrics.fcpMs, 0, 120000)
    }
  };
}

function recordAnalyticsEvent(req, input = {}) {
  const event = normalizeAnalyticsEvent(req, input);
  analyticsWriteChain = analyticsWriteChain
    .then(async () => {
      const now = Date.now();
      const cutoff = now - analyticsRetentionDays * 86400000;
      const store = await readAnalyticsStore();
      const events = store.events.filter((item) => Number(item.ts || 0) >= cutoff);
      events.push(event);
      const trimmed = events.slice(-analyticsMaxEvents);
      await writeAnalyticsStore({ events: trimmed });
    })
    .catch((error) => console.error("analytics write failed", error));
  return analyticsWriteChain;
}

function topAnalyticsGroups(items = [], key, limit = 8) {
  const map = new Map();
  const uniques = new Map();
  for (const item of items) {
    const label = sanitizeAnalyticsText(typeof key === "function" ? key(item) : item[key], 120) || "未知";
    map.set(label, (map.get(label) || 0) + 1);
    if (!uniques.has(label)) uniques.set(label, new Set());
    if (item.visitorId) uniques.get(label).add(item.visitorId);
  }
  return [...map.entries()]
    .map(([label, count]) => ({ label, count, visitors: uniques.get(label)?.size || 0 }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

function percentile(values = [], percentileValue = 75) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const index = Math.min(numbers.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * numbers.length) - 1));
  return numbers[index];
}

function average(values = []) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (!numbers.length) return 0;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function sessionDurations(events = []) {
  const sessions = new Map();
  for (const item of events) {
    if (!item.sessionId) continue;
    const current = sessions.get(item.sessionId) || { first: item.ts, last: item.ts, events: 0, visitorId: item.visitorId };
    current.first = Math.min(current.first, item.ts);
    current.last = Math.max(current.last, item.ts);
    current.events += 1;
    sessions.set(item.sessionId, current);
  }
  return [...sessions.values()].map((session) => Math.min(7200, Math.max(0, Math.round((session.last - session.first) / 1000))));
}

function postClickThrough(impressions = [], clicks = [], limit = 10) {
  const rows = new Map();
  const ensure = (item) => {
    const key = item.postId || item.path || item.title || "unknown";
    if (!rows.has(key)) {
      rows.set(key, {
        id: key,
        title: sanitizeAnalyticsText(item.title || item.path || "未知帖子", 120),
        impressions: 0,
        clicks: 0,
        ctr: 0
      });
    }
    return rows.get(key);
  };
  for (const item of impressions) ensure(item).impressions += 1;
  for (const item of clicks) ensure(item).clicks += 1;
  return [...rows.values()]
    .map((row) => ({ ...row, ctr: row.impressions ? Math.round((row.clicks / row.impressions) * 10000) / 100 : 0 }))
    .sort((left, right) => right.clicks - left.clicks || right.impressions - left.impressions)
    .slice(0, limit);
}

function videoViews(rows = [], limit = 10) {
  const groups = new Map();
  for (const item of rows) {
    const key = item.videoId || item.postId || item.path || "unknown";
    const current = groups.get(key) || { id: key, title: sanitizeAnalyticsText(item.title || item.path || "未知视频", 120), vv: 0, visitors: new Set() };
    current.vv += 1;
    if (item.visitorId) current.visitors.add(item.visitorId);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((item) => ({ id: item.id, title: item.title, vv: item.vv, visitors: item.visitors.size }))
    .sort((left, right) => right.vv - left.vv)
    .slice(0, limit);
}

function analyticsTimeline(pageViews = [], now = Date.now()) {
  const hourMs = 60 * 60 * 1000;
  const start = Math.floor((now - 23 * hourMs) / hourMs) * hourMs;
  return Array.from({ length: 24 }, (_, index) => {
    const from = start + index * hourMs;
    const to = from + hourMs;
    const rows = pageViews.filter((item) => item.ts >= from && item.ts < to);
    return {
      ts: from,
      label: new Date(from).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }),
      pv: rows.length,
      uv: new Set(rows.map((item) => item.visitorId).filter(Boolean)).size
    };
  });
}

function analyticsTargets() {
  const targets = [];
  for (const host of routeEntryHosts()) {
    targets.push({ label: `入口 ${host}`, url: `https://${host}/` });
  }
  if (routeSelectorOrigin) targets.push({ label: `导航 ${originHost(routeSelectorOrigin)}`, url: `${routeSelectorOrigin}/` });
  for (const line of routeLines) {
    if (line.origin) targets.push({ label: line.label, url: `${line.origin}/` });
  }
  if (publicApiBaseUrl) targets.push({ label: `API ${originHost(publicApiBaseUrl)}`, url: `${publicApiBaseUrl}/api/health` });
  if (publicAdminOrigin) targets.push({ label: `后台 ${originHost(publicAdminOrigin)}`, url: `${publicAdminOrigin}/admin-login.html` });
  const seen = new Set();
  return targets.filter((target) => {
    if (!target.url || seen.has(target.url)) return false;
    seen.add(target.url);
    return true;
  }).slice(0, 10);
}

async function checkStatusTarget(target) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(target.url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal
    });
    return {
      ...target,
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      responseMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ...target,
      ok: false,
      status: 0,
      responseMs: Date.now() - startedAt,
      error: error.name === "AbortError" ? "timeout" : "request failed",
      checkedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timer);
  }
}

async function siteStatusSnapshot() {
  const now = Date.now();
  if (siteStatusCache.data.length && now - siteStatusCache.checkedAt < siteStatusCacheMs) return siteStatusCache.data;
  const data = await Promise.all(analyticsTargets().map(checkStatusTarget));
  siteStatusCache = { checkedAt: now, data };
  return data;
}

async function analyticsSummary() {
  const now = Date.now();
  const todayStart = shanghaiDayStart(now);
  const [store, searchConsole] = await Promise.all([readAnalyticsStore(), readSearchConsoleSnapshot()]);
  const events = store.events.filter((item) => Number(item.ts || 0) > 0);
  const pageViews = events.filter((item) => ["pageview", "redirect"].includes(item.event));
  const todayViews = pageViews.filter((item) => item.ts >= todayStart);
  const todayEvents = events.filter((item) => item.ts >= todayStart);
  const todayImpressions = todayEvents.filter((item) => item.event === "post_impression");
  const todayClicks = todayEvents.filter((item) => item.event === "post_click");
  const todayVideoPlays = todayEvents.filter((item) => item.event === "video_play");
  const todayPerformance = todayEvents.filter((item) => item.event === "performance");
  const todaySearchViews = todayViews.filter((item) => ["Google", "Bing", "百度", "Yandex"].includes(item.source));
  const durations = sessionDurations(todayEvents);
  const loadValues = todayPerformance.map((item) => item.metrics?.loadMs || 0);
  const ttfbValues = todayPerformance.map((item) => item.metrics?.ttfbMs || 0);
  const recentEvents = events.filter((item) => item.ts >= now - analyticsOnlineWindowMs);
  const onlineByVisitor = new Map();
  for (const item of recentEvents) {
    const current = onlineByVisitor.get(item.visitorId);
    if (!current || item.ts > current.ts) onlineByVisitor.set(item.visitorId, item);
  }
  const recentByVisitor = new Map();
  for (const item of [...events].sort((left, right) => right.ts - left.ts)) {
    if (!item.visitorId || recentByVisitor.has(item.visitorId)) continue;
    recentByVisitor.set(item.visitorId, item);
    if (recentByVisitor.size >= 24) break;
  }
  return {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    retentionDays: analyticsRetentionDays,
    onlineWindowSeconds: Math.round(analyticsOnlineWindowMs / 1000),
    overview: {
      online: onlineByVisitor.size,
      todayPv: todayViews.length,
      todayUv: new Set(todayViews.map((item) => item.visitorId).filter(Boolean)).size,
      todayIp: new Set(todayEvents.map((item) => item.ipId).filter(Boolean)).size,
      sessions: new Set(todayEvents.map((item) => item.sessionId).filter(Boolean)).size,
      avgStaySeconds: average(durations),
      searchTraffic: todaySearchViews.length,
      videoViews: todayVideoPlays.length,
      avgLoadMs: average(loadValues),
      indexedPages: searchConsole.indexedPages,
      keywordCount: searchConsole.keywords.length,
      totalPv: pageViews.length,
      events: events.length
    },
    byHost: topAnalyticsGroups(todayViews, "host", 10),
    bySource: topAnalyticsGroups(todayViews, "source", 10),
    byPath: topAnalyticsGroups(todayViews, (item) => item.title || item.path, 10),
    byDevice: topAnalyticsGroups(todayViews, "device", 6),
    byCountry: topAnalyticsGroups(todayViews, "country", 8),
    byBrowser: topAnalyticsGroups(todayViews, "browser", 8),
    byOs: topAnalyticsGroups(todayViews, "os", 8),
    searchTraffic: {
      total: todaySearchViews.length,
      sources: topAnalyticsGroups(todaySearchViews, "source", 6),
      queries: topAnalyticsGroups(todaySearchViews.filter((item) => item.searchQuery), "searchQuery", 8)
    },
    seo: {
      ...searchConsole,
      analyticsSearchTraffic: todaySearchViews.length
    },
    pageSpeed: {
      samples: todayPerformance.length,
      avgLoadMs: average(loadValues),
      p75LoadMs: percentile(loadValues, 75),
      avgTtfbMs: average(ttfbValues),
      p75TtfbMs: percentile(ttfbValues, 75),
      avgDomReadyMs: average(todayPerformance.map((item) => item.metrics?.domReadyMs || 0)),
      avgFcpMs: average(todayPerformance.map((item) => item.metrics?.fcpMs || 0))
    },
    postCtr: postClickThrough(todayImpressions, todayClicks),
    video: {
      vv: todayVideoPlays.length,
      byVideo: videoViews(todayVideoPlays)
    },
    timeline: analyticsTimeline(pageViews, now),
    online: [...onlineByVisitor.values()]
      .sort((left, right) => right.ts - left.ts)
      .slice(0, 20),
    recent: [...recentByVisitor.values()],
    status: await siteStatusSnapshot()
  };
}

function hasConfiguredSplitHosts() {
  return Boolean(
    publicSiteOrigins.length ||
    routeLineOrigins.length ||
    routeEntryHosts().length ||
    routeSelectorHost ||
    publicAdminOrigin ||
    publicApiBaseUrl ||
    publicMediaBaseUrl ||
    publicUploadOrigin ||
    adminHost ||
    apiHost ||
    mediaHost ||
    uploadHost
  );
}

function isAdminPagePath(pathname = "") {
  return pathname === "/admin" || pathname === "/admin.html" || pathname === "/admin-login.html";
}

function isPublicPagePath(pathname = "") {
  return ["/", "/index.html", "/detail.html", "/app.html", "/qq.html"].includes(pathname);
}

function isStaticHtmlPath(pathname = "") {
  return /\.html$/i.test(pathname);
}

function isSeoFilePath(pathname = "") {
  return pathname === "/robots.txt" || pathname === "/sitemap.xml";
}

function routeEntryHosts() {
  return uniqueList([...fixedRouteEntryHosts, ...(cachedRoutingSettings.entryHosts || [])]);
}

function extractEmailAddress(value = "") {
  const match = String(value || "").match(/<([^<>@\s]+@[^<>@\s]+)>|([^\s<>]+@[^\s<>]+)/);
  return match ? (match[1] || match[2]) : "";
}

function cachedSettingsMeta(settings) {
  return {
    ...(settings.routing || { entryHosts: [] }),
    email: extractEmailAddress(settings.emailAutoReply?.from) || "51sp1@proton.me"
  };
}

function routeSelectorUrl() {
  if (routeSelectorOrigin) return `${routeSelectorOrigin}/`;
  return "/route-select.html";
}

function isRouteSelectorPath(pathname = "") {
  return pathname === "/" || pathname === "/route-select.html" || pathname === "/config.js" || pathname === "/favicon.ico" || isSeoFilePath(pathname) || pathname.startsWith("/assets/") || pathname === "/vendor/lucide/lucide.min.js" || pathname === "/vendor/hls/hls.min.js" || pathname === "/vendor/dplayer/DPlayer.min.js";
}

function isEntryHostDirectAssetPath(pathname = "") {
  return pathname === "/favicon.ico" || isSeoFilePath(pathname) || pathname.startsWith("/assets/");
}

function isRestrictedInfrastructureHost(req) {
  return configuredHostMatches(req, adminHost)
    || configuredHostMatches(req, apiHost)
    || configuredHostMatches(req, mediaHost)
    || configuredHostMatches(req, uploadHost);
}

function enforceHostBoundary(req, res, next) {
  if (!hasConfiguredSplitHosts() || isLocalRequest(req)) {
    next();
    return;
  }

  if (hostInList(req, routeEntryHosts())) {
    if (isEntryHostDirectAssetPath(req.path)) {
      next();
      return;
    }
    void recordAnalyticsEvent(req, {
      event: "redirect",
      host: requestHost(req),
      path: req.originalUrl || req.path || "/",
      title: "入口跳转",
      referrer: req.headers.referer || ""
    });
    res.redirect(302, routeSelectorUrl());
    return;
  }

  if (configuredHostMatches(req, routeSelectorHost)) {
    if (!isRouteSelectorPath(req.path)) {
      res.redirect(302, "/");
      return;
    }
    next();
    return;
  }

  if (isRestrictedInfrastructureHost(req)) {
    if (req.path === "/robots.txt") {
      next();
      return;
    }
    if (req.path === "/sitemap.xml") {
      res.status(404).send("Sitemap is not available on this host.");
      return;
    }
  }

  if (configuredHostMatches(req, mediaHost)) {
    if (!req.path.startsWith("/uploads/") && req.path !== "/config.js") {
      res.status(404).send("Media host only serves uploaded files.");
      return;
    }
    next();
    return;
  }

  if (configuredHostMatches(req, apiHost)) {
    if (req.path !== "/" && !req.path.startsWith("/api/") && req.path !== "/api" && req.path !== "/config.js") {
      res.status(404).send("API host only serves API routes.");
      return;
    }
    next();
    return;
  }

  if (configuredHostMatches(req, uploadHost)) {
    if (!req.path.startsWith("/api/media/video/chunk/")) {
      res.status(404).send("Upload host only serves video chunk upload routes.");
      return;
    }
    next();
    return;
  }

  if (configuredHostMatches(req, adminHost)) {
    if (req.path.startsWith("/api/") || req.path === "/api") {
      res.status(404).send("Admin host does not serve API routes.");
      return;
    }
    if ((req.path !== "/" && isPublicPagePath(req.path)) || (isStaticHtmlPath(req.path) && !isAdminPagePath(req.path))) {
      res.status(404).send("Admin host only serves the admin panel.");
      return;
    }
    next();
    return;
  }

  if (siteHosts.length && !hostInList(req, siteHosts)) {
    if (isPublicPagePath(req.path) || req.path.startsWith("/api/") || req.path === "/api") {
      res.status(404).send("Site is only available on configured line hosts.");
      return;
    }
  }

  if (isAdminPagePath(req.path)) {
    res.status(404).send("Admin panel is only available on the admin host.");
    return;
  }

  if (apiHost && !hostInList(req, siteHosts) && (req.path.startsWith("/api/") || req.path === "/api")) {
    res.status(404).send("API is only available on the API host.");
    return;
  }

  next();
}

async function findAdmin(account, password) {
  const authors = await readAuthors(true);
  const author = authors.find((item) => item.account === account && item.status !== "禁用");
  if (!author?.passwordHash) return null;
  const valid = await bcrypt.compare(password, author.passwordHash);
  return valid ? publicAuthor(author) : null;
}

async function initPostgres() {
  await ensureAnalyticsStore();
  pool = new pg.Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
  await ensureSiteSettingsSeeded();
  await ensureAuthorsSeeded();
}

async function initFileStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(tempUploadDir, { recursive: true });
  await fs.mkdir(tempVideoDir, { recursive: true });
  await fs.mkdir(tempVideoChunkDir, { recursive: true });
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
    await fs.access(usersFile);
  } catch {
    await fs.writeFile(usersFile, "[]");
  }
  try {
    await fs.access(commentsFile);
  } catch {
    await fs.writeFile(commentsFile, "[]");
  }
  try {
    await fs.access(siteSettingsFile);
  } catch {
    await fs.writeFile(siteSettingsFile, JSON.stringify(defaultSiteSettings, null, 2));
  }
  try {
    await fs.access(mediaRecordsFile);
  } catch {
    await fs.writeFile(mediaRecordsFile, "[]");
  }
  await ensureAnalyticsStore();
  await ensureAuthorsSeeded();
}

async function readPosts() {
  if (pool) {
    const { rows } = await pool.query("SELECT client_id, payload FROM posts ORDER BY sort_order ASC, id ASC");
    return rows.map((row, index) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      return normalizePost({ ...payload, id: payload.id || row.client_id }, index);
    });
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

async function readUsers(includeSecrets = false) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT user_id AS id, account, display_name AS name, password_hash AS "passwordHash", status, created_at AS "createdAt"
       FROM users
       ORDER BY created_at DESC, id DESC`
    );
    return rows.map((user) => includeSecrets ? user : publicUser(user));
  }
  try {
    const users = JSON.parse(await fs.readFile(usersFile, "utf8"));
    if (!Array.isArray(users)) return [];
    return users.map((user) => includeSecrets ? user : publicUser(user));
  } catch {
    return [];
  }
}

async function findUser(account, password) {
  const normalizedAccount = String(account || "").trim().toLowerCase();
  const users = await readUsers(true);
  const user = users.find((item) => item.account === normalizedAccount && item.status !== "禁用");
  if (!user?.passwordHash) return null;
  const valid = await bcrypt.compare(String(password || ""), user.passwordHash);
  return valid ? publicUser(user) : null;
}

async function registerUser(input = {}) {
  const account = String(input.account || "").trim().toLowerCase();
  const users = await readUsers(true);
  if (users.some((user) => user.account === account)) throw new Error("账号已注册，请直接登录");
  const user = await userForStorage({ account, name: input.name || account, password: input.password });
  if (pool) {
    await pool.query(
      `INSERT INTO users (user_id, account, display_name, password_hash, status)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, user.account, user.name, user.passwordHash, user.status]
    );
    return publicUser(user);
  }
  users.unshift(user);
  await fs.writeFile(usersFile, JSON.stringify(users.slice(0, 100000), null, 2));
  return publicUser(user);
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
      `SELECT comment_id AS id, post_id AS "postId", post_title AS "postTitle", name, body AS text, status, user_id AS "userId", created_at AS "createdAt"
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
      `INSERT INTO comments (comment_id, post_id, post_title, name, body, status, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [comment.id, comment.postId, comment.postTitle, comment.name, comment.text, comment.status, input.userId || ""]
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

async function readSiteSettings() {
  let settings;
  if (pool) {
    const { rows } = await pool.query("SELECT payload FROM site_settings WHERE id = 1");
    settings = rows.length ? normalizeSiteSettings(rows[0].payload) : normalizeSiteSettings(defaultSiteSettings);
    cachedRoutingSettings = cachedSettingsMeta(settings);
    return settings;
  }
  try {
    settings = normalizeSiteSettings(JSON.parse(await fs.readFile(siteSettingsFile, "utf8")));
  } catch {
    settings = normalizeSiteSettings(defaultSiteSettings);
  }
  cachedRoutingSettings = cachedSettingsMeta(settings);
  return settings;
}

async function replaceSiteSettings(settings) {
  const nextSettings = normalizeSiteSettings(settings);
  cachedRoutingSettings = cachedSettingsMeta(nextSettings);
  if (pool) {
    await pool.query(
      `INSERT INTO site_settings (id, payload, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [JSON.stringify(nextSettings)]
    );
    return nextSettings;
  }
  await fs.writeFile(siteSettingsFile, JSON.stringify(nextSettings, null, 2));
  return nextSettings;
}

async function ensureSiteSettingsSeeded() {
  if (pool) {
    const { rows } = await pool.query("SELECT 1 FROM site_settings WHERE id = 1");
    if (rows.length) {
      await readSiteSettings();
      return;
    }
    await replaceSiteSettings(defaultSiteSettings);
    return;
  }
  try {
    await fs.access(siteSettingsFile);
    await readSiteSettings();
  } catch {
    await replaceSiteSettings(defaultSiteSettings);
  }
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
  const index = records.findIndex((item) => item.id === record.id || item.media_id === record.id);
  if (index >= 0) records[index] = { ...records[index], ...record };
  else records.unshift(record);
  await fs.writeFile(mediaRecordsFile, JSON.stringify(records.slice(0, 1000), null, 2));
}

function normalizeMediaRecord(record = {}, { includeInternal = false } = {}) {
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  const kind = String(record.kind || metadata.kind || "");
  const status = String(record.status || metadata.status || "ready");
  const normalized = {
    id: String(record.id || record.mediaId || record.media_id || metadata.id || ""),
    kind,
    type: String(record.type || metadata.type || (kind === "video" ? "video" : kind)),
    name: String(record.name || metadata.name || record.originalName || record.original_name || metadata.originalName || ""),
    originalName: String(record.originalName || record.original_name || metadata.originalName || ""),
    mimeType: String(record.mimeType || record.mime_type || metadata.mimeType || ""),
    size: Number(record.size ?? record.size_bytes ?? metadata.size ?? 0) || 0,
    storageProvider: String(record.storageProvider || record.storage_provider || metadata.storageProvider || ""),
    storagePath: String(record.storagePath || record.storage_path || metadata.storagePath || ""),
    url: String(record.url || metadata.url || ""),
    status,
    progress: Number(record.progress ?? metadata.progress ?? (status === "ready" ? 100 : 0)) || 0,
    format: String(record.format || metadata.format || (kind === "video" ? "HLS" : "")),
    quality: String(record.quality || metadata.quality || (kind === "video" ? "720P" : "")),
    aspect: String(record.aspect || metadata.aspect || (Number(record.height || metadata.height) > Number(record.width || metadata.width) ? "9-16" : "16-9")),
    width: Number(record.width ?? metadata.width ?? 0) || 0,
    height: Number(record.height ?? metadata.height ?? 0) || 0,
    duration: Number(record.duration ?? metadata.duration ?? 0) || 0,
    posterUrl: String(record.posterUrl || metadata.posterUrl || ""),
    posterStoragePath: String(record.posterStoragePath || metadata.posterStoragePath || ""),
    posterMediaId: String(record.posterMediaId || metadata.posterMediaId || ""),
    segments: Number(record.segments ?? metadata.segments ?? (kind === "video" ? 1 : 0)) || 0,
    playbackType: String(record.playbackType || metadata.playbackType || (kind === "video" ? "hls" : "")),
    encrypted: Boolean(record.encrypted ?? metadata.encrypted ?? false),
    processingMode: String(record.processingMode || metadata.processingMode || ""),
    playlistStoragePath: String(record.playlistStoragePath || metadata.playlistStoragePath || ""),
    keyStoragePath: String(record.keyStoragePath || metadata.keyStoragePath || ""),
    hlsSegmentSeconds: Number(record.hlsSegmentSeconds ?? metadata.hlsSegmentSeconds ?? 0) || 0,
    uploadProgress: record.uploadProgress || metadata.uploadProgress || null,
    createdAt: record.createdAt || record.created_at || metadata.createdAt || "",
    date: record.date || metadata.date || (record.created_at ? new Date(record.created_at).toLocaleString() : "")
  };
  if (includeInternal) {
    normalized.tempInputPath = record.tempInputPath || metadata.tempInputPath || "";
    normalized.originalMimeType = record.originalMimeType || metadata.originalMimeType || record.mimeType || record.mime_type || "";
    normalized.hlsFiles = Array.isArray(record.hlsFiles) ? record.hlsFiles : (Array.isArray(metadata.hlsFiles) ? metadata.hlsFiles : []);
  }
  return normalized;
}

async function readMediaRecords({ id = "", kind = "", publicOnly = false, includeInternal = false } = {}) {
  if (pool) {
    const clauses = [];
    const values = [];
    if (id) {
      values.push(id);
      clauses.push(`media_id = $${values.length}`);
    }
    if (kind) {
      values.push(kind);
      clauses.push(`kind = $${values.length}`);
    }
    if (publicOnly) {
      values.push("ready");
      clauses.push(`status = $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT media_id AS id, kind, original_name AS "originalName", mime_type AS "mimeType",
              size_bytes AS size, storage_provider AS "storageProvider", storage_path AS "storagePath",
              url, status, width, height, duration, metadata, created_at AS "createdAt"
       FROM media_files
       ${where}
       ORDER BY created_at DESC, id DESC`,
      values
    );
    return rows.map((row) => normalizeMediaRecord(row, { includeInternal }));
  }
  try {
    const records = JSON.parse(await fs.readFile(mediaRecordsFile, "utf8"));
    return (Array.isArray(records) ? records : [])
      .map((record) => normalizeMediaRecord(record, { includeInternal }))
      .filter((record) => (!id || record.id === id) && (!kind || record.kind === kind) && (!publicOnly || record.status === "ready"));
  } catch {
    return [];
  }
}

async function deleteMediaRecord(id) {
  const mediaId = String(id || "");
  if (!mediaId) return null;
  const [record] = await readMediaRecords({ id: mediaId, includeInternal: true });
  if (!record) return null;
  if (pool) {
    await pool.query("DELETE FROM media_files WHERE media_id = $1", [mediaId]);
  } else {
    let records = [];
    try {
      const data = JSON.parse(await fs.readFile(mediaRecordsFile, "utf8"));
      records = Array.isArray(data) ? data : [];
    } catch {}
    await fs.writeFile(mediaRecordsFile, JSON.stringify(records.filter((item) => item.id !== mediaId && item.media_id !== mediaId), null, 2));
  }
  return record;
}

const transcodeQueue = [];
const cancelledTranscodes = new Set();
const activeTranscodeChildren = new Map();
let activeTranscodes = 0;

function videoChunkUploadDir(uploadId) {
  const safeId = String(uploadId || "").trim();
  if (!/^[a-f0-9-]{36}$/i.test(safeId)) throw new Error("上传任务不存在");
  return path.join(tempVideoChunkDir, safeId);
}

function videoChunkMetaPath(uploadId) {
  return path.join(videoChunkUploadDir(uploadId), "metadata.json");
}

async function readVideoChunkMeta(uploadId) {
  return JSON.parse(await fs.readFile(videoChunkMetaPath(uploadId), "utf8"));
}

async function writeVideoChunkMeta(meta) {
  await fs.writeFile(videoChunkMetaPath(meta.uploadId), JSON.stringify(meta, null, 2));
}

function videoChunkPartPath(uploadId, index) {
  return path.join(videoChunkUploadDir(uploadId), `${String(index).padStart(8, "0")}.part`);
}

async function assembleVideoChunks(meta, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const output = fsSync.createWriteStream(outputPath);
  try {
    for (let index = 0; index < meta.totalChunks; index += 1) {
      const input = fsSync.createReadStream(videoChunkPartPath(meta.uploadId, index));
      for await (const chunk of input) {
        if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
  }
}

function createQueuedVideoRecord(file, poster = {}) {
  const outputName = `${path.parse(file.originalname || "video").name || "video"}.m3u8`;
  return {
    id: crypto.randomUUID(),
    kind: "video",
    type: "video",
    originalName: file.originalname || "",
    name: outputName,
    mimeType: "application/vnd.apple.mpegurl",
    originalMimeType: file.mimetype || "",
    size: file.size || 0,
    storagePath: "",
    storageProvider: useBunnyStorage ? "bunny" : "local",
    url: "",
    status: "queued",
    progress: 0,
    format: "HLS",
    quality: "720P",
    aspect: "16-9",
    width: 0,
    height: 0,
    duration: 0,
    posterUrl: poster.posterUrl || "",
    posterStoragePath: poster.posterStoragePath || "",
    posterMediaId: poster.posterMediaId || "",
    segments: 0,
    playbackType: "hls",
    encrypted: true,
    hlsSegmentSeconds,
    tempInputPath: file.path,
    createdAt: new Date().toISOString(),
    date: new Date().toLocaleString()
  };
}

function publicQueuedVideoRecord(record) {
  const { tempInputPath: _tempInputPath, originalMimeType: _originalMimeType, ...safeRecord } = record;
  return safeRecord;
}

function enqueueTranscode(record) {
  if (!record?.id || !record.tempInputPath) return;
  if (!transcodeQueue.some((item) => item.id === record.id)) transcodeQueue.push(record);
  processTranscodeQueue();
}

function processTranscodeQueue() {
  while (activeTranscodes < transcodeConcurrency && transcodeQueue.length) {
    const job = transcodeQueue.shift();
    activeTranscodes += 1;
    runTranscodeJob(job)
      .catch((error) => console.error(error))
      .finally(() => {
        activeTranscodes -= 1;
        processTranscodeQueue();
      });
  }
}

async function runTranscodeJob(job) {
  let outputDir = "";
  try {
    if (cancelledTranscodes.has(job.id)) return;
    outputDir = path.join(tempVideoDir, `${job.id}-hls`);
    const inputMetadata = await probeVideo(job.tempInputPath);
    const processingJob = {
      ...job,
      ...inputMetadata,
      status: "processing",
      progress: 10,
      format: "HLS",
      quality: "720P",
      playbackType: "hls",
      encrypted: true,
      hlsSegmentSeconds
    };
    let lastSavedProgress = 10;
    await saveMediaRecord(processingJob);
    const hlsMetadata = await generateHlsVideo(job.tempInputPath, outputDir, inputMetadata, (progress) => {
      if (cancelledTranscodes.has(job.id)) return;
      if (progress <= lastSavedProgress) return;
      lastSavedProgress = progress;
      saveMediaRecord({ ...processingJob, progress }).catch((error) => console.error(error));
    }, inputMetadata.duration, job.id);
    if (cancelledTranscodes.has(job.id)) return;
    await saveMediaRecord({ ...processingJob, ...hlsMetadata, status: "processing", progress: 90 });
    let lastUploadProgress = 90;
    const uploadProgressJob = { ...processingJob, ...hlsMetadata, status: "processing" };
    const media = await uploadProcessedHls(outputDir, {
      originalname: job.originalName,
      mimetype: "application/vnd.apple.mpegurl"
    }, {
      ...hlsMetadata,
      posterUrl: job.posterUrl || "",
      posterStoragePath: job.posterStoragePath || "",
      posterMediaId: job.posterMediaId || ""
    }, job.id, async (progress, uploadProgress) => {
      if (cancelledTranscodes.has(job.id)) return;
      if (progress <= lastUploadProgress) return;
      lastUploadProgress = progress;
      await saveMediaRecord({ ...uploadProgressJob, progress, uploadProgress });
    });
    if (cancelledTranscodes.has(job.id)) {
      await deleteStoredMediaObjects(media).catch((error) => console.error(error));
      return;
    }
    await saveMediaRecord({ ...media, progress: 100, status: "ready" });
  } catch (error) {
    if (cancelledTranscodes.has(job.id)) return;
    await saveMediaRecord({
      ...job,
      status: "failed",
      progress: 100,
      error: error.message || "HLS 处理失败"
    }).catch(() => {});
  } finally {
    cancelledTranscodes.delete(job.id);
    await Promise.all([
      job.tempInputPath ? fs.rm(job.tempInputPath, { force: true }).catch(() => {}) : null,
      outputDir ? fs.rm(outputDir, { recursive: true, force: true }).catch(() => {}) : null
    ].filter(Boolean));
  }
}

async function resumePendingTranscodes() {
  const records = await readMediaRecords({ kind: "video", includeInternal: true });
  for (const record of records) {
    if (!["queued", "processing"].includes(record.status)) continue;
    if (record.tempInputPath && fsSync.existsSync(record.tempInputPath)) {
      const queuedRecord = { ...record, status: "queued", progress: 0 };
      await saveMediaRecord(queuedRecord);
      enqueueTranscode(queuedRecord);
    } else {
      await saveMediaRecord({ ...record, status: "failed", progress: 100, error: "临时视频文件不存在，请重新上传" });
    }
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    storage: storageMode,
    postgres: Boolean(pool),
    mediaStorage: useBunnyStorage ? "bunny" : "local",
    transcode: { queued: transcodeQueue.length, active: activeTranscodes, concurrency: transcodeConcurrency }
  });
});

app.get("/config.js", (req, res) => {
  const currentHost = hostWithoutPort(requestHost(req));
  const onLineHost = siteHosts.some((host) => hostWithoutPort(host) === currentHost);
  res.type("application/javascript");
  res.setHeader("Cache-Control", "no-store");
  res.send(`window.POSTWAVE_CONFIG=${JSON.stringify({
    siteOrigin: onLineHost ? `${requestProtocol(req)}://${requestHost(req)}` : publicSiteOrigins[0] || "",
    siteOrigins: publicSiteOrigins,
    adminOrigin: publicAdminOrigin,
    apiBaseUrl: onLineHost ? "" : publicApiBaseUrl,
    mediaBaseUrl: publicMediaBaseUrl,
    routeSelectorOrigin,
    routeSelectorTitle,
    routeSelectorSubtitle,
    routeSelectorEmail: routeSelectorEmail || cachedRoutingSettings.email || "51sp1@proton.me",
    routeLines,
    routeEntryHosts: routeEntryHosts(),
    demoSeedEnabled,
    localPostFallbackEnabled: !isProduction
  })};`);
});

app.get("/api/public/email-autoreply", async (_req, res, next) => {
  try {
    const settings = await readSiteSettings();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      from: settings.emailAutoReply.from,
      subject: settings.emailAutoReply.subject,
      text: settings.emailAutoReply.text
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/public/analytics/track", async (req, res, next) => {
  try {
    await recordAnalyticsEvent(req, req.body && typeof req.body === "object" ? req.body : {});
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/analytics", requireAdminApi, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await analyticsSummary());
  } catch (error) {
    next(error);
  }
});

app.get("/api/session", (req, res) => {
  const session = readSession(req, sessionCookieName, "admin");
  res.json({ authenticated: Boolean(session), user: session ? { account: session.account, name: session.name } : null });
});

app.get("/api/csrf", requireAdminApi, (req, res) => {
  const sessionToken = sessionTokenFromRequest(req, sessionCookieName);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, csrfToken: createCsrfToken(sessionToken) });
});

app.post("/api/login", loginRateLimit("admin-login"), async (req, res, next) => {
  try {
    const account = String(req.body?.account || "").trim();
    const password = String(req.body?.password || "").trim();
    const admin = await findAdmin(account, password);
    if (!admin) {
      recordLoginFailure(req);
      res.status(401).json({ error: "账号或密码错误" });
      return;
    }
    clearLoginFailures(req);
    const sessionToken = createSession(admin, "admin");
    res.setHeader("Set-Cookie", sessionCookie(sessionToken, sessionMaxAgeSeconds, sessionCookieName, req));
    res.json({ ok: true, user: { account: admin.account, name: admin.name }, csrfToken: createCsrfToken(sessionToken) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", 0, sessionCookieName, req));
  res.json({ ok: true });
});

app.get("/api/user/session", (req, res) => {
  const session = readSession(req, userSessionCookieName, "user");
  res.json({ authenticated: Boolean(session), user: session ? { account: session.account, name: session.name } : null });
});

app.post("/api/user/register", loginRateLimit("user-register"), async (req, res, next) => {
  try {
    const user = await registerUser({
      account: req.body?.account,
      password: req.body?.password,
      name: req.body?.name
    });
    clearLoginFailures(req);
    res.setHeader("Set-Cookie", sessionCookie(createSession(user, "user"), sessionMaxAgeSeconds, userSessionCookieName, req));
    res.json({ ok: true, user });
  } catch (error) {
    recordLoginFailure(req);
    res.status(400).json({ error: error.message || "注册失败" });
  }
});

app.post("/api/user/login", loginRateLimit("user-login"), async (req, res, next) => {
  try {
    const user = await findUser(req.body?.account, req.body?.password);
    if (!user) {
      recordLoginFailure(req);
      res.status(401).json({ error: "账号或密码错误" });
      return;
    }
    clearLoginFailures(req);
    res.setHeader("Set-Cookie", sessionCookie(createSession(user, "user"), sessionMaxAgeSeconds, userSessionCookieName, req));
    res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/user/logout", (req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", 0, userSessionCookieName, req));
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

app.get("/api/site-settings", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await readSiteSettings());
  } catch (error) {
    next(error);
  }
});

app.put("/api/site-settings", requireAdminApi, async (req, res, next) => {
  try {
    res.json({ ok: true, settings: await replaceSiteSettings(req.body || {}) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/media", requireAdminApi, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ media: await readMediaRecords({ kind: String(req.query.kind || "") }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/:id", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const [media] = await readMediaRecords({ id: String(req.params.id || ""), publicOnly: true });
    if (!media) {
      res.status(404).json({ error: "媒体不存在或尚未处理完成" });
      return;
    }
    res.json({ media });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/media/:id", requireAdminApi, async (req, res, next) => {
  const mediaId = String(req.params.id || "");
  try {
    const [record] = await readMediaRecords({ id: mediaId, includeInternal: true });
    if (!record) {
      res.status(404).json({ error: "媒体不存在" });
      return;
    }
    cancelledTranscodes.add(mediaId);
    const queuedIndex = transcodeQueue.findIndex((item) => item.id === mediaId);
    if (queuedIndex >= 0) transcodeQueue.splice(queuedIndex, 1);
    const activeChild = activeTranscodeChildren.get(mediaId);
    if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
    await deleteStoredMediaObjects(record);
    if (record.posterMediaId && record.posterMediaId !== mediaId) {
      const [posterRecord] = await readMediaRecords({ id: record.posterMediaId, includeInternal: true });
      if (posterRecord) await deleteStoredMediaObjects(posterRecord);
      await deleteMediaRecord(record.posterMediaId);
    }
    if (record.tempInputPath) await fs.rm(record.tempInputPath, { force: true }).catch(() => {});
    await deleteMediaRecord(mediaId);
    res.json({ ok: true });
  } catch (error) {
    cancelledTranscodes.delete(mediaId);
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

app.post("/api/comments", requireUserApi, async (req, res, next) => {
  try {
    const settings = await readSiteSettings();
    const commentName = settings.siteConfig?.commentLogoText || "注册用户";
    const comment = await createComment({
      postId: String(req.body?.postId || ""),
      postTitle: String(req.body?.postTitle || ""),
      name: commentName,
      text: String(req.body?.text || "").trim(),
      userId: String(req.user?.id || req.user?.account || "")
    });
    res.json({ ok: true, comment });
  } catch (error) {
    res.status(400).json({ error: error.message || "评论提交失败" });
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

app.post("/api/media/upload", requireAdminApi, imageUpload.single("file"), async (req, res, next) => {
  try {
    const media = await uploadMediaFile(req.file, String(req.body?.kind || "asset"));
    res.json({ ok: true, url: media.url, media });
  } catch (error) {
    next(error);
  } finally {
    if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
});

app.post("/api/media/video/chunk/init", requireAdminApi, async (req, res, next) => {
  try {
    const originalName = String(req.body?.name || req.body?.originalName || "video").trim();
    const mimeType = String(req.body?.mimeType || "application/octet-stream").trim();
    const size = Number(req.body?.size || 0);
    const maxVideoBytes = videoUploadLimitMb * 1024 * 1024;
    const requestedChunkSize = Number(req.body?.chunkSize || 0);
    const chunkSize = Number.isFinite(requestedChunkSize) && requestedChunkSize > 0
      ? Math.max(1024 * 1024, Math.min(videoChunkBytes, Math.floor(requestedChunkSize)))
      : videoChunkBytes;
    if (!isAllowedVideoFile(originalName, mimeType)) throw new Error("只允许上传 MP4、MOV、WEBM、MKV 视频");
    if (!Number.isFinite(size) || size <= 0) throw new Error("视频文件大小无效");
    if (size > maxVideoBytes) throw new Error(`视频文件超过 ${videoUploadLimitMb}MB 限制`);
    const uploadId = crypto.randomUUID();
    const totalChunks = Math.ceil(size / chunkSize);
    const uploadDir = videoChunkUploadDir(uploadId);
    await fs.mkdir(uploadDir, { recursive: true });
    const meta = {
      uploadId,
      originalName,
      mimeType,
      size,
      chunkSize,
      totalChunks,
      posterUrl: String(req.body?.posterUrl || ""),
      posterStoragePath: String(req.body?.posterStoragePath || ""),
      posterMediaId: String(req.body?.posterMediaId || ""),
      received: [],
      createdAt: new Date().toISOString()
    };
    await writeVideoChunkMeta(meta);
    res.json({ ok: true, uploadId, chunkSize, totalChunks });
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/video/chunk/:uploadId/status", requireAdminApi, async (req, res, next) => {
  try {
    const meta = await readVideoChunkMeta(req.params.uploadId);
    const received = Array.from(new Set((meta.received || []).map(Number)))
      .filter((item) => Number.isInteger(item) && item >= 0 && item < meta.totalChunks)
      .sort((a, b) => a - b);
    const receivedSet = new Set(received);
    const missing = [];
    for (let index = 0; index < meta.totalChunks; index += 1) {
      if (!receivedSet.has(index)) missing.push(index);
    }
    res.json({
      ok: true,
      uploadId: meta.uploadId,
      chunkSize: meta.chunkSize,
      totalChunks: meta.totalChunks,
      received,
      missing,
      complete: missing.length === 0
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/video/chunk/:uploadId", requireAdminApi, videoChunkUpload.single("chunk"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("没有收到视频分片");
    const meta = await readVideoChunkMeta(req.params.uploadId);
    const index = Number(req.body?.index);
    if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) throw new Error("视频分片序号无效");
    const targetPath = videoChunkPartPath(meta.uploadId, index);
    await fs.rename(req.file.path, targetPath);
    meta.received = Array.from(new Set([...(meta.received || []), index])).sort((a, b) => a - b);
    meta.updatedAt = new Date().toISOString();
    await writeVideoChunkMeta(meta);
    res.json({ ok: true, uploadId: meta.uploadId, index, received: meta.received.length, totalChunks: meta.totalChunks });
  } catch (error) {
    if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
    next(error);
  }
});

app.post("/api/media/video/chunk/:uploadId/complete", requireAdminApi, async (req, res, next) => {
  let assembledPath = "";
  try {
    const meta = await readVideoChunkMeta(req.params.uploadId);
    for (let index = 0; index < meta.totalChunks; index += 1) {
      await fs.access(videoChunkPartPath(meta.uploadId, index));
    }
    assembledPath = path.join(tempVideoDir, `${meta.uploadId}-${safeFilename(meta.originalName, meta.mimeType)}`);
    await assembleVideoChunks(meta, assembledPath);
    const stats = await fs.stat(assembledPath);
    if (stats.size !== Number(meta.size)) throw new Error("视频分片合并后大小不一致，请重新上传");
    const media = createQueuedVideoRecord({
      originalname: meta.originalName,
      mimetype: meta.mimeType,
      size: stats.size,
      path: assembledPath
    }, {
      posterUrl: meta.posterUrl,
      posterStoragePath: meta.posterStoragePath,
      posterMediaId: meta.posterMediaId
    });
    await saveMediaRecord(media);
    enqueueTranscode(media);
    await fs.rm(videoChunkUploadDir(meta.uploadId), { recursive: true, force: true }).catch(() => {});
    res.status(202).json({ ok: true, media: publicQueuedVideoRecord(media) });
  } catch (error) {
    if (assembledPath) await fs.rm(assembledPath, { force: true }).catch(() => {});
    next(error);
  }
});

app.post("/api/media/video/transcode", requireAdminApi, videoUpload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("没有收到视频文件");
    const media = createQueuedVideoRecord(req.file, {
      posterUrl: String(req.body?.posterUrl || ""),
      posterStoragePath: String(req.body?.posterStoragePath || ""),
      posterMediaId: String(req.body?.posterMediaId || "")
    });
    await saveMediaRecord(media);
    enqueueTranscode(media);
    res.status(202).json({ ok: true, media: publicQueuedVideoRecord(media) });
  } catch (error) {
    if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
    next(error);
  }
});

app.get("/", (req, res, next) => {
  if (hostMatches(req, routeSelectorHost)) {
    renderRouteSelectPage(req, res, next);
    return;
  }
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

function sendHtmlPage(filename) {
  return (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, filename));
  };
}

function htmlEscape(value = "") {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function safePublicUrl(value = "", fallback = "") {
  const url = String(value || "").trim();
  if (/^(https?:|data:image\/|\/|app\.html|admin-login\.html|admin\.html|index\.html|detail\.html|qq\.html|mailto:|#)/i.test(url)) return url;
  return fallback;
}

function ssrJsonScript(data) {
  return `<script>window.POSTWAVE_SSR_DATA=${JSON.stringify(data).replace(/</g, "\\u003c")};</script>`;
}

function ssrDetailJsonScript(data) {
  return `<script>window.POSTWAVE_SSR_DETAIL=${JSON.stringify(data).replace(/</g, "\\u003c")};</script>`;
}

function jsonLdScript(data) {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

function seoSiteName(settings = {}) {
  return settings.siteConfig?.siteName || routeSelectorTitle || "51春梦";
}

function seoDescription(settings = {}, fallback = "") {
  return truncateText(
    plainPostText(fallback || settings.footer?.introText || settings.siteConfig?.tabs?.[0]?.subtitle || "51春梦聚合图文与视频内容，提供最新地址、频道导航和内容更新。"),
    160
  );
}

function seoCanonical(origin = "", pathname = "/") {
  const base = normalizeOrigin(origin);
  const pathValue = String(pathname || "/");
  if (!base) return pathValue;
  return `${base}${pathValue.startsWith("/") ? pathValue : `/${pathValue}`}`;
}

function seoDefaultImage(req) {
  return absolutePublicUrl(req, "/assets/logo.png");
}

function seoHeadTags({
  title,
  description,
  canonical,
  image,
  type = "website",
  siteName = "51春梦",
  imageAlt = "",
  extra = [],
  jsonLd = null
}) {
  const safeTitle = title || siteName;
  const safeDescription = description || "51春梦内容聚合与线路导航。";
  const safeImage = image || "";
  return [
    `<meta name="description" content="${htmlEscape(safeDescription)}">`,
    `<meta name="rating" content="adult">`,
    canonical ? `<link rel="canonical" href="${htmlEscape(canonical)}">` : "",
    `<meta property="og:type" content="${htmlEscape(type)}">`,
    `<meta property="og:site_name" content="${htmlEscape(siteName)}">`,
    `<meta property="og:title" content="${htmlEscape(safeTitle)}">`,
    `<meta property="og:description" content="${htmlEscape(safeDescription)}">`,
    canonical ? `<meta property="og:url" content="${htmlEscape(canonical)}">` : "",
    safeImage ? `<meta property="og:image" content="${htmlEscape(safeImage)}">` : "",
    safeImage && imageAlt ? `<meta property="og:image:alt" content="${htmlEscape(imageAlt)}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${htmlEscape(safeTitle)}">`,
    `<meta name="twitter:description" content="${htmlEscape(safeDescription)}">`,
    safeImage ? `<meta name="twitter:image" content="${htmlEscape(safeImage)}">` : "",
    safeImage && imageAlt ? `<meta name="twitter:image:alt" content="${htmlEscape(imageAlt)}">` : "",
    ...extra,
    jsonLd ? jsonLdScript(jsonLd) : ""
  ].filter(Boolean).join("\n");
}

function injectSeoHead(html, meta) {
  const block = `  <!--POSTWAVE_SEO_HEAD_START-->\n${String(meta || "").split("\n").map((line) => `  ${line}`).join("\n")}\n  <!--POSTWAVE_SEO_HEAD_END-->`;
  const pattern = /\s*<!--POSTWAVE_SEO_HEAD_START-->[\s\S]*?<!--POSTWAVE_SEO_HEAD_END-->/;
  if (pattern.test(html)) return html.replace(pattern, `\n${block}`);
  return html.replace("</head>", `${block}\n</head>`);
}

function publicPostForHome(post = {}, index = 0) {
  const categories = Array.isArray(post.categories) && post.categories.length
    ? post.categories
    : normalizeArray(post.category);
  return {
    ...post,
    id: String(post.id || post.clientId || post.client_id || `post-${index}`),
    title: post.title || "未命名帖子",
    image: post.cover || post.cover_url || post.image || "",
    author: post.author || "alun",
    date: post.date || post.date_text || "",
    category: post.category || categories[0] || "内容",
    categories,
    tags: normalizeArray(post.tags),
    keywords: normalizeArray(post.keywords),
    body: post.body || ""
  };
}

function ssrPostRow(post) {
  const categories = post.categories && post.categories.length ? post.categories.join("、") : post.category;
  return `
        <a class="post-row" href="detail.html?id=${encodeURIComponent(post.id)}">
          <img src="${htmlEscape(safePublicUrl(post.image))}" alt="${htmlEscape(post.title)}">
          <div class="post-content">
            <h2 class="post-title">${htmlEscape(post.title)}</h2>
            <p class="post-meta"><span>${htmlEscape(post.author || "alun")}</span><span>·</span><span>${htmlEscape(post.date || "")}</span><span>·</span><span>${htmlEscape(categories || "内容")}</span></p>
          </div>
        </a>
      `;
}

function normalizeSsrAd(ad = {}) {
  const possibleUrl = String(ad.url || "");
  const urlIsImage = /^(data:image|blob:)|\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(possibleUrl);
  return {
    ...ad,
    title: ad.title || "",
    desc: ad.desc || "",
    link: ad.link || ad.href || ad.target || (!urlIsImage ? possibleUrl : "") || "app.html",
    image: ad.image || ad.img || ad.src || ad.file || ad.data || (urlIsImage ? possibleUrl : ""),
    slot: Number(ad.slot ?? ad.order ?? ad.sort ?? 0),
    placement: ad.placement || "home-banner"
  };
}

function ssrFeedAdRow(ad) {
  if (!ad.image) return "";
  return `<a class="post-row feed-ad" href="${htmlEscape(safePublicUrl(ad.link || "app.html", "app.html"))}"><img src="${htmlEscape(safePublicUrl(ad.image))}" alt="${htmlEscape(ad.title || "广告")}"><div class="post-content" aria-hidden="true"></div></a>`;
}

function ssrPager(totalPages, currentPage = 1) {
  return `
        <button class="page-btn" data-prev ${currentPage === 1 ? "disabled" : ""}>上一页</button>
        ${Array.from({ length: totalPages }, (_, i) => `<button class="page-btn ${i + 1 === currentPage ? "active" : ""}" data-page="${i + 1}">${i + 1}</button>`).join("")}
        <button class="page-btn" data-next ${currentPage === totalPages ? "disabled" : ""}>下一页</button>
        <input class="page-jump" id="pageJumpInput" type="number" min="1" max="${totalPages}" value="${currentPage}" aria-label="跳转页码">
        <button class="page-btn" data-jump>跳转</button>
      `;
}

function requestOrigin(req) {
  const host = requestHost(req);
  return host ? `${requestProtocol(req)}://${host}` : "";
}

function canonicalSiteOrigin(req) {
  if (isLocalRequest(req)) return requestOrigin(req);
  return publicSiteOrigins[0] || routeLineOrigins[0] || requestOrigin(req);
}

function absolutePublicUrl(req, value = "") {
  const url = String(value || "").trim();
  if (!url || /^data:/i.test(url)) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `${requestProtocol(req)}:${url}`;
  const origin = canonicalSiteOrigin(req);
  if (!origin) return url;
  if (url.startsWith("/")) return `${origin}${url}`;
  return `${origin}/${url.replace(/^\.?\//, "")}`;
}

function detailUrl(req, post) {
  const origin = canonicalSiteOrigin(req);
  const id = encodeURIComponent(post.id || "");
  return `${origin || ""}/detail.html?id=${id}`;
}

function plainPostText(value = "") {
  return String(value || "")
    .replace(/\[图片(?::\d+)?\]|\[视频(?::[^\]]+)?\]/g, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value = "", maxLength = 160) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function detailDescription(post) {
  return truncateText(plainPostText(post.body) || post.title || "51春梦内容详情。", 160);
}

function parsePostDate(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw
    .replace(/年|\/|\./g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return "";
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const pad = (item) => String(item).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`;
}

function isoDuration(seconds = 0) {
  const total = Math.floor(Number(seconds) || 0);
  if (!total) return "";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${secs || (!hours && !minutes) ? `${secs}S` : ""}`;
}

function extractPostVideoIds(post = {}) {
  const ids = new Set();
  const add = (value) => {
    const id = String(value || "").trim();
    if (id) ids.add(id);
  };
  add(post.video);
  if (Array.isArray(post.videos)) post.videos.forEach(add);
  for (const match of String(post.body || "").matchAll(/\[视频(?::([^\]]+))?\]/g)) add(match[1]);
  return Array.from(ids);
}

async function mediaMapForVideoIds(videoIds = []) {
  const entries = await Promise.all(videoIds.map(async (id) => {
    try {
      const [media] = await readMediaRecords({ id, publicOnly: true });
      return [id, media || null];
    } catch {
      return [id, null];
    }
  }));
  return new Map(entries);
}

function ssrDetailContent(post, mediaById = new Map()) {
  const body = String(post.body || "");
  const renderText = (text) => {
    const cleaned = String(text || "").replace(/^\n+|\n+$/g, "");
    return cleaned.trim() ? `<div class="body">${htmlEscape(cleaned)}</div>` : "";
  };
  if (!body.includes("[图片") && !body.includes("[视频")) return renderText(body || "暂无内容。");
  return body.split(/(\[图片(?::\d+)?\]|\[视频(?::[^\]]+)?\])/g).map((part) => {
    if (!part) return "";
    if (part.startsWith("[图片")) {
      const match = part.match(/\[图片(?::(\d+))?\]/);
      const imgIndex = match && match[1] ? Number(match[1]) : 0;
      const img = (post.bodyImages || [])[imgIndex] || "";
      if (!img) return "";
      return `<div class="media image-media"><img src="${htmlEscape(safePublicUrl(img))}" alt="${htmlEscape(post.title)}" loading="lazy" decoding="async"></div>`;
    }
    if (part.startsWith("[视频")) {
      const match = part.match(/\[视频(?::([^\]]+))?\]/);
      const videoId = match && match[1] ? String(match[1]).trim() : "";
      if (!videoId) return "";
      const media = mediaById.get(videoId);
      const ratioClass = media?.aspect === "9-16" ? "ratio-9-16" : "ratio-16-9";
      return `<div class="media video-media ${ratioClass}"><div class="hls-player" data-media-video="${htmlEscape(videoId)}"></div></div>`;
    }
    return renderText(part);
  }).join("");
}

function ssrTags(post) {
  const tags = normalizeArray(post.tags).map((tag) => String(tag).replace(/^#+/, "")).filter(Boolean);
  return `<div class="tags" id="tags">${tags.map((tag) => `<span class="tag">${htmlEscape(tag)}</span>`).join("")}</div>`;
}

function ssrPrevNext(req, posts, index) {
  const prev = index >= 0 && posts.length > 1 ? posts[(index - 1 + posts.length) % posts.length] : null;
  const next = index >= 0 && posts.length > 1 ? posts[(index + 1) % posts.length] : null;
  const link = (id, label, rel, post) => {
    if (!post) return `<a class="pn" id="${id}">${label}<span>暂无</span></a>`;
    return `<a class="pn" id="${id}" href="${htmlEscape(detailUrl(req, post))}" rel="${rel}">${label}<span>${htmlEscape(post.title)}</span></a>`;
  };
  return `<nav class="prev-next">${link("prevPost", "上一篇", "prev", prev)}${link("nextPost", "下一篇", "next", next)}</nav>`;
}

function detailClientPost(post = {}, includeBody = false) {
  return {
    id: post.id,
    title: post.title,
    cover: post.cover || post.image || "",
    body: includeBody ? post.body || "" : "",
    bodyImages: post.bodyImages || [],
    video: post.video || "",
    videos: Array.isArray(post.videos) ? post.videos : [],
    author: post.author || "alun",
    date: post.date || "",
    category: post.category || "",
    categories: post.categories || [],
    keywords: post.keywords || [],
    tags: post.tags || []
  };
}

function detailSeoHead(req, post, description, mediaById = new Map()) {
  const canonical = detailUrl(req, post);
  const image = absolutePublicUrl(req, post.image || post.cover || post.bodyImages?.[0] || "");
  const title = `${post.title} - 51春梦`;
  const published = parsePostDate(post.date);
  const images = [post.image || post.cover, ...(post.bodyImages || [])]
    .map((url) => absolutePublicUrl(req, url))
    .filter(Boolean)
    .slice(0, 8);
  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description,
    image: images,
    author: { "@type": "Person", name: post.author || "51春梦" },
    datePublished: published || undefined,
    dateModified: published || undefined,
    keywords: normalizeArray(post.keywords).join(", "),
    articleSection: post.categories?.length ? post.categories.join(", ") : post.category,
    mainEntityOfPage: canonical
  };
  const videos = extractPostVideoIds(post).map((id) => {
    const media = mediaById.get(id);
    const thumbnail = absolutePublicUrl(req, media?.posterUrl || post.image || post.cover || "");
    return {
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: post.title,
      description,
      thumbnailUrl: thumbnail ? [thumbnail] : undefined,
      uploadDate: published || undefined,
      duration: isoDuration(media?.duration),
      contentUrl: absolutePublicUrl(req, media?.url || ""),
      embedUrl: canonical
    };
  });
  const graph = [article, ...videos].map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && !value.length))));
  const jsonLd = graph.length === 1 ? graph[0] : { "@context": "https://schema.org", "@graph": graph.map(({ "@context": _context, ...item }) => item) };
  const meta = [
    `<meta name="description" content="${htmlEscape(description)}">`,
    `<meta name="rating" content="adult">`,
    `<link rel="canonical" href="${htmlEscape(canonical)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${htmlEscape(post.title)}">`,
    `<meta property="og:description" content="${htmlEscape(description)}">`,
    `<meta property="og:url" content="${htmlEscape(canonical)}">`,
    image ? `<meta property="og:image" content="${htmlEscape(image)}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${htmlEscape(post.title)}">`,
    `<meta name="twitter:description" content="${htmlEscape(description)}">`,
    image ? `<meta name="twitter:image" content="${htmlEscape(image)}">` : "",
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`
  ].filter(Boolean).join("\n  ");
  return { title, canonical, meta };
}

function xmlEscape(value = "") {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;"
  }[char]));
}

function uniqueOrigins(origins = []) {
  return uniqueList(origins.map(normalizeOrigin).filter(Boolean));
}

function configuredLineOrigins() {
  return uniqueOrigins(routeLineOrigins.length ? routeLineOrigins : publicSiteOrigins);
}

function requestHostOrigin(req) {
  return normalizeOrigin(requestOrigin(req));
}

function isRouteEntryRequest(req) {
  return hostInList(req, routeEntryHosts());
}

function isRouteSelectorRequest(req) {
  return configuredHostMatches(req, routeSelectorHost);
}

function isLineHostRequest(req) {
  const host = hostWithoutPort(requestHost(req));
  return siteHosts.some((item) => hostWithoutPort(item) === host);
}

function sitemapOriginsForIndex(req) {
  const lines = configuredLineOrigins();
  if (lines.length) return lines;
  const fallback = routeSelectorOrigin || requestHostOrigin(req);
  return fallback ? [fallback] : [];
}

function sitemapUrlset(entries = []) {
  const rows = entries.map((entry) => {
    const parts = [
      `    <loc>${xmlEscape(entry.loc)}</loc>`,
      entry.lastmod ? `    <lastmod>${xmlEscape(entry.lastmod)}</lastmod>` : "",
      entry.changefreq ? `    <changefreq>${xmlEscape(entry.changefreq)}</changefreq>` : "",
      entry.priority ? `    <priority>${xmlEscape(entry.priority)}</priority>` : ""
    ].filter(Boolean).join("\n");
    return `  <url>\n${parts}\n  </url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>\n`;
}

function sitemapIndex(origins = []) {
  const rows = origins.map((origin) => `  <sitemap>\n    <loc>${xmlEscape(`${normalizeOrigin(origin)}/sitemap.xml`)}</loc>\n  </sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</sitemapindex>\n`;
}

function siteMapOriginForRequest(req) {
  if (isLocalRequest(req)) return requestHostOrigin(req);
  if (isRouteSelectorRequest(req) && routeSelectorOrigin) return routeSelectorOrigin;
  if (isLineHostRequest(req)) return requestHostOrigin(req) || canonicalSiteOrigin(req);
  return requestHostOrigin(req) || canonicalSiteOrigin(req);
}

async function renderRobotsTxt(req, res, next) {
  try {
    await readSiteSettings();
    const lines = ["User-agent: *"];
    if (isRestrictedInfrastructureHost(req)) {
      lines.push("Disallow: /");
    } else {
      lines.push("Allow: /");
      if (isRouteEntryRequest(req)) {
        for (const origin of sitemapOriginsForIndex(req)) lines.push(`Sitemap: ${normalizeOrigin(origin)}/sitemap.xml`);
      } else {
        const origin = siteMapOriginForRequest(req);
        if (origin) lines.push(`Sitemap: ${normalizeOrigin(origin)}/sitemap.xml`);
      }
    }
    res.type("text/plain");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(`${lines.join("\n")}\n`);
  } catch (error) {
    next(error);
  }
}

async function renderSitemapXml(req, res, next) {
  try {
    await readSiteSettings();
    res.type("application/xml");
    res.setHeader("Cache-Control", "public, max-age=300");

    if (isRestrictedInfrastructureHost(req)) {
      res.status(404).send(sitemapUrlset([]));
      return;
    }

    if (isRouteEntryRequest(req)) {
      res.send(sitemapIndex(sitemapOriginsForIndex(req)));
      return;
    }

    if (isRouteSelectorRequest(req)) {
      const origin = siteMapOriginForRequest(req);
      res.send(sitemapUrlset([{
        loc: `${origin}/`,
        changefreq: "daily",
        priority: "0.7"
      }]));
      return;
    }

    const origin = siteMapOriginForRequest(req);
    const rawPosts = await readPosts();
    const posts = rawPosts.map(publicPostForHome).filter((post) => post.id);
    const entries = [
      { loc: `${origin}/`, changefreq: "hourly", priority: "1.0" },
      { loc: `${origin}/index.html`, changefreq: "hourly", priority: "0.9" },
      { loc: `${origin}/app.html`, changefreq: "weekly", priority: "0.4" },
      ...posts.slice(0, 45000).map((post) => ({
        loc: `${origin}/detail.html?id=${encodeURIComponent(post.id)}`,
        lastmod: parsePostDate(post.date),
        changefreq: "daily",
        priority: "0.8"
      }))
    ];
    res.send(sitemapUrlset(entries));
  } catch (error) {
    next(error);
  }
}

async function renderIndexPage(_req, res, next) {
  try {
    const [rawPosts, settings, html] = await Promise.all([
      readPosts(),
      readSiteSettings(),
      fs.readFile(path.join(__dirname, "index.html"), "utf8")
    ]);
    const perPage = 26;
    const posts = rawPosts.map(publicPostForHome);
    const pagePosts = posts.slice(0, perPage);
    const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
    const feedAds = (settings.ads || [])
      .map(normalizeSsrAd)
      .filter((ad) => ad.placement === "home-feed" && ad.image)
      .sort((a, b) => (Number(a.slot) || 1) - (Number(b.slot) || 1));
    const rows = pagePosts.map(ssrPostRow);
    feedAds.forEach((ad, order) => {
      const slot = Math.max(1, Math.min(rows.length + 1, Number(ad.slot) || order + 1));
      rows.splice(slot - 1, 0, ssrFeedAdRow(ad));
    });
    const postHtml = rows.join("");
    const pageTitle = settings.siteConfig?.tabs?.[0]?.name || "首页";
    const pageSubtitle = settings.siteConfig?.tabs?.[0]?.subtitle || "精选图文与视频内容，按发布时间聚合展示。";
    const ssrPayload = {
      posts: rawPosts,
      siteConfig: settings.siteConfig,
      footer: settings.footer,
      ads: settings.ads
    };
    const rendered = html
      .replace("</head>", `${ssrJsonScript(ssrPayload)}\n</head>`)
      .replace('<h1 class="page-title" id="pageTitle">首页</h1>', `<h1 class="page-title" id="pageTitle">${htmlEscape(pageTitle)}</h1>`)
      .replace('<p class="page-subtitle" id="pageSubtitle">精选图文与视频内容，按发布时间聚合展示。</p>', `<p class="page-subtitle" id="pageSubtitle">${htmlEscape(pageSubtitle)}</p>`)
      .replace('<section class="content-list" id="postList" aria-label="内容列表"></section>', `<section class="content-list" id="postList" aria-label="内容列表">${postHtml}</section>`)
      .replace('<div class="empty" id="emptyState">没有找到匹配内容</div>', `<div class="empty" id="emptyState" style="${pagePosts.length ? "display:none" : "display:block"}">没有找到匹配内容</div>`)
      .replace('<nav class="pager" id="pager" aria-label="分页"></nav>', `<nav class="pager" id="pager" aria-label="分页">${ssrPager(totalPages, 1)}</nav>`);
    res.type("html").send(rendered);
  } catch (error) {
    next(error);
  }
}

async function renderDetailPage(req, res, next) {
  try {
    const postId = String(req.query.id || "").trim();
    const [rawPosts, settings, html] = await Promise.all([
      readPosts(),
      readSiteSettings(),
      fs.readFile(path.join(__dirname, "detail.html"), "utf8")
    ]);
    const posts = rawPosts.map(publicPostForHome);
    const index = postId
      ? posts.findIndex((post, postIndex) => String(post.id) === postId || `admin-${postIndex}` === postId)
      : 0;
    const current = posts[index];
    if (!current) {
      res.status(404).type("html").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>内容不存在 - 51春梦</title></head><body>内容不存在</body></html>`);
      return;
    }

    const videoIds = extractPostVideoIds(current);
    const mediaById = await mediaMapForVideoIds(videoIds);
    const description = detailDescription(current);
    const seo = detailSeoHead(req, current, description, mediaById);
    const contentHtml = ssrDetailContent(current, mediaById);
    const categories = current.categories && current.categories.length ? current.categories.join("、") : current.category;
    const clientPosts = posts.map((post) => detailClientPost(post, String(post.id) === String(current.id)));
    const media = Array.from(mediaById.values()).filter(Boolean);
    const ssrPayload = {
      posts: clientPosts,
      siteConfig: settings.siteConfig,
      footer: settings.footer,
      ads: settings.ads,
      adConfig: settings.adConfig,
      notice: settings.notice,
      media
    };

    const rendered = html
      .replace("<title>51春梦 - 吃瓜爆料 + 成人视频，一站搞定</title>", `<title>${htmlEscape(seo.title)}</title>`)
      .replace("</head>", `  ${seo.meta}\n  ${ssrDetailJsonScript(ssrPayload)}\n</head>`)
      .replace('<span id="crumbTitle">帖子详情</span>', `<span id="crumbTitle">${htmlEscape(current.title)}</span>`)
      .replace('<h1 id="title">帖子详情</h1>', `<h1 id="title">${htmlEscape(current.title)}</h1>`)
      .replace('<span id="author"></span>', `<span id="author">${htmlEscape(current.author || "alun")}</span>`)
      .replace('<span id="date"></span>', `<span id="date">${htmlEscape(current.date || "")}</span>`)
      .replace('<span id="category"></span>', `<span id="category">${htmlEscape(categories || "内容")}</span>`)
      .replace('<div id="contentFlow"></div>', `<div id="contentFlow">${contentHtml}</div>`)
      .replace('<div class="tags" id="tags"></div>', ssrTags(current))
      .replace('<span id="officialNotice"></span>', `<span id="officialNotice">${htmlEscape(settings.notice || "")}</span>`)
      .replace('<nav class="prev-next"><a class="pn" id="prevPost">上一篇<span></span></a><a class="pn" id="nextPost">下一篇<span></span></a></nav>', ssrPrevNext(req, posts, index));

    res.type("html").send(rendered);
  } catch (error) {
    next(error);
  }
}

app.use((req, res, next) => {
  if (hostMatches(req, mediaHost) && !req.path.startsWith("/uploads/") && req.path !== "/config.js") {
    res.status(404).send("Media host only serves uploaded files.");
    return;
  }
  next();
});

app.get(["/admin.html", "/admin"], requireAdminPage, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/robots.txt", renderRobotsTxt);
app.get("/sitemap.xml", renderSitemapXml);
app.get("/route-select.html", sendHtmlPage("route-select.html"));
app.get(["/", "/index.html"], renderIndexPage);
app.get("/detail.html", renderDetailPage);
app.get("/app.html", sendHtmlPage("app.html"));
app.get("/qq.html", sendHtmlPage("qq.html"));
app.get("/admin-login.html", sendHtmlPage("admin-login.html"));
app.get("/vendor/lucide/lucide.min.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "vendor/lucide/lucide.min.js"));
});
app.get("/vendor/hls/hls.min.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "vendor/hls/hls.min.js"));
});
app.get("/vendor/dplayer/DPlayer.min.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "vendor/dplayer/DPlayer.min.js"));
});
app.get("/favicon.ico", (_req, res) => {
  res.type("image/png");
  res.sendFile(path.join(__dirname, "assets/favicon-51.png"));
});
app.get("/assets/webmaster-analytics.js", (_req, res) => {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "assets/webmaster-analytics.js"));
});
app.use("/assets", express.static(path.join(__dirname, "assets"), { maxAge: "7d" }));
app.use("/uploads", express.static(uploadsDir, {
  maxAge: "7d",
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".m3u8") res.type("application/vnd.apple.mpegurl");
    if (ext === ".ts") res.type("video/mp2t");
    if (ext === ".bin") res.type("application/octet-stream");
  }
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "上传文件超过大小限制" : (isProduction ? "上传失败，请稍后重试" : error.message);
    res.status(413).json({ error: message });
    return;
  }
  if (/只允许上传/.test(error.message || "")) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: isProduction ? "服务器暂时无法处理请求，请稍后再试" : (error.message || "Server error") });
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
await resumePendingTranscodes();

app.listen(port, () => {
  console.log(`51cm server running at http://localhost:${port}`);
  console.log(`Posts storage mode: ${storageMode}`);
});
