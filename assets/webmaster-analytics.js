(() => {
  const config = window.POSTWAVE_CONFIG || {};
  const apiBase = String(config.apiBaseUrl || "").replace(/\/+$/, "");
  const endpoint = `${apiBase}/api/public/analytics/track`;
  const storageKey = "postwave_visitor_id";

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

  function pageType() {
    const path = location.pathname;
    if (path.includes("detail")) return "detail";
    if (path.includes("route-select")) return "route-select";
    if (path.includes("app")) return "app";
    if (path.includes("qq")) return "qq";
    return "home";
  }

  function payload(event) {
    const params = new URLSearchParams(location.search);
    return {
      event,
      clientId: visitorId(),
      host: location.host,
      path: `${location.pathname}${location.search}`,
      title: document.title,
      referrer: document.referrer,
      language: navigator.language || "",
      pageType: pageType(),
      postId: params.get("id") || "",
      screen: {
        width: window.innerWidth || 0,
        height: window.innerHeight || 0
      }
    };
  }

  function send(event) {
    if (!endpoint || document.visibilityState === "prerender") return;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload(event)),
      keepalive: true
    }).catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => send("pageview"), { once: true });
  } else {
    send("pageview");
  }

  setInterval(() => {
    if (!document.hidden) send("heartbeat");
  }, 30000);
})();
