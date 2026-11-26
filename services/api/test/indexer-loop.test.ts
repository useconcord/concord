import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIndexer } from "../src/main.js";

describe("background indexer loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("skips ticks while a previous pass is still running and does not overlap", async () => {
    let resolvePass!: () => void;
    let callCount = 0;

    const fakeTenants = {
      syncAll: vi.fn(() => {
        callCount++;
        return new Promise<Array<{ orgId: string; assetId?: string }>>((resolve) => {
          resolvePass = () => resolve([]);
        });
      }),
    };

    const indexer = startIndexer(fakeTenants, 10);
    expect(callCount).toBe(1);

    // Advance by 3 intervals (30 seconds) while pass is still running
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(1);

    // Finish the running pass
    resolvePass();
    await Promise.resolve();

    // Now advance another interval: next tick runs
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(2);

    indexer.stop();
  });

  it("survives a throwing pass, logs the error once, and runs the next tick", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;

    const fakeTenants = {
      syncAll: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("RPC network dropped");
        }
        return [{ orgId: "org-1", added: 5 }];
      }),
    };

    const indexer = startIndexer(fakeTenants, 10);
    await vi.waitFor(() => expect(callCount).toBe(1));
    expect(errorSpy).toHaveBeenCalledWith("sync pass failed", expect.any(Error));

    // Next tick runs and completes normally
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(2);

    indexer.stop();
  });

  it("does not start a timer or schedule any passes when syncIntervalSec is 0", async () => {
    const fakeTenants = {
      syncAll: vi.fn(async () => []),
    };

    const indexer = startIndexer(fakeTenants, 0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fakeTenants.syncAll).not.toHaveBeenCalled();
    indexer.stop();
  });

  it("stop() clears the timer and prevents subsequent ticks", async () => {
    let callCount = 0;
    const fakeTenants = {
      syncAll: vi.fn(async () => {
        callCount++;
        return [];
      }),
    };

    const indexer = startIndexer(fakeTenants, 10);
    await vi.waitFor(() => expect(callCount).toBe(1));

    // Stop the indexer
    indexer.stop();

    // Advance time: no further passes should run
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(1);
  });
});
