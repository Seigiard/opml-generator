# OPML review fixes final result

## Commits

- `7fba09c` `fix: repair shared engine OPML cascades`
- `602b85a` `docs: record OPML review phase 1`
- `391e0f3` `chore: pin sync engine 0.5.1`

## Engine pin evidence

- `package.json` pins `@seigiard/sync-engine` to exact version `0.5.1`.
- `bun.lock` resolves `@seigiard/sync-engine@0.5.1` with integrity `sha512-dIO+BVc7lw2Ydc+dKCg2TXn7p2hLltwL7AcUMH1wqt1EbhlruO6cPBSL7CdqsnvvAQRFou3kIR6lSsGEQytskA==`.
- Host install check: `node_modules/@seigiard/sync-engine/package.json` reports `0.5.1`.
- Registry pack check: `npm pack @seigiard/sync-engine@0.5.1 --pack-destination /var/folders/mg/mg22yjv17054nxmbq8_jkqnm0000gn/T/opencode` reported shasum `aeb9d387aeafc4f5a58d07578a2f9341d220ca75` and the same integrity.
- Host source equality: `diff -qr node_modules/@seigiard/sync-engine /var/folders/mg/mg22yjv17054nxmbq8_jkqnm0000gn/T/opencode/opml-engine-pack-verify/package` produced no output.
- Production image equality: after `COMPOSE_PROJECT_NAME=opml49-rf2 TEST_PORT=18170 docker compose -f docker-compose.e2e.yml build`, copying `/app/node_modules/@seigiard/sync-engine` from `opml49-rf2-opml` and diffing it against the unpacked npm pack produced no output.
- Test image rebuild: `COMPOSE_PROJECT_NAME=opml49-rf2 docker compose -f docker-compose.test.yml build` installed `@seigiard/sync-engine@0.5.1`.
- No `.github/workflows/*` file exists in this worktree, so there was no repository CI workflow Bun pin to reuse. All local lock/update steps used Bun `1.4.2`, matching the Docker images used by the gates.

## Findings, tests, red and green

| Finding                                                      | Test / oracle                                                                                                               | Calibrated red                                                                                                                       | Green                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Vanished audio file re-enqueued itself forever               | `test/engine/episode-sync.test.ts`, source file removed during `lstat`, oracle is pass completion and no generated episode. | Phase 1 old-code run failed with `completed: false`, `state: working`, and repeated `targetLstats: 220`.                             | Full Docker suite passes; targeted engine file passes.                         |
| `FolderDeleted` cascade was dropped                          | Engine folder delete and folder rename tests assert old RSS file is gone and exact OPML URLs exclude stale podcast.         | Phase 1 old-code run failed with stale feed files and stale OPML URLs.                                                               | Full Docker suite passes.                                                      |
| Folder RSS work was never declared                           | Engine tests delete `feed.xml`, bump folder processing version, and assert unchanged folders skip writes.                   | Phase 1 old-code run failed with missing `feed.xml` ENOENT and `feedWrites: 0` for version bump.                                     | Full Docker suite passes.                                                      |
| Audio file to directory type change removed new child output | Engine test replaces `Author/Book.mp3` file with `Author/Book.mp3/01.mp3` directory tree and checks child RSS/OPML.         | Phase 1 old-code run failed with invalid empty OPML.                                                                                 | Full Docker suite passes.                                                      |
| Content freshness hashed full audio files                    | Engine tests assert metadata-equivalent plain pass skips, changed-path hint reprocesses, and forced pass reprocesses.       | Phase 1 old-code run failed because plain metadata-equivalent pass rewrote episode output.                                           | Full Docker suite passes.                                                      |
| SIGTERM before first pass produced false startup failure     | Runtime test stops before ready and asserts `ready` fulfills, not rejects; smoke checks SIGTERM exit `0`.                   | Throwaway old-runtime patch failed with `ready: rejected`.                                                                           | Runtime unit test, full Docker suite, and smoke pass.                          |
| Malformed `/events/books` JSON was an unhandled rejection    | HTTP unit test calls `createServerFetch` with malformed JSON and expects `400 Invalid event`.                               | Throwaway old-HTTP patch failed with `SyntaxError: JSON Parse error`.                                                                | Runtime unit test and full Docker suite pass.                                  |
| Resync e2e was false-green                                   | E2E corrupts published RSS, proves visible corrupted title, then waits for forced resync repair and exact OPML URL set.     | The old test did not prove this behavior; this is strengthened coverage. The precondition would fail if corruption were not visible. | `bun run test:e2e` passes with 14 tests.                                       |
| Smoke forced resync/restart checks were false-green          | Smoke corrupts published RSS before forced resync and deletes derived RSS before restart replay.                            | The old smoke did not observe repair. This is strengthened smoke coverage rather than an old-code red unit.                          | `SMOKE_PROJECT=opml49-rf2-smoke SMOKE_PORT=18172 bun run smoke:engine` passes. |
| Deleted episode test accepted stale RSS                      | Engine deletion test asserts exact RSS GUID list after deleting `02.mp3`.                                                   | Covered by phase 1 old-code red group and would fail if RSS still listed deleted episode.                                            | Full Docker suite passes.                                                      |
| Dead handler registry and unreachable handlers               | `npx knip`, typecheck, and handler tests prove no production-only dead registry remains.                                    | Red is structural: before removal these files were reachable only through the dead registry. No behavior threshold was weakened.     | `bun --bun tsc --noEmit`, `npx knip`, and full Docker suite pass.              |
| Data watcher spawned ignored events                          | Integration watcher transport still proves source overflow behavior; docs and watcher code now have no data worker path.    | Red is operational inefficiency, not a failing behavior test. The removed `/events/data` path is no longer documented or started.    | Full Docker suite and E2E pass.                                                |
| Stale docs contradicted shared engine behavior               | README, CLAUDE, ADR 0001, smoke expected version, and phase evidence now match 0.5.1 and current lifecycle.                 | Docs were stale in the review report; no executable red applies.                                                                     | Full gates and `npx knip` pass.                                                |

