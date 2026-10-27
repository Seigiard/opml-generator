# Project profile: opml-generator

This file carries weights, not facts. The diff and the repository hold the facts; read them
there. Everything below is here because it changes a verdict.

## What the software is

- A self-hosted podcast RSS + OPML generator for a personal audiobook library: Bun (TypeScript, Effect) on port 3000 behind nginx on port 80, in one Alpine Docker container. One maintainer, one household of users, no public API, no multi-tenant concerns.
- `/audiobooks` is the authoritative source. `/data` is a generated, reversible cache. Any podcast app subscribes to `/feed.opml` or a per-folder `feed.xml`; nginx streams the audio.
- Contracts live in `docs/agents/synchronization.md` (passes, reconciliation, cache safety, watcher, RSS/OPML, shutdown), `docs/adr/0001` (filesystem is authoritative) and `docs/adr/0002` (private `~` cache projection, public paths stay source-relative). `GLOSSARY.md` names the domain terms. Weigh a finding against those documents rather than generic podcast or Node intuition.

## What a real failure looks like here

- A write outside the cache root, or a cache mutation that follows a symlink into the source library. The library is the only copy; the mutation guards in `src/cache-boundary.ts` and `src/stopping.ts` exist because of this. Highest weight.
- A pass that publishes a wrong or truncated `feed.opml` or `feed.xml` instead of retaining the prior one on error. Clients cache subscriptions; a silently empty feed looks like an unsubscribed podcast.
- A changed public metadata path or Episode identity. Podcast apps key playback position and downloads on the episode URL; a renamed path resets every listener.
- An event loop or infinite reprocessing: a generated-file write that reaches the source watcher, or a freshness check that never settles. Costs CPU forever and masks real changes.
- A shutdown that leaves inotify or wget children alive, or a container that reports ready before `feed.opml` exists.
- A hidden Bun or Alpine gotcha: `music-metadata` `parseFile()` hangs in Bun (use `parseBuffer()`), the image has no `curl`, the output lease needs Linux `flock`.
- A green test that cannot fail: expected values re-derived from the code under test, a mock answering its own assertion, a fixture-count gate. The repository's tdd chain locks tests before implementation; a test that was never red is not coverage.
- A link, URL, or XML that a real client parses differently from a string comparison: WHATWG URL serialization of custom schemes, percent-encoding of non-ASCII folder names, iTunes namespace fields. Check against the consumer's actual rules, not the author's intent.

## Blast radius

- One container, one library, a handful of podcast apps. No scale, latency, or availability concerns beyond "the pass finishes and the feed is right".
- Runtime files are cheap; the source library is not. Rate a defect by what it can do to `/audiobooks` and to published feeds first.

## Reporting bar

- Report defects that make a published feed, a cache mutation, readiness, or shutdown wrong on the real container, or that break the contracts named above.
- Report a test only when it is a false green, has no independent oracle, or contradicts a documented contract. Report a missing test only where a real oracle exists; "add a unit test" without naming its consumer and observable failure is not a finding.
- Do not report style, formatting, or naming: `bun run fix` (oxfmt + oxlint with the vendored anti-slop rules), `tsc`, and `knip` gate every commit and push.
- Do not report Node-vs-Bun API choices, Effect idioms, or missing abstractions in single-use handlers. The CLAUDE.md table (Bun.file, Bun.serve, Bun.$, Bun.hash) is deliberate.
- Do not report performance of a pass over a few thousand files unless it is unbounded.

## Deliberate conventions (not defects)

- Filesystem is authoritative; there is no database and no data watcher. Generated files never post events back to Bun.
- Cache paths go through the shared Bun/njs codec `src/cache-layout.js`; nginx resolves public metadata URLs through the same projection. Audio streams from the original source path.
- Episode numbers are recomputed from 1 on every feed update, sorted by `(disc, track, filename)`. The cached `episodeNumber` in `entry.xml` is ignored on purpose.
- An M4B file is one episode; chapters are not extracted.
- `/resync` requires Basic Auth only when both `ADMIN_USER` and `ADMIN_TOKEN` are set; otherwise nginx drops the auth block.
- Unit and engine tests run in Docker (`bun run test`); `test/e2e/` needs the production container; `smoke:engine` is a manual gate and is not in CI.
- The static feed page (`static/layout.xsl`, `static/subscribe.js`) is plain browser JS run through XSLT; it is tested through the served file with a fake DOM, not through a browser.
- `main` is the deployed branch and has no PR gate; lefthook pre-commit (format, lint, typecheck on staged files) and pre-push (knip) are the gates.
