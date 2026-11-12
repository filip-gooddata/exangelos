/**
 * Read-only check of one issue against a real Jira Cloud site, outside the test suite.
 *
 *   JIRA_SITE=https://acme.atlassian.net JIRA_EMAIL=… JIRA_TOKEN_FILE=… bun scripts/live-check.ts PROJECT-123
 *
 * Sends GET requests only, for the one issue named, and writes nothing to disk. Prints statuses,
 * selected headers and response shapes (key names, value types and array lengths, never values).
 * Never prints the token, the email or an Authorization header. Exits 0 when steps 1–5 and 8
 * succeed, 1 when one of them fails, and 2 when the input is missing or unreadable.
 */
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { readFileSync } from "node:fs"
import { diffIssue } from "../src/Diff.ts"
import { JiraClient, layer } from "../src/JiraClient.ts"
import { makeSite } from "../src/Site.ts"

const usage = "Usage: JIRA_SITE=… JIRA_EMAIL=… JIRA_TOKEN_FILE=… bun scripts/live-check.ts PROJECT-123"

const refuse = (message: string): never => {
  console.error(message)
  console.error(usage)
  process.exit(2)
}

const variables = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN_FILE"] as const
const missing = variables.filter((name) => (process.env[name] ?? "").trim() === "")
if (missing.length > 0) refuse(`Missing environment variable: ${missing.join(", ")}`)

const key = (process.argv[2] ?? "").trim().toUpperCase()
if (process.argv.length !== 3 || !/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(key)) {
  refuse("Give exactly one issue key, such as PROJECT-123, as the only argument.")
}

const readToken = (): string => {
  try {
    return readFileSync(process.env.JIRA_TOKEN_FILE ?? "", "utf8").trim()
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown error"
    return refuse(`Cannot read the file JIRA_TOKEN_FILE names (${code}).`)
  }
}
const token = readToken()
if (token === "") refuse("The file JIRA_TOKEN_FILE names is empty.")

const email = (process.env.JIRA_EMAIL ?? "").trim()
const site = await Effect.runPromise(
  makeSite({ url: process.env.JIRA_SITE ?? "", email, token: Redacted.make(token) }).pipe(
    Effect.catch((error) => Effect.sync(() => refuse(`JIRA_SITE is not usable: ${error.reason}`)))
  )
)

const basic = (secret: string) => `Basic ${Buffer.from(`${email}:${secret}`).toString("base64")}`
const authorization = basic(token)
const secrets = [token, email, authorization, authorization.slice("Basic ".length)]

const redact = (text: string): string =>
  secrets.reduce((redacted, secret) => redacted.split(secret).join("[redacted]"), text)

const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length === 0 ? "array(0)" : [`array(${value.length})`, shape(value[0])]
  if (value === null) return "null"
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, shape(inner)]))
  }
  return typeof value
}

const shownHeaders = (headers: Headers) =>
  Object.fromEntries(
    [...headers.entries()].filter(([name]) =>
      ["etag", "last-modified", "cache-control", "retry-after"].includes(name) || name.startsWith("x-ratelimit-")
    )
  )

const print = (label: string, lines: Record<string, unknown>) => {
  console.log(`\n== ${label}`)
  for (const [name, value] of Object.entries(lines)) {
    console.log(`${name}: ${redact(typeof value === "string" ? value : JSON.stringify(value, null, 2))}`)
  }
}

