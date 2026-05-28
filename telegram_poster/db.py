import json
import sqlite3
import time
from pathlib import Path


class PosterDatabase:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")

    def close(self):
        self.conn.close()

    def init(self):
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS published_posts (
              post_id TEXT PRIMARY KEY,
              first_published_date TEXT NOT NULL,
              last_published_at TEXT NOT NULL,
              telegram_message_ids TEXT NOT NULL DEFAULT '[]',
              created_ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS daily_queue (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              queue_date TEXT NOT NULL,
              slot_index INTEGER NOT NULL,
              post_id TEXT NOT NULL,
              title TEXT NOT NULL,
              keywords_json TEXT NOT NULL DEFAULT '[]',
              images_json TEXT NOT NULL DEFAULT '[]',
              url TEXT NOT NULL DEFAULT '',
              excerpt TEXT NOT NULL DEFAULT '',
              scheduled_at TEXT NOT NULL,
              scheduled_ts INTEGER NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,
              next_attempt_ts INTEGER NOT NULL DEFAULT 0,
              last_error TEXT NOT NULL DEFAULT '',
              telegram_message_ids TEXT NOT NULL DEFAULT '[]',
              sent_at TEXT NOT NULL DEFAULT '',
              created_ts INTEGER NOT NULL,
              UNIQUE(queue_date, slot_index),
              UNIQUE(queue_date, post_id)
            );

            CREATE INDEX IF NOT EXISTS idx_daily_queue_due
              ON daily_queue(status, scheduled_ts, next_attempt_ts);
            CREATE INDEX IF NOT EXISTS idx_daily_queue_date
              ON daily_queue(queue_date);
            """
        )
        self.conn.commit()

    def queue_count(self, queue_date):
        row = self.conn.execute(
            "SELECT COUNT(*) AS count FROM daily_queue WHERE queue_date = ?",
            (queue_date,),
        ).fetchone()
        return int(row["count"])

    def insert_queue_items(self, queue_date, items):
        now_ts = int(time.time())
        with self.conn:
            for item in items:
                self.conn.execute(
                    """
                    INSERT OR IGNORE INTO daily_queue (
                      queue_date, slot_index, post_id, title, keywords_json,
                      images_json, url, excerpt, scheduled_at, scheduled_ts, created_ts
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        queue_date,
                        item["slot_index"],
                        item["post_id"],
                        item["title"],
                        json.dumps(item.get("keywords", []), ensure_ascii=False),
                        json.dumps(item.get("images", []), ensure_ascii=False),
                        item.get("url", ""),
                        item.get("excerpt", ""),
                        item["scheduled_at"],
                        item["scheduled_ts"],
                        now_ts,
                    ),
                )

    def exclude_ids(self, queue_date, global_dedup=True):
        ids = set()
        if global_dedup:
            rows = self.conn.execute("SELECT post_id FROM published_posts").fetchall()
            ids.update(str(row["post_id"]) for row in rows)
        rows = self.conn.execute(
            "SELECT post_id FROM daily_queue WHERE queue_date = ?",
            (queue_date,),
        ).fetchall()
        ids.update(str(row["post_id"]) for row in rows)
        return sorted(ids)

    def due_items(self, now_ts, limit=5):
        rows = self.conn.execute(
            """
            SELECT * FROM daily_queue
            WHERE status IN ('pending', 'failed')
              AND scheduled_ts <= ?
              AND next_attempt_ts <= ?
            ORDER BY scheduled_ts ASC, id ASC
            LIMIT ?
            """,
            (now_ts, now_ts, limit),
        ).fetchall()
        return [self._decode_row(row) for row in rows]

    def next_due_ts(self):
        row = self.conn.execute(
            """
            SELECT MIN(CASE
              WHEN next_attempt_ts > scheduled_ts THEN next_attempt_ts
              ELSE scheduled_ts
            END) AS next_ts
            FROM daily_queue
            WHERE status IN ('pending', 'failed')
            """
        ).fetchone()
        return int(row["next_ts"]) if row and row["next_ts"] is not None else None

    def mark_sent(self, queue_id, post_id, queue_date, sent_at, message_ids, dry_run=False):
        status = "dry_run" if dry_run else "sent"
        encoded_message_ids = json.dumps(message_ids or [], ensure_ascii=False)
        with self.conn:
            self.conn.execute(
                """
                UPDATE daily_queue
                SET status = ?, sent_at = ?, telegram_message_ids = ?, last_error = ''
                WHERE id = ?
                """,
                (status, sent_at, encoded_message_ids, queue_id),
            )
            if not dry_run:
                self.conn.execute(
                    """
                    INSERT INTO published_posts (
                      post_id, first_published_date, last_published_at,
                      telegram_message_ids, created_ts
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(post_id) DO UPDATE SET
                      last_published_at = excluded.last_published_at,
                      telegram_message_ids = excluded.telegram_message_ids
                    """,
                    (post_id, queue_date, sent_at, encoded_message_ids, int(time.time())),
                )

    def mark_failed(self, queue_id, attempts, error, next_attempt_ts):
        with self.conn:
            self.conn.execute(
                """
                UPDATE daily_queue
                SET status = 'failed',
                    attempts = ?,
                    last_error = ?,
                    next_attempt_ts = ?
                WHERE id = ?
                """,
                (attempts, str(error)[:1000], next_attempt_ts, queue_id),
            )

    def mark_skipped(self, queue_id, error):
        with self.conn:
            self.conn.execute(
                """
                UPDATE daily_queue
                SET status = 'skipped',
                    last_error = ?
                WHERE id = ?
                """,
                (str(error)[:1000], queue_id),
            )

    def _decode_row(self, row):
        data = dict(row)
        data["keywords"] = json.loads(data.pop("keywords_json") or "[]")
        data["images"] = json.loads(data.pop("images_json") or "[]")
        return data
