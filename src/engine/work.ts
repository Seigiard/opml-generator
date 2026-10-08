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

export type OpmlEngineWork = EpisodeWork | EpisodeDeleteWork | FolderWork;

export function workKey(work: OpmlEngineWork): string {
  return `${work._tag}:${"relativePath" in work ? work.relativePath : work.dataPath}`;
}
