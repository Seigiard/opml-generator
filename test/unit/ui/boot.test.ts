import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createUiWindow } from "../../helpers/ui-document.ts";

const BOOT_MODULE = "../../../ui/app/boot.ts";

const originalDomParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");

type BrowserFunctionReceiver = typeof globalThis | undefined;

function requireGlobalReceiver<Arguments extends unknown[], Result>(
  implementation: (...args: Arguments) => Result,
): (...args: Arguments) => Result {
  return function (this: BrowserFunctionReceiver, ...args: Arguments): Result {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }

    return implementation(...args);
  };
}

beforeAll(() => {
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    writable: true,
    value: new Window().DOMParser,
  });
});

afterAll(() => {
  if (originalDomParser) {
    Object.defineProperty(globalThis, "DOMParser", originalDomParser);
  } else {
    Reflect.deleteProperty(globalThis, "DOMParser");
  }
});

describe("boot", () => {
  test("renders a navigation feed as an ordered child list with podcast-only subscriptions", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/Parent/");

    const text = await Bun.file(
      new URL("../../fixtures/feeds/navigation.xml", import.meta.url),
    ).text();

    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(text, { status: 200 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    const items = Array.from(window.document.querySelectorAll("ul.podcasts > li.podcast"));

    // #then
    expect({
      documentTitle: window.document.title,
      heading: window.document.querySelector("h1")?.textContent,
      items: items.map((item) => ({
        title: item.querySelector("a.podcast__title")?.textContent,
        href: item.querySelector("a.podcast__title")?.getAttribute("href"),
        subscribe: item.querySelector("small.subscribe a:last-child")?.getAttribute("href") ?? null,
      })),
      podcastHeaderCount: window.document.querySelectorAll("header.feed-header").length,
      episodeListCount: window.document.querySelectorAll("ol.episodes").length,
      libraryLinkCount: window.document.querySelectorAll("main > small.subscribe").length,
    }).toEqual({
      documentTitle: "Parent & Group",
      heading: "Parent & Group",
      items: [
        {
          title: "Podcast One",
          href: "/browse/Parent/Podcast%20One/",
          subscribe: "antennapod-subscribe://library.example/Parent/Podcast%20One/feed.xml",
        },
        {
          title: "Nested Group",
          href: "/browse/Parent/Nested%20Group/",
          subscribe: null,
        },
        {
          title: "Legacy Child",
          href: "/browse/Parent/Legacy%20Child/",
          subscribe: null,
        },
      ],
      podcastHeaderCount: 0,
      episodeListCount: 0,
      libraryLinkCount: 0,
    });
  });

  test("renders the library OPML link under the library heading", async () => {
    // #given
    const window = createUiWindow("https://library.example/");

    const text = await Bun.file(
      new URL("../../fixtures/feeds/library.opml", import.meta.url),
    ).text();

    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(text, { status: 200 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    const heading = window.document.querySelector("main > h1");

    const libraryLinks = Array.from(
      window.document.querySelectorAll("main > small.subscribe a"),
      (link) => ({ text: link.textContent, href: link.getAttribute("href") }),
    );

    // #then
    expect({
      heading: heading?.textContent,
      followsHeading: heading?.nextElementSibling?.className,
      libraryLinks,
    }).toEqual({
      heading: "Audio Library",
      followsHeading: "subscribe",
      libraryLinks: [{ text: "Copy\u00a0OPML", href: "https://library.example/feed.opml" }],
    });
  });

  test("keeps rendering podcast RSS as a podcast page", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/first/");

    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(text, { status: 200 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      documentTitle: window.document.title,
      title: window.document.querySelector("h1.feed-header__title")?.textContent,
      episodes: Array.from(
        window.document.querySelectorAll("ol.episodes > li.episode a.episode__title"),
        (episode) => episode.textContent,
      ),
      navigationListCount: window.document.querySelectorAll("ul.podcasts").length,
    }).toEqual({
      documentTitle: "First & Finest",
      title: "First & Finest",
      episodes: ["Opening <b>Chapter</b>", "Long Chapter"],
      navigationListCount: 0,
    });
  });

  test("normalizes a browser path before fetching its RSS feed", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/first");

    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    const events: string[] = [];
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: {
        replaceState: (_data: null, _unused: string, url?: string | URL | null) => {
          events.push(`replaceState:${String(url)}`);
        },
      },
      fetch: requireGlobalReceiver(async (input: string | URL | Request) => {
        events.push(`fetch:${String(input)}`);

        return new Response(text, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect(events).toEqual(["replaceState:/browse/books/first/", "fetch:/books/first/feed.xml"]);
  });

  test("shows the building message and retries after Retry-After seconds", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/first/");

    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    let calls = 0;
    let delay: number | undefined;
    let messageAtSchedule = "";
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => {
        calls += 1;

        if (calls === 1) {
          return new Response(null, { status: 503, headers: { "Retry-After": "7" } });
        }

        return new Response(text, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver((callback: () => void, timeout?: number) => {
        delay = timeout;
        messageAtSchedule = window.document.body.textContent?.trim() ?? "";
        callback();

        return 1;
      }),
    });

    // #then
    expect({ calls, delay, messageAtSchedule }).toEqual({
      calls: 2,
      delay: 7000,
      messageAtSchedule: "library is being built",
    });
  });

  test("renders a not-found message with a link to the library", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/missing/");
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(null, { status: 404 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      hasMessage: window.document.body.textContent?.includes("podcast not found"),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
    }).toEqual({ hasMessage: true, href: "/" });
  });

  test("renders an HTTP failure with a link to the raw feed", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/broken/");
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(
        async () => new Response(null, { status: 500, statusText: "Internal Server Error" }),
      ),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      hasMessage: window.document.body.textContent?.includes("Internal Server Error"),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
    }).toEqual({ hasMessage: true, href: "/books/broken/feed.xml" });
  });

  test("renders not found without fetching outside the browser URL contract", async () => {
    // #given
    const window = createUiWindow("https://library.example/books/first/");
    const events: string[] = [];
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async (input: string | URL | Request) => {
        events.push(`fetch:${String(input)}`);

        return new Response(null, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      message: window.document.body.textContent?.trim(),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
      events,
    }).toEqual({ message: "podcast not found Back to library", href: "/", events: [] });
  });

  test("renders not found without fetching a protocol-relative browse path", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse//evil.example/x/");
    const events: string[] = [];
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async (input: string | URL | Request) => {
        events.push(`fetch:${String(input)}`);

        return new Response(null, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      message: window.document.body.textContent?.trim(),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
      events,
    }).toEqual({ message: "podcast not found Back to library", href: "/", events: [] });
  });
});

