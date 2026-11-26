import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StellarSource } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { openRuntime, type Runtime } from "../src/main.js";
import { CONTROL_MIGRATIONS } from "../src/schema.js";
import { MAINNET_PASSPHRASE, PASSPHRASE } from "./helpers.js";

describe("openRuntime", () => {
  let tmp: string;
  let runtime: Runtime | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "concord-runtime-"));
  });

  afterEach(() => {
    try {
      runtime?.close();
    } catch {
      // Ignore if already closed
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("wires both networks, opens control.db at current migration and applies scrypt cost", async () => {
    const config = loadConfig({
      CONCORD_DATA_DIR: tmp,
      CONCORD_PASSWORD_COST: "16384:8:1",
    });
    runtime = openRuntime(config);

    // control.db is created at user_version equal to CONTROL_MIGRATIONS.length
    const version = runtime.control.get<{ user_version: number }>("PRAGMA user_version");
    expect(version?.user_version).toBe(CONTROL_MIGRATIONS.length);

    // Sign up through runtime.auth
    const { userId, orgId } = await runtime.auth.signUp({
      email: "alice@example.com",
      name: "Alice Owner",
      password: "password123!",
      orgName: "Acme Corp",
    });

    // CONCORD_PASSWORD_COST reaches Auth and new hash starts with scrypt$16384$8$1
    const credential = runtime.control.get<{ secret: string }>(
      "SELECT secret FROM credentials WHERE user_id = ? AND kind = 'password'",
      userId,
    );
    expect(credential?.secret).toMatch(/^scrypt\$16384\$8\$1\$/);

    // Open the workspace with runtime.tenants.forOrg
    const ws = runtime.tenants.forOrg(orgId);

    // Both networks get a StellarSource with their own passphrase
    expect(ws.networks.mainnet?.chain instanceof StellarSource).toBe(true);
    expect(ws.networks.testnet?.chain instanceof StellarSource).toBe(true);
    expect(ws.networks.mainnet?.passphrase).toBe(MAINNET_PASSPHRASE);
    expect(ws.networks.testnet?.passphrase).toBe(PASSPHRASE);
  });
});
