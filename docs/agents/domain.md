# Domain Docs

This repo uses a single-context layout:

- `GLOSSARY.md` at the repo root defines domain terms.
- `docs/adr/` holds architecture decision records.

## Before exploring

Read `GLOSSARY.md` and the ADRs relevant to the area you will work on.

If these files are absent, proceed silently. The `domain-modeling`
skill creates them when terms or decisions are resolved.

## Use the glossary

Use the glossary's terms in issue titles, proposals, code, and test names.
Respect distinctions and synonyms defined there.

If a concept has no entry, check whether an existing term fits.
If there is a real gap, note it for `domain-modeling`.

## Surface decision conflicts

If a proposal contradicts an ADR, name the ADR and explain why the
decision should be reconsidered before proceeding.
