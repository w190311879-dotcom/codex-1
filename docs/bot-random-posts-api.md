# Telegram 机器人随机帖子接口

该接口供内部 Telegram 自动发帖机器人读取公开帖子数据。接口只返回数据，不负责发布 Telegram。

## 地址

```http
GET https://51cmtv.com/api/bot/random-posts
```

## 鉴权

服务端从环境变量读取 token：

```env
BOT_API_TOKEN=replace-with-a-long-random-token
```

请求时必须带 Bearer Token：

```http
Authorization: Bearer <BOT_API_TOKEN>
```

未带 token 或 token 错误返回 `401`。服务端未配置 `BOT_API_TOKEN` 时返回 `503`，避免接口被意外公开。

## 请求参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `limit` | `15` | 返回帖子数量，范围 `1-50`。没有足够帖子时返回当前可用数量。 |
| `images_per_post` | `6` | 每条帖子返回图片数量，范围 `6-20`。接口只会选择至少有这么多张图片的公开帖子。 |
| `exclude_ids` | 空 | 英文逗号分隔的帖子 ID 列表，用于排除已经发过的帖子。 |

## 返回示例

```json
{
  "posts": [
    {
      "id": "post-123",
      "title": "帖子标题",
      "keywords": ["关键词1", "关键词2"],
      "images": [
        "https://media.51cmtv.com/images/2026-05-28/1.jpg",
        "https://media.51cmtv.com/images/2026-05-28/2.jpg"
      ],
      "url": "https://51cmtv.com/v/post-123/post-title",
      "published_at": "2026-05-28T04:00:00.000Z",
      "excerpt": "帖子摘要"
    }
  ]
}
```

## 过滤规则

- 只返回现有业务逻辑中的公开帖子，也就是状态为 `已发布` 的内容。
- 不返回草稿、隐藏、删除、下架、投诉处理或审核中的内容。
- 每条帖子至少有 `images_per_post` 张可访问图片。
- 图片和原文链接都会返回完整 URL。

## curl 测试

```bash
curl -fsS \
  -H "Authorization: Bearer $BOT_API_TOKEN" \
  "https://51cmtv.com/api/bot/random-posts?limit=15&images_per_post=6"
```

排除已发过的帖子：

```bash
curl -fsS \
  -H "Authorization: Bearer $BOT_API_TOKEN" \
  "https://51cmtv.com/api/bot/random-posts?limit=15&images_per_post=6&exclude_ids=post-1,post-2,post-3"
```

本地集成测试：

```bash
npm run test:bot-api
```
