import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function loadDotEnvFile() {
  const envPath = path.join(rootDir, ".env");
  if (!fsSync.existsSync(envPath)) return;
  const content = fsSync.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnvFile();

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : "1"];
}));
const apply = args.has("apply");
const scope = String(args.get("scope") || "covers").toLowerCase();
const limit = Number(args.get("limit") || 0) || 0;
const force = args.has("force");
const widths = [480, 768, 1200];
const webpQuality = Math.max(40, Math.min(95, Number(process.env.POSTWAVE_IMAGE_WEBP_QUALITY || 78) || 78));
const avifQuality = Math.max(35, Math.min(85, Number(process.env.POSTWAVE_IMAGE_AVIF_QUALITY || 50) || 50));
const maxPixels = Math.max(16, Number(process.env.POSTWAVE_IMAGE_MAX_PIXELS || 120) || 120) * 1000 * 1000;

const databaseUrl = process.env.DATABASE_URL || "";
const dataDir = path.join(rootDir, "data");
const postsFile = path.join(dataDir, "posts.json");
const uploadsDir = path.join(dataDir, "uploads");
const bunnyStorageZone = process.env.BUNNY_STORAGE_ZONE || "";
const bunnyStorageAccessKey = process.env.BUNNY_STORAGE_ACCESS_KEY || "";
const bunnyStorageHost = process.env.BUNNY_STORAGE_HOST || "storage.bunnycdn.com";
const bunnyCdnBaseUrl = (process.env.BUNNY_CDN_BASE_URL || process.env.PUBLIC_MEDIA_BASE_URL || "").replace(/\/+$/, "");
const useBunnyStorage = Boolean(bunnyStorageZone && bunnyStorageAccessKey && bunnyCdnBaseUrl);

function imageVariantKey(width) {
  if (width <= 480) return "sm";
  if (width <= 768) return "md";
  return "lg";
}

function imageVariantStoragePath(storagePath, width, format) {
  const parsed = path.posix.parse(String(storagePath || ""));
  const filename = `${parsed.name}@${width}.${format}`;
  return parsed.dir ? `${parsed.dir}/${filename}` : filename;
}

function hasUsableVariants(variants = {}) {
  return Boolean(variants?.sm?.webp || variants?.md?.webp || variants?.lg?.webp);
}

