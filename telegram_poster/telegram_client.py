import json
import logging
import urllib.request


class TelegramClient:
    def __init__(self, bot_token, channel_id, timeout=30, dry_run=False):
        self.bot_token = bot_token
        self.channel_id = channel_id
        self.timeout = timeout
        self.dry_run = dry_run

    def send_media_group(self, images, caption):
        media = []
        for index, image_url in enumerate(images):
            item = {"type": "photo", "media": image_url}
            if index == 0 and caption:
                item["caption"] = caption
            media.append(item)

        if self.dry_run:
            logging.info("DRY_RUN media group: channel=%s images=%s caption=%r", self.channel_id, len(media), caption)
            return [f"dry-run-{index + 1}" for index in range(len(media))]

        payload = {
            "chat_id": self.channel_id,
            "media": media,
            "disable_notification": False,
        }
        response = self._post_json("sendMediaGroup", payload)
        messages = response.get("result", [])
        return [str(message.get("message_id")) for message in messages if isinstance(message, dict)]

    def _post_json(self, method, payload):
        url = f"https://api.telegram.org/bot{self.bot_token}/{method}"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "51cmtv-telegram-poster/0.1",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8")
        except Exception as exc:
            raise RuntimeError(f"Telegram API request failed: {exc}") from exc

        data = json.loads(text)
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API error: {data}")
        return data
