export interface RawBooksEvent {
  parent: string;
  name: string;
  events: string;
}

export interface RawDataEvent {
  parent: string;
  name: string;
  events: string;
}

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
