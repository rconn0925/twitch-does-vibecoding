/**
 * Persisted auto-refreshing Twitch auth (INFRA-01, D2-09/D2-10).
 *
 * Single broadcaster token, persisted as a JSON file at deps.tokenPath
 * (default wired from TWITCH_TOKEN_PATH inside the gitignored data/
 * directory). Token file chosen over a SQLite table deliberately: keeps
 * this plan's files disjoint from plan 02-01's schema.sql (wave-1
 * parallelism) and tokens are one mutable record, not append-only audit
 * data (D2-09 grants the discretion).
 *
 * This module is the ONLY place that reads/writes tokenPath. Token values
 * (accessToken/refreshToken) are NEVER logged — only userId, scope list,
 * and obtainmentTimestamp (T-02-07, extending Phase 1's T-01-10 key
 * hygiene to OAuth tokens). Proven by a capturing-logger unit test.
 *
 * Graceful degradation (armPanicHotkey pattern): a missing/corrupt token
 * file logs a warning and returns null — the app must run without Twitch;
 * the operator re-authorizes at /auth/start (routes owned by plan 02-04).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AccessToken, exchangeCode, RefreshingAuthProvider } from "@twurple/auth";
import type { Logger } from "pino";
import { z } from "zod";

/**
 * D2-09/D2-10: user access token acting as itself — user:bot/channel:bot
 * are NOT needed (those apply only to app access tokens; RESEARCH.md
 * Pattern 2). Channel-points scopes are deferred to Phase 4.
 */
export const TWITCH_SCOPES = ["user:read:chat", "user:write:chat"] as const;

/** twurple's AccessToken shape plus the owning user id, as persisted on disk. */
const PersistedTokenSchema = z.object({
  userId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().nullable(),
  scope: z.array(z.string()),
  expiresIn: z.number().nullable(),
  obtainmentTimestamp: z.number(),
});

type PersistedToken = z.infer<typeof PersistedTokenSchema>;

export interface TwitchAuthDeps {
  clientId: string;
  clientSecret: string;
  /** JSON token file, e.g. ./data/twitch-token.json (gitignored data/). */
  tokenPath: string;
  logger?: Logger;
  /** Injected in tests; default constructs the real RefreshingAuthProvider. */
  makeProvider?: (args: { clientId: string; clientSecret: string }) => RefreshingAuthProvider;
  /** Injected in tests; default is @twurple/auth's exchangeCode (network). */
  exchange?: (
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ) => Promise<AccessToken>;
}

/**
 * Build a provider from the persisted token file. Returns null (never
 * throws) when no valid persisted token exists yet — bootstrap required
 * via buildAuthorizeUrl + completeAuthorization.
 */
export function createAuthProvider(deps: TwitchAuthDeps): RefreshingAuthProvider | null {
  const persisted = readPersistedToken(deps);
  if (persisted === null) {
    deps.logger?.warn(
      { tokenPath: deps.tokenPath },
      "no persisted Twitch token — run /auth/start to authorize",
    );
    return null;
  }
  const provider = makeProviderWithPersistence(deps);
  const { userId, ...tokenData } = persisted;
  provider.addUser(userId, tokenData, ["chat"]);
  deps.logger?.info(
    { userId, scope: tokenData.scope, obtainmentTimestamp: tokenData.obtainmentTimestamp },
    "Twitch auth provider ready from persisted token",
  );
  return provider;
}

/** Pure builder for the one-time OAuth bootstrap URL (D2-10). The state
 * nonce is generated/validated by the console's auth routes (plan 02-04,
 * login-CSRF defense T-02-16). */
export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TWITCH_SCOPES.join(" "));
  url.searchParams.set("state", args.state);
  return url.toString();
}

/**
 * Exchange the authorization code, register the user on a refresh-wired
 * provider, and persist the token + userId to tokenPath. After this
 * resolves, createAuthProvider returns non-null on every restart.
 */
export async function completeAuthorization(
  deps: TwitchAuthDeps,
  code: string,
  redirectUri: string,
): Promise<void> {
  const exchange = deps.exchange ?? exchangeCode;
  const tokenData = await exchange(deps.clientId, deps.clientSecret, code, redirectUri);
  const provider = makeProviderWithPersistence(deps);
  const userId = await provider.addUserForToken(tokenData, ["chat"]);
  persistToken(deps, userId, tokenData);
  deps.logger?.info(
    { userId, scope: tokenData.scope, obtainmentTimestamp: tokenData.obtainmentTimestamp },
    "Twitch authorization complete — token persisted",
  );
}

/** Construct a provider with onRefresh persistence + onRefreshFailure alarm wired. */
function makeProviderWithPersistence(deps: TwitchAuthDeps): RefreshingAuthProvider {
  const make =
    deps.makeProvider ??
    ((args: { clientId: string; clientSecret: string }) => new RefreshingAuthProvider(args));
  const provider = make({ clientId: deps.clientId, clientSecret: deps.clientSecret });
  provider.onRefresh((userId, newTokenData) => {
    persistToken(deps, userId, newTokenData);
    deps.logger?.info(
      {
        userId,
        scope: newTokenData.scope,
        obtainmentTimestamp: newTokenData.obtainmentTimestamp,
      },
      "Twitch token refreshed and re-persisted",
    );
  });
  provider.onRefreshFailure((userId, error) => {
    deps.logger?.error(
      { userId, err: error },
      "Twitch token refresh failed; bot is going deaf — re-authorize at /auth/start",
    );
  });
  return provider;
}

/** Read + validate the persisted token. Null on missing/corrupt (never throws). */
function readPersistedToken(deps: TwitchAuthDeps): PersistedToken | null {
  let raw: string;
  try {
    raw = readFileSync(deps.tokenPath, "utf8");
  } catch {
    return null; // missing file — bootstrap needed
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    deps.logger?.warn({ tokenPath: deps.tokenPath }, "persisted Twitch token is not valid JSON");
    return null;
  }
  const parsed = PersistedTokenSchema.safeParse(json);
  if (!parsed.success) {
    deps.logger?.warn(
      { tokenPath: deps.tokenPath },
      "persisted Twitch token has an unexpected shape — re-authorize at /auth/start",
    );
    return null;
  }
  return parsed.data;
}

/** Persist token + userId. mode 0o600 where the platform honors it; on
 * Windows this is advisory — NTFS ACLs on the user profile apply instead. */
function persistToken(deps: TwitchAuthDeps, userId: string, token: AccessToken): void {
  mkdirSync(path.dirname(deps.tokenPath), { recursive: true });
  const persisted: PersistedToken = {
    userId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    scope: token.scope,
    expiresIn: token.expiresIn,
    obtainmentTimestamp: token.obtainmentTimestamp,
  };
  writeFileSync(deps.tokenPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
}
