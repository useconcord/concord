import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEntry } from "../src/main.js";

describe("isEntry", () => {
  let tmp: string;
  const mainPath = resolve(import.meta.dirname, "../src/main.ts");
  const mainUrl = pathToFileURL(mainPath).href;
  const cliPath = resolve(import.meta.dirname, "../src/cli.ts");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "concord-isentry-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for direct execution with absolute path", () => {
    expect(isEntry(mainPath, mainUrl)).toBe(true);
  });

  it("returns true when executed through a symlink to the file", () => {
    const linkPath = join(tmp, "main-symlink.ts");
    try {
      symlinkSync(mainPath, linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM" && process.platform === "win32") {
        // Windows unprivileged environments cannot create symlinks without Developer Mode
        return;
      }
      throw err;
    }
    expect(isEntry(linkPath, mainUrl)).toBe(true);
  });

  it("returns false when imported by another file such as cli.ts", () => {
    expect(isEntry(cliPath, mainUrl)).toBe(false);
  });

  it("returns false without throwing when argv1 is undefined", () => {
    expect(isEntry(undefined, mainUrl)).toBe(false);
  });
});
