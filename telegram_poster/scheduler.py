from datetime import datetime, time, timedelta
import random


def local_midnight(day, timezone):
    return datetime.combine(day, time.min, tzinfo=timezone)


def generate_daily_schedule(day, count, timezone, start_after=None, rng=None):
    if count <= 0:
        return []
    rng = rng or random.SystemRandom()
    day_start = local_midnight(day, timezone)
    day_end = day_start + timedelta(days=1)
    start = day_start
    if start_after is not None:
        if start_after.tzinfo is None:
            start_after = start_after.replace(tzinfo=timezone)
        start_after = start_after.astimezone(timezone)
        if day_start < start_after < day_end:
            start = start_after
    if start >= day_end:
        return []

    window_seconds = (day_end - start).total_seconds()
    slot_seconds = window_seconds / count
    times = []
    for index in range(count):
        slot_start = start + timedelta(seconds=slot_seconds * index)
        slot_end = start + timedelta(seconds=slot_seconds * (index + 1))
        usable_seconds = max(0, (slot_end - slot_start).total_seconds() - 1)
        offset = rng.uniform(0, usable_seconds) if usable_seconds else 0
        times.append(slot_start + timedelta(seconds=offset))
    return sorted(times)
