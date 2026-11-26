/**
 * A ref name pattern: `*` stands for any run of characters, `/` included, and `?` for one character. Anything else
 * matches itself.
 */
export interface Glob {
  readonly source: string
  readonly regex: RegExp
  /** The literal text before the first wildcard, which GitHub can narrow the ref list by. */
  readonly prefix: string
}

const special = /[.+^${}()|[\]\\]/g

export const compile = (source: string): Glob => {
  const body = source.replace(special, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
  const wildcard = source.search(/[*?]/)
  return { source, regex: new RegExp(`^${body}$`), prefix: wildcard === -1 ? source : source.slice(0, wildcard) }
}

export const matchesAny = (globs: ReadonlyArray<Glob>, name: string) => globs.some((glob) => glob.regex.test(name))
