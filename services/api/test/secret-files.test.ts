import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("mounted secret file configuration", () => {
  it("reads Google and RPC secrets from files, trimming one trailing line break", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-secrets-"));
    try {
      const googleFile = join(dir, "google-secret");
      const headersFile = join(dir, "provider-headers");
      writeFileSync(googleFile, "secret with spaces\n");
      writeFileSync(headersFile, '{"rpc.example":{"x-api-key":"abc"}}\r\n');
      const warnings: string[] = [];
      const config = loadConfig({
        CONCORD_GOOGLE_CLIENT_ID: "my-client",
        CONCORD_GOOGLE_CLIENT_SECRET_FILE: googleFile,
        CONCORD_RPC_HEADERS_FILE: headersFile,
        CONCORD_MAINNET_RPC_URLS: "https://rpc.example",
      }, (warning) => warnings.push(warning));
      expect(config.google?.clientSecret).toBe("secret with spaces");
      expect(config.networks.mainnet.rpc[0]?.headers).toEqual({ "x-api-key": "abc" });
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects conflicts and missing files without printing secret values", () => {
    expect(() => loadConfig({
      CONCORD_RPC_HEADERS: "{}",
      CONCORD_RPC_HEADERS_FILE: "/nonexistent/secret",
    })).toThrow(/either CONCORD_RPC_HEADERS or CONCORD_RPC_HEADERS_FILE/);
    expect(() => loadConfig({
      CONCORD_GOOGLE_CLIENT_ID: "id",
      CONCORD_GOOGLE_CLIENT_SECRET: "should-not-log",
      CONCORD_GOOGLE_CLIENT_SECRET_FILE: "/nonexistent/secret",
    })).toThrow(/either CONCORD_GOOGLE_CLIENT_SECRET or CONCORD_GOOGLE_CLIENT_SECRET_FILE/);
    expect(() => loadConfig({ CONCORD_RPC_HEADERS_FILE: "/nonexistent/secret" })).toThrow(/could not be read/);
  });
});
