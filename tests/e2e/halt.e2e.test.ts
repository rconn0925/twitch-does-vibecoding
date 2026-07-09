import { afterEach, describe, expect, it } from "vitest";
// Walking Skeleton contract: src/main.ts must export createApp({ dbPath, port })
// returning a started app handle. This import FAILS until Task 3 implements it (TDD RED).
import { createApp } from "../../src/main.js";

type AppHandle = Awaited<ReturnType<typeof createApp>>;

let app: AppHandle | null = null;

async function startApp(): Promise<AppHandle> {
  app = await createApp({ dbPath: ":memory:", port: 0 });
  return app;
}

function baseUrl(handle: AppHandle): string {
  return `http://127.0.0.1:${handle.port}`;
}

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("halt walking skeleton (e2e)", () => {
  it("GET /api/state returns 200 with mode IDLE on fresh start", async () => {
    const handle = await startApp();
    const res = await fetch(`${baseUrl(handle)}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("IDLE");
  });

  it("POST /api/halt flips the state machine to HALTED", async () => {
    const handle = await startApp();
    const haltRes = await fetch(`${baseUrl(handle)}/api/halt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(haltRes.status).toBe(200);

    const stateRes = await fetch(`${baseUrl(handle)}/api/state`);
    expect(stateRes.status).toBe(200);
    const body = (await stateRes.json()) as { mode: string };
    expect(body.mode).toBe("HALTED");
  });

  it("after a halt, GET /api/audit returns a halt record with source console", async () => {
    const handle = await startApp();
    const haltRes = await fetch(`${baseUrl(handle)}/api/halt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(haltRes.status).toBe(200);

    const auditRes = await fetch(`${baseUrl(handle)}/api/audit?limit=10`);
    expect(auditRes.status).toBe(200);
    const records = (await auditRes.json()) as Array<{
      event_type: string;
      source: string;
    }>;
    const haltRecords = records.filter((r) => r.event_type === "halt" && r.source === "console");
    expect(haltRecords.length).toBeGreaterThanOrEqual(1);
  });

  it("binds to 127.0.0.1, never 0.0.0.0", async () => {
    const handle = await startApp();
    const address = handle.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    if (address && typeof address === "object") {
      expect(address.address).toBe("127.0.0.1");
    }
  });
});
