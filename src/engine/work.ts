export class EpisodeWork {
  readonly _tag = "EpisodeWork";

  constructor(readonly relativePath: string) {}
}

export class EpisodeDeleteWork {
  readonly _tag = "EpisodeDeleteWork";

  constructor(
    readonly relativePath: string,
    readonly suppressFolderSync = false,
  ) {}
}

export class FolderWork {
  readonly _tag = "FolderWork";

  constructor(readonly dataPath: string) {}
}

export class FolderDeleteWork {
  readonly _tag = "FolderDeleteWork";

  constructor(readonly relativePath: string) {}
}

export type OpmlEngineWork = EpisodeWork | EpisodeDeleteWork | FolderWork | FolderDeleteWork;

export function workKey(work: OpmlEngineWork): string {
  return `${work._tag}:${"relativePath" in work ? work.relativePath : work.dataPath}`;
}

export function failureKey(work: OpmlEngineWork): string {
  if (work._tag === "EpisodeWork" || work._tag === "EpisodeDeleteWork")
    return `Episode:${work.relativePath}`;

  return workKey(work);
}
