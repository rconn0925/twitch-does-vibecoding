import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessToken, RefreshingAuthProvider } from "@twurple/auth";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  completeAuthorization,
  createAuthProvider,
  TWITCH_SCOPES,
} from "./twitch-auth.js";

const SECRET_ACCESS = "secret-access-token-value-abc123";
const SECRET_REFRESH = "secret-refresh-token-value-xyz789";

function sampleToken(overrides?: Partial<AccessToken>): AccessToken {
  return {
    accessToken: SECRET_ACCESS,
    refreshToken: SECRET_REFRESH,
    scope: [...TWITCH_SCOPES],
    expiresIn: 14_400,
    obtainmentTimestamp: 1_752_000_000_000,
    ...overrides,
  };
}

/** Capturing fake logger — records every structured object + message. */
function capturingLogger() {
  const entries: unknown[] = [];
  const record =
    () =>
    (...args: unknown[]) => {
      entries.push(args);
    };
  const logger = {
    info: record(),
    warn: record(),
    error: record(),
    debug: record(),
  } as unknown as Logger;
  return { logger, entries };
}

interface CapturedRefresh {
  onRefreshCbs: Array<(userId: string, token: AccessToken) => void>;
  onRefreshFailureCbs: Array<(userId: string, error: Error) => void>;
  addUserCalls: Array<{ userId: string; token: AccessToken; intents: string[] }>;
  addUserForTokenCalls: Array<{ token: AccessToken; intents: string[] }>;
}

function fakeProvider(): { provider: RefreshingAuthProvider; captured: CapturedRefresh } {
  const captured: CapturedRefresh = {
    onRefreshCbs: [],
    onRefreshFailureCbs: [],
    addUserCalls: [],
    addUserForTokenCalls: [],
  };
  const provider = {
    onRefresh: (cb: (userId: string, token: AccessToken) => void) => {
      captured.onRefreshCbs.push(cb);
    },
    onRefreshFailure: (cb: (userId: string, error: Error) => void) => {
      captured.onRefreshFailureCbs.push(cb);
    },
    addUser: (userId: string, token: AccessToken, intents: string[]) => {
      captured.addUserCalls.push({ userId, token, intents });
    },
    addUserForToken: (token: AccessToken, intents: string[]) => {
      captured.addUserForTokenCalls.push({ token, intents });
      return Promise.resolve("user-777");
    },
  } as unknown as RefreshingAuthProvider;
  return { provider, captured };
}

let tmpDir: string;

function tokenPathIn(): string {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "twitch-auth-test-"));
  return path.join(tmpDir, "data", "twitch-token.json");
}

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("TWITCH_SCOPES", () => {
  it("is exactly user:read:chat + user:write:chat (no user:bot/channel:bot)", () => {
    expect([...TWITCH_SCOPES]).toEqual(["user:read:chat", "user:write:chat"]);
  });
});

describe("createAuthProvider", () => {
  it("returns a provider with the broadcaster registered from a valid persisted token", () => {
    const tokenPath = tokenPathIn();
    const { provider, captured } = fakeProvider();
    const { logger } = capturingLogger();
    writePersisted(tokenPath, { ...sampleToken(), userId: "user-777" });
    const result = createAuthProvider({
      clientId: "cid",
      clientSecret: "csec",
      tokenPath,
      logger,
      makeProvider: () => provider,
    });
    expect(result).not.toBeNull();
    expect(captured.addUserCalls).toHaveLength(1);
    expect(captured.addUserCalls[0]?.userId).toBe("user-777");
    expect(captured.addUserCalls[0]?.token.accessToken).toBe(SECRET_ACCESS);
    expect(captured.addUserCalls[0]?.intents).toEqual(["chat"]);
  });

  it("returns null (not throw) on a missing token file", () => {
    const tokenPath = tokenPathIn();
    const { logger } = capturingLogger();
    const result = createAuthProvider({
      clientId: "cid",
      clientSecret: "csec",
      tokenPath,
      logger,
      makeProvider: () => fakeProvider().provider,
    });
    expect(result).toBeNull();
  });

  it("returns null (not throw) on a corrupt token file", () => {
    const tokenPath = tokenPathIn();
    const { logger } = capturingLogger();
    writeFileSyncDeep(tokenPath, "not json {{{");
    expect(
      createAuthProvider({
        clientId: "cid",
        clientSecret: "csec",
        tokenPath,
        logger,
        makeProvider: () => fakeProvider().provider,
      }),
    ).toBeNull();
    // Valid JSON, wrong shape → also null.
    writeFileSyncDeep(tokenPath, JSON.stringify({ hello: "world" }));
    expect(
      createAuthProvider({
        clientId: "cid",
        clientSecret: "csec",
        tokenPath,
        logger,
        makeProvider: () => fakeProvider().provider,
      }),
    ).toBeNull();
  });

  it("re-persists new token data when the onRefresh callback fires", () => {
    const tokenPath = tokenPathIn();
    const { provider, captured } = fakeProvider();
    const { logger } = capturingLogger();
    writePersisted(tokenPath, { ...sampleToken(), userId: "user-777" });
    createAuthProvider({
      clientId: "cid",
      clientSecret: "csec",
      tokenPath,
      logger,
      makeProvider: () => provider,
    });
    expect(captured.onRefreshCbs).toHaveLength(1);
    const newToken = sampleToken({
      accessToken: "rotated-access-token-new",
      refreshToken: "rotated-refresh-token-new",
      obtainmentTimestamp: 1_752_000_999_000,
    });
    captured.onRefreshCbs[0]?.("user-777", newToken);
    const onDisk = JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
    expect(onDisk.accessToken).toBe("rotated-access-token-new");
    expect(onDisk.refreshToken).toBe("rotated-refresh-token-new");
    expect(onDisk.userId).toBe("user-777");
    expect(onDisk.obtainmentTimestamp).toBe(1_752_000_999_000);
  });
});