function storagePathFromUrl(url = "") {
  const value = String(url || "").trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return "";
  try {
    const parsed = new URL(value, bunnyCdnBaseUrl || "https://media.51cmtv.com");
    const pathname = decodeURIComponent(parsed.pathname || "").replace(/^\/+/, "");
    return pathname.startsWith("uploads/") ? pathname.slice("uploads/".length) : pathname;
  } catch {
    return value.replace(/^\/uploads\//, "").replace(/^\/+/, "");
  }
}

async function uploadBufferToBunny(buffer, mimeType, storagePath) {
  const url = `https://${bunnyStorageHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${encodeURIComponent(bunnyStorageZone)}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      AccessKey: bunnyStorageAccessKey,
      "Content-Type": mimeType,
      "Content-Length": String(buffer.length)
    },
    body: buffer
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bunny 上传失败：${response.status} ${text}`.trim());
  }
  return `${bunnyCdnBaseUrl}/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadBufferLocally(buffer, storagePath) {
  const filePath = path.join(uploadsDir, storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return `/uploads/${storagePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadVariant(buffer, mimeType, storagePath) {
  return useBunnyStorage ? uploadBufferToBunny(buffer, mimeType, storagePath) : uploadBufferLocally(buffer, storagePath);
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}`);
  const type = response.headers.get("content-type") || "";
  if (!/^image\/(png|jpe?g|webp)$/i.test(type)) throw new Error(`跳过不支持格式 ${type || "unknown"}`);
  return Buffer.from(await response.arrayBuffer());
}

async function generateVariants(url, storagePath) {
  const input = await downloadImage(url);
  const metadata = await sharp(input, { animated: false, limitInputPixels: maxPixels }).metadata();
  const variants = {};
  for (const width of widths) {
    const key = imageVariantKey(width);
    const resize = { width, fit: "inside", withoutEnlargement: true };
    const webpStoragePath = imageVariantStoragePath(storagePath, width, "webp");
    const avifStoragePath = imageVariantStoragePath(storagePath, width, "avif");
    const webp = await sharp(input, { animated: false, limitInputPixels: maxPixels }).rotate().resize(resize).webp({ quality: webpQuality, effort: 4 }).toBuffer({ resolveWithObject: true });
    const avif = await sharp(input, { animated: false, limitInputPixels: maxPixels }).rotate().resize(resize).avif({ quality: avifQuality, effort: 4 }).toBuffer({ resolveWithObject: true });
    variants[key] = {
      width: webp.info.width || width,
      height: webp.info.height || 0,
      webp: await uploadVariant(webp.data, "image/webp", webpStoragePath),
      avif: await uploadVariant(avif.data, "image/avif", avifStoragePath),
      webpStoragePath,
      avifStoragePath,
      webpSize: webp.data.length,
      avifSize: avif.data.length
    };
  }
  return { variants, width: Number(metadata.width) || 0, height: Number(metadata.height) || 0 };
}

async function readRows() {
  if (!databaseUrl) {
    const posts = JSON.parse(await fs.readFile(postsFile, "utf8"));
    return posts.map((payload, index) => ({ client_id: payload.id || `post-${index}`, payload }));
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const { rows } = await pool.query("SELECT client_id, payload FROM posts ORDER BY sort_order ASC, id ASC");
  await pool.end();
  return rows;
}

async function saveRows(rows) {
  if (!apply) return;
  if (!databaseUrl) {
    await fs.writeFile(postsFile, JSON.stringify(rows.map((row) => row.payload), null, 2));
    return;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows.filter((item) => item.changed)) {
      const payload = row.payload;
      await client.query(
        `UPDATE posts
         SET cover_url = $1, body_images = $2::jsonb, payload = $3::jsonb, updated_at = NOW()
         WHERE client_id = $4`,
        [
          String(payload.cover || payload.image || ""),
          JSON.stringify(Array.isArray(payload.bodyImages) ? payload.bodyImages : []),
          JSON.stringify(payload),
          row.client_id
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function shouldIncludeBodyImages() {
  return scope === "all" || scope === "body" || scope === "body-images";
}

function shouldIncludeCovers() {
  return scope === "all" || scope === "covers" || scope === "cover";
}

const rows = await readRows();
const generated = new Map();
let candidates = 0;
let generatedCount = 0;
let skipped = 0;
let failed = 0;

for (const row of rows) {
  const post = row.payload && typeof row.payload === "object" ? row.payload : {};
  if (!post.id && row.client_id) post.id = row.client_id;
  if (shouldIncludeCovers()) {
    const cover = String(post.cover || post.image || "").trim();
    if (cover && (force || !hasUsableVariants(post.coverVariants || post.imageVariants))) {
      candidates += 1;
      if (!limit || candidates <= limit) {
        if (apply) {
          try {
            const storagePath = storagePathFromUrl(cover);
            if (!storagePath) throw new Error("无法识别存储路径");
            if (!generated.has(cover)) generated.set(cover, await generateVariants(cover, storagePath));
            post.coverVariants = generated.get(cover).variants;
            post.imageVariants = post.coverVariants;
            row.changed = true;
            generatedCount += 1;
            console.log(`cover ok ${post.id || row.client_id}`);
          } catch (error) {
            failed += 1;
            console.warn(`cover failed ${post.id || row.client_id}: ${error.message}`);
          }
        } else {
          console.log(`cover candidate ${post.id || row.client_id}: ${cover}`);
        }
      }
    } else if (cover) {
      skipped += 1;
    }
  }

  if (shouldIncludeBodyImages()) {
    const images = Array.isArray(post.bodyImages) ? post.bodyImages : [];
    const bodyVariants = Array.isArray(post.bodyImageVariants) ? [...post.bodyImageVariants] : [];
    for (let index = 0; index < images.length; index += 1) {
      const image = String(images[index] || "").trim();
      if (!image || (!force && hasUsableVariants(bodyVariants[index]?.variants || bodyVariants[index]))) {
        if (image) skipped += 1;
        continue;
      }
      candidates += 1;
      if (limit && candidates > limit) continue;
      if (!apply) {
        console.log(`body candidate ${post.id || row.client_id}#${index}: ${image}`);
        continue;
      }
      try {
        const storagePath = storagePathFromUrl(image);
        if (!storagePath) throw new Error("无法识别存储路径");
        if (!generated.has(image)) generated.set(image, await generateVariants(image, storagePath));
        bodyVariants[index] = generated.get(image).variants;
        row.changed = true;
        generatedCount += 1;
        console.log(`body ok ${post.id || row.client_id}#${index}`);
      } catch (error) {
        failed += 1;
        console.warn(`body failed ${post.id || row.client_id}#${index}: ${error.message}`);
      }
    }
    if (row.changed) post.bodyImageVariants = bodyVariants;
  }
}

await saveRows(rows);

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  scope,
  totalPosts: rows.length,
  candidates,
  generated: generatedCount,
  skippedExisting: skipped,
  failed,
  changedPosts: rows.filter((row) => row.changed).length,
  limited: Boolean(limit && candidates > limit)
}, null, 2));