const get = async (path: string, headers: Record<string, string> = {}) => {
  try {
    const response = await fetch(`${site.url}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: authorization, ...headers }
    })
    const text = await response.text()
    let body: unknown = undefined
    try {
      body = text === "" ? undefined : JSON.parse(text)
    } catch {
      body = undefined
    }
    return { response, text, body }
  } catch (error) {
    return { failure: redact(error instanceof Error ? error.message : String(error)) }
  }
}

type Got = Awaited<ReturnType<typeof get>>

const ok = (got: Got) => "response" in got && got.response.ok

const report = (label: string, got: Got, extra: (body: unknown) => Record<string, unknown> = () => ({})) => {
  if (!("response" in got)) return print(label, { failure: got.failure })
  print(label, {
    status: got.response.status,
    headers: shownHeaders(got.response.headers),
    shape: shape(got.body),
    ...extra(got.body)
  })
}

const field = (body: unknown, name: string): unknown =>
  typeof body === "object" && body !== null && name in body ? (body as Record<string, unknown>)[name] : undefined

const issuePath = `/rest/api/3/issue/${encodeURIComponent(key)}`
const results: Array<boolean> = []

const serverInfo = await get("/rest/api/3/serverInfo")
report("1. serverInfo", serverInfo, (body) => ({ deploymentType: field(body, "deploymentType") ?? "(absent)" }))
results.push(ok(serverInfo))

const myself = await get("/rest/api/3/myself")
print("2. myself", "response" in myself ? { status: myself.response.status } : { failure: myself.failure })
results.push(ok(myself))

const issue = await get(`${issuePath}?fields=summary`)
report("3. issue", issue)
results.push(ok(issue))

const changelog = await get(`${issuePath}/changelog?startAt=0&maxResults=100`)
report("4. changelog, first page", changelog, (body) => {
  const values = field(body, "values")
  const fieldIds = Array.isArray(values)
    ? [...new Set(values.flatMap((history) => {
      const items = field(history, "items")
      return Array.isArray(items) ? items.map((item) => String(field(item, "fieldId") ?? "(none)")) : []
    }))]
    : []
  return { fieldIds }
})
results.push(ok(changelog))

const comments = await get(`${issuePath}/comment?startAt=0&maxResults=100&orderBy=created`)
report("5. comments, first page", comments)
results.push(ok(comments))

const wrong = await get(`${issuePath}?fields=summary`, { Authorization: basic("not-a-valid-api-token") })
if ("response" in wrong) {
  print("6. issue with a wrong token", {
    status: wrong.response.status,
    headers: shownHeaders(wrong.response.headers),
    body: wrong.text
  })
} else {
  print("6. issue with a wrong token", { failure: wrong.failure })
}

if ("response" in issue) {
  const etag = issue.response.headers.get("etag")
  const lastModified = issue.response.headers.get("last-modified")
  const condition = etag !== null
    ? { "If-None-Match": etag }
    : lastModified !== null
    ? { "If-Modified-Since": lastModified }
    : undefined
  if (condition === undefined) {
    print("7. conditional issue request", { skipped: "step 3 returned neither ETag nor Last-Modified" })
  } else {
    const again = await get(`${issuePath}?fields=summary`, condition)
    print("7. conditional issue request", {
      sent: Object.keys(condition)[0],
      ...("response" in again
        ? { status: again.response.status, answered304: again.response.status === 304, headers: shownHeaders(again.response.headers) }
        : { failure: again.failure })
    })
  }
} else {
  print("7. conditional issue request", { skipped: "step 3 failed" })
}

const pluginPath = Effect.gen(function*() {
  const client = yield* JiraClient
  yield* client.checkSite(site)
  const snapshot = yield* client.readIssue({ site, key, position: undefined })
  const { cursor, events } = diffIssue({ siteUrl: site.url, previous: undefined, snapshot })
  return {
    events: events.length,
    cursorKeys: Object.keys(cursor),
    changelog: { consumed: cursor.changelog.consumed, recentIds: cursor.changelog.recent.length, atLastIds: cursor.changelog.atLast.length },
    comments: { consumed: cursor.comments.consumed, recentIds: cursor.comments.recent.length, atLastIds: cursor.comments.atLast.length }
  }
}).pipe(Effect.provide(Layer.provide(layer, FetchHttpClient.layer)))

const plugin = await Effect.runPromise(Effect.result(pluginPath))
if (plugin._tag === "Success") {
  print("8. plugin path: checkSite, readIssue from no position, baseline diff", plugin.success)
} else {
  print("8. plugin path: checkSite, readIssue from no position, baseline diff", { failure: plugin.failure })
}
results.push(plugin._tag === "Success")

const passed = results.every(Boolean)
console.log(`\n${passed ? "PASS" : "FAIL"}: steps 1–5 and 8 ${passed ? "succeeded" : "did not all succeed"}.`)
process.exit(passed ? 0 : 1)
