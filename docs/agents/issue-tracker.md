# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Seigiard/opml-generator`.
Use the `gh` CLI. Run commands from this clone, or pass
`--repo Seigiard/opml-generator`.

## Issue operations

- Create: `gh issue create --title "..." --body-file <path>`
- Read with comments: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open --json number,title,body,labels`
- Comment: `gh issue comment <number> --body-file <path>`
- Add a label: `gh issue edit <number> --add-label "..."`
- Remove a label: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use `--label` and `--state` to filter lists. Use `--json` and `--jq`
when a skill needs structured data.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If changed to `yes`, triage external PRs with the same roles as issues.
Use `gh pr view`, `gh pr diff`, `gh pr comment`, `gh pr edit`, and
`gh pr close`. Keep PRs whose author association is `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR`, or `NONE`.

GitHub issues and PRs share one number space. For an ambiguous `#<number>`,
try `gh pr view <number>`, then fall back to `gh issue view <number>`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, with Notes,
  Decisions-so-far, and Fog sections.
- Child ticket: link it as a GitHub sub-issue. If sub-issues are unavailable,
  add it to the map's task list and start its body with `Part of #<map>`.
- Ticket type: use `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: use native GitHub issue dependencies. Get the blocker's
  database ID with `gh api repos/Seigiard/opml-generator/issues/<n> --jq .id`,
  then add the edge:

  ```bash
  gh api --method POST repos/Seigiard/opml-generator/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>
  ```

  If dependencies are unavailable, start the child body with
  `Blocked by: #<n>, #<n>`. A ticket is unblocked when all blockers are closed.

- Frontier: inspect the map's open children in map order. Select the first
  unassigned ticket with no open blockers. Native dependencies report
  open blockers in `issue_dependencies_summary.blocked_by`.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the ticket, then add a short
  summary and a link to the map's Decisions-so-far section.
