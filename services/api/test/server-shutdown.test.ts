import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distMain = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const canRun = existsSync(distMain) && process.platform !== "win32";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe.skipIf(!canRun)("server shutdown", () => {
  it("shuts down cleanly on SIGTERM, closes databases, and ignores a second SIGTERM", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "concord-shutdown-"));
    const port = await getFreePort();

    const child = spawn(process.execPath, [distMain], {
      env: {
        ...process.env,
        PORT: String(port),
        CONCORD_PORT: String(port),
        CONCORD_HOST: "127.0.0.1",
        CONCORD_SYNC_INTERVAL: "0",
        CONCORD_DATA_DIR: tempDir,
        CONCORD_PUBLIC_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    try {
      // Wait up to 60s for the server to log that it is listening
      const started = Date.now();
      while (!output.includes("listening on")) {
        if (Date.now() - started > 60_000) {
          throw new Error(`Server failed to start within 60s:\n${output}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // First SIGTERM initiates shutdown
      child.kill("SIGTERM");

      // A second SIGTERM during shutdown is ignored
      child.kill("SIGTERM");

      const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });

      expect(exitResult.code).toBe(0);

      // Verify no leftover -wal files
      const files = readdirSync(tempDir);
      const walFiles = files.filter((f) => f.endsWith("-wal"));
      expect(walFiles).toEqual([]);
    } finally {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }, 90_000);
});
