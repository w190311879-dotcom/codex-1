const DEFAULT_MEDIA_ORIGIN = "https://cmtv-media.b-cdn.net";
const DEFAULT_EDGE_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_BROWSER_TTL_SECONDS = 60 * 60 * 24;

function numberFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function mediaContentType(pathname) {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (lower.endsWith(".ts")) return "video/mp2t";
  if (lower.endsWith(".m4s")) return "video/iso.segment";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".key") || lower.endsWith(".bin")) return "application/octet-stream";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".gif")) return "image/gif";
  return "";
}

function mediaHeaders(originResponse, pathname, env, cacheStatus) {
  const edgeTtl = numberFromEnv(env.MEDIA_EDGE_TTL_SECONDS, DEFAULT_EDGE_TTL_SECONDS);
  const browserTtl = numberFromEnv(env.MEDIA_BROWSER_TTL_SECONDS, DEFAULT_BROWSER_TTL_SECONDS);
  const headers = new Headers(originResponse.headers);
  const type = mediaContentType(pathname);
  if (type) headers.set("Content-Type", type);
  headers.set("Cache-Control", `public, max-age=${browserTtl}, s-maxage=${edgeTtl}, immutable`);
  headers.set("CDN-Cache-Control", `public, max-age=${edgeTtl}`);
  headers.set("Cloudflare-CDN-Cache-Control", `public, max-age=${edgeTtl}`);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range, Content-Type, If-Modified-Since, If-None-Match");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified");
  headers.set("Timing-Allow-Origin", "*");
  headers.set("X-Media-Proxy", "cloudflare-worker");
  headers.set("X-Media-Cache", cacheStatus);
  headers.delete("Set-Cookie");
  return headers;
}

function cacheableRequest(request, response) {
  if (request.method !== "GET") return false;
  if (request.headers.has("Range")) return false;
  return response.status === 200;
}

async function fetchFromMediaOrigin(request, env, pathname, upstreamUrl) {
  const edgeTtl = numberFromEnv(env.MEDIA_EDGE_TTL_SECONDS, DEFAULT_EDGE_TTL_SECONDS);
  const headers = new Headers(request.headers);
  headers.set("Host", upstreamUrl.host);
  headers.delete("Cookie");
  headers.delete("CF-Connecting-IP");
  headers.delete("CF-IPCountry");
  headers.delete("X-Forwarded-For");
  return fetch(upstreamUrl.toString(), {
    method: request.method,
    headers,
    redirect: "follow",
    cf: {
      cacheEverything: true,
      cacheTtl: edgeTtl
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: mediaHeaders(new Response(null), "", env, "OPTIONS")
      });
    }

    const requestUrl = new URL(request.url);
    if (!requestUrl.pathname.startsWith("/m/")) return fetch(request);

    const mediaPath = requestUrl.pathname.slice(3);
    if (!mediaPath || mediaPath.includes("..")) return new Response("Invalid media path", { status: 400 });

    const mediaOrigin = String(env.MEDIA_ORIGIN || DEFAULT_MEDIA_ORIGIN).replace(/\/+$/, "");
    const upstreamUrl = new URL(`${mediaOrigin}/${mediaPath}`);
    upstreamUrl.search = requestUrl.search;

    const cache = caches.default;
    const cacheKey = new Request(requestUrl.toString(), { method: "GET" });
    if (request.method === "GET" && !request.headers.has("Range")) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = mediaHeaders(cached, requestUrl.pathname, env, "HIT");
        return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
      }
    }

    const originResponse = await fetchFromMediaOrigin(request, env, requestUrl.pathname, upstreamUrl);
    const headers = mediaHeaders(originResponse, requestUrl.pathname, env, "MISS");
    const response = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers
    });

    if (cacheableRequest(request, response)) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  }
};
