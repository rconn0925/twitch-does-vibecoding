/**
 * Public orchestrator surface (SDK-free static import graph).
 *
 * `createBuildSession` and its injected-deps vocabulary are the only things the
 * composition root needs at module-load time. The REAL SDK-backed AgentRunner
 * (which statically imports `@anthropic-ai/claude-agent-sdk`'s `query()`) lives
 * in ./sdk-runner.js and is DYNAMICALLY imported behind main.ts's guarded
 * entrypoint — so a missing/broken SDK degrades to a loud log instead of
 * failing the whole process at import time (armPanicHotkey/buildTwitchAdapters
 * doctrine).
 */

export {
  type BuildSession,
  type BuildSessionDeps,
  createBuildSession,
  extractAssistantText,
  extractScreenableText,
} from "./build-session.js";