## Full gate commands and counts

- `bun run fix`: pass.
- `bun run lint`: pass, 0 warnings and 0 errors.
- `bun run lint:anti-slop`: pass, 0 errors after spacing fixes.
- `bun --bun tsc --noEmit`: pass.
- `COMPOSE_PROJECT_NAME=opml49-rf2 bun run test`: pass, `150 pass`, `0 fail`, `255 expect() calls`, `15 files`.
- `npx knip`: pass, no findings.
- `COMPOSE_PROJECT_NAME=opml49-rf2 TEST_PORT=18171 TEST_BASE_URL=http://localhost:18171 bun run test:e2e`: pass, `14 pass`, `0 fail`, `25 expect() calls`, `2 files`.
- `SMOKE_PROJECT=opml49-rf2-smoke SMOKE_PORT=18172 bun run smoke:engine`: pass. Smoke output reported engine version `0.5.1`, SIGTERM exit code `0`, and `restartedAvailableFrom: prior-output`.

Pre-review comparison:

- Phase 1 calibrated old-code engine run: `17 pass`, `7 fail`. Final engine coverage inside full Docker suite: all engine tests pass.
- Phase 2 full Docker suite after all fixes: `150 pass`, `0 fail`. The first phase-2 full-suite attempt exposed a parser-sensitive test helper shape and reported `146 pass`, `1 fail`; the helper was rewritten without changing behavior, then the full suite passed.
- No pre-review full-suite green count exists in this worktree, because phase 1 explicitly did not run full suites.

## Not fixed / open decisions

- Removed in-process 8 second shutdown deadline remains an open decision, by prompt. Current real behavior: `runServer()` closes HTTP admission and awaits the shared engine stop hook; the entrypoint watchdog and compose stop grace are the outer shutdown bound. Smoke verifies ordinary SIGTERM exit `0`, but there is still no restored application-level 8 second deadline.
- Engine open item from publication receipt remains upstream: a source entry that vanishes between `readdir` and `lstat` can still fail scan as `ScanFailed`. OPML's phase-1 vanished-file fix covers scan-to-handler disappearance for declared episode work.

## Leftover images

After the runs, these local Docker images remained and were not removed:

- `opml49-rf2-opml:latest d1508909d567`
- `opml49-rf2-test:latest c7970fadbc41`
- `opml49-rf2-smoke-opml:latest 1aaba50ea76f`
- `opml49-rf2-red-json-test:latest de5f87b99fad`
- `opml49-rf2-red-stop-test:latest 62fcce63e2c6`
