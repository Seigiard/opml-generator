import { describe, test, expect, beforeAll } from "bun:test";
import { Window } from "happy-dom";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const PODCAST_PATH = "/test/Test%20Author/Test%20Audiobook/";

async function waitForServer(maxWaitMs = 30000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await fetch(`${BASE_URL}/ready`);

      if (response.status === 200) return;
    } catch {
      // Connection refused
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error("Server not ready");
}

async function isResyncEnabled(): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/resync`);

  return response.status === 401;
}

describe("nginx integration", () => {
  beforeAll(async () => {
    await waitForServer();
  });

  describe("browser shell", () => {
    test("GET / returns the no-cache HTML shell with feed fallbacks", async () => {
      // #given / #when
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      const body = await response.text();
      const document = new Window().document;

      document.write(body);

      // #then
      expect({
        status: response.status,
        contentType: response.headers.get("content-type")?.split(";")[0],
        cacheControl: response.headers.get("cache-control"),
        csp: response.headers.get("content-security-policy"),
        feedFallbacks: Array.from(document.querySelectorAll("noscript a")).map((link) =>
          link.getAttribute("href"),
        ),
        moduleScripts: document.querySelectorAll('script[type="module"][src="/_app/main.js"]')
          .length,
        stylesheets: document.querySelectorAll('link[rel="stylesheet"][href="/_app/style.css"]')
          .length,
        icons: document.querySelectorAll('link[rel="icon"][href="/_app/favicon/favicon.svg"]')
          .length,
      }).toEqual({
        status: 200,
        contentType: "text/html",
        cacheControl: "no-cache",
        csp: SHELL_CSP,
        feedFallbacks: ["/feed.opml", "feed.xml"],
        moduleScripts: 1,
        stylesheets: 1,
        icons: 1,
      });
    });

    test("GET a podcast folder returns the same no-cache HTML shell", async () => {
      // #given / #when
      const response = await fetch(`${BASE_URL}${PODCAST_PATH}`, { redirect: "manual" });

      // #then
      expect({
        status: response.status,
        contentType: response.headers.get("content-type")?.split(";")[0],
        cacheControl: response.headers.get("cache-control"),
        csp: response.headers.get("content-security-policy"),
      }).toEqual({
        status: 200,
        contentType: "text/html",
        cacheControl: "no-cache",
        csp: SHELL_CSP,
      });
    });
  });

  describe("feed.opml", () => {
    test("GET /ready returns 200 after initial publication", async () => {
      const response = await fetch(`${BASE_URL}/ready`);
      expect(response.status).toBe(200);
    });

    test("GET /feed.opml returns 200 with XML content", async () => {
      const response = await fetch(`${BASE_URL}/feed.opml`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("<?xml");
      expect(text).toContain("<opml");
    });
  });

  describe("shell assets", () => {
    test.each([
      ["/_app/main.js", "text/javascript"],
      ["/_app/style.css", "text/css"],
      ["/_app/favicon/favicon.svg", "image/svg+xml"],
    ])("GET %s returns its static asset", async (path, contentType) => {
      // #given / #when
      const response = await fetch(`${BASE_URL}${path}`);

      // #then
      expect({
        status: response.status,
        contentType: response.headers.get("content-type")?.split(";")[0],
      }).toEqual({ status: 200, contentType });
    });

    test.each(["/_app/", "/_app/index.html", "/static/layout.xsl", "/static/style.css"])(
      "GET %s returns 404",
      async (path) => {
        // #given / #when
        const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });

        // #then
        expect(response.status).toBe(404);
      },
    );
  });

  describe("feed XML", () => {
    test("GET /feed.opml keeps the machine-readable OPML endpoint", async () => {
      // #given / #when
      const response = await fetch(`${BASE_URL}/feed.opml`);
      const body = await response.text();

      // #then
      expect({
        status: response.status,
        contentType: response.headers.get("content-type")?.split(";")[0],
        isXml: body.startsWith("<?xml") && body.includes("<opml"),
      }).toEqual({ status: 200, contentType: "text/xml", isXml: true });
    });

    test("GET a podcast feed keeps the machine-readable RSS endpoint", async () => {
      // #given / #when
      const response = await fetch(`${BASE_URL}${PODCAST_PATH}feed.xml`);
      const body = await response.text();

      // #then
      expect({
        status: response.status,
        contentType: response.headers.get("content-type")?.split(";")[0],
        isXml: body.startsWith("<?xml") && body.includes("<rss"),
      }).toEqual({ status: 200, contentType: "text/xml", isXml: true });
    });
  });

  describe("directory index", () => {
    test("GET /nonexistent/ returns the browser shell", async () => {
      const response = await fetch(`${BASE_URL}/nonexistent/`, { redirect: "manual" });
      expect(response.status).toBe(200);
    });
  });

  describe("internal endpoints are blocked", () => {
    test("POST /events returns 404", async () => {
      const response = await fetch(`${BASE_URL}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });

      expect(response.status).toBe(404);
    });
  });

  describe("initial sync", () => {
    test("creates root feed.opml with valid OPML structure", async () => {
      const response = await fetch(`${BASE_URL}/feed.opml`);
      expect(response.status).toBe(200);

      const content = await response.text();
      expect(content).toContain('<?xml version="1.0"');
      expect(content).toContain("<opml");
      expect(content).toContain('version="2.0"');
      expect(content).toContain("<head>");
      expect(content).toContain("<body>");
    });
  });

  describe("audio file serving", () => {
    test("GET /audiobooks/ path returns audio content or 404", async () => {
      const response = await fetch(`${BASE_URL}/audiobooks/nonexistent.mp3`);
      expect([200, 404]).toContain(response.status);
    });

    test("Range request returns 206 for existing audio", async () => {
      const listResponse = await fetch(
        `${BASE_URL}/audiobooks/test/Test%20Author/Test%20Audiobook/01%20-%20Chapter%20One.mp3`,
      );

      if (listResponse.status !== 200) {
        console.log("Skipping: test audio file not found");

        return;
      }

      const rangeResponse = await fetch(
        `${BASE_URL}/audiobooks/test/Test%20Author/Test%20Audiobook/01%20-%20Chapter%20One.mp3`,
        {
          headers: { Range: "bytes=0-1023" },
        },
      );

      expect(rangeResponse.status).toBe(206);
      expect(rangeResponse.headers.get("content-range")).toBeTruthy();
    });
  });

  describe("image file serving", () => {
    test("GET an existing cover returns its image content", async () => {
      // #given / #when
      const response = await fetch(`${BASE_URL}${PODCAST_PATH}cover.jpg`);

      // #then
      expect({
        status: response.status,
        contentType: response.headers.get("content-type")?.split(";")[0],
      }).toEqual({ status: 200, contentType: "image/jpeg" });
    });
  });

  describe("/resync endpoint", () => {
    test("GET /resync without auth returns 401 (when enabled)", async () => {
      const enabled = await isResyncEnabled();

      if (!enabled) {
        console.log("Skipping: /resync not configured");

        return;
      }

      const response = await fetch(`${BASE_URL}/resync`);
      expect(response.status).toBe(401);
    });

    test("GET /resync with wrong auth returns 401 (when enabled)", async () => {
      const enabled = await isResyncEnabled();

      if (!enabled) {
        console.log("Skipping: /resync not configured");

        return;
      }

      const credentials = Buffer.from("wrong:credentials").toString("base64");

      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });

      expect(response.status).toBe(401);
    });

    test("GET /resync with correct auth returns 202 (when enabled)", async () => {
      const enabled = await isResyncEnabled();

      if (!enabled) {
        console.log("Skipping: /resync not configured");

        return;
      }

      const credentials = Buffer.from("admin:secret").toString("base64");

      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });

      expect(response.status).toBe(202);
    });
  });
});
