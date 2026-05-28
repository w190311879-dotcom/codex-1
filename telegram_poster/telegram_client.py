import json
import logging
import mimetypes
import uuid
import urllib.error
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

        return self.send_uploaded_media_group(images, caption)

    def send_uploaded_media_group(self, images, caption):
        files = []
        media = []
        for index, image_url in enumerate(images):
            field_name = f"photo{index}"
            filename, content_type, data = self._download_media(image_url, index)
            files.append((field_name, filename, content_type, data))
            item = {"type": "photo", "media": f"attach://{field_name}"}
            if index == 0 and caption:
                item["caption"] = caption
            media.append(item)

        payload = {
            "chat_id": self.channel_id,
            "disable_notification": False,
            "media": json.dumps(media, ensure_ascii=False),
        }
        response = self._post_multipart("sendMediaGroup", payload, files)
        messages = response.get("result", [])
        return [str(message.get("message_id")) for message in messages if isinstance(message, dict)]

    def _download_media(self, url, index):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "51cmtv-telegram-poster/0.1"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                data = response.read()
                content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip()
        except Exception as exc:
            raise RuntimeError(f"Failed to download media {index + 1}: {exc}") from exc

        if not data:
            raise RuntimeError(f"Downloaded media {index + 1} is empty")
        guessed_type = mimetypes.guess_type(url)[0]
        content_type = content_type or guessed_type or "application/octet-stream"
        extension = mimetypes.guess_extension(content_type) or ".jpg"
        return f"photo{index}{extension}", content_type, data

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
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Telegram API request failed: HTTP {exc.code} {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Telegram API request failed: {exc}") from exc

        data = json.loads(text)
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API error: {data}")
        return data

    def _post_multipart(self, method, fields, files):
        boundary = f"----telegram-poster-{uuid.uuid4().hex}"
        body_parts = []

        for name, value in fields.items():
            body_parts.append(f"--{boundary}\r\n".encode("utf-8"))
            body_parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
            body_parts.append(str(value).encode("utf-8"))
            body_parts.append(b"\r\n")

        for field_name, filename, content_type, data in files:
            body_parts.append(f"--{boundary}\r\n".encode("utf-8"))
            body_parts.append(
                (
                    f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
                    f"Content-Type: {content_type}\r\n\r\n"
                ).encode("utf-8")
            )
            body_parts.append(data)
            body_parts.append(b"\r\n")

        body_parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        body = b"".join(body_parts)
        request = urllib.request.Request(
            f"https://api.telegram.org/bot{self.bot_token}/{method}",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Telegram API request failed: HTTP {exc.code} {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Telegram API request failed: {exc}") from exc

        data = json.loads(text)
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API error: {data}")
        return data
