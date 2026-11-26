# Deploying Concord Behind a Reverse Proxy

This guide covers deploying Concord in production behind a reverse proxy (such as Caddy, Nginx, Cloudflare, or AWS CloudFront/ALB), focusing on TLS termination, HTTP Strict Transport Security (HSTS), session cookie protection, sub-path restrictions, and correct proxy hop counting with `CONCORD_TRUST_PROXY`.

---

## 1. Why Concord Requires a Reverse Proxy

Concord's HTTP service (`services/api/src/main.ts`) runs as a single unprivileged Node.js process listening by default on `127.0.0.1:4400`. It deliberately does not bind low-numbered ports (80/443) or manage TLS certificates.

In production, a reverse proxy handles:
- **TLS termination**: Automating and managing TLS certificates.
- **HSTS and HTTP-to-HTTPS redirection**: Ensuring transport encryption.
- **Header normalization**: Accurately setting `X-Forwarded-For`, `X-Forwarded-Proto`, and `Host`.
- **DDoS and slow-client buffering**.

---

## 2. Reverse Proxy Hop Counting (`CONCORD_TRUST_PROXY`)

Concord enforces per-IP rate limiting on security-sensitive endpoints (such as sign-in, account creation, invitations, and password resets in `services/api/src/auth-api.ts`).

To attribute requests to client IP addresses rather than the proxy's local socket address, Concord inspects the `X-Forwarded-For` header according to `CONCORD_TRUST_PROXY` (`services/api/src/config.ts`).

### The Extraction Algorithm

In `services/api/src/auth-api.ts`:
```ts
const hops = (c.req.header("x-forwarded-for") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const seen = hops[hops.length - trustProxyHops];
```
Concord counts **`trustProxyHops` entries from the right-hand side** of the `X-Forwarded-For` list.

### Why Correct Hop Counting Matters

1. **Under-counting (`CONCORD_TRUST_PROXY=0` or omitted)**:
   Concord ignores `X-Forwarded-For` and falls back to the socket's peer address (typically `127.0.0.1`). All external users share a single global rate-limit bucket (e.g. 20 failed sign-ins per 10 minutes), allowing a single user's failed attempts to block access for the entire installation.
2. **Over-counting (`CONCORD_TRUST_PROXY` set too high)**:
   If there is 1 proxy but `CONCORD_TRUST_PROXY=2`, Concord looks two hops from the right, reading an entry supplied by the client. An attacker can spoof their IP by sending `X-Forwarded-For: <fake-ip>`, bypassing rate limits.

---

### Hop Count Architecture Diagrams

#### Scenario A: Single Reverse Proxy (`CONCORD_TRUST_PROXY=1`)

A single reverse proxy (Caddy or Nginx) faces the public internet directly:

```
+-------------------+               +-------------------+               +-------------------+
|   Client Device   |               |   Reverse Proxy   |               |   Concord API     |
| (203.0.113.195)   |               |  (Caddy / Nginx)  |               | (127.0.0.1:4400)  |
+-------------------+               +-------------------+               +-------------------+
          |                                   |                                   |
          | HTTP Request                      |                                   |
          |---------------------------------->|                                   |
          |                                   | Appends client peer IP to XFF:   |
          |                                   | "X-Forwarded-For: 203.0.113.195"  |
          |                                   |---------------------------------->|
          |                                   |                                   |
          |                                   |       hops = ["203.0.113.195"]    |
          |                                   |       trustProxyHops = 1          |
          |                                   |       index: hops.length - 1 = 0  |
          |                                   |       Client IP: 203.0.113.195    |
```

#### Scenario B: Two Reverse Proxies (`CONCORD_TRUST_PROXY=2`)

Traffic passes through an edge proxy/CDN (e.g. Cloudflare, AWS CloudFront) and then a local ingress/proxy (e.g. Nginx, Kubernetes Ingress):

```
+----------------+      +-------------------+      +-------------------+      +-------------------+
| Client Device  |      |   Edge CDN / LB   |      |   Origin Proxy    |      |   Concord API     |
| 203.0.113.195  |      |   198.51.100.10   |      |   (Nginx/Caddy)   |      | (127.0.0.1:4400)  |
+----------------+      +-------------------+      +-------------------+      +-------------------+
        |                         |                          |                          |
        | Request                 |                          |                          |
        |------------------------>|                          |                          |
        |                         | Appends client IP:       |                          |
        |                         | XFF: 203.0.113.195       |                          |
        |                         |------------------------->|                          |
        |                         |                          | Appends Edge Proxy IP:   |
        |                         |                          | XFF: 203.0.113.195,      |
        |                         |                          |      198.51.100.10       |
        |                         |                          |------------------------->|
        |                         |                          |                          |
        |                         |                          | hops = [                 |
        |                         |                          |   "203.0.113.195",       |
        |                         |                          |   "198.51.100.10"        |
        |                         |                          | ]                        |
        |                         |                          | trustProxyHops = 2       |
        |                         |                          | index: length - 2 = 0    |
        |                         |                          | Client IP: 203.0.113.195 |
```

