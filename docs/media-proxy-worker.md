# Cloudflare Worker 媒体反代

这个 Worker 用于把主站路径 `/m/*` 直接在 Cloudflare 边缘反代到 Bunny Pull Zone，避免视频分片继续经过 VPS 中转。

## Worker 路由

在 Cloudflare Workers 中创建 Worker 后，把路由绑定到：

```text
51cmtv.com/m/*
```

绑定后链路变成：

```text
用户 -> 51cmtv.com/m/... -> Cloudflare Worker -> cmtv-media.b-cdn.net -> Bunny
```

## 变量

Worker 变量：

```text
MEDIA_ORIGIN=https://cmtv-media.b-cdn.net
MEDIA_EDGE_TTL_SECONDS=2592000
MEDIA_BROWSER_TTL_SECONDS=86400
```

## 验证

部署后访问一个已存在的媒体文件：

```text
https://51cmtv.com/m/videos/2026-06-03/84f9bf6e-c37e-4325-8fc9-8df38e0f3027-media.jpg
```

响应头应包含：

```text
server: cloudflare
x-media-proxy: cloudflare-worker
x-media-cache: MISS 或 HIT
cache-control: public, max-age=86400, s-maxage=2592000, immutable
```

第二次访问同一个非 Range 资源时，`x-media-cache` 应变为 `HIT`。

## 注意

- HLS `.m3u8`、`.ts`、`.m4s`、图片和 GIF 都会走同一个 `/m/*` 反代。
- Range 请求会透传给 Bunny，不主动写入 Worker Cache，避免部分内容缓存异常。
- 如果还没有部署 Worker，VPS 端 `/m/*` 代理仍可兜底，但视频会继续消耗 VPS 中转带宽。
