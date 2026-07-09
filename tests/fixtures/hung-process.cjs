/**
 * Synthetic hung task (Phase 1 Success Criterion 3).
 *
 * Models Phase 3's worst case: a wedged agent session that will NOT cooperate
 * (PITFALLS.md Pitfall 6 — "must not rely on the agent cooperating"). It traps
 * and swallows the polite termination signals, then stays alive indefinitely.
 * Only a forced process-tree kill (tree-kill -> taskkill /T /F on Windows)
 * can take it down.
 *
 * Plain CommonJS so it runs directly under `node` with zero build step.
 */
process.on("SIGTERM", () => {
  // swallow: refuse to die politely
});
process.on("SIGINT", () => {
  // swallow: refuse to die politely
});

// Keep the event loop alive forever.
setInterval(() => {}, 1000);

// Signal readiness so the e2e test knows the traps are installed.
process.stdout.write("ready\n");
