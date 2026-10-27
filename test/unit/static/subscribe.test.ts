import { expect, test } from "bun:test";

class FakeDataset {
  href: string | undefined;
}

class FakeText {
  constructor(readonly text: string) {}
}

class FakeElement {
  className = "";
  dataset = new FakeDataset();
  href = "";
  textContent = "";
  replacement: FakeElement | undefined;
  readonly children: Array<FakeElement | FakeText> = [];

  addEventListener(): void {}

  appendChild(child: FakeElement | FakeText): void {
    this.children.push(child);
  }

  replaceWith(replacement: FakeElement): void {
    this.replacement = replacement;
  }
}

class FakeDocument {
  constructor(private readonly subscribeElement: FakeElement) {}

  createElement(): FakeElement {
    return new FakeElement();
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  querySelectorAll(): FakeElement[] {
    return [this.subscribeElement];
  }
}

function anchors(element: FakeElement): FakeElement[] {
  return element.children.filter((child): child is FakeElement => child instanceof FakeElement);
}

function anchorNamed(element: FakeElement, name: string): FakeElement {
  const anchor = anchors(element).find((link) => link.textContent === name);

  if (!anchor) throw new Error(`Missing ${name} anchor`);

  return anchor;
}

function separator(element: FakeElement): string {
  const text = element.children.find((child) => child instanceof FakeText);

  if (!(text instanceof FakeText)) throw new Error("Missing subscribe separator");

  return text.text;
}

async function renderSubscribeLinks(feedUrl: string): Promise<FakeElement> {
  const subscribeElement = new FakeElement();
  subscribeElement.dataset.href = feedUrl;
  const document = new FakeDocument(subscribeElement);
  const script = await Bun.file(new URL("../../../static/subscribe.js", import.meta.url)).text();
  const execute = new Function("document", "location", "navigator", script);

  execute(document, { href: "https://opml.1218217.xyz/" }, { clipboard: { writeText() {} } });

  if (!subscribeElement.replacement) throw new Error("Subscribe element was not replaced");

  return subscribeElement.replacement;
}

test("serializes the AntennaPod link without the HTTPS scheme", async () => {
  // #given
  const feedUrl =
    "https://opml.1218217.xyz/audiobooks/%D0%A7%D0%BE%D1%80%D1%82%D0%B8%2C%20%D0%94%D0%B6%D0%BE%20%D0%90%D0%B1%D0%B5%D1%80%D0%BA%D1%80%D0%BE%D0%BC%D0%B1%D1%96/feed.xml";

  // #when
  const links = await renderSubscribeLinks(feedUrl);
  const antennaPod = anchorNamed(links, "AntennaPod");

  // #then
  expect(new URL(antennaPod.href).href).toBe(
    "antennapod-subscribe://opml.1218217.xyz/audiobooks/%D0%A7%D0%BE%D1%80%D1%82%D0%B8%2C%20%D0%94%D0%B6%D0%BE%20%D0%90%D0%B1%D0%B5%D1%80%D0%BA%D1%80%D0%BE%D0%BC%D0%B1%D1%96/feed.xml",
  );
});

test("serializes the AntennaPod link without the HTTP scheme", async () => {
  // #given
  const feedUrl = "http://opml.1218217.xyz/audiobooks/feed.xml";

  // #when
  const links = await renderSubscribeLinks(feedUrl);
  const antennaPod = anchorNamed(links, "AntennaPod");

  // #then
  expect(new URL(antennaPod.href).href).toBe(
    "antennapod-subscribe://opml.1218217.xyz/audiobooks/feed.xml",
  );
});

test("replaces the subscribe element with the existing Copy RSS and AntennaPod links", async () => {
  // #given
  const feedUrl = "https://opml.1218217.xyz/audiobooks/feed.xml";

  // #when
  const links = await renderSubscribeLinks(feedUrl);

  // #then
  expect({
    className: links.className,
    copyRss: anchorNamed(links, "Copy RSS"),
    separator: separator(links),
    antennaPod: anchorNamed(links, "AntennaPod").textContent,
  }).toEqual({
    className: "subscribe",
    copyRss: expect.objectContaining({ href: "#", textContent: "Copy RSS" }),
    separator: " · ",
    antennaPod: "AntennaPod",
  });
});
