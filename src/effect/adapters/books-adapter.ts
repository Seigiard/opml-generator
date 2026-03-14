import { log } from "../../logging/index.ts";
import { AUDIO_EXTENSIONS } from "../../types.ts";
import type { RawBooksEvent, EventType } from "../types.ts";
import type { DeduplicationService } from "../../context.ts";

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
  const { parent, name } = raw;

  switch (event) {
    case "CREATE":
      if (isDir) return { _tag: "FolderCreated", parent, name };
      return { _tag: "Ignored" };
    case "CLOSE_WRITE":
      return isValidAudioExtension(name) ? { _tag: "AudioFileCreated", parent, name } : { _tag: "Ignored" };
    case "DELETE":
      if (isDir) return { _tag: "FolderDeleted", parent, name };
      return isValidAudioExtension(name) ? { _tag: "AudioFileDeleted", parent, name } : { _tag: "Ignored" };
    case "MOVED_FROM":
      if (isDir) return { _tag: "FolderDeleted", parent, name };
      return isValidAudioExtension(name) ? { _tag: "AudioFileDeleted", parent, name } : { _tag: "Ignored" };
    case "MOVED_TO":
      if (isDir) return { _tag: "FolderCreated", parent, name };
      return isValidAudioExtension(name) ? { _tag: "AudioFileCreated", parent, name } : { _tag: "Ignored" };
    default:
      return { _tag: "Ignored" };
  }
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

export function adaptBooksEvent(raw: RawBooksEvent, dedup: DeduplicationService): EventType | null {
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
  const shouldProcess = dedup.shouldProcess(key);

  if (!shouldProcess) {
    log.debug("Adapter", "Event deduplicated", {
      event_type: "event_deduplicated",
      event_id: eventId,
      event_tag: eventType._tag,
      path,
    });
  }

  return shouldProcess ? eventType : null;
}
