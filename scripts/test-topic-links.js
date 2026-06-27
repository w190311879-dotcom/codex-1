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
const mediaPath = path.join(rootDir, "data", "media.json");
const port = crypto.randomInt(24001, 30000);
const baseUrl = `http://127.0.0.1:${port}`;

const fixturePosts = [
  {
    id: "topic-1",
    title: "网红吃瓜事件后续 热点爆料更新",
    body: "今日吃瓜内容更新，整理网红吃瓜事件和娱乐吃瓜线索。",
    cover: "/uploads/topic-1.jpg",
    bodyImages: ["/uploads/topic-1-1.jpg"],
    category: "娱乐",
    categories: ["娱乐"],
    keywords: ["娱乐吃瓜", "今日吃瓜"],
    tags: ["网红吃瓜", "热点爆料"],
    status: "已发布",
    date: "2026/5/29 12:00:00"
  },
  {
    id: "topic-2",
    title: "高清视频合集更新",
    body: "成人视频与高清视频内容整理。\n[视频:video-1]",
    cover: "/uploads/topic-2.jpg",
    category: "视频",
    categories: ["视频"],
    keywords: ["高清视频"],
    tags: ["视频合集"],
    status: "已发布",
    date: "2026/5/29 12:10:00"
  },
  {
    id: "draft-topic",
    title: "草稿里的网红吃瓜",
    body: "这条不能公开。",
    cover: "/uploads/draft-topic.jpg",
    tags: ["网红吃瓜"],
    status: "草稿"
  },
  {
    id: "blocked-topic",
    title: "风险词过滤检查",
    body: "这条用于检查高风险标签不会被自动链接。",
    cover: "/uploads/blocked-topic.jpg",
    tags: ["偷拍", "网红吃瓜"],
    status: "已发布"
  }
];

const fixtureMedia = [
  {
    id: "video-1",
    kind: "video",
    mimeType: "application/vnd.apple.mpegurl",
    url: "/uploads/video-1/master.m3u8",
    status: "ready",
    posterUrl: "/uploads/video-1/poster.jpg",
    aspect: "16-9",
    playbackType: "hls"
  }
];

fixturePosts.push(...Array.from({ length: 40 }, (_, index) => ({
  id: `long-tail-${index + 1}`,
  title: `长尾标签测试 ${index + 1}`,
  body: `这是 extra-tag-${index + 1} 的公开内容。`,
  cover: `/uploads/long-tail-${index + 1}.jpg`,
  category: "视频",
  categories: ["视频"],
  tags: [`extra-tag-${index + 1}`],
  status: "已发布",
  date: "2026/5/29 13:00:00"
})));

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

async function getText(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  return { response, text };
}

let originalPosts = null;
let originalMedia = null;
let child = null;
const output = [];

try {
  originalPosts = await fs.readFile(postsPath, "utf8").catch(() => null);
  originalMedia = await fs.readFile(mediaPath, "utf8").catch(() => null);
  await fs.mkdir(path.dirname(postsPath), { recursive: true });
  await fs.writeFile(postsPath, JSON.stringify(fixturePosts, null, 2));
  await fs.writeFile(mediaPath, JSON.stringify(fixtureMedia, null, 2));

  child = spawn(process.execPath, ["server.js"], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_URL: "",
      POSTWAVE_STORAGE: "file",
      POSTWAVE_ENABLE_DEMO_SEED: "0",
      PUBLIC_SITE_ORIGIN: "",
      PUBLIC_SITE_ORIGINS: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  await waitForServer(child);

  const detail = await getText("/v/topic-1");
  assert.equal(detail.response.status, 200, "详情页应正常返回");
  assert.ok(detail.text.includes('rel="tag"'), "详情页应输出 tag 链接");
  assert.ok(detail.text.includes("/tag/wang-hong-chi-gua"), "详情页应链接主题相关关键词");
  assert.ok(detail.text.includes("/tag/re-dian-bao-liao"), "详情页应链接爆料关键词");

  const videoDetail = await getText("/v/topic-2");
  assert.equal(videoDetail.response.status, 200, "视频详情页应正常返回");
  assert.ok(videoDetail.text.includes('data-media-video="video-1"'), "视频详情页应输出视频容器");
  assert.ok(videoDetail.text.includes("<video controls playsinline"), "视频详情页 SSR 应输出真实 video 标签");
  assert.ok(videoDetail.text.includes('<source src="/uploads/video-1/master.m3u8"'), "视频详情页 SSR 应输出视频 source");

  const tagPage = await getText("/tag/wang-hong-chi-gua");
  assert.equal(tagPage.response.status, 200, "tag 列表页应正常返回");
  assert.ok(tagPage.text.includes("网红吃瓜事件后续"), "tag 页面应包含匹配的公开帖子");
  assert.ok(!tagPage.text.includes("草稿里的网红吃瓜"), "tag 页面不应包含草稿帖子");

  const longTailTagPage = await getText("/tag/extra-tag-40");
  assert.equal(longTailTagPage.response.status, 200, "未进入 sitemap 的长尾 tag 页面仍应可访问");
  assert.ok(longTailTagPage.text.includes("长尾标签测试 40"), "长尾 tag 页面应展示匹配内容");

  const staleSafeTag = await getText("/tag/zhong-xin", { redirect: "manual" });
  assert.equal(staleSafeTag.response.status, 301, "历史安全 tag 404 应重定向到首页");
  assert.equal(staleSafeTag.response.headers.get("location"), "/", "历史安全 tag 应重定向到首页");

  const blockedTag = await getText("/tag/%E5%81%B7%E6%8B%8D");
  assert.equal(blockedTag.response.status, 404, "高风险 tag 页面不应公开");
  const violationTag = await getText("/tag/%E4%BE%B5%E7%8A%AF");
  assert.equal(violationTag.response.status, 404, "侵权/非自愿语义 tag 页面不应公开");

  const blockedDetail = await getText("/v/blocked-topic");
  assert.equal(blockedDetail.response.status, 200, "公开帖子详情仍应正常返回");
  assert.ok(!blockedDetail.text.includes("/tag/%E5%81%B7%E6%8B%8D"), "详情页不应链接高风险关键词");

  const sitemapIndex = await getText("/sitemap-index.xml");
  assert.equal(sitemapIndex.response.status, 200, "sitemap index 应正常返回");
  assert.ok(sitemapIndex.text.includes("/sitemap-tags.xml"), "sitemap index 应包含 tag sitemap");

  const sitemapTags = await getText("/sitemap-tags.xml");
  assert.equal(sitemapTags.response.status, 200, "tag sitemap 应正常返回");
  const sitemapTagCount = (sitemapTags.text.match(/<url>/g) || []).length;
  assert.ok(sitemapTagCount <= 30, "tag sitemap 最多提交 30 个核心 tag");
  assert.ok(sitemapTags.text.includes("/tag/wang-hong-chi-gua"), "tag sitemap 应包含主题 tag");
  assert.ok(!sitemapTags.text.includes("/tag/extra-tag-40"), "tag sitemap 不应提交长尾 tag");

  console.log("Topic link tests passed");
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
  if (originalMedia === null) {
    await fs.rm(mediaPath, { force: true }).catch(() => {});
  } else {
    await fs.writeFile(mediaPath, originalMedia);
  }
}
