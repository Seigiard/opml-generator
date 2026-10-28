import { feedUrlFor, normalizePath } from "./routes.ts";

// The part of the Navigation API the shell uses, so tests can drive it.
export type ShellNavigateEvent = Pick<
  NavigateEvent,
  | "canIntercept"
  | "hashChange"
  | "downloadRequest"
  | "formData"
  | "navigationType"
  | "destination"
  | "signal"
  | "intercept"
  | "scroll"
>;

export interface ShellNavigation {
  addEventListener(type: "navigate", listener: (event: ShellNavigateEvent) => void): void;
}

// Returns the shell page path a navigation can render in place, or null when
// the browser should load the destination itself: feeds, audio, other origins,
// reloads, and slash-less paths that the initial load normalizes.
export function shellPathFor(event: ShellNavigateEvent, origin: string): string | null {
  if (
    !event.canIntercept ||
    event.hashChange ||
    event.downloadRequest !== null ||
    event.formData !== null ||
    event.navigationType === "reload"
  ) {
    return null;
  }

  const url = new URL(event.destination.url);

  if (url.origin !== origin) return null;

  if (normalizePath(url.pathname) !== null || feedUrlFor(url.pathname) === null) return null;

  return url.pathname;
}
