import { createHmac, randomBytes } from "node:crypto";
import { lookup as lookupCallback, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { setTimeout as pauseFor } from "node:timers/promises";

/** What a workspace can be told about: something a team must act on, not a progress tick. */
export type WebhookEventType = "run.breaks" | "sync.failed" | "action.breaks";

export interface WebhookEvent {
  type: WebhookEventType;
  asset: { id: string; code: string };
  /** Breaks in the run, or 1 for a failed sync pass. */
  count: number;
  /** Where a person can look at it, on this deployment's dashboard. */
  url: string;
}

/** The header a receiver checks. The value is `sha256=` and the hex HMAC of the exact body. */
export const SIGNATURE_HEADER = "x-concord-signature";

export const newWebhookSecret = () => randomBytes(24).toString("base64url");

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// ── SSRF guard ──────────────────────────────────────────────────────────────
// A delivery is an outbound request that a workspace chooses. It must never reach the service's
// own network, a cloud metadata endpoint or a loopback port, so both the URL and the addresses
// its host resolves to are checked. The address check runs inside the connection's own DNS
// lookup (`guardedPost`), so the socket can only open to an address that was just checked: a
// rebinding DNS answer cannot slip in between the check and the connect.

function blockedV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // IETF protocol assignments and TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // TEST-NET-2
    (a === 203 && b === 0) || // TEST-NET-3
    a >= 224 // multicast, reserved and broadcast
  );
}

function blockedV6(address: string): boolean {
  const addr = address.toLowerCase().split("%")[0] ?? "";
  if (addr === "::" || addr === "::1") return true;
  // IPv4-mapped and NAT64 addresses reach the IPv4 network underneath.
  const mapped =
    /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return blockedV4(mapped[1]!);
  // A mapped address written in hex (::ffff:7f00:1) is loopback too; refuse the whole form.
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(addr)) return true;
  return (
    addr.startsWith("fc") || // unique local
    addr.startsWith("fd") || // unique local
    /^fe[89ab]/.test(addr) || // link local
    addr.startsWith("ff") || // multicast
    addr.startsWith("2001:db8") || // documentation
    addr.startsWith("2002:") // 6to4, which embeds an IPv4 address
  );
}

/** True for loopback, private, link-local and other addresses a delivery must not reach. */
export function isPrivateAddress(address: string): boolean {
  const host = address.trim().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return blockedV4(host);
  if (family === 6) return blockedV6(host);
  // Not an address at all: refuse rather than guess.
  return true;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  if (isIP(host)) return isPrivateAddress(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  // A single label is not a public DNS name; it would only resolve through local search domains.
  return !host.includes(".");
}

/** Why a URL is not an acceptable webhook target, or undefined when it is. */
export function webhookUrlProblem(raw: unknown): string | undefined {
  if (typeof raw !== "string") return "webhookUrl must be an https URL";
  const text = raw.trim();
  if (!text) return "webhookUrl must be an https URL";
  if (text.length > 2048) return "webhookUrl is too long";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "webhookUrl must be an https URL";
  }
  if (url.protocol !== "https:") return "webhookUrl must use https";
  if (url.username || url.password) return "webhookUrl must not carry credentials";
  if (url.port === "0") return "webhookUrl has an invalid port";
  if (blockedHostname(url.hostname)) {
    return "webhookUrl must point at a public host, not a private or loopback address";
  }
  return undefined;
}

// ── delivery ────────────────────────────────────────────────────────────────

/** A failure that retrying cannot fix: a bad target, a private address, a redirect or a 4xx. */
class Permanent extends Error {}

/**
 * The connection's DNS lookup: resolve every address, refuse the lot if any is private, and hand
 * the socket only checked addresses. Used as `lookup` on the request, so it runs at connect time.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookupCallback(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 0);
    if (addresses.length === 0) return callback(new Error(`webhook host ${hostname} did not resolve`), "", 0);
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      return callback(new Permanent("webhook host resolves to a private or loopback address"), "", 0);
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    return callback(null, first.address, first.family);
  });
};

/** POST over https through `guardedLookup`. Redirects are never followed; the body is not read. */
function guardedPost(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers, lookup: guardedLookup, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => req.destroy(new Error(`webhook did not answer within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

export interface WebhookOptions {
  /**
   * Injected in tests so no delivery leaves the machine. Without it a delivery goes through
   * `guardedPost`, which re-checks the addresses at connect time.
   */
  fetch?: typeof fetch;
  /** Resolves a hostname to every address it has; injected in tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  pause?: (ms: number) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
  /** Total tries, including the first. */
  attempts?: number;
  timeoutMs?: number;
  /** First wait; each further retry waits twice as long. */
  baseDelayMs?: number;
}

const resolveAll = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export class WebhookSender {
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly resolve: (hostname: string) => Promise<string[]>;
  private readonly pause: (ms: number) => Promise<void>;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly baseDelayMs: number;

  constructor(options: WebhookOptions = {}) {
    this.fetchImpl = options.fetch;
    this.resolve = options.resolve ?? resolveAll;
    this.pause = options.pause ?? ((ms) => pauseFor(ms, undefined, { ref: false }));
    this.log = options.log ?? ((message, error) => console.error(message, error));
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  /** One attempt. Resolves on a 2xx, rejects on anything else. */
  async send(url: string, secret: string, event: WebhookEvent): Promise<void> {
    const problem = webhookUrlProblem(url);
    if (problem) throw new Permanent(problem);
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    try {
      addresses = await this.resolve(hostname);
    } catch (err) {
      throw new Error(`webhook host ${hostname} did not resolve: ${(err as Error).message}`);
    }
    if (addresses.length === 0) throw new Error(`webhook host ${hostname} did not resolve`);
    if (addresses.some(isPrivateAddress)) {
      throw new Permanent("webhook host resolves to a private or loopback address");
    }

    // Sign exactly the bytes that are sent, so a receiver's HMAC check is over the raw body.
    const body = JSON.stringify(event);
    const headers = {
      "content-type": "application/json",
      "user-agent": "concord-webhook/1",
      "x-concord-event": event.type,
      [SIGNATURE_HEADER]: sign(secret, body),
    };
    let status: number;
    if (this.fetchImpl) {
      const answer = await this.fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        credentials: "omit",
      });
      // Release the socket; the body of a webhook answer is not read.
      await answer.body?.cancel().catch(() => {});
      status = answer.status;
    } else {
      status = await guardedPost(url, headers, body, this.timeoutMs);
    }
    const response = { status, ok: status >= 200 && status < 300 };
    if (response.status >= 300 && response.status < 400) {
      throw new Permanent(`webhook answered with a redirect (${response.status}), which is not followed`);
    }
    if (!response.ok) {
      const message = `webhook answered ${response.status}`;
      // Back off on the statuses that mean "busy", not on ones that mean "no".
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw retryable ? new Error(message) : new Permanent(message);
    }
  }

  /**
   * Deliver with backoff. Never rejects: the indexer and the reconciliation that raised the
   * event must not fail because someone's endpoint was down. Failures are logged.
   */
  notify(url: string, secret: string, event: WebhookEvent): Promise<void> {
    return this.withRetries(url, secret, event).catch((err) => {
      this.log(`webhook ${event.type} for ${event.asset.code} was not delivered`, err);
    });
  }

  private async withRetries(url: string, secret: string, event: WebhookEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.send(url, secret, event);
        return;
      } catch (err) {
        if (err instanceof Permanent || attempt >= this.attempts) throw err;
        this.log(
          `webhook ${event.type} for ${event.asset.code}: attempt ${attempt} failed, retrying`,
          err,
        );
        await this.pause(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}
