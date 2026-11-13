import { Schema } from "effect"

/** The values a harness command can name. Wake text never goes into arguments: it goes to stdin. */
export const placeholders = ["session", "subscription"] as const
export type Values = { readonly [K in typeof placeholders[number]]: string }

const token = /\{(\w+)\}/g

const isPlaceholder = (word: string): word is keyof Values => (placeholders as ReadonlyArray<string>).includes(word)

/** Why the command cannot serve as a harness command, or undefined when it can. */
export const problem = (command: ReadonlyArray<string>): string | undefined => {
  const [program, ...args] = command
  if (program === undefined || program.length === 0) return "the command needs a program"
  const inProgram = program.match(token)
  if (inProgram !== null) return `the program cannot hold a placeholder, found ${inProgram[0]}`
  for (const arg of args) {
    for (const [found, word] of arg.matchAll(token)) {
      if (!isPlaceholder(word!)) {
        return `unknown placeholder ${found}, use ${placeholders.map((name) => `{${name}}`).join(" or ")}`
      }
    }
  }
  return undefined
}

/**
 * A program and its arguments, run without a shell. Arguments may hold `{session}` and
 * `{subscription}`; the program holds none.
 */
export const Command = Schema.Array(Schema.String).check(
  Schema.makeFilter((command: ReadonlyArray<string>) => problem(command))
)
export type Command = readonly [program: string, ...args: Array<string>]

export const Definition = Schema.Struct({ command: Command })
export type Definition = typeof Definition.Type

/**
 * The command with each placeholder replaced by its value, in one pass per argument. A value is
 * never scanned again, so text in it that looks like a placeholder or a replacement pattern stays
 * as it is.
 */
export const substitute = (command: ReadonlyArray<string>, values: Values): Command => {
  const [program, ...args] = command
  return [
    program!,
    ...args.map((arg) => arg.replace(token, (found, word: string) => isPlaceholder(word) ? values[word] : found))
  ]
}
