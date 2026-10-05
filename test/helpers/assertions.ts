import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export function assertValidXml(xml: string): void {
  try {
    xmlParser.parse(xml);
  } catch (error) {
    throw new Error(`Invalid XML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertValidOpdsFeed(xml: string): void {
  assertValidXml(xml);

  const doc = xmlParser.parse(xml);
  const feed = doc.feed;

  if (!feed) {
    throw new Error("OPDS feed must have a <feed> root element");
  }

  if (!feed.id) {
    throw new Error("OPDS feed must have an <id> element");
  }

  if (!feed.title) {
    throw new Error("OPDS feed must have a <title> element");
  }

  if (!feed.updated) {
    throw new Error("OPDS feed must have an <updated> element");
  }

  if (!feed.link) {
    throw new Error("OPDS feed must have at least one <link> element");
  }
}

export function assertValidOpdsEntry(xml: string): void {
  assertValidXml(xml);

  const doc = xmlParser.parse(xml);
  const entry = doc.entry;

  if (!entry) {
    throw new Error("OPDS entry must have an <entry> root element");
  }

  if (!entry.id) {
    throw new Error("OPDS entry must have an <id> element");
  }

  if (!entry.title) {
    throw new Error("OPDS entry must have a <title> element");
  }

  if (!entry.updated) {
    throw new Error("OPDS entry must have an <updated> element");
  }
}

export function assertContainsElement(xml: string, elementName: string): void {
  if (!xml.includes(`<${elementName}`) && !xml.includes(`<${elementName}/`)) {
    throw new Error(`Expected XML to contain <${elementName}> element`);
  }
}

export function assertXmlAttribute(
  xml: string,
  element: string,
  attr: string,
  value: string,
): void {
  const regex = new RegExp(`<${element}[^>]*${attr}=["']${value}["']`);

  if (!regex.test(xml)) {
    throw new Error(`Expected <${element}> to have ${attr}="${value}"`);
  }
}
