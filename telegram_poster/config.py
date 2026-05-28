import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo


def parse_dotenv_line(line):
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not key:
        return None
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    return key, value


def load_env_file(path):
    env_path = Path(path)
    if not env_path.exists():
        return False
    for line in env_path.read_text(encoding="utf-8").splitlines():
        parsed = parse_dotenv_line(line)
        if not parsed:
            continue
        key, value = parsed
        os.environ.setdefault(key, value)
    return True


def load_default_env(explicit_path=None):
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path))
    elif os.environ.get("TELEGRAM_POSTER_ENV_FILE"):
        candidates.append(Path(os.environ["TELEGRAM_POSTER_ENV_FILE"]))
    else:
        candidates.extend([Path(".env.telegram-poster"), Path(".env")])

    for candidate in candidates:
        if load_env_file(candidate):
            return candidate
    return None


def bool_env(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


def int_env(name, default, minimum=None, maximum=None):
    raw = str(os.environ.get(name, default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be at most {maximum}")
    return value


@dataclass(frozen=True)
class Config:
    telegram_bot_token: str
    telegram_channel_id: str
    bot_api_token: str
    post_source_api_url: str
    fixed_content: str
    timezone_name: str
    daily_post_limit: int
    images_per_post: int
    global_dedup: bool
    dry_run: bool
    database_path: str
    http_timeout_seconds: int
    max_attempts: int
    loop_sleep_seconds: int
    log_level: str

    @property
    def timezone(self):
        return ZoneInfo(self.timezone_name)


def load_config():
    dry_run = bool_env("DRY_RUN", False)
    telegram_bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    telegram_channel_id = os.environ.get("TELEGRAM_CHANNEL_ID", "").strip()
    bot_api_token = os.environ.get("BOT_API_TOKEN", "").strip()
    fixed_content = os.environ.get("FIXED_CONTENT", "").strip()
    fixed_content_file = os.environ.get("FIXED_CONTENT_FILE", "").strip()
    if fixed_content_file:
        fixed_content = Path(fixed_content_file).read_text(encoding="utf-8").strip()

    if not dry_run and not telegram_bot_token:
        raise ValueError("TELEGRAM_BOT_TOKEN is required when DRY_RUN=false")
    if not dry_run and not telegram_channel_id:
        raise ValueError("TELEGRAM_CHANNEL_ID is required when DRY_RUN=false")
    if not bot_api_token:
        raise ValueError("BOT_API_TOKEN is required")

    timezone_name = os.environ.get("TIMEZONE", "Asia/Shanghai").strip() or "Asia/Shanghai"
    ZoneInfo(timezone_name)

    return Config(
        telegram_bot_token=telegram_bot_token,
        telegram_channel_id=telegram_channel_id,
        bot_api_token=bot_api_token,
        post_source_api_url=os.environ.get(
            "POST_SOURCE_API_URL",
            "https://51cmtv.com/api/bot/random-posts",
        ).strip(),
        fixed_content=fixed_content,
        timezone_name=timezone_name,
        daily_post_limit=int_env("DAILY_POST_LIMIT", 15, minimum=1, maximum=50),
        images_per_post=int_env("IMAGES_PER_POST", 6, minimum=1, maximum=20),
        global_dedup=bool_env("GLOBAL_DEDUP", True),
        dry_run=dry_run,
        database_path=os.environ.get("DATABASE_PATH", "data/telegram_poster.sqlite3").strip(),
        http_timeout_seconds=int_env("HTTP_TIMEOUT_SECONDS", 30, minimum=5, maximum=180),
        max_attempts=int_env("MAX_ATTEMPTS", 5, minimum=1, maximum=20),
        loop_sleep_seconds=int_env("LOOP_SLEEP_SECONDS", 30, minimum=5, maximum=600),
        log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO",
    )
