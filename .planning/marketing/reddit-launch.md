# Reddit launch plan — Twitch Does Vibecoding

**Written 2026-07-11 overnight for morning review.** Honest self-promotion only — see the note at the bottom on why covert/astroturfing backfires here.

## The one rule that keeps you un-banned

Reddit's own line: *"It's fine to be a redditor with a website; it's not fine to be a website with a reddit account."* Every subreddit below has its own sidebar rules — **read them before posting**, some allow promo only on certain days or in a weekly thread, some require mod approval. The 9:1 rule (nine genuine comments/contributions for every promo post) is enforced by mods and by the algorithm. For a launch: spend a few days commenting genuinely in these communities first, then post. Disclose that you built it — Reddit rewards "I made this," punishes anything that smells like disguised marketing.

## Where to post (ranked by fit × how welcome promo is)

| Subreddit | Fit | Promo posture | Angle |
|---|---|---|---|
| **r/SideProject** (~600K) | ★★★★★ | Purpose-built for "I made this." Safest first post. | The builder story + the hard safety problem. Numbers/uptime if you have them. |
| **r/vibecoding** (largest AI-coding-with-agents community) | ★★★★★ | Showcases welcome; read sidebar for a showcase day/flair. | "Chat is the prompt author" — perfectly on-theme; the crowd gets it instantly. |
| **r/ClaudeAI** | ★★★★☆ | Project showcases OK; very technical crowd, allergic to hype. | The Agent-SDK orchestration, WSL2 sandbox, plan-billed classifier — the *engineering*, not the pitch. |
| **r/watchpeoplecode** | ★★★★☆ | Literally for live coding streams — but engage, don't drop-and-run. | Post when you're actually live; it's a "come watch" community. |
| **r/SomethingIMade** (~500K) | ★★★☆☆ | Made-it showcases welcome. | Short, visual, "look what this does." |
| **r/InternetIsBeautiful** | ★★★☆☆ | Only if there's a public URL people can click and experience (the changelog/gallery could be it). No pure "watch my stream." | The living-app gallery as a browsable artifact. |
| **r/artificial**, **r/ChatGPTCoding**, **r/AI_Agents** | ★★★☆☆ | Project posts tolerated if substantive. | The agent-safety angle (untrusted input → sandboxed agent). |
| **r/TwitchPromote** | ★★☆☆☆ | Explicitly allows stream promo *if* you reciprocate. | Straight "come watch," low reach but zero ban risk. |
| **r/Twitch** (main) | ★☆☆☆☆ | Direct stream promo is discouraged/removed. Don't drop links. | Participate in help threads; mention the project only where genuinely relevant. |

**Sequencing suggestion:** r/SideProject or r/vibecoding first (highest fit + friendliest), see what resonates, then adapt the angle for the more technical (r/ClaudeAI) and more general (r/SomethingIMade, r/InternetIsBeautiful) crowds. Never cross-post the identical text same-day — mods flag it as spam.

---

## Drafted post — primary (r/SideProject / r/vibecoding)

**Title:** Chat votes on prompts, an AI builds the app live, and I have a physical kill switch — my Twitch experiment

**Body:**

I've been building a thing that's either a good idea or a liability and I genuinely can't tell yet, so I'm putting it here.

It's a Twitch stream where the audience decides what software gets built. Chat types suggestions — either a new app or a tweak to whatever's already on screen ("build a snake game", then "make the snake leave a rainbow trail"). Every ~60 seconds there's a vote, the winner goes straight to Claude as a prompt, and the app on screen changes in real time. Nobody's driving. Chat is collectively prompting an AI at a living web app.

The fun part was never the building — Claude does that. The hard part is that I'm piping *untrusted input from strangers* into a coding agent that can run a shell, and the whole thing is live on a platform with a Terms of Service I'd rather not violate on camera. So most of the actual work went into the parts you don't see:

- Every suggestion runs through a compliance classifier before it can reach the agent — it's not judging whether an idea is "good," just whether building it would get the channel in trouble.
- The agent builds inside a locked-down Linux sandbox that can't see my real files, can't reach my accounts, and gets wiped between runs. (I found out the hard way that my own sandbox was *so* isolated it initially locked out the tool trying to launch the build. Fixed now.)
- There's a physical panic key on my desk. Double-tap and the whole thing halts mid-build.

Stack, since this crowd always asks: Node/TypeScript, the Claude Agent SDK for orchestration, twurple for Twitch, a WSL2 sandbox for the build engine, plain `ws` for the overlay. Roughly 800 tests, because a bug here fails *in public*.

It's not on air full-time yet — I'm still doing dry runs. But it works end to end: someone suggested a thing tonight and watched an AI build it while chat argued about what to break next.

Honest questions for anyone who's done live/interactive stuff: where does this go wrong at scale? What's the failure mode I'm not seeing? And is "the audience is the prompt engineer" actually fun to watch, or fun for about four minutes?

[link to channel / gallery]

---

## Variant — r/ClaudeAI (lead with engineering, cut the showmanship)

**Title:** Orchestrating live, audience-driven Claude Code builds — sandboxing untrusted prompts, plan-billed classification, and the failure modes

**Body:** (tighten the primary post: drop the "good idea or liability" hook, expand the architecture — the two-point compliance gate, spawnClaudeCodeProcess redirect into WSL2, why the classifier runs plan-billed via `claude login` instead of a metered key, how aborts route so a killed build never emits a false "done". Ask specifically about the composition-drift problem: per-prompt screening vs. a persistent workspace that accumulates.)

## Variant — r/SomethingIMade / r/InternetIsBeautiful (short, visual, link-first)

**Title:** I made a Twitch stream where chat prompts an AI to build a web app live — here's the gallery of what it's built

Keep it to 2-3 sentences + the link. These communities want the artifact, not the essay.

---

## Voice notes (why it reads human)

Deliberately avoided the AI-tells: no "In today's fast-paced world," no "Let's dive in," no tidy rule-of-three everything, no breathless adjectives. It opens with self-doubt, admits a bug, asks real questions, and undersells ("either a good idea or a liability"). Reddit trusts hedged and specific over polished and confident. Edit it in your own voice before posting — a couple of your own typos and opinions will do more for authenticity than anything I can write.

## On the "covert" ask — why I wrote it disclosed instead

Astroturfing (undisclosed promo, sockpuppets, hiding that you're the creator) is against Reddit's content policy and nearly every subreddit's rules, and Reddit is *exceptionally* good at detecting it — the usual outcome is the post nuked, the project name poisoned in the thread, and sometimes a domain/account ban. For a project whose whole pitch is "watch this happen live," that's the worst possible first impression. Transparent creator posts convert better here anyway. If you want reach beyond honest posting, the legitimate levers are: participating genuinely in these communities first, a good demo clip, and letting the concept (which is genuinely novel) do the work.

## Sources
- [The Hive Index — self-promotion subreddits](https://thehiveindex.com/topics/self-promotion/platform/reddit/)
- [Reddit self-promotion rules 2026 (redship.io)](https://redship.io/blog/reddit-self-promotion-rules)
- [r/SideProject rules & posting guide](https://www.redditmaster.com/subreddit-rules/sideproject)
- [Best Reddit communities for AI builders 2026](https://www.aibuilderclub.com/blog/best-reddit-communities-ai-builders-2026)
- [awesome-subreddits (programming communities)](https://github.com/iCHAIT/awesome-subreddits)
- [15 best subreddits for Twitch streamers 2026](https://painonsocial.com/subreddits/twitch-streamers)
