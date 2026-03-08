import { Effect, Match } from "effect";
import { log } from "../../logging/index.ts";
import { AUDIO_EXTENSIONS } from "../../types.ts";
import type { RawBooksEvent, EventType } from "../types.ts";
import { DeduplicationService } from "../services.ts";

function parseEvents(events: string): { event: string; isDir: boolean } {
  const parts = events.split(",");
  const isDir = parts.includes("ISDIR");
  const event = parts.find((p) => p !== "ISDIR") ?? "";
  return { event, isDir };
}

function isValidAudioExtension(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

function classifyBooksEvent(raw: RawBooksEvent): EventType {
  const { event, isDir } = parseEvents(raw.events);

  return Match.value({ event, isDir, name: raw.name, parent: raw.parent }).pipe(
    Match.when({ event: "CREATE", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderCreated" as const,
      parent,
      name,
    })),

    Match.when({ event: "CREATE", isDir: false }, () => ({
      _tag: "Ignored" as const,
    })),

    Match.when({ event: "CLOSE_WRITE" }, ({ parent, name }) =>
      isValidAudioExtension(name)
        ? { _tag: "AudioFileCreated" as const, parent, name }
        : { _tag: "Ignored" as const },
    ),

    Match.when({ event: "DELETE", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderDeleted" as const,
      parent,
      name,
    })),

    Match.when({ event: "DELETE", isDir: false }, ({ parent, name }) =>
      isValidAudioExtension(name)
        ? { _tag: "AudioFileDeleted" as const, parent, name }
        : { _tag: "Ignored" as const },
    ),

    Match.when({ event: "MOVED_FROM", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderDeleted" as const,
      parent,
      name,
    })),

    Match.when({ event: "MOVED_FROM", isDir: false }, ({ parent, name }) =>
      isValidAudioExtension(name)
        ? { _tag: "AudioFileDeleted" as const, parent, name }
        : { _tag: "Ignored" as const },
    ),

    Match.when({ event: "MOVED_TO", isDir: true }, ({ parent, name }) => ({
      _tag: "FolderCreated" as const,
      parent,
      name,
    })),

    Match.when({ event: "MOVED_TO", isDir: false }, ({ parent, name }) =>
      isValidAudioExtension(name)
        ? { _tag: "AudioFileCreated" as const, parent, name }
        : { _tag: "Ignored" as const },
    ),

    Match.orElse(() => ({ _tag: "Ignored" as const })),
  );
}

function getEventKey(event: EventType): string {
  switch (event._tag) {
    case "AudioFileCreated":
    case "AudioFileDeleted":
    case "FolderCreated":
    case "FolderDeleted":
      return `${event._tag}:${event.parent}:${event.name}`;
    case "Ignored":
      return "Ignored";
    default:
      return `${event._tag}:unknown`;
  }
}

export const adaptBooksEvent = (raw: RawBooksEvent) =>
  Effect.gen(function* () {
    const dedup = yield* DeduplicationService;

    const eventType = classifyBooksEvent(raw);
    const path = `${raw.parent}/${raw.name}`;
    const eventId = `raw:books:${path}:${Date.now()}`;

    if (eventType._tag === "Ignored") {
      log.debug("Adapter", "Event ignored", {
        event_type: "event_ignored",
        event_id: eventId,
        event_tag: "Ignored",
        path,
      });
      return null;
    }

    const key = getEventKey(eventType);
    const shouldProcess = yield* dedup.shouldProcess(key);

    if (!shouldProcess) {
      log.debug("Adapter", "Event deduplicated", {
        event_type: "event_deduplicated",
        event_id: eventId,
        event_tag: eventType._tag,
        path,
      });
    }

    return shouldProcess ? eventType : null;
  });
