const reserved = [
  "feed.xml",
  "feed.opml",
  "entry.xml",
  "_entry.xml",
  "cover.jpg",
  "events.jsonl",
  "errors.jsonl",
];

function cacheName(name) {
  return reserved.indexOf(name) !== -1 || name.slice(-4) === ".tmp" || name === "~"
    ? "~/" + name
    : name;
}

function encodeRelative(path) {
  return path.split("/").filter(Boolean).map(cacheName).join("/");
}

function decodeRelative(path) {
  const parts = path.split("/").filter(Boolean);
  const logical = [];

  for (let index = 0; index < parts.length; index++) {
    if (parts[index] === "~") {
      index++;

      if (index === parts.length) throw new Error("Incomplete private cache projection");
    }

    logical.push(parts[index]);
  }

  return logical.join("/");
}

function isContainer(path) {
  const parts = path.split("/").filter(Boolean);

  for (let index = 0; index < parts.length; index++) {
    if (parts[index] === "~" && ++index === parts.length) return true;
  }

  return false;
}

function cachePath(root, logical) {
  const suffix = encodeRelative(logical);

  return root.replace(/\/$/, "") + (suffix ? "/" + suffix : "");
}

function cacheUri(uri) {
  const parts = uri.split("/");
  const metadata = parts.pop();

  return "/" + encodeRelative(parts.join("/")) + (parts.some(Boolean) ? "/" : "") + metadata;
}

export default { decodeRelative, cachePath, cacheUri, isContainer };
