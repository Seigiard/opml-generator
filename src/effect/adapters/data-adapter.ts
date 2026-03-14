import { log } from "../../logging/index.ts";
import type { RawDataEvent, EventType } from "../types.ts";
import type { DeduplicationService } from "../../context.ts";
import { ENTRY_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";

function classifyDataEvent(raw: RawDataEvent): EventType {
  if (raw.name === ENTRY_FILE) {
    return { _tag: "EntryXmlChanged", parent: raw.parent };
  }
  if (raw.name === FOLDER_ENTRY_FILE) {
    return { _tag: "FolderEntryXmlChanged", parent: raw.parent };
  }
  return { _tag: "Ignored" };
}

function getEventKey(event: EventType): string {
  switch (event._tag) {
    case "EntryXmlChanged":
    case "FolderEntryXmlChanged":
      return `${event._tag}:${event.parent}`;
    case "Ignored":
      return "Ignored";
    default:
      return `${event._tag}:unknown`;
  }
}

export function adaptDataEvent(raw: RawDataEvent, dedup: DeduplicationService): EventType | null {
  const eventType = classifyDataEvent(raw);
  const path = `${raw.parent}/${raw.name}`;
  const eventId = `raw:data:${path}:${Date.now()}`;

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
