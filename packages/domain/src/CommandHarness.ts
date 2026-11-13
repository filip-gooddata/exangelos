import { Schema } from "effect"

export const placeholders = ["session", "subscription"] as const
export type Values = { readonly [K in typeof placeholders[number]]: string }

const token = /\{(\w+)\}/g

const isPlaceholder = (word: string): word is keyof Values => (placeholders as ReadonlyArray<string>).includes(word)

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

export const Command = Schema.Array(Schema.String).check(
  Schema.makeFilter((command: ReadonlyArray<string>) => problem(command))
)
export type Command = readonly [program: string, ...args: Array<string>]

export const Definition = Schema.Struct({ command: Command })
export type Definition = typeof Definition.Type

export const substitute = (command: ReadonlyArray<string>, values: Values): Command => {
  const [program, ...args] = command
  return [
    program!,
    ...args.map((arg) => arg.replace(token, (found, word: string) => isPlaceholder(word) ? values[word] : found))
  ]
}