interface NavigationRecord {
  handler: (() => Promise<void>) | undefined;
  scrolls: number;
  controller: AbortController;
}

interface DeferredTransition {
  update: (() => void) | undefined;
  captured: ReturnType<typeof Promise.withResolvers<void>>;
  done: ReturnType<typeof Promise.withResolvers<void>>;
}

interface CapturedRequest {
  signal: AbortSignal | null;
}

// The NavigateEvent fields the shell reads. The root tsconfig has no DOM lib,
// so UI modules load through dynamic imports and this fake stays local.
interface FakeNavigateEvent {
  canIntercept: boolean;
  hashChange: boolean;
  downloadRequest: string | null;
  formData: FormData | null;
  navigationType: "push" | "replace" | "reload" | "traverse";
  destination: { url: string };
  signal: AbortSignal;
  intercept(options: { handler: () => Promise<void> }): void;
  scroll(): void;
}

type NavigateOverrides = Partial<
  Pick<
    FakeNavigateEvent,
    "canIntercept" | "hashChange" | "downloadRequest" | "formData" | "navigationType"
  >
>;

function createNavigation() {
  const listeners: Array<(event: FakeNavigateEvent) => void> = [];

  return {
    addEventListener(_type: "navigate", listener: (event: FakeNavigateEvent) => void): void {
      listeners.push(listener);
    },
    navigate(url: string, overrides: NavigateOverrides = {}): NavigationRecord {
      const record: NavigationRecord = {
        handler: undefined,
        scrolls: 0,
        controller: new AbortController(),
      };

      const event: FakeNavigateEvent = {
        canIntercept: true,
        hashChange: false,
        downloadRequest: null,
        formData: null,
        navigationType: "push",
        ...overrides,
        destination: { url },
        signal: record.controller.signal,
        intercept(options: { handler: () => Promise<void> }): void {
          record.handler = options.handler;
        },
        scroll(): void {
          record.scrolls += 1;
        },
      };

      for (const listener of listeners) listener(event);

      return record;
    },
  };
}

