export class EpisodeWork {
  readonly _tag = "EpisodeWork";

  constructor(readonly relativePath: string) {}
}

export type OpmlEngineWork = EpisodeWork;

export function workKey(work: OpmlEngineWork): string {
  return `${work._tag}:${work.relativePath}`;
}
