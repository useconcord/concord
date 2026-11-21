import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticHandler } from "../src/main.js";

describe("static handler path traversal", () => {
  let tempDir: string;
  let webDir: string;
  let siblingDir: string;
  let app: Hono;
  const siblingContent = "secret sibling content";

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concord-static-traversal-"));
    webDir = join(tempDir, "web");
    siblingDir = join(tempDir, "web-sibling");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<html>app shell</html>");
    writeFileSync(join(webDir, "assets", "a.js"), "console.log('a');");
    writeFileSync(join(siblingDir, "f.txt"), siblingContent);

    app = new Hono();
    app.get("*", createStaticHandler(webDir));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const cases: Array<{ path: string; expectedStatus: number }> = [
    { path: "/%2e%2e/web-sibling/f.txt", expectedStatus: 404 },
    { path: "/..%2fweb-sibling%2ff.txt", expectedStatus: 404 },
    { path: "/%252e%252e/x", expectedStatus: 200 },
    { path: "//etc/passwd", expectedStatus: 200 },
    { path: "/..%5cweb-sibling%5cf.txt", expectedStatus: 404 },
    { path: "/assets/%00", expectedStatus: 404 },
    { path: "/assets/%ZZ", expectedStatus: 400 },
    { path: "/../web-sibling/f.txt", expectedStatus: 404 },
    { path: "/%2e%2e%2fweb-sibling%2ff.txt", expectedStatus: 404 },
  ];

  for (const { path, expectedStatus } of cases) {
    it(`never exposes sibling content and returns ${expectedStatus} for ${path}`, async () => {
      const res = await app.request(`http://localhost${path}`);
      expect(res.status).toBe(expectedStatus);
      const text = await res.text();
      expect(text).not.toContain(siblingContent);
    });
  }
});
