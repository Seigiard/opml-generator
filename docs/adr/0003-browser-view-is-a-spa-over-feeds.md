---
status: accepted
---

# The browser view is a single-page application over feeds

Chrome 158 removes browser XSLT on 2026-11-17. The generator used an
`xml-stylesheet` processing instruction in `feed.opml` and `feed.xml`, which
made the browser depend on the removed feature. The feeds are also consumed
by podcast applications, so their URLs and XML content must remain stable.

The browser view is now one static shell in `static/`. Nginx serves the shell
for `/` and `/browse/<path>/`. The shell fetches `/feed.opml` for `/`, or the
source-relative folder's `feed.xml` for a `/browse/<path>/` page. `/browse/`
is the browser page for the root podcast. The shell parses feeds with the
browser `DOMParser` and creates pages with the DOM APIs. The generated feeds
no longer include an XSLT processing instruction. The shell is built from
`ui/` with `bun run build:ui`.

## Considered options

- **Keep browser XSLT**: rejected because Chrome 158 removes the feature.
- **Generate `index.html` during synchronization**: rejected because every
  browser-view change would require rebuilding every generated folder.
- **Use content negotiation or server-rendered HTML**: rejected because it
  creates a second browser contract at the feed endpoint and complicates
  caching for podcast applications.

## Consequences

- Podcast applications keep using the unchanged `feed.opml` and `feed.xml`
  endpoints.
- The browser view requires JavaScript. The shell provides only `/feed.opml`
  in `<noscript>` as a feed fallback.
- Shell changes ship with committed files in `static/`; run
  `bun run build:ui:check` before pushing.
- The `/browse/` prefix keeps browser pages separate from source-relative
  feeds, audio URLs, and shell assets, so no top-level source folder name
  collides with a browser page.
- A slash-less `/browse/<path>` whose last segment ends in `.jpg`, `.jpeg`,
  `.png`, `.webp`, or `.xml` is answered by the image or feed location (404)
  and is not normalized; the shell's own links always end with `/`.
- Audio files placed directly in the source root publish `/feed.xml` for
  podcast apps and appear in the list with subscribe controls; `/browse/` is
  their browser page.
- A 503 feed response shows `library is being built` and retries after its
  `Retry-After` value. If the header is absent, the shell retries after five
  seconds.
