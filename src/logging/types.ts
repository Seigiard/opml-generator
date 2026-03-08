export type LogLevel = "debug" | "info" | "warn" | "error";

export type EventType =
  | "event_received"
  | "event_ignored"
  | "event_deduplicated"
  | "handler_start"
  | "handler_complete"
  | "handler_error"
  | "cascades_generated";

export interface LogContext {
  // Event context
  event_id?: string;
  event_tag?: string;
  event_type?: EventType;

  // Path context
  path?: string;
  parent?: string;
  name?: string;

  // Handler context
  handler?: string;
  duration_ms?: number;

  // Cascade context
  cascade_count?: number;
  cascade_tags?: string[];

  // Sync context
  audio_files_found?: number;
  audio_files_process?: number;
  audio_files_delete?: number;
  folders_count?: number;

  // Result context
  has_cover?: boolean;
  entries_count?: number;
  subfolders?: number;
  audio_files?: number;

  // Error context
  error?: string;
  error_stack?: string;

  // Misc
  file?: string;
  tool?: string;
  port?: number;
  body?: unknown;
  raw_event?: string;
}

export interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  tag: string;
  msg: string;
}
