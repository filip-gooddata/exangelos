import { keys, type LogRecord } from "./Record.ts"

export const redacted = "[redacted]"

const sensitive = /TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE/i

/** Whether a key names something that must not be logged, such as apiToken or Cookie. */
export const isSensitiveKey = (key: string): boolean => sensitive.test(key)

const shortest = 4
const deepest = 16

const word = /\w/

const standsAlone = (text: string, at: number, length: number) =>
  !word.test(text.charAt(at - 1)) && !word.test(text.charAt(at + length))

/**
 * Replaces every occurrence of each secret of at least four characters, and each shorter secret
 * where it stands as a whole word. Matches are found in the original text and merged first, so
 * overlapping secrets leave no fragment.
 */
export const redactText = (text: string, secrets: ReadonlyArray<string>): string => {
  let hidden: Array<boolean> | undefined
  for (const secret of secrets) {
    if (secret.length === 0) continue
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      if (secret.length < shortest && !standsAlone(text, at, secret.length)) continue
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

const reserved: ReadonlySet<string> = new Set(keys)

/** Like redactValue, but the daemon's own annotation keys stay as they are, so readers still find them. */
export const redactAnnotations = (ann: Record<string, unknown>, secrets: ReadonlyArray<string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(ann)) {
    out[reserved.has(key) ? key : redactText(key, secrets)] = isSensitiveKey(key) ? redacted : redactValue(item, secrets, 1)
  }
  return out
}

export const redactRecord = (record: LogRecord, secrets: ReadonlyArray<string>): LogRecord => ({
  ...record,
  msg: redactText(record.msg, secrets),
  ...(record.ann === undefined ? {} : { ann: redactAnnotations(record.ann, secrets) }),
  ...(record.spans === undefined ? {} : {
    spans: Object.fromEntries(Object.entries(record.spans).map(([label, ms]) => [redactText(label, secrets), ms]))
  }),
  ...(record.cause === undefined ? {} : { cause: redactText(record.cause, secrets) })
})

const address = /[a-z][\w+.-]*:\/\/[^\s"'<>]+/gi
const sensitiveWord = /token|key|secret|passw|auth|cookie|bearer|\bbasic\b|session|credential|signature|sig=/i

/** An address without credentials, query or fragment, and without a path that names a secret. */
export const plainAddress = (text: string): string => {
  try {
    const url = new URL(text)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    if (sensitiveWord.test(decodeURIComponent(url.pathname))) url.pathname = `/${redacted}`
    return url.toString()
  } catch {
    return redacted
  }
}

/** Failure text fit for a log: known secrets hidden, and every address inside reduced to its plain form. */
export const sanitise = (text: string): string => redactText(text, Secrets.values()).replace(address, plainAddress)

const deepestCause = 4

const shown = (value: unknown): string => {
  if (typeof value === "string") return sanitise(value)
  try {
    return sanitise(JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}

/** A failure's tag and fields, then whatever caused it, with secrets and address extras removed. */
export const describeFailure = (error: unknown, depth = 0): string => {
  if (typeof error !== "object" || error === null) return shown(error)
  const fields = Object.entries(error)
    .filter(([key]) => key !== "_tag" && key !== "cause" && key !== "stack")
    .map(([key, value]) => `${key}: ${isSensitiveKey(key) ? redacted : shown(value)}`)
  if (error instanceof Error && error.message !== "" && !Object.keys(error).includes("message")) {
    fields.unshift(`message: ${sanitise(error.message)}`)
  }
  const name = "_tag" in error ? String(error._tag) : error instanceof Error ? error.name : "object"
  const head = fields.length === 0 ? name : `${name}: ${fields.join(", ")}`
  const cause = (error as { readonly cause?: unknown }).cause
  return cause === undefined || depth >= deepestCause ? head : `${head}\ncaused by ${describeFailure(cause, depth + 1)}`
}

const known = new Set<string>()

/** The process-wide set of secret values seen, so logs can hide them wherever they turn up. */
export const Secrets = {
  register: (values: Iterable<string>): void => {
    for (const value of values) if (value.length > 0) known.add(value)
  },
  /** Values of variables whose names look sensitive; short ones are flags rather than credentials. */
  registerEnvironment: (env: Readonly<Record<string, string | undefined>>): void => {
    for (const [name, value] of Object.entries(env)) {
      if (value !== undefined && value.length >= shortest && isSensitiveKey(name)) known.add(value)
    }
  },
  values: (): ReadonlyArray<string> => [...known],
  clear: (): void => known.clear()
}
