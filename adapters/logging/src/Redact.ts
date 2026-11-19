import type { LogRecord } from "./Record.ts"

export const redacted = "[redacted]"

const sensitive = /TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE/i

/** Whether a key names something that must not be logged, such as apiToken or Cookie. */
export const isSensitiveKey = (key: string): boolean => sensitive.test(key)

const shortest = 4
const deepest = 16

/**
 * Replaces every occurrence of each secret of at least four characters. Matches are found in the
 * original text and merged first, so overlapping secrets leave no fragment.
 */
export const redactText = (text: string, secrets: ReadonlyArray<string>): string => {
  let hidden: Array<boolean> | undefined
  for (const secret of secrets) {
    if (secret.length < shortest) continue
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      hidden ??= new Array<boolean>(text.length).fill(false)
      hidden.fill(true, at, at + secret.length)
    }
  }
  if (hidden === undefined) return text
  let out = ""
  for (let i = 0; i < text.length; i++) {
    if (!hidden[i]) out += text[i]
    else if (i === 0 || !hidden[i - 1]) out += redacted
  }
  return out
}

/**
 * Walks objects and arrays: sensitive keys lose their value, and every string loses known secrets.
 * Errors keep their name and message, and objects with toJSON (such as dates) their JSON form.
 */
export const redactValue = (value: unknown, secrets: ReadonlyArray<string>, depth = 0): unknown => {
  if (typeof value === "string") return redactText(value, secrets)
  if (typeof value === "bigint") return redactText(value.toString(), secrets)
  if (value === null || typeof value !== "object") return value
  if (depth >= deepest) return redacted
  if (value instanceof Error) return redactValue({ name: value.name, message: value.message }, secrets, depth + 1)
  if ("toJSON" in value && typeof value.toJSON === "function") return redactValue(value.toJSON(), secrets, depth + 1)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[redactText(key, secrets)] = isSensitiveKey(key) ? redacted : redactValue(item, secrets, depth + 1)
  }
  return out
}

export const redactRecord = (record: LogRecord, secrets: ReadonlyArray<string>): LogRecord => ({
  ...record,
  msg: redactText(record.msg, secrets),
  ...(record.ann === undefined ? {} : { ann: redactValue(record.ann, secrets) as Record<string, unknown> }),
  ...(record.spans === undefined ? {} : {
    spans: Object.fromEntries(Object.entries(record.spans).map(([label, ms]) => [redactText(label, secrets), ms]))
  }),
  ...(record.cause === undefined ? {} : { cause: redactText(record.cause, secrets) })
})

const known = new Set<string>()

/** The process-wide set of secret values seen, so logs can hide them wherever they turn up. */
export const Secrets = {
  register: (values: Iterable<string>): void => {
    for (const value of values) if (value.length >= shortest) known.add(value)
  },
  values: (): ReadonlyArray<string> => [...known],
  clear: (): void => known.clear()
}
