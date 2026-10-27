interface PodcastListEntry {
  title: string;
  xmlUrl: string;
  author?: string;
  description?: string;
  imageUrl?: string;
}

export interface PodcastList {
  title: string;
  podcasts: PodcastListEntry[];
}

interface PodcastEpisode {
  title: string;
  enclosureUrl: string;
  duration?: number;
  episodeNumber: number;
}

export interface Podcast {
  title: string;
  author?: string;
  description?: string;
  imageUrl?: string;
  episodes: PodcastEpisode[];
}

export function parseOpml(text: string): PodcastList {
  const document = parseXml(text);
  const opml = document.documentElement;
  const head = opml ? childNamed(opml, "head") : undefined;
  const body = opml ? childNamed(opml, "body") : undefined;
  const outlines = body ? childrenNamed(body, "outline") : [];

  return {
    title: head ? (textOf(childNamed(head, "title")) ?? "") : "",
    podcasts: outlines.map((outline) => ({
      title: outline.getAttribute("title") ?? outline.getAttribute("text") ?? "",
      xmlUrl: outline.getAttribute("xmlUrl") ?? "",
      ...optionalAttribute(outline, "author"),
      ...optionalAttribute(outline, "description"),
      ...optionalAttribute(outline, "imageUrl"),
    })),
  };
}

export function parseRss(text: string): Podcast {
  const document = parseXml(text);

  const channel = document.documentElement
    ? childNamed(document.documentElement, "channel")
    : undefined;

  if (!channel) return { title: "", episodes: [] };

  return {
    title: textOf(childNamed(channel, "title")) ?? "",
    ...optionalChildText(channel, "author"),
    ...optionalChildText(channel, "description"),
    ...optionalImage(channel),
    episodes: childrenNamed(channel, "item").map((item) => {
      const durationText = textOf(childNamed(item, "duration"));
      const episodeText = textOf(childNamed(item, "episode"));

      const episode: PodcastEpisode = {
        title: textOf(childNamed(item, "title")) ?? "",
        enclosureUrl: childNamed(item, "enclosure")?.getAttribute("url") ?? "",
        episodeNumber: Number.parseInt(episodeText ?? "0", 10),
      };

      if (durationText !== undefined) episode.duration = Number.parseInt(durationText, 10);

      return episode;
    }),
  };
}

function parseXml(text: string): XMLDocument {
  return new DOMParser().parseFromString(text, "application/xml");
}

function childrenNamed(element: Element, name: string): Element[] {
  return Array.from(element.children).filter((child) => localName(child) === name);
}

function childNamed(element: Element, name: string): Element | undefined {
  return childrenNamed(element, name)[0];
}

function localName(element: Element): string {
  return element.localName ?? element.tagName.split(":").at(-1) ?? element.tagName;
}

function textOf(element: Element | undefined): string | undefined {
  return element?.textContent?.trim();
}

function optionalAttribute(element: Element, name: string): Record<string, string> {
  const value = element.getAttribute(name);

  return value === null ? {} : { [name]: value };
}

function optionalChildText(element: Element, name: string): Record<string, string> {
  const child = childNamed(element, name);
  const value = textOf(child);

  return child && value !== undefined ? { [name]: value } : {};
}

function optionalImage(channel: Element): Record<string, string> {
  const image = childNamed(channel, "image");
  const value = image?.getAttribute("href");

  return value === null || value === undefined ? {} : { imageUrl: value };
}
