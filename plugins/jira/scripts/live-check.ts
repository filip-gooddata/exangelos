/**
 * Read-only check of one issue against a real Jira Cloud site, outside the test suite.
 *
 *   JIRA_SITE=https://acme.atlassian.net JIRA_EMAIL=… JIRA_TOKEN_FILE=… bun scripts/live-check.ts PROJECT-123
 *
 * Sends GET requests only, for the one issue named, and writes nothing to disk. Prints statuses,
 * selected headers and response shapes (key names, value types and array lengths, never values).
 * Never prints the token, the email or an Authorization header. Exits 0 when every step but 6 (the
 * wrong token) succeeds, 1 when one of them fails, and 2 when the input is missing or unreadable.
 */
import { BunServices } from "@effect/platform-bun"
import { Config, Effect, FileSystem, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
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

const inputs = Effect.gen(function*() {
  const values = yield* Config.all(variables.map((name) => Config.String(name).pipe(Config.withDefault(""))))
  const [siteUrl, email, tokenFile] = values.map((value) => value.trim())
  const missing = variables.filter((_, index) => values[index]?.trim() === "")
  if (missing.length > 0) refuse(`Missing environment variable: ${missing.join(", ")}`)

  const key = (process.argv[2] ?? "").trim().toUpperCase()
  if (process.argv.length !== 3 || !/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(key)) {
    refuse("Give exactly one issue key, such as PROJECT-123, as the only argument.")
  }

  const fs = yield* FileSystem.FileSystem
  const token = yield* fs.readFileString(tokenFile ?? "").pipe(
    Effect.map((text) => text.trim()),
    Effect.catch((error) => Effect.sync(() => refuse(`Cannot read the file JIRA_TOKEN_FILE names (${error.reason._tag}).`)))
  )
  if (token === "") refuse("The file JIRA_TOKEN_FILE names is empty.")

  const site = yield* makeSite({ url: siteUrl ?? "", email: email ?? "", token: Redacted.make(token) }).pipe(
    Effect.catch((error) => Effect.sync(() => refuse(`JIRA_SITE is not usable: ${error.reason}`)))
  )
  return { key, site, email: email ?? "", token }
})

const { email, key, site, token } = await Effect.runPromise(
  inputs.pipe(Effect.catch((error) => Effect.sync(() => refuse(`Cannot read the environment (${error._tag}).`))), Effect.provide(BunServices.layer))
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

const shownHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      ["etag", "last-modified", "cache-control", "retry-after"].includes(name) || name.startsWith("x-ratelimit-")
    )
  )

const print = (label: string, lines: Record<string, unknown>) => {
  console.log(`\n== ${label}`)
  for (const [name, value] of Object.entries(lines)) {
    console.log(`${name}: ${redact(typeof value === "string" ? value : JSON.stringify(value, null, 2))}`)
  }
}

const http = await Effect.runPromise(
  Effect.gen(function*() {
    return yield* HttpClient.HttpClient
  }).pipe(Effect.provide(FetchHttpClient.layer))
)

