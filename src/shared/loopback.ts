/**
 * Loopback host allowlist — DNS-rebinding defense (CR-02).
 *
 * Both localhost servers (operator console + public overlay) bind to
 * 127.0.0.1, but the LISTEN address alone does not authenticate the
 * browser's idea of where it is: a remote page at http://attacker.com:4900
 * whose DNS record is rebound to 127.0.0.1 reaches these servers with
 * `Host: attacker.com:4900` and `Origin: http://attacker.com:4900` — and
 * from the browser's perspective the request is SAME-origin, so no CORS
 * preflight fires. Any check that compares Origin against the request's
 * own Host header therefore validates the attacker against themselves.
 *
 * The fix: pin the accepted hostnames. Every HTTP request and every
 * WebSocket handshake must carry a Host header naming a loopback host,
 * and any present Origin must itself be a loopback origin. A rebound
 * page can spoof neither (the browser sets both from the attacker's URL),
 * so it is refused before any handler runs.
 *
 * Shared by src/operator-console/server.ts and src/overlay/server.ts —
 * ONE copy, so the two surfaces can never drift apart.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * True when a Host header value (`host` or `host:port`) names a loopback
 * host: 127.0.0.1, localhost, or [::1] — with or without a port suffix.
 * Undefined/empty (an HTTP/1.0 client with no Host) is refused: fail closed.
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(bare);
}

/** True when an Origin header value is an http(s) origin on a loopback host. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}
