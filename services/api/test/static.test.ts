import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticHandler } from "../src/main.js";

describe("static handler cache headers", () => {
  let tempDir: string;
  let webDir: string;
  let app: Hono;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concord-static-headers-"));
    webDir = join(tempDir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<html>app shell</html>");
    writeFileSync(join(webDir, "assets", "a.js"), "console.log('a');");

    app = new Hono();
    app.get("*", createStaticHandler(webDir));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves hashed assets with immutable cache policy", async () => {
    const res = await app.request("http://localhost/assets/a.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves root and SPA routes with no-cache html", async () => {
    for (const path of ["/", "/a/x/reconciliation"]) {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("serves /index.html with no-cache and not immutable policy", async () => {
    const res = await app.request("http://localhost/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("cache-control")).not.toContain("immutable");
  });

  it("handles HEAD requests with 200, matching headers, and empty body", async () => {
    const res = await app.request("http://localhost/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("");
  });

  it("returns 404 text for missing assets without falling back to index.html", async () => {
    const res = await app.request("http://localhost/assets/nope.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("Not found");
  });

  it("returns 404 for POST requests", async () => {
    const res = await app.request("http://localhost/anything", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
