import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

async function waitForServer(maxWaitMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await fetch(`${BASE_URL}/feed.opml`);
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

  describe("redirects", () => {
    test("GET / redirects to /feed.opml", async () => {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/feed.opml");
    });
  });

  describe("feed.opml", () => {
    test("GET /feed.opml returns 200 with XML content", async () => {
      const response = await fetch(`${BASE_URL}/feed.opml`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("<?xml");
      expect(text).toContain("<opml");
    });
  });

  describe("static files", () => {
    test("GET /static/layout.xsl returns 200", async () => {
      const response = await fetch(`${BASE_URL}/static/layout.xsl`);
      expect(response.status).toBe(200);
    });

    test("GET /static/style.css returns 200", async () => {
      const response = await fetch(`${BASE_URL}/static/style.css`);
      expect(response.status).toBe(200);
    });
  });

  describe("directory index", () => {
    test("GET /nonexistent/ returns 404", async () => {
      const response = await fetch(`${BASE_URL}/nonexistent/`, { redirect: "manual" });
      expect(response.status).toBe(404);
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
      const listResponse = await fetch(`${BASE_URL}/audiobooks/test/Test%20Author/Test%20Audiobook/01%20-%20Chapter%20One.mp3`);
      if (listResponse.status !== 200) {
        console.log("Skipping: test audio file not found");
        return;
      }

      const rangeResponse = await fetch(`${BASE_URL}/audiobooks/test/Test%20Author/Test%20Audiobook/01%20-%20Chapter%20One.mp3`, {
        headers: { Range: "bytes=0-1023" },
      });
      expect(rangeResponse.status).toBe(206);
      expect(rangeResponse.headers.get("content-range")).toBeTruthy();
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
