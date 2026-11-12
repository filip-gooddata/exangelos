export interface PullRequestRef {
  readonly owner: string
  readonly repo: string
  readonly number: number
}

const shorthand = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)#([1-9][0-9]*)$/
const link = /^https?:\/\/[^/\s]+\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)\/?$/

/** Reads `owner/repo#number` or a pull request link. */
export const parse = (input: string): PullRequestRef | undefined => {
  const match = shorthand.exec(input.trim()) ?? link.exec(input.trim())
  if (match === null) return undefined
  const number = Number(match[3])
  if (!Number.isSafeInteger(number) || number > 2_147_483_647) return undefined
  return { owner: match[1]!, repo: match[2]!, number }
}

export const format = (ref: PullRequestRef): string => `${ref.owner}/${ref.repo}#${ref.number}`
