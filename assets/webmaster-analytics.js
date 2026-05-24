(() => {
  const config = window.POSTWAVE_CONFIG || {};
  const apiBase = String(config.apiBaseUrl || "").replace(/\/+$/, "");
  const endpoint = `${apiBase}/api/public/analytics/track`;
  const storageKey = "postwave_visitor_id";
  const sessionKey = "postwave_analytics_session";
  const sessionTimeoutMs = 30 * 60 * 1000;
  const pageStartedAt = Date.now();
  const impressedPosts = new Set();
  const playedVideos = new WeakSet();

  function visitorId() {
    try {
      let id = localStorage.getItem(storageKey);
      if (!id) {
        id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(storageKey, id);
      }
      return id;
    } catch {
      return "";
    }
  }

  function sessionId() {
    try {
      const now = Date.now();
      const current = JSON.parse(localStorage.getItem(sessionKey) || "null");
      if (current?.id && current?.lastSeen && now - Number(current.lastSeen) < sessionTimeoutMs) {
        current.lastSeen = now;
        localStorage.setItem(sessionKey, JSON.stringify(current));
        return current.id;
      }
      const next = { id: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(16).slice(2)}`, lastSeen: now };
      localStorage.setItem(sessionKey, JSON.stringify(next));
      return next.id;
    } catch {
      return "";
    }
  }

  function pageType() {
    const path = location.pathname;
    if (path.includes("detail")) return "detail";
    if (path.includes("route-select")) return "route-select";
    if (path.includes("app")) return "app";
    if (path.includes("qq")) return "qq";
    return "home";
  }

  function postIdFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.searchParams.get("id") || "";
    } catch {
      return "";
    }
  }

  function payload(event, extra = {}) {
    const params = new URLSearchParams(location.search);
    return {
      event,
      clientId: visitorId(),
      sessionId: sessionId(),
      host: location.host,
      path: `${location.pathname}${location.search}`,
      title: document.title,
      referrer: document.referrer,
      language: navigator.language || "",
      pageType: pageType(),
      postId: params.get("id") || "",
      durationSeconds: Math.round((Date.now() - pageStartedAt) / 1000),
      screen: {
        width: window.innerWidth || 0,
        height: window.innerHeight || 0
      },
      ...extra
    };
  }

  function send(event, extra = {}) {
    if (!endpoint || document.visibilityState === "prerender") return;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload(event, extra)),
      keepalive: true
    }).catch(() => {});
  }

  function navigationMetrics() {
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    const paint = performance.getEntriesByType?.("paint") || [];
    const fcp = paint.find((entry) => entry.name === "first-contentful-paint");
    if (nav) {
      return {
        ttfbMs: Math.round(nav.responseStart),
        domReadyMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd || nav.duration),
        fcpMs: fcp ? Math.round(fcp.startTime) : 0
      };
    }
    const timing = performance.timing;
    if (!timing?.navigationStart) return {};
    return {
      ttfbMs: timing.responseStart - timing.navigationStart,
      domReadyMs: timing.domContentLoadedEventEnd - timing.navigationStart,
      loadMs: timing.loadEventEnd - timing.navigationStart,
      fcpMs: fcp ? Math.round(fcp.startTime) : 0
    };
  }

  function postInfoFromLink(link) {
    const postId = postIdFromUrl(link.getAttribute("href") || "");
    if (!postId) return null;
    const title = link.querySelector(".post-title, h2, h3")?.textContent?.trim() || link.getAttribute("aria-label") || document.title;
    return { postId, title };
  }

  function observePostLinks() {
    const links = [...document.querySelectorAll('a[href*="detail.html?id="]')];
    if (!links.length) return;
    if (!("IntersectionObserver" in window)) {
      links.forEach((link) => {
        const info = postInfoFromLink(link);
        if (!info || impressedPosts.has(info.postId)) return;
        impressedPosts.add(info.postId);
        send("post_impression", info);
      });
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const info = postInfoFromLink(entry.target);
        if (!info || impressedPosts.has(info.postId)) return;
        impressedPosts.add(info.postId);
        send("post_impression", info);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.45 });
    links.forEach((link) => {
      const info = postInfoFromLink(link);
      if (info && !impressedPosts.has(info.postId)) observer.observe(link);
    });
  }

  function videoInfo(video) {
    const holder = video.closest?.("[data-media-video], [data-preview-video]");
    const videoId = holder?.dataset?.mediaVideo || holder?.dataset?.previewVideo || "";
    return { videoId, title: document.title, postId: new URLSearchParams(location.search).get("id") || "" };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      send("pageview");
      observePostLinks();
    }, { once: true });
  } else {
    send("pageview");
    observePostLinks();
  }

  window.addEventListener("load", () => {
    setTimeout(() => send("performance", { metrics: navigationMetrics() }), 0);
  }, { once: true });

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.('a[href*="detail.html?id="]');
    if (!link) return;
    const info = postInfoFromLink(link);
    if (info) send("post_click", info);
  }, true);

  document.addEventListener("play", (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || playedVideos.has(video)) return;
    playedVideos.add(video);
    send("video_play", videoInfo(video));
  }, true);

  new MutationObserver(() => observePostLinks()).observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    if (!document.hidden) send("heartbeat");
  }, 30000);

  window.addEventListener("pagehide", () => send("heartbeat"));
})();