function createDeferredTransition(): DeferredTransition {
  return {
    update: undefined,
    captured: Promise.withResolvers<void>(),
    done: Promise.withResolvers<void>(),
  };
}

async function feedFixtures(): Promise<Record<string, string>> {
  const fixture = (name: string) =>
    Bun.file(new URL(`../../fixtures/feeds/${name}`, import.meta.url)).text();

  return {
    "/feed.opml": await fixture("library.opml"),
    "/books/first/feed.xml": await fixture("podcast.xml"),
  };
}

describe("in-shell navigation", () => {
  test("renders a browse page in place, opens it at the top, and focuses its heading", async () => {
    // #given
    const window = createUiWindow("https://library.example/");
    const feeds = await feedFixtures();
    const fetched: string[] = [];
    const navigation = createNavigation();
    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(async (input: string) => {
        fetched.push(input);

        return new Response(feeds[input] ?? null, { status: feeds[input] ? 200 : 404 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    window.document.documentElement.scrollTop = 200;

    // #when
    const record = navigation.navigate("https://library.example/browse/books/first/");
    await record.handler?.();

    // #then
    expect({
      intercepted: record.handler !== undefined,
      fetched,
      documentTitle: window.document.title,
      heading: window.document.querySelector("h1.feed-header__title")?.textContent,
      focused: window.document.activeElement?.localName,
      scrollTop: window.document.documentElement.scrollTop,
    }).toEqual({
      intercepted: true,
      fetched: ["/feed.opml", "/books/first/feed.xml"],
      documentTitle: "First & Finest",
      heading: "First & Finest",
      focused: "h1",
      scrollTop: 0,
    });
  });

  test("Back and Forward hand scroll restoration to the browser", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/first/");
    const feeds = await feedFixtures();
    const navigation = createNavigation();
    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(
        async (input: string) => new Response(feeds[input] ?? null, { status: 200 }),
      ),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    window.document.documentElement.scrollTop = 200;

    // #when
    const record = navigation.navigate("https://library.example/", { navigationType: "traverse" });
    await record.handler?.();

    // #then
    expect({
      heading: window.document.querySelector("main > h1")?.textContent,
      browserScrolls: record.scrolls,
      scrollTop: window.document.documentElement.scrollTop,
    }).toEqual({ heading: "Audio Library", browserScrolls: 1, scrollTop: 200 });
  });

  test("resets the document title on a page without its own title", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/first/");
    // createUiWindow copies only the shell body; this is the shell's <title>.
    window.document.title = "Podcast Library";
    const feeds = await feedFixtures();
    const navigation = createNavigation();
    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(
        async (input: string) =>
          new Response(feeds[input] ?? null, { status: feeds[input] ? 200 : 404 }),
      ),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #when
    const record = navigation.navigate("https://library.example/browse/books/missing/");
    await record.handler?.();

    // #then
    expect({
      documentTitle: window.document.title,
      message: window.document.body.textContent?.trim(),
    }).toEqual({ documentTitle: "Podcast Library", message: "podcast not found Back to library" });
  });

  test("leaves feeds, audio, other origins, reloads, and slash-less paths to the browser", async () => {
    // #given
    const window = createUiWindow("https://library.example/");
    const feeds = await feedFixtures();
    const navigation = createNavigation();
    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(
        async (input: string) => new Response(feeds[input] ?? null, { status: 200 }),
      ),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #when
    const intercepted = [
      navigation.navigate("https://library.example/books/first/feed.xml"),
      navigation.navigate("https://library.example/books/first/01.mp3"),
      navigation.navigate("https://other.example/browse/books/first/"),
      navigation.navigate("https://library.example/browse/books/first"),
      navigation.navigate("https://library.example/", { navigationType: "reload" }),
      navigation.navigate("https://library.example/browse/books/first/", { canIntercept: false }),
      navigation.navigate("https://library.example/browse/books/first/", {
        downloadRequest: "first",
      }),
      navigation.navigate("https://library.example/#top", { hashChange: true }),
    ].map((record) => record.handler !== undefined);

    // #then
    expect(intercepted).toEqual([false, false, false, false, false, false, false, false]);
  });

  test("a navigation during the first load's 503 retry cancels that retry", async () => {
    // #given
    const window = createUiWindow("https://library.example/browse/books/first/");
    const feeds = await feedFixtures();
    const fetched: string[] = [];
    const timers: Array<() => void> = [];
    const navigation = createNavigation();
    const { boot } = await import(BOOT_MODULE);

    const booted = boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(async (input: string) => {
        fetched.push(input);

        if (input === "/books/first/feed.xml") return new Response(null, { status: 503 });

        return new Response(feeds[input] ?? null, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver((callback: () => void) => {
        timers.push(callback);

        return 1;
      }),
    });

    await Bun.sleep(0);

    // #when
    const record = navigation.navigate("https://library.example/");
    await record.handler?.();
    await booted;

    for (const timer of timers) timer();

    await Bun.sleep(0);

    // #then
    expect({
      fetched,
      heading: window.document.querySelector("main > h1")?.textContent,
    }).toEqual({ fetched: ["/books/first/feed.xml", "/feed.opml"], heading: "Audio Library" });
  });

  test("a slow feed that answers after its navigation was aborted does not replace the newer page", async () => {
    // #given
    const window = createUiWindow("https://library.example/");
    const feeds = await feedFixtures();
    const navigation = createNavigation();
    const slow = Promise.withResolvers<Response>();
    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(async (input: string) => {
        if (input === "/books/slow/feed.xml") return slow.promise;

        return new Response(feeds[input] ?? null, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    const stale = navigation.navigate("https://library.example/browse/books/slow/", {
      navigationType: "traverse",
    });

    const staleDone = stale.handler?.();

    // #when
    stale.controller.abort();
    const first = navigation.navigate("https://library.example/browse/books/first/");
    await first.handler?.();
    slow.resolve(new Response(null, { status: 404 }));
    await staleDone;

    // #then
    expect({
      heading: window.document.querySelector("h1")?.textContent,
      staleScrolls: stale.scrolls,
    }).toEqual({ heading: "First & Finest", staleScrolls: 0 });
  });

  test("an aborted navigation stops its 503 retry and leaves the newer page on screen", async () => {
    // #given
    const window = createUiWindow("https://library.example/");
    const feeds = await feedFixtures();
    const fetched: string[] = [];
    const timers: Array<() => void> = [];
    const navigation = createNavigation();
    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(async (input: string) => {
        fetched.push(input);

        if (input === "/books/building/feed.xml") return new Response(null, { status: 503 });

        return new Response(feeds[input] ?? null, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver((callback: () => void) => {
        timers.push(callback);

        return 1;
      }),
    });

    const building = navigation.navigate("https://library.example/browse/books/building/", {
      navigationType: "traverse",
    });

    const buildingDone = building.handler?.();
    await Bun.sleep(0);

    // #when
    building.controller.abort();
    const first = navigation.navigate("https://library.example/browse/books/first/");
    await first.handler?.();
    await buildingDone;

    for (const timer of timers) timer();

    await Bun.sleep(0);

    // #then
    expect({
      fetched,
      heading: window.document.querySelector("h1")?.textContent,
      buildingScrolls: building.scrolls,
    }).toEqual({
      fetched: ["/feed.opml", "/books/building/feed.xml", "/books/first/feed.xml"],
      heading: "First & Finest",
      buildingScrolls: 0,
    });
  });

  test("an aborted navigation cannot update the page through a deferred view transition", async () => {
    // #given
    const window = createUiWindow("https://library.example/");
    const feeds = await feedFixtures();

    const parentFeed = await Bun.file(
      new URL("../../fixtures/feeds/navigation.xml", import.meta.url),
    ).text();

    const navigation = createNavigation();
    const firstTransition = createDeferredTransition();
    const secondTransition = createDeferredTransition();
    const pendingTransitions = [firstTransition, secondTransition];

    Object.defineProperty(window.document, "startViewTransition", {
      configurable: true,
      value(update: () => void) {
        const transition = pendingTransitions.shift();

        if (transition === undefined) throw new Error("Unexpected view transition");

        transition.update = update;
        transition.captured.resolve();

        return { updateCallbackDone: transition.done.promise };
      },
    });

    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(async (input: string) => {
        if (input === "/Parent/feed.xml") return new Response(parentFeed, { status: 200 });

        return new Response(feeds[input] ?? null, { status: feeds[input] ? 200 : 404 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    const stale = navigation.navigate("https://library.example/browse/books/first/", {
      navigationType: "traverse",
    });

    const staleDone = stale.handler?.();
    await firstTransition.captured.promise;

    // #when
    stale.controller.abort();
    const current = navigation.navigate("https://library.example/browse/Parent/");
    const currentDone = current.handler?.();
    await secondTransition.captured.promise;

    if (firstTransition.update === undefined) throw new Error("First transition was not captured");

    firstTransition.update();
    firstTransition.done.resolve();
    await staleDone;

    const afterStaleUpdate = {
      heading: window.document.querySelector("h1")?.textContent,
      documentTitle: window.document.title,
      focusedElement: window.document.activeElement?.localName,
      staleScrolls: stale.scrolls,
    };

    if (secondTransition.update === undefined)
      throw new Error("Second transition was not captured");

    secondTransition.update();
    secondTransition.done.resolve();
    await currentDone;

    // #then
    expect({
      afterStaleUpdate,
      finalHeading: window.document.querySelector("h1")?.textContent,
      finalDocumentTitle: window.document.title,
    }).toEqual({
      afterStaleUpdate: {
        heading: "Audio Library",
        documentTitle: "Audio Library",
        focusedElement: "body",
        staleScrolls: 0,
      },
      finalHeading: "Parent & Group",
      finalDocumentTitle: "Parent & Group",
    });
  });

  test("passes the aborted navigation signal to its pending feed request", async () => {
    // #given
    const window = createUiWindow("https://library.example/");
    const feeds = await feedFixtures();
    const navigation = createNavigation();
    const slow = Promise.withResolvers<Response>();
    const fetchStarted = Promise.withResolvers<void>();
    const staleRequest: CapturedRequest = { signal: null };
    const { boot } = await import(BOOT_MODULE);

    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      navigation,
      fetch: requireGlobalReceiver(async (input: string, init?: RequestInit) => {
        if (input === "/books/slow/feed.xml") {
          staleRequest.signal = init?.signal ?? null;
          fetchStarted.resolve();

          return slow.promise;
        }

        return new Response(feeds[input] ?? null, { status: feeds[input] ? 200 : 404 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    const stale = navigation.navigate("https://library.example/browse/books/slow/");
    const staleDone = stale.handler?.();
    await fetchStarted.promise;

    // #when
    stale.controller.abort();
    const current = navigation.navigate("https://library.example/");
    await current.handler?.();
    const observedSignal = staleRequest.signal;
    slow.resolve(new Response(null, { status: 404 }));
    await staleDone;

    // #then
    expect({
      signalWasPassed: observedSignal === stale.controller.signal,
      signalAborted: observedSignal?.aborted ?? null,
      heading: window.document.querySelector("main > h1")?.textContent,
    }).toEqual({
      signalWasPassed: true,
      signalAborted: true,
      heading: "Audio Library",
    });
  });
});
