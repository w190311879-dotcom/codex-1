import json
import urllib.parse
import urllib.request


class PostSourceClient:
    def __init__(self, api_url, bot_api_token, timeout=30):
        self.api_url = api_url
        self.bot_api_token = bot_api_token
        self.timeout = timeout

    def fetch_posts(self, limit, images_per_post, exclude_ids=None):
        exclude_ids = exclude_ids or []
        query = {
            "limit": str(limit),
            "images_per_post": str(images_per_post),
        }
        if exclude_ids:
            query["exclude_ids"] = ",".join(str(item) for item in exclude_ids)
        url = f"{self.api_url}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self.bot_api_token}",
                "Accept": "application/json",
                "User-Agent": "51cmtv-telegram-poster/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
                status = response.status
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Post source returned HTTP {exc.code}: {detail[:300]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Post source request failed: {exc}") from exc

        if status < 200 or status >= 300:
            raise RuntimeError(f"Post source returned HTTP {status}")

        payload = json.loads(body)
        posts = payload.get("posts")
        if not isinstance(posts, list):
            raise RuntimeError("Post source response is missing posts list")
        return [self._normalize_post(post, images_per_post) for post in posts]

    def _normalize_post(self, post, images_per_post):
        if not isinstance(post, dict):
            raise RuntimeError("Post source returned an invalid post")
        images = [str(url).strip() for url in post.get("images", []) if str(url).strip()]
        if len(images) < images_per_post:
            raise RuntimeError(f"Post {post.get('id')} has fewer than {images_per_post} images")
        return {
            "id": str(post.get("id", "")).strip(),
            "title": str(post.get("title", "")).strip(),
            "keywords": [str(item).strip() for item in post.get("keywords", []) if str(item).strip()],
            "images": images[:images_per_post],
            "url": str(post.get("url", "")).strip(),
            "published_at": str(post.get("published_at", "")).strip(),
            "excerpt": str(post.get("excerpt", "")).strip(),
        }
