export class EpisodeWork {
  readonly _tag = "EpisodeWork";

  constructor(readonly relativePath: string) {}
}

export class EpisodeDeleteWork {
  readonly _tag = "EpisodeDeleteWork";

  constructor(readonly relativePath: string) {}
}

export class FolderWork {
  readonly _tag = "FolderWork";

  constructor(readonly dataPath: string) {}
}

export class FolderDeleteWork {
  readonly _tag = "FolderDeleteWork";

  constructor(readonly relativePath: string) {}
}

export class OpmlWork {
  readonly _tag = "OpmlWork";

  constructor(readonly dataPath: string) {}
}

export type OpmlEngineWork =
  | EpisodeWork
  | EpisodeDeleteWork
  | FolderWork
  | FolderDeleteWork
  | OpmlWork;

export function workKey(work: OpmlEngineWork): string {
  if (work._tag === "OpmlWork") return "OpmlWork";

  return `${work._tag}:${"relativePath" in work ? work.relativePath : work.dataPath}`;
}
