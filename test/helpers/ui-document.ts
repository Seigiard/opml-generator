import { Window } from "happy-dom";

const INDEX_HTML = await Bun.file(new URL("../../ui/app/index.html", import.meta.url)).text();

// Copies the shell body (the #app mount and its templates) without the module script
// and noscript fallback, so tests render exactly where the browser shell does.
export function createUiWindow(url?: string): Window {
  const window = url === undefined ? new Window() : new Window({ url });
  const shell = new window.DOMParser().parseFromString(INDEX_HTML, "text/html");

  for (const node of shell.body.children) {
    if (node.localName === "script" || node.localName === "noscript") continue;

    window.document.body.appendChild(window.document.importNode(node, true));
  }

  return window;
}
