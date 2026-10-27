---
status: accepted
---

# The browser view is a single-page application over feeds

Chrome 158 removes browser XSLT on 2026-11-17. The generator used an
`xml-stylesheet` processing instruction in `feed.opml` and `feed.xml`, which
made the browser depend on the removed feature. The feeds are also consumed
by podcast applications, so their URLs and XML content must remain stable.

The browser view is now one static shell in `static/`. Nginx serves the shell
for `/` and folder paths. The shell fetches `/feed.opml` or the folder's
`feed.xml`, parses it with the browser `DOMParser`, and creates the page with
the DOM APIs. The generated feeds no longer include an XSLT processing
instruction. The shell is built from `ui/` with `bun run build:ui`.

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
- The browser view requires JavaScript. The shell provides `/feed.opml` and
  relative `feed.xml` links in `<noscript>` as feed fallbacks.
- Shell changes ship with committed files in `static/`; run
  `bun run build:ui:check` before pushing.
- Top-level source folder names `_app`, `static`, and `audiobooks` collide with nginx locations and have no browser page (`audiobooks` and `static` were already reserved before this change).
- The browser view requires audio files to live in folders. Audio files placed
  directly in the source root still publish `/feed.xml` for podcast apps and
  appear in the list with subscribe controls, but have no browser page by
  design.
- A 503 feed response shows `library is being built` and retries after its
  `Retry-After` value. If the header is absent, the shell retries after five
  seconds.
