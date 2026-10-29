import { boot } from "./boot.ts";

function start(): void {
  // SAFETY: `connection` is the optional Network Information API extension to Navigator.
  const { connection } = navigator as Navigator & { connection?: { saveData?: boolean } };

  void boot({ document, fetch, location, history, setTimeout, saveData: connection?.saveData });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
