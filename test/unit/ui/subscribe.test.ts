import { describe, expect, test } from "bun:test";
import { createUiWindow } from "../../helpers/ui-document.ts";

const SUBSCRIBE_MODULE = "../../../ui/app/subscribe.ts";

interface StubbedTimeout {
  delay: number | undefined;
  run(): void;
}

async function withStubbedTimeout(body: (timeout: StubbedTimeout) => Promise<void>): Promise<void> {
  let scheduled: (() => void) | undefined;

  const timeout: StubbedTimeout = {
    delay: undefined,
    run: () => scheduled?.(),
  };

  const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    writable: true,
    value: (callback: () => void, delay?: number) => {
      scheduled = callback;
      timeout.delay = delay;

      return 1;
    },
  });

  try {
    await body(timeout);
  } finally {
    if (originalSetTimeout) {
      Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
    } else {
      Reflect.deleteProperty(globalThis, "setTimeout");
    }
  }
}

describe("renderSubscribe", () => {
  test("renders Copy RSS as a real feed link next to AntennaPod", async () => {
    // #given
    const document = createUiWindow().document;
    const feedUrl = "https://opml.1218217.xyz/audiobooks/feed.xml";
    const navigator = { clipboard: { writeText: async () => undefined } };
    const { renderSubscribe } = await import(SUBSCRIBE_MODULE);

    // #when
    const control = renderSubscribe(document, feedUrl, navigator);
    const anchors = control.querySelectorAll("a");

    // #then
    expect({
      tag: control.tagName,
      className: control.className,
      copy: { text: anchors[0]?.textContent, href: anchors[0]?.getAttribute("href") },
      separator: control.childNodes[1]?.textContent,
      antennaPod: { text: anchors[1]?.textContent, href: anchors[1]?.getAttribute("href") },
    }).toEqual({
      tag: "SMALL",
      className: "subscribe",
      copy: { text: "Copy\u00a0RSS", href: "https://opml.1218217.xyz/audiobooks/feed.xml" },
      separator: " · ",
      antennaPod: {
        text: "AntennaPod",
        href: "antennapod-subscribe://opml.1218217.xyz/audiobooks/feed.xml",
      },
    });
  });

  test.each([
    [
      "https://opml.1218217.xyz/audiobooks/%D0%A7%D0%BE%D1%80%D1%82%D0%B8/feed.xml",
      "antennapod-subscribe://opml.1218217.xyz/audiobooks/%D0%A7%D0%BE%D1%80%D1%82%D0%B8/feed.xml",
    ],
    [
      "http://opml.1218217.xyz/audiobooks/feed.xml",
      "antennapod-subscribe://opml.1218217.xyz/audiobooks/feed.xml",
    ],
  ])("strips the HTTP scheme from %s", async (feedUrl, expected) => {
    // #given
    const document = createUiWindow().document;
    const navigator = { clipboard: { writeText: async () => undefined } };
    const { renderSubscribe } = await import(SUBSCRIBE_MODULE);

    // #when
    const control = renderSubscribe(document, feedUrl, navigator);

    // #then
    expect(control.querySelector("a:last-child")?.getAttribute("href")).toBe(expected);
  });

  test("a plain click copies the feed URL instead of navigating, then restores the label after 1500 ms", async () => {
    await withStubbedTimeout(async (timeout) => {
      // #given
      const window = createUiWindow();
      const feedUrl = "https://opml.1218217.xyz/audiobooks/feed.xml";
      let copied = "";

      const navigator = {
        clipboard: {
          writeText: async (value: string) => {
            copied = value;
          },
        },
      };

      const { renderSubscribe } = await import(SUBSCRIBE_MODULE);

      const copy = renderSubscribe(window.document, feedUrl, navigator).querySelector(
        "a:first-child",
      )!;

      const click = new window.MouseEvent("click", { bubbles: true, cancelable: true });

      // #when
      copy.dispatchEvent(click);
      await Promise.resolve();
      const confirmation = copy.textContent;
      timeout.run();

      // #then
      expect({
        navigationPrevented: click.defaultPrevented,
        copied,
        confirmation,
        delay: timeout.delay,
        restored: copy.textContent,
      }).toEqual({
        navigationPrevented: true,
        copied: "https://opml.1218217.xyz/audiobooks/feed.xml",
        confirmation: "Copied!",
        delay: 1500,
        restored: "Copy\u00a0RSS",
      });
    });
  });

  test.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
    ["middle button", { button: 1 }],
  ])("a click with %s follows the link without copying", async (_name, modifier) => {
    // #given
    const window = createUiWindow();
    let copied = "";

    const navigator = {
      clipboard: {
        writeText: async (value: string) => {
          copied = value;
        },
      },
    };

    const { renderSubscribe } = await import(SUBSCRIBE_MODULE);

    const copy = renderSubscribe(
      window.document,
      "https://opml.1218217.xyz/audiobooks/feed.xml",
      navigator,
    ).querySelector("a:first-child")!;

    const click = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...modifier,
    });

    // #when
    copy.dispatchEvent(click);
    await Promise.resolve();

    // #then
    expect({ navigationPrevented: click.defaultPrevented, copied }).toEqual({
      navigationPrevented: false,
      copied: "",
    });
  });

  test("a plain click follows the link when the clipboard API is unavailable", async () => {
    // #given
    const window = createUiWindow();
    const { renderSubscribe } = await import(SUBSCRIBE_MODULE);

    const copy = renderSubscribe(
      window.document,
      "https://opml.1218217.xyz/audiobooks/feed.xml",
      {},
    ).querySelector("a:first-child")!;

    const click = new window.MouseEvent("click", { bubbles: true, cancelable: true });

    // #when
    copy.dispatchEvent(click);

    // #then
    expect({ navigationPrevented: click.defaultPrevented, label: copy.textContent }).toEqual({
      navigationPrevented: false,
      label: "Copy\u00a0RSS",
    });
  });

  test("a rejected clipboard write shows Copy failed, then restores the label after 1500 ms", async () => {
    await withStubbedTimeout(async (timeout) => {
      // #given
      const window = createUiWindow();

      const navigator = {
        clipboard: {
          writeText: async () => {
            throw new Error("NotAllowedError");
          },
        },
      };

      const { renderSubscribe } = await import(SUBSCRIBE_MODULE);

      const copy = renderSubscribe(
        window.document,
        "https://opml.1218217.xyz/audiobooks/feed.xml",
        navigator,
      ).querySelector("a:first-child")!;

      // #when
      copy.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      const failure = copy.textContent;
      timeout.run();

      // #then
      expect({ failure, delay: timeout.delay, restored: copy.textContent }).toEqual({
        failure: "Copy failed",
        delay: 1500,
        restored: "Copy\u00a0RSS",
      });
    });
  });
});

