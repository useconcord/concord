import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

describe("unknown environment variable diagnostics", () => {
  it("suggests a recognized setting for a typo without exposing its value", () => {
    const warnings: string[] = [];
    loadConfig({ CONCORD_SYNC_INTERVL: "super-secret-value" }, (message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("CONCORD_SYNC_INTERVL");
    expect(warnings[0]).toContain("CONCORD_SYNC_INTERVAL");
    expect(warnings[0]).not.toContain("super-secret-value");
  });

  it("ignores known options, CLI-only options and unrelated environment variables", () => {
    const warn = vi.fn();
    loadConfig({
      CONCORD_SYNC_INTERVAL: "5",
      CONCORD_MAX_ASSETS: "10",
      CONCORD_ORG: "my-workspace",
      OTHER_PROGRAM_VAR: "whatever",
    }, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns without guessing when no setting name is similar", () => {
    const warn = vi.fn();
    loadConfig({ CONCORD_NONSENSE_PLACEHOLDER: "x" }, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe("Unknown Concord setting CONCORD_NONSENSE_PLACEHOLDER");
  });

  it("retired options still fail before typo warnings", () => {
    const warn = vi.fn();
    expect(() => loadConfig({ CONCORD_API_TOKEN: "legacy", CONCORD_SYNC_INTERVL: "5" }, warn)).toThrow(/no longer read/);
    expect(warn).not.toHaveBeenCalled();
  });
});
