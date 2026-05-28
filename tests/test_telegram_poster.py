import tempfile
import unittest
from datetime import date, datetime
from random import Random
from zoneinfo import ZoneInfo

from telegram_poster.caption import build_caption, hashtag
from telegram_poster.db import PosterDatabase
from telegram_poster.scheduler import generate_daily_schedule


class SchedulerTests(unittest.TestCase):
    def test_generate_daily_schedule_is_evenly_slotted(self):
        timezone = ZoneInfo("Asia/Shanghai")
        day = date(2026, 5, 28)
        times = generate_daily_schedule(day, 15, timezone, rng=Random(123))

        self.assertEqual(len(times), 15)
        self.assertEqual(times, sorted(times))
        start = datetime(2026, 5, 28, tzinfo=timezone)
        slot_seconds = 24 * 60 * 60 / 15
        for index, scheduled_at in enumerate(times):
            lower = start.timestamp() + slot_seconds * index
            upper = start.timestamp() + slot_seconds * (index + 1)
            self.assertGreaterEqual(scheduled_at.timestamp(), lower)
            self.assertLess(scheduled_at.timestamp(), upper)


class CaptionTests(unittest.TestCase):
    def test_caption_is_within_telegram_limit(self):
        caption = build_caption(
            title="A long title " * 30,
            keywords=["alpha", "beta keyword", "中文关键词"],
            fixed_content="fixed " * 500,
            url="https://51cmtv.com/v/post-1",
        )

        self.assertLessEqual(len(caption), 1024)
        self.assertNotIn("https://51cmtv.com/v/post-1", caption)
        self.assertIn("#alpha", caption)
        self.assertIn("#betakeyword", caption)
        self.assertIn("#中文关键词", caption)

    def test_hashtag_sanitizes_text(self):
        self.assertEqual(hashtag("# hello world! "), "#helloworld")
        self.assertEqual(hashtag("关键词-1"), "#关键词1")


class DatabaseTests(unittest.TestCase):
    def test_exclude_ids_include_published_and_today_queue(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db = PosterDatabase(f"{temp_dir}/poster.sqlite3")
            db.init()
            db.insert_queue_items(
                "2026-05-28",
                [
                    {
                        "slot_index": 0,
                        "post_id": "queued-1",
                        "title": "Queued",
                        "keywords": [],
                        "images": ["https://media.51cmtv.com/1.jpg"] * 6,
                        "url": "https://51cmtv.com/v/queued-1",
                        "scheduled_at": "2026-05-28T00:00:00+08:00",
                        "scheduled_ts": 1780000000,
                    }
                ],
            )
            db.mark_sent(
                queue_id=1,
                post_id="published-1",
                queue_date="2026-05-27",
                sent_at="2026-05-27T00:00:00+08:00",
                message_ids=["1"],
            )

            self.assertEqual(db.exclude_ids("2026-05-28", global_dedup=True), ["published-1", "queued-1"])
            self.assertEqual(db.exclude_ids("2026-05-28", global_dedup=False), ["queued-1"])
            db.close()


if __name__ == "__main__":
    unittest.main()
