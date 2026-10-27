import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const SUBSCRIBE_MODULE = "../../../ui/app/subscribe.ts";

describe("renderSubscribe", () => {
  test("renders the existing Copy RSS and AntennaPod control", async () => {
    // #given
    const document = new Window().document;
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
      copy: { text: "Copy RSS", href: "#" },
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
    const document = new Window().document;
    const navigator = { clipboard: { writeText: async () => undefined } };
    const { renderSubscribe } = await import(SUBSCRIBE_MODULE);

    // #when
    const control = renderSubscribe(document, feedUrl, navigator);

    // #then
    expect(control.querySelector("a:last-child")?.getAttribute("href")).toBe(expected);
  });

  test("copies the feed URL, shows confirmation, and restores the label after 1500 ms", async () => {
    // #given
    const window = new Window();
    const document = window.document;
    const feedUrl = "https://opml.1218217.xyz/audiobooks/feed.xml";
    let copied = "";
    let delay: number | undefined;
    let scheduled: (() => void) | undefined;

    const navigator = {
      clipboard: {
        writeText: async (value: string) => {
          copied = value;
        },
      },
    };

    const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      writable: true,
      value: (callback: () => void, timeout?: number) => {
        scheduled = callback;
        delay = timeout;

        return 1;
      },
    });

    try {
      const { renderSubscribe } = await import(SUBSCRIBE_MODULE);
      const control = renderSubscribe(document, feedUrl, navigator);
      const copy = control.querySelector("a:first-child")!;

      // #when
      copy.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      const confirmation = copy.textContent;
      scheduled?.();

      // #then
      expect({ copied, confirmation, delay, restored: copy.textContent }).toEqual({
        copied: feedUrl,
        confirmation: "Copied!",
        delay: 1500,
        restored: "Copy RSS",
      });
    } finally {
      if (originalSetTimeout) {
        Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
      } else {
        Reflect.deleteProperty(globalThis, "setTimeout");
      }
    }
  });
});