const parse = (text: string): unknown => {
  try {
    return text === "" ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

type Got =
  | {
    readonly request: string
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly text: string
    readonly body: unknown
  }
  | { readonly request: string; readonly failure: string }

const get = (base: string, path: string, headers: Record<string, string> = { Authorization: authorization }) => {
  const request = `GET ${path}`
  return Effect.runPromise(
    http.execute(
      HttpClientRequest.get(`${base}${path}`).pipe(HttpClientRequest.setHeaders({ Accept: "application/json", ...headers }))
    ).pipe(
      Effect.flatMap((response) =>
        response.text.pipe(
          Effect.map((text): Got => ({ request, status: response.status, headers: response.headers, text, body: parse(text) }))
        )
      ),
      Effect.catch((error) => Effect.succeed<Got>({ request, failure: redact(error.message) }))
    )
  )
}

const ok = (got: Got) => "status" in got && got.status >= 200 && got.status < 300

const report = (label: string, got: Got, extra: (body: unknown) => Record<string, unknown> = () => ({})) => {
  if (!("status" in got)) return print(label, { request: got.request, failure: got.failure })
  print(label, {
    request: got.request,
    status: got.status,
    headers: shownHeaders(got.headers),
    shape: shape(got.body),
    ...extra(got.body)
  })
}

const field = (body: unknown, name: string): unknown =>
  typeof body === "object" && body !== null && name in body ? (body as Record<string, unknown>)[name] : undefined

const issuePath = `/rest/api/3/issue/${encodeURIComponent(key)}`
const results: Array<boolean> = []

const serverInfo = await get(site.url, "/rest/api/3/serverInfo")
report("1. serverInfo", serverInfo)
results.push(ok(serverInfo))

const statusOf = (got: Got) => "status" in got ? got.status : got.failure

/** The base that accepts the credential: /myself on the site URL, else through the gateway by cloud id. */
const resolveRoute = async () => {
  const direct = await get(site.url, "/rest/api/3/myself")
  const attempts: Record<string, unknown> = { "GET /rest/api/3/myself on the site": statusOf(direct) }
  if (ok(direct)) return { route: "site", base: site.url, attempts }
  if (!("status" in direct) || direct.status !== 401) return { route: "none", base: site.url, attempts }
  const tenant = await get(site.url, "/_edge/tenant_info", {})
  attempts["GET /_edge/tenant_info on the site, no credential"] = statusOf(tenant)
  const cloudId = field("body" in tenant ? tenant.body : undefined, "cloudId")
  if (typeof cloudId !== "string" || !/^[0-9a-zA-Z-]+$/.test(cloudId)) {
    attempts.cloudId = "absent"
    return { route: "none", base: site.url, attempts }
  }
  const base = `https://api.atlassian.com/ex/jira/${cloudId}`
  const gateway = await get(base, "/rest/api/3/myself")
  attempts["GET /rest/api/3/myself on the gateway"] = statusOf(gateway)
  return ok(gateway) ? { route: "gateway", base, attempts } : { route: "none", base: site.url, attempts }
}

const { attempts, base, route } = await resolveRoute()
print("2. route for the credential (/myself)", { ...attempts, route })
results.push(route !== "none")

const issue = await get(base, `${issuePath}?fields=summary`)
report("3. issue", issue)
results.push(ok(issue))

const changelog = await get(base, `${issuePath}/changelog?startAt=0&maxResults=100`)
report("4. changelog, first page", changelog, (body) => {
  const values = field(body, "values")
  const items = Array.isArray(values) ? values.flatMap((history) => field(history, "items") ?? []) : []
  return { histories: Array.isArray(values) ? values.length : 0, items: Array.isArray(items) ? items.length : 0 }
})
results.push(ok(changelog))

const comments = await get(base, `${issuePath}/comment?startAt=0&maxResults=100&orderBy=created`)
report("5. comments, first page", comments)
results.push(ok(comments))

const wrong = await get(base, `${issuePath}?fields=summary`, { Authorization: basic("not-a-valid-api-token") })
if ("status" in wrong) {
  print("6. issue with a wrong token", {
    request: wrong.request,
    status: wrong.status,
    headers: shownHeaders(wrong.headers),
    body: wrong.text
  })
} else {
  print("6. issue with a wrong token", { request: wrong.request, failure: wrong.failure })
}

if ("status" in issue) {
  const etag: string | undefined = issue.headers["etag"]
  const lastModified: string | undefined = issue.headers["last-modified"]
  const condition = etag !== undefined
    ? { "If-None-Match": etag }
    : lastModified !== undefined
    ? { "If-Modified-Since": lastModified }
    : undefined
  if (condition === undefined) {
    print("7. conditional issue request", { failure: "step 3 returned neither ETag nor Last-Modified, so no conditional request was possible" })
    results.push(false)
  } else {
    const again = await get(base, `${issuePath}?fields=summary`, { Authorization: authorization, ...condition })
    print("7. conditional issue request", {
      request: again.request,
      sent: Object.keys(condition)[0],
      ...("status" in again
        ? { status: again.status, answered304: again.status === 304, headers: shownHeaders(again.headers) }
        : { failure: again.failure })
    })
    results.push("status" in again && (again.status === 304 || ok(again)))
  }
} else {
  print("7. conditional issue request", { skipped: "step 3 failed" })
  results.push(false)
}

const pluginLabel = "8. plugin path: checkSite, readIssue from no position, baseline diff"
const pluginPath = Effect.gen(function*() {
  const client = yield* JiraClient
  const routed = yield* client.checkSite(site)
  const snapshot = yield* client.readIssue({ site: routed, key, position: undefined })
  const { cursor, events } = diffIssue({ siteUrl: routed.url, previous: undefined, snapshot })
  return {
    route: routed.api === routed.url ? "site" : "gateway",
    events: events.length,
    cursorKeys: Object.keys(cursor),
    changelog: { consumed: cursor.changelog.consumed, recentIds: cursor.changelog.recent.length, atLastIds: cursor.changelog.atLast.length },
    comments: { consumed: cursor.comments.consumed, recentIds: cursor.comments.recent.length, atLastIds: cursor.comments.atLast.length }
  }
}).pipe(Effect.provide(Layer.provide(layer, FetchHttpClient.layer)))

const plugin = await Effect.runPromise(Effect.result(pluginPath))
if (plugin._tag === "Success") {
  print(pluginLabel, plugin.success)
} else {
  print(pluginLabel, { failure: plugin.failure })
}
results.push(plugin._tag === "Success")

const passed = results.every(Boolean)
console.log(`\n${passed ? "PASS" : "FAIL"}: steps 1–5, 7 and 8 ${passed ? "succeeded" : "did not all succeed"}.`)
process.exit(passed ? 0 : 1)
