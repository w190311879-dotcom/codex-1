# Domain Routing

The production routing model has three public layers:

1. Entry domains only redirect to the route selector.
2. The route selector shows the available line domains.
3. Line domains serve the real PostWave site and same-origin `/api` routes.

Example environment:

```env
ROUTE_ENTRY_HOSTS=51cmtv.com
ROUTE_SELECTOR_ORIGIN=https://nav.51cmtv.com
PUBLIC_SITE_ORIGINS=https://line1.51cmtv.com,https://line2.51cmtv.com,https://line3.51cmtv.com
ROUTE_LINE_ORIGINS=https://line1.51cmtv.com,https://line2.51cmtv.com,https://line3.51cmtv.com

PUBLIC_ADMIN_ORIGIN=https://admin.51cmtv.com
PUBLIC_API_BASE_URL=https://api.51cmtv.com
PUBLIC_MEDIA_BASE_URL=https://media.51cmtv.com
SESSION_COOKIE_DOMAIN=.51cmtv.com

ADMIN_HOST=admin.51cmtv.com
API_HOST=api.51cmtv.com
MEDIA_HOST=media.51cmtv.com
```

Cloudflare should point entry domains at the app or a Worker that returns a
`302` to `ROUTE_SELECTOR_ORIGIN`. If the entry domains point at the app, the
Node server performs that redirect itself.

`ROUTE_ENTRY_HOSTS` is for fixed entry domains that must always work, such as
`51cmtv.com`. Backup entries such as `51cmtv1.com` and `51cmtv2.com` are stored
in the admin panel under Appearance, so they can be changed without editing the
server `.env`.

Line domains should proxy to the app. Frontend pages on a line domain call
same-origin `/api/...` so user login and comments keep working without
cross-site cookie issues.

Media URLs remain on `PUBLIC_MEDIA_BASE_URL`, backed by bunny.net CDN and
Storage.

The latest-address email autoresponder is separate from page routing. See
`docs/email-autoreply.md` for the Cloudflare Email Routing + Worker setup.
