import { boot } from "./boot.ts";

function start(): void {
  void boot({ document, fetch, location, history, setTimeout });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
