export interface SubscribeNavigator {
  clipboard: {
    writeText(value: string): Promise<void>;
  };
}

export function renderSubscribe(
  document: Document,
  feedUrl: string,
  navigator: SubscribeNavigator,
): HTMLElement {
  const small = document.createElement("small");
  small.className = "subscribe";

  const copy = document.createElement("a");
  copy.href = "#";
  copy.textContent = "Copy\u00a0RSS";
  copy.addEventListener("click", (event) => {
    event.preventDefault();
    navigator.clipboard
      .writeText(feedUrl)
      .then(() => {
        copy.textContent = "Copied!";
        setTimeout(() => {
          copy.textContent = "Copy\u00a0RSS";
        }, 1500);
      })
      .catch(() => undefined);
  });
  small.appendChild(copy);

  small.appendChild(document.createTextNode(" · "));

  const antennaPod = document.createElement("a");
  antennaPod.href = `antennapod-subscribe://${feedUrl.replace(/^https?:\/\//, "")}`;
  antennaPod.textContent = "AntennaPod";
  small.appendChild(antennaPod);

  return small;
}
