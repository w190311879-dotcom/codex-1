import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const postsPath = path.join(rootDir, "data", "posts.json");
const token = "test-bot-token";
const port = crypto.randomInt(18000, 24000);
const baseUrl = `http://127.0.0.1:${port}`;

function postImages(prefix, count) {
  return Array.from({ length: count }, (_, index) => `/uploads/${prefix}-${index + 1}.jpg`);
}

const fixturePosts = [
  {
    id: "eligible-1",
    title: "公开帖子一",
    body: "这是公开帖子一的摘要正文。",
    cover: "/uploads/eligible-1-cover.jpg",
    bodyImages: postImages("eligible-1", 6),
    keywords: ["公开", "图片"],
    tags: ["tag-a"],
    status: "已发布",
    date: "2026/5/28 12:00:00"
  },
  {
    id: "eligible-2",
    title: "公开帖子二",
    body: "这是公开帖子二的摘要正文。",
    cover: "/uploads/eligible-2-cover.jpg",
    bodyImages: postImages("eligible-2", 6),
    keywords: ["机器人"],
    status: "已发布",
    date: "2026/5/28 12:10:00"
  },
  {
    id: "eligible-3",
    title: "公开帖子三",
    body: "这是公开帖子三的摘要正文。",
    cover: "/uploads/eligible-3-cover.jpg",
    bodyImages: postImages("eligible-3", 7),
    keywords: ["随机"],
    status: "已发布",
    date: "2026/5/28 12:20:00"
  },
  {
    id: "too-few-images",
    title: "图片不足",
    cover: "/uploads/short-cover.jpg",
    bodyImages: postImages("short", 4),
    keywords: ["不足"],
    status: "已发布",
    date: "2026/5/28 12:30:00"
  },
  { id: "draft-post", title: "草稿", cover: "/uploads/draft.jpg", bodyImages: postImages("draft", 6), status: "草稿" },
  { id: "hidden-post", title: "隐藏", cover: "/uploads/hidden.jpg", bodyImages: postImages("hidden", 6), status: "隐藏" },
  { id: "deleted-post", title: "删除", cover: "/uploads/deleted.jpg", bodyImages: postImages("deleted", 6), status: "已删除" },
  { id: "review-post", title: "审核", cover: "/uploads/review.jpg", bodyImages: postImages("review", 6), status: "审核中" }
];

async function waitForServer(child) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("测试服务器启动失败");
}

async function apiRequest(pathname, authToken = token) {
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const response = await fetch(`${baseUrl}${pathname}`, { headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body };
}

let originalPosts = null;
let child = null;
const output = [];

try {
  originalPosts = await fs.readFile(postsPath, "utf8").catch(() => null);
  await fs.mkdir(path.dirname(postsPath), { recursive: true });
  await fs.writeFile(postsPath, JSON.stringify(fixturePosts, null, 2));

  child = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_URL: "",
      POSTWAVE_STORAGE: "file",
      POSTWAVE_ENABLE_DEMO_SEED: "0",
      BOT_API_TOKEN: token,
      PUBLIC_SITE_ORIGIN: "",
      PUBLIC_SITE_ORIGINS: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  await waitForServer(child);

  const missingToken = await apiRequest("/api/bot/random-posts", "");
  assert.equal(missingToken.response.status, 401, "未带 token 应返回 401");

  const ok = await apiRequest("/api/bot/random-posts?limit=2&images_per_post=6");
  assert.equal(ok.response.status, 200, "正确 token 应返回 200");
  assert.equal(ok.body.posts.length, 2, "limit=2 应返回 2 条");
  assert.ok(ok.body.posts.every((post) => post.images.length === 6), "每条返回 6 张图片");
  assert.ok(ok.body.posts.every((post) => post.url.startsWith(baseUrl)), "原文链接应是完整 URL");

  const limited = await apiRequest("/api/bot/random-posts?limit=1&images_per_post=6");
  assert.equal(limited.body.posts.length, 1, "limit=1 应生效");

  const excluded = await apiRequest("/api/bot/random-posts?limit=5&images_per_post=6&exclude_ids=eligible-1,eligible-2");
  assert.equal(excluded.response.status, 200, "exclude_ids 请求应成功");
  assert.equal(excluded.body.posts.length, 1, "排除两个已发帖子后只剩一条合格公开帖子");
  assert.equal(excluded.body.posts[0].id, "eligible-3", "exclude_ids 应排除指定帖子");

  const all = await apiRequest("/api/bot/random-posts?limit=10&images_per_post=6");
  const ids = all.body.posts.map((post) => post.id);
  assert.deepEqual(new Set(ids), new Set(["eligible-1", "eligible-2", "eligible-3"]), "只返回至少 6 张图片的已发布帖子");
  assert.ok(!ids.includes("too-few-images"), "图片不足的已发布帖子不应返回");
  assert.ok(!ids.includes("draft-post") && !ids.includes("hidden-post") && !ids.includes("deleted-post") && !ids.includes("review-post"), "非公开帖子不应返回");

  const invalid = await apiRequest("/api/bot/random-posts?limit=0&images_per_post=6");
  assert.equal(invalid.response.status, 400, "非法 limit 应返回 400");

  console.log("Bot random posts API tests passed");
} catch (error) {
  console.error(output.join(""));
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (originalPosts === null) {
    await fs.rm(postsPath, { force: true }).catch(() => {});
  } else {
    await fs.writeFile(postsPath, originalPosts);
  }
}