#### Scenario C: Spoofing Resistance

If a client sends a fabricated `X-Forwarded-For: 1.1.1.1` to a single proxy (`CONCORD_TRUST_PROXY=1`):

```
Client sends:      X-Forwarded-For: 1.1.1.1
Proxy appends:     X-Forwarded-For: 1.1.1.1, 203.0.113.195
Concord evaluates: hops.length - 1 => "203.0.113.195" (attacker's real IP, spoof ignored)
```

---

## 3. TLS, HSTS, and `CONCORD_PUBLIC_URL`

### Secure Cookies (`__Host-` prefix)

In `services/api/src/auth-api.ts`:
```ts
const secure = options.publicUrl.startsWith("https://");
const name = secure ? "__Host-concord_session" : "concord_session";
```
When `CONCORD_PUBLIC_URL` begins with `https://`:
- Concord automatically sets session cookies with the hardened `__Host-` prefix (`__Host-concord_session` and `__Host-concord_oauth`).
- The `__Host-` prefix enforces browser-level security:
  - Must be sent over HTTPS only (`Secure`).
  - Must have `Path=/`.
  - Must not have a `Domain` attribute (cannot be read, set, or overwritten by sibling subdomains).

### Non-HTTPS Startup Warning

If `CONCORD_PUBLIC_URL` uses `http://`, Concord emits a startup warning in `services/api/src/main.ts`:
```
CONCORD_PUBLIC_URL is not https: sessions travel in the clear. Put TLS in front before anyone signs in.
```

### Google OAuth Redirect URI

When Google OAuth sign-in is enabled, the redirect URI is constructed as:
```
${CONCORD_PUBLIC_URL}/api/auth/google/callback
```
This exact URI must be added to the Google Cloud Console under **Authorized redirect URIs**.

### HTTP Strict Transport Security (HSTS)

Your reverse proxy must emit HSTS headers to instruct browsers never to connect over insecure HTTP:
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

---

## 4. Why Path Prefixes / Sub-Path Hosting is Unsupported

Concord must be hosted at the root of a domain or subdomain (e.g., `https://concord.example.com/`). Hosting under a sub-path (e.g., `https://example.com/concord/`) is explicitly rejected at startup:

```
CONCORD_PUBLIC_URL must not carry a path, query or fragment — Concord serves from the root and sub-path hosting is not supported. Got "https://example.com/concord"; use "https://example.com".
```

### Reasons Sub-Paths Are Unsupported

1. **SPA Asset Routing**: The Vite single-page application is compiled with absolute root assets (`/assets/...`, `/favicon.svg`, `/manifest.webmanifest`).
2. **`__Host-` Cookie Standard**: The W3C/IETF RFC 6265bis specification requires `__Host-` cookies to have `Path=/`. A cookie restricted to `/concord` cannot use the `__Host-` prefix.
3. **Same-Origin CSRF Protection**: Concord checks the `Origin` header against `CONCORD_PUBLIC_URL` origin (`services/api/src/api.ts`).
4. **OAuth Callbacks**: OAuth flows rely on standard root-relative routing.

---

## 5. Tested Configuration Examples

### Caddy Configuration (`Caddyfile`)

Caddy automatically obtains TLS certificates, forces HTTPS, sets HSTS, and overwrites `X-Forwarded-For` with the remote client IP.

```caddy
concord.example.com {
    # Forward to Concord backend
    reverse_proxy 127.0.0.1:4400

    # Security headers
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
```
*Environment setting:* `CONCORD_TRUST_PROXY=1`

---

### Nginx Configuration (`/etc/nginx/sites-available/concord.conf`)

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name concord.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name concord.example.com;

    # TLS Certificates (e.g. from Let's Encrypt / Certbot)
    ssl_certificate /etc/letsencrypt/live/concord.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/concord.example.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_pass http://127.0.0.1:4400;

        # Forwarding headers
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSockets / SSE support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```
*Environment setting:* `CONCORD_TRUST_PROXY=1`

---

## 6. Verification and Testing

Verify your reverse proxy setup using `curl`:

1. **Verify HTTPS redirect and HSTS:**
   ```bash
   curl -I http://concord.example.com
   # Expected: HTTP/1.1 301 Moved Permanently, Location: https://...

   curl -I https://concord.example.com
   # Expected: Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
   ```

2. **Verify Session Cookie Hardening:**
   ```bash
   curl -I -X POST https://concord.example.com/api/auth/signin \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"test"}'
   # Look for: Set-Cookie: __Host-concord_session=...; Secure; HttpOnly; SameSite=Lax; Path=/
   ```

3. **Verify Proxy IP Attribution:**
   Send 25 rapid failed sign-in attempts from a single test IP. Verify that only your test IP receives HTTP 429 Too Many Requests, confirming that rate limiting is not blocking the loopback interface or proxy IP.
