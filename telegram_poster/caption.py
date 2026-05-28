import re


MAX_TELEGRAM_CAPTION_LENGTH = 1024


def truncate_text(value, limit):
    text = str(value or "").strip()
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def hashtag(value):
    raw = str(value or "").strip().lstrip("#")
    cleaned = re.sub(r"[^0-9A-Za-z_\u3400-\u9fff]+", "", raw)
    return f"#{cleaned}" if cleaned else ""


def keyword_line(keywords, max_length=240):
    tags = []
    for keyword in keywords or []:
        tag = hashtag(keyword)
        if tag and tag not in tags:
            tags.append(tag)
    if not tags:
        return ""
    line = " ".join(tags)
    return truncate_text(f"关键词：{line}", max_length)


def build_caption(title, keywords, fixed_content, url, max_length=MAX_TELEGRAM_CAPTION_LENGTH):
    title_text = truncate_text(title or "Untitled", 180)
    keywords_text = keyword_line(keywords)
    link_text = f"原文链接：{str(url or '').strip()}" if url else ""

    required_parts = [part for part in [title_text, keywords_text, link_text] if part]
    required = "\n\n".join(required_parts)
    if not fixed_content:
        return truncate_text(required, max_length)

    separator = "\n\n" if required else ""
    remaining = max_length - len(required) - len(separator)
    fixed_text = truncate_text(fixed_content, remaining)
    parts = [title_text, keywords_text, fixed_text, link_text]
    return truncate_text("\n\n".join(part for part in parts if part), max_length)
