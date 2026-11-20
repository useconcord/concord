import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { createServerApp, type Runtime } from "../src/main.js";
import { CONTROL_MIGRATIONS } from "../src/schema.js";
import { Tenants, fileStore } from "../src/tenants.js";

/**
 * The headers `secureHeaders` in main.ts sets (CON-0374). A dependency bump could silently
 * weaken them, so this test pins the exact strings on both a static response and an API
 * response, for an http origin and an https origin.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const HSTS = "max-age=31536000; includeSubDomains";

/** The real server app over a throwaway data directory and a one-file dashboard. */
function serve(publicUrl: string): { app: Hono; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "concord-static-"));
  const webDir = join(dir, "web");
  const dataDir = join(dir, "data");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
  const cfg = loadConfig({
    CONCORD_DATA_DIR: dataDir,
    CONCORD_WEB_DIR: webDir,
    CONCORD_SIGNUP: "open",
    CONCORD_PUBLIC_URL: publicUrl,
  });
  const control = new Db(join(dataDir, "control.db"), CONTROL_MIGRATIONS);
  const auth = new Auth(control, { signup: "open" });
  const tenants = new Tenants(
    fileStore(dataDir),
    {},
    () => false,
    () => [],
  );
  const runtime: Runtime = {
    control,
    auth,
    tenants,
    close: () => {
      tenants.close();
      control.close();
    },
  };
  const app = createServerApp(runtime, cfg);
  return {
    app,
    close: () => {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("security headers", () => {
  it("sends the exact CSP, nosniff, referrer policy and frame options on static and API responses, without HSTS over http", async () => {
    const { app, close } = serve("http://127.0.0.1:4400");
    try {
      for (const path of ["/", "/api/health"]) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-security-policy")).toBe(CSP);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBe("same-origin");
        expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(res.headers.get("strict-transport-security")).toBeNull();
      }
    } finally {
      close();
    }
  });

  it("sends HSTS over https and keeps the other headers identical", async () => {
    const { app, close } = serve("https://concord.example.com");
    try {
      for (const path of ["/", "/api/health"]) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-security-policy")).toBe(CSP);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("referrer-policy")).toBe("same-origin");
        expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(res.headers.get("strict-transport-security")).toBe(HSTS);
      }
    } finally {
      close();
    }
  });
});
