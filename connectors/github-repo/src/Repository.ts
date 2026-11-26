export interface Repository {
  readonly owner: string
  readonly name: string
}

const shorthand = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?$/
const link = /^https?:\/\/[^/\s]+\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/

export const parse = (input: string): Repository | undefined => {
  const match = shorthand.exec(input.trim()) ?? link.exec(input.trim())
  return match === null ? undefined : { owner: match[1]!, name: match[2]! }
}

export const format = (repository: Repository): string => `${repository.owner}/${repository.name}`
