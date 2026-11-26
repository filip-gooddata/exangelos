/** Ref name to the commit it points at; an annotated tag is peeled to its commit. */
export type Refs = Readonly<Record<string, string>>

export interface Release {
  readonly id: string
  readonly tag: string
  readonly name: string | null
  readonly prerelease: boolean
  readonly draft: boolean
  readonly publishedAt: string | null
  readonly url: string
}

export interface Run {
  readonly id: number
  readonly attempt: number
  readonly runNumber: number
  readonly name: string
  readonly conclusion: string | null
  readonly branch: string | null
  readonly sha: string
  readonly event: string
  readonly url: string
  readonly updatedAt: string
}

/** What one poll saw. A part the subscription does not ask for is `null`; a workflow whose list did not change is `null`. */
export interface Snapshot {
  readonly tags: Refs | null
  readonly branches: Refs | null
  readonly releases: ReadonlyArray<Release> | null
  readonly workflows: Readonly<Record<string, ReadonlyArray<Run> | null>>
}