describe("renderCopyOpml", () => {
  test("renders a single Copy OPML link to the library OPML", async () => {
    // #given
    const document = createUiWindow().document;
    const navigator = { clipboard: { writeText: async () => undefined } };
    const { renderCopyOpml } = await import(SUBSCRIBE_MODULE);

    // #when
    const control = renderCopyOpml(document, "https://opml.1218217.xyz/feed.opml", navigator);
    const anchors = control.querySelectorAll("a");

    // #then
    expect({
      tag: control.tagName,
      className: control.className,
      linkCount: anchors.length,
      copy: { text: anchors[0]?.textContent, href: anchors[0]?.getAttribute("href") },
    }).toEqual({
      tag: "SMALL",
      className: "subscribe",
      linkCount: 1,
      copy: { text: "Copy\u00a0OPML", href: "https://opml.1218217.xyz/feed.opml" },
    });
  });

  test("a plain click copies the OPML URL", async () => {
    await withStubbedTimeout(async () => {
      // #given
      const window = createUiWindow();
      let copied = "";

      const navigator = {
        clipboard: {
          writeText: async (value: string) => {
            copied = value;
          },
        },
      };

      const { renderCopyOpml } = await import(SUBSCRIBE_MODULE);

      const copy = renderCopyOpml(
        window.document,
        "https://opml.1218217.xyz/feed.opml",
        navigator,
      ).querySelector("a")!;

      // #when
      copy.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();

      // #then
      expect({ copied, label: copy.textContent }).toEqual({
        copied: "https://opml.1218217.xyz/feed.opml",
        label: "Copied!",
      });
    });
  });
});