describe("buildAuthorizeUrl", () => {
  it("produces the Twitch authorize endpoint with the exact expected params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "my-client-id",
        redirectUri: "http://localhost:4900/auth/callback",
        state: "nonce-42",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("my-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4900/auth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("user:read:chat user:write:chat");
    expect(url.searchParams.get("state")).toBe("nonce-42");
    // Space-joined scope is URL-encoded in the raw string (never a literal space).
    expect(url.search).not.toContain(" ");
  });
});

describe("completeAuthorization", () => {
  it("persists the exchanged token; a subsequent createAuthProvider returns non-null", async () => {
    const tokenPath = tokenPathIn();
    const { provider, captured } = fakeProvider();
    const { logger } = capturingLogger();
    const exchanged = sampleToken();
    await completeAuthorization(
      {
        clientId: "cid",
        clientSecret: "csec",
        tokenPath,
        logger,
        makeProvider: () => provider,
        exchange: (clientId, clientSecret, code, redirectUri) => {
          expect([clientId, clientSecret, code, redirectUri]).toEqual([
            "cid",
            "csec",
            "auth-code-1",
            "http://localhost:4900/auth/callback",
          ]);
          return Promise.resolve(exchanged);
        },
      },
      "auth-code-1",
      "http://localhost:4900/auth/callback",
    );
    // Registered on the provider with the chat intent.
    expect(captured.addUserForTokenCalls).toHaveLength(1);
    expect(captured.addUserForTokenCalls[0]?.intents).toEqual(["chat"]);
    // Persisted with the userId resolved by the provider.
    const onDisk = JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, unknown>;
    expect(onDisk.accessToken).toBe(SECRET_ACCESS);
    expect(onDisk.userId).toBe("user-777");
    // Bootstrap complete: createAuthProvider now returns non-null.
    const again = createAuthProvider({
      clientId: "cid",
      clientSecret: "csec",
      tokenPath,
      logger,
      makeProvider: () => fakeProvider().provider,
    });
    expect(again).not.toBeNull();
  });
});

describe("token hygiene (T-02-07)", () => {
  it("no log line ever contains an accessToken or refreshToken value", async () => {
    const tokenPath = tokenPathIn();
    const { logger, entries } = capturingLogger();
    const { provider, captured } = fakeProvider();
    // Exercise every logging path: bootstrap-missing, complete, load, refresh, refresh-failure.
    createAuthProvider({
      clientId: "cid",
      clientSecret: "csec",
      tokenPath,
      logger,
      makeProvider: () => provider,
    });
    await completeAuthorization(
      {
        clientId: "cid",
        clientSecret: "csec",
        tokenPath,
        logger,
        makeProvider: () => provider,
        exchange: () => Promise.resolve(sampleToken()),
      },
      "code",
      "http://localhost:4900/auth/callback",
    );
    createAuthProvider({
      clientId: "cid",
      clientSecret: "csec",
      tokenPath,
      logger,
      makeProvider: () => provider,
    });
    for (const cb of captured.onRefreshCbs) {
      cb("user-777", sampleToken({ accessToken: `${SECRET_ACCESS}-r2` }));
    }
    for (const cb of captured.onRefreshFailureCbs) {
      cb("user-777", new Error("refresh denied"));
    }
    expect(entries.length).toBeGreaterThan(0);
    const allLogged = JSON.stringify(entries);
    expect(allLogged).not.toContain(SECRET_ACCESS);
    expect(allLogged).not.toContain(SECRET_REFRESH);
  });
});

/** Write a token file (creating parent dirs), matching the module's on-disk shape. */
function writePersisted(tokenPath: string, data: Record<string, unknown>): void {
  writeFileSyncDeep(tokenPath, JSON.stringify(data, null, 2));
}

function writeFileSyncDeep(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}
