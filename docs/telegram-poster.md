# Telegram poster service

这个服务每天从 `51cmtv.com` 的内部 API 获取帖子，并按随机但均匀的时间发送到 Telegram 频道。

## 本地测试

```bash
cp .env.telegram-poster.example .env.telegram-poster
python3 -m unittest discover -s tests
python3 -m telegram_poster --env-file .env.telegram-poster --dry-run --preview
```

## VPS 目录

推荐部署到独立目录，避免影响网站主程序：

```bash
/var/www/telegram-poster
```

## 环境变量

```env
TELEGRAM_BOT_TOKEN=telegram-bot-token
TELEGRAM_CHANNEL_ID=@channel_username_or_-100_id
BOT_API_TOKEN=site-bot-api-token
POST_SOURCE_API_URL=https://51cmtv.com/api/bot/random-posts
FIXED_CONTENT=your-fixed-message
# 多行固定文案建议写入单独文件：
FIXED_CONTENT_FILE=/var/www/telegram-poster/fixed-content.txt
TIMEZONE=Asia/Shanghai
DAILY_POST_LIMIT=15
IMAGES_PER_POST=6
GLOBAL_DEDUP=true
DRY_RUN=false
DATABASE_PATH=data/telegram_poster.sqlite3
```

## systemd

```bash
sudo cp deploy/telegram-poster.service /etc/systemd/system/telegram-poster.service
sudo systemctl daemon-reload
sudo systemctl enable telegram-poster
sudo systemctl start telegram-poster
journalctl -u telegram-poster -f
```

如果频道 ID 或固定文案还没确定，可以先不要启动服务，或设置 `DRY_RUN=true` 做预览。
