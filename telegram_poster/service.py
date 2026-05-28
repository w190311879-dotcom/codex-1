import argparse
from datetime import datetime, timedelta
import logging
import sys
import time

from .caption import build_caption
from .config import load_config, load_default_env
from .db import PosterDatabase
from .post_source import PostSourceClient
from .scheduler import generate_daily_schedule, local_midnight
from .telegram_client import TelegramClient


class PosterService:
    def __init__(self, config):
        self.config = config
        self.db = PosterDatabase(config.database_path)
        self.source = PostSourceClient(
            config.post_source_api_url,
            config.bot_api_token,
            timeout=config.http_timeout_seconds,
        )
        self.telegram = TelegramClient(
            config.telegram_bot_token,
            config.telegram_channel_id,
            timeout=config.http_timeout_seconds,
            dry_run=config.dry_run,
        )

    def close(self):
        self.db.close()

    def setup(self):
        self.db.init()

    def ensure_today_queue(self, startup=False):
        now = datetime.now(self.config.timezone)
        queue_date = now.date().isoformat()
        if self.db.queue_count(queue_date) > 0:
            return

        exclude_ids = self.db.exclude_ids(queue_date, global_dedup=self.config.global_dedup)
        posts = self.source.fetch_posts(
            limit=self.config.daily_post_limit,
            images_per_post=self.config.images_per_post,
            exclude_ids=exclude_ids,
        )
        if len(posts) < self.config.daily_post_limit:
            logging.warning("Post source returned %s/%s posts", len(posts), self.config.daily_post_limit)

        start_after = None
        if startup and now > local_midnight(now.date(), self.config.timezone) + timedelta(minutes=2):
            start_after = now + timedelta(minutes=1)

        schedule = generate_daily_schedule(now.date(), len(posts), self.config.timezone, start_after=start_after)
        queue_items = []
        for index, (post, scheduled_at) in enumerate(zip(posts, schedule)):
            queue_items.append(
                {
                    "slot_index": index,
                    "post_id": post["id"],
                    "title": post["title"],
                    "keywords": post["keywords"],
                    "images": post["images"],
                    "url": post["url"],
                    "excerpt": post.get("excerpt", ""),
                    "scheduled_at": scheduled_at.isoformat(),
                    "scheduled_ts": int(scheduled_at.timestamp()),
                }
            )
        self.db.insert_queue_items(queue_date, queue_items)
        logging.info("Created %s queue items for %s", len(queue_items), queue_date)

    def send_due_once(self):
        now_ts = int(time.time())
        sent_count = 0
        for item in self.db.due_items(now_ts, limit=5):
            if item["attempts"] >= self.config.max_attempts:
                logging.error("Skipping queue item %s after %s attempts", item["id"], item["attempts"])
                self.db.mark_skipped(item["id"], "max attempts exceeded")
                continue
            try:
                self.send_item(item)
                sent_count += 1
            except Exception as exc:
                attempts = int(item["attempts"]) + 1
                delay_seconds = min(3600, 300 * (2 ** max(0, attempts - 1)))
                next_attempt_ts = int(time.time()) + delay_seconds
                self.db.mark_failed(item["id"], attempts, exc, next_attempt_ts)
                logging.exception("Failed to send queue item %s; attempt %s", item["id"], attempts)
        return sent_count

    def send_item(self, item):
        caption = build_caption(
            title=item["title"],
            keywords=item["keywords"],
            fixed_content=self.config.fixed_content,
            url=item["url"],
        )
        message_ids = self.telegram.send_media_group(item["images"], caption)
        sent_at = datetime.now(self.config.timezone).isoformat()
        self.db.mark_sent(
            item["id"],
            item["post_id"],
            item["queue_date"],
            sent_at,
            message_ids,
            dry_run=self.config.dry_run,
        )
        logging.info("Sent post %s with %s images", item["post_id"], len(item["images"]))

    def preview(self):
        exclude_ids = self.db.exclude_ids(
            datetime.now(self.config.timezone).date().isoformat(),
            global_dedup=self.config.global_dedup,
        )
        posts = self.source.fetch_posts(1, self.config.images_per_post, exclude_ids=exclude_ids)
        if not posts:
            print("No posts returned.")
            return 1
        post = posts[0]
        print("Post ID:", post["id"])
        print("Title:", post["title"])
        print("Images:", len(post["images"]))
        print("URL:", post["url"])
        print()
        print(build_caption(post["title"], post["keywords"], self.config.fixed_content, post["url"]))
        return 0

    def run_forever(self):
        self.setup()
        self.ensure_today_queue(startup=True)
        current_date = datetime.now(self.config.timezone).date()
        logging.info("Telegram poster started; dry_run=%s", self.config.dry_run)
        while True:
            now = datetime.now(self.config.timezone)
            if now.date() != current_date:
                current_date = now.date()
                self.ensure_today_queue(startup=False)
            else:
                self.ensure_today_queue(startup=True)

            self.send_due_once()
            sleep_seconds = self._sleep_seconds()
            time.sleep(sleep_seconds)

    def _sleep_seconds(self):
        now_ts = int(time.time())
        next_due_ts = self.db.next_due_ts()
        if next_due_ts is None:
            return self.config.loop_sleep_seconds
        return max(5, min(self.config.loop_sleep_seconds, next_due_ts - now_ts))


def configure_logging(level):
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )


def parse_args(argv):
    parser = argparse.ArgumentParser(description="51cmtv Telegram poster service")
    parser.add_argument("--env-file", help="Path to dotenv file")
    parser.add_argument("--dry-run", action="store_true", help="Override DRY_RUN=true")
    parser.add_argument("--once", action="store_true", help="Create today's queue, send due items, and exit")
    parser.add_argument("--preview", action="store_true", help="Fetch one post and print the message preview")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    load_default_env(args.env_file)
    if args.dry_run:
        import os

        os.environ["DRY_RUN"] = "true"
    config = load_config()
    configure_logging(config.log_level)

    service = PosterService(config)
    try:
        service.setup()
        if args.preview:
            return service.preview()
        if args.once:
            service.ensure_today_queue(startup=True)
            service.send_due_once()
            return 0
        service.run_forever()
        return 0
    finally:
        service.close()
