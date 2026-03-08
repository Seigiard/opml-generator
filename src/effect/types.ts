import { Schema } from "@effect/schema";

// Raw event from books watcher (events string parsed in adapter)
export const RawBooksEvent = Schema.Struct({
  parent: Schema.String,
  name: Schema.String,
  events: Schema.String, // "CREATE,ISDIR" or "CLOSE_WRITE"
});

export type RawBooksEvent = typeof RawBooksEvent.Type;

// Raw event from data watcher
export const RawDataEvent = Schema.Struct({
  parent: Schema.String,
  name: Schema.String,
  events: Schema.String, // "CLOSE_WRITE" or "MOVED_TO"
});

export type RawDataEvent = typeof RawDataEvent.Type;

// Classified event types for handlers
export type EventType =
  | { _tag: "AudioFileCreated"; parent: string; name: string }
  | { _tag: "AudioFileDeleted"; parent: string; name: string }
  | { _tag: "FolderCreated"; parent: string; name: string }
  | { _tag: "FolderDeleted"; parent: string; name: string }
  | { _tag: "EntryXmlChanged"; parent: string }
  | { _tag: "FolderEntryXmlChanged"; parent: string }
  | { _tag: "FolderMetaSyncRequested"; path: string }
  | { _tag: "FeedXmlCreated"; path: string }
  | { _tag: "FeedXmlDeleted"; path: string }
  | { _tag: "Ignored" };
