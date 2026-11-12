// @effect-diagnostics experimentalApiUsage:off
import { Glob, Result } from "effect"

/**
 * A path glob split into the directory to watch and a matcher for the files
 * below it. `glob` is the absolute pattern after `~` expansion.
 */
export interface FileGlob {
  readonly glob: string
  readonly base: string
  readonly depth: number
  readonly includes: (relative: string) => boolean
  readonly ignores: (relative: string) => boolean
}

const special = /[*?[{\\]/

const expandHome = (pattern: string, home: string) =>
  pattern === "~" ? home : pattern.startsWith("~/") ? `${home}${pattern.slice(1)}` : pattern

const segmentsOf = (path: string) => path.split("/").filter((segment) => segment !== "" && segment !== ".")

const unescape = (segment: string) => segment.replace(/\\(.)/g, "$1")

const balanced = (pattern: string) => {
  let braces = 0
  let inClass = false
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === "\\") index++
    else if (inClass) inClass = char !== "]"
    else if (char === "[") inClass = true
    else if (char === "{") braces++
    else if (char === "}" && braces > 0) braces--
  }
  return braces === 0 && !inClass
}

const ancestorsAndSelf =(relative: string) => {
  const segments = relative.split("/")
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"))
}

/**
 * Expands `~`, splits the leading literal segments off as the base directory
 * and compiles the rest. A pattern without wildcards watches its parent
 * directory for that one name. Wildcards skip dot files unless the pattern
 * names them.
 */
export const parse = (
  input: { readonly path: string; readonly ignore?: ReadonlyArray<string> | undefined },
  home: string
): Result.Result<FileGlob, string> => {
  const expanded = expandHome(input.path.trim(), home)
  if (expanded === "") return Result.fail("The path glob is empty")
  if (!expanded.startsWith("/")) return Result.fail(`The path glob must start with / or ~/, got ${input.path}`)
  if (segmentsOf(expanded).includes("..")) return Result.fail("The path glob must not contain ..")
  const unclosed = [expanded, ...(input.ignore ?? [])].find((pattern) => !balanced(pattern))
  if (unclosed !== undefined) return Result.fail(`The glob ${unclosed} has an unclosed [ or {`)
  const segments = segmentsOf(expanded)
  if (segments.length === 0) return Result.fail("The path glob must name something below /")
  const literal = segments.findIndex((segment) => special.test(segment))
  const split = literal === -1 ? segments.length - 1 : literal
  const base = `/${segments.slice(0, split).map(unescape).join("/")}`
  const rest = segments.slice(split)
  const pattern = Glob.make(rest.join("/"))
  const ignored = (input.ignore ?? [])
    .map((ignore) => expandHome(ignore.trim(), home))
    .filter((ignore) => ignore !== "")
    .flatMap((ignore) => {
      if (!ignore.startsWith("/")) return [ignore]
      const prefix = base === "/" ? "/" : `${base}/`
      return ignore.startsWith(prefix) ? [ignore.slice(prefix.length)] : []
    })
    .map((ignore) => Glob.make(ignore))
  return Result.succeed({
    glob: `/${segments.join("/")}`,
    base,
    depth: rest.some((segment) => segment.includes("**")) ? Number.POSITIVE_INFINITY : rest.length,
    includes: (relative) => Glob.match(pattern, relative),
    ignores: (relative) =>
      ignored.length > 0 &&
      ancestorsAndSelf(relative).some((path) => ignored.some((ignore) => Glob.match(ignore, path)))
  })
}

/** Whether `path` lies at or below `directory`; both absolute. */
export const relativeTo = (directory: string, path: string): string | undefined => {
  if (path === directory) return ""
  const prefix = directory === "/" ? "/" : `${directory}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

/** Shows `path` with the home directory written as `~`. */
export const display = (path: string, home: string) => {
  const relative = relativeTo(home, path)
  return relative === undefined ? path : relative === "" ? "~" : `~/${relative}`
}
