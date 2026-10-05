# Anti-slop checks

Run `bun run lint:anti-slop` to check owned JavaScript and TypeScript, including tests. A dedicated GitHub Actions job runs the same command on pull requests and pushes. Existing lint commands and workflows are retained.

All 18 upstream generic rules and native `oxc/no-accumulating-spread` are enabled at error severity. No direct Effect dependency is declared, so Effect rules are not registered.

Source: [dmmulroy/anti-slop at c44ef22](https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b/src). Exact provenance and licenses are in `tools/oxlint/anti-slop/`. Oxlint and `@oxlint/plugins` are pinned at 1.87.0. This upgrades older Oxlint installations because their matching plugin package versions are not published.

## Initial verification

The installation initially reported **349 source findings**. The same PR now fixes them without changing rule severity or widening ignores.

- `require-readable-spacing`: 258
- `no-unknown-parameters`: 5
- `no-runtime-typeof`: 16
- `require-safety-comment-for-type-assertion`: 47
- `no-unsafe-dictionary-type`: 10
- `no-known-value-widening`: 13

| Command                  | Exit code |
| ------------------------ | --------- |
| `bun run lint:anti-slop` | 1         |
| `bun run lint`           | 0         |
| `bun --bun tsc --noEmit` | 0         |
| `bun run test`           | 127       |
| `bunx knip`              | 0         |

These exit codes describe the installation baseline. Local Docker is unavailable. Runtime verification for the cleanup uses the existing Docker test/build workflow on the published commit.

## Cleanup verification

- Anti-slop, existing lint, TypeScript, and Knip pass locally.
- Watcher payloads and RSS metadata are decoded with Zod at their input boundaries. Handlers receive typed events.
- XML nodes have field contracts instead of unknown dictionaries. Existing XMLBuilder assertions state the library's string output invariant.
- Handler catches return Error values without asserting that every thrown value is an Error. Test call collections are initialized without assertions.
- Whitespace is committed separately. A second fix/format pass leaves the source diff unchanged.
- Runtime success requires the existing same-head Docker tests and image build to pass on GitHub Actions.

## Scope

Owned source and tests are included in cleanup. Vendored plugin source, installed dependencies, generated output, and agent tooling are excluded from the check. Existing rules are not suppressed. The separate config avoids inheriting broad legacy ignores that would exclude owned JavaScript or tests.
