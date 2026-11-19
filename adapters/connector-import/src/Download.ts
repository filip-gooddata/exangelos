import * as Fs from "node:fs/promises"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { limits, Refused } from "./Entries.ts"

const redirects = new Set([301, 302, 303, 307, 308])
const maxRedirects = 5

const httpsUrl = (raw: string, base?: string) => {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    throw new Refused({ reason: base === undefined ? "the link is not a URL" : "the link redirects to an address that is not a URL" })
  }
  if (url.protocol !== "https:") throw new Refused({ reason: `only https links are accepted, not ${url.protocol}` })
  return url
}

const refuse = (reason: string) => Effect.fail(new Refused({ reason: reason }))

/**
 * Downloads an https link into a new file, following up to five redirects that stay on https. Fails
 * when the server answers other than 200 or the body passes the download limit. Expects a client
 * that does not follow redirects itself, so it can check each hop.
 */
export const download = (link: string, file: string) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    let url = yield* Effect.try({ try: () => httpsUrl(link), catch: (error) => error as Refused })
    for (let hop = 0;; hop++) {
      const response = yield* client.get(url).pipe(
        Effect.mapError((error) => new Refused({ reason: `the download from ${url.host} failed: ${error.message}` }))
      )
      const location = response.headers["location"]
      if (redirects.has(response.status) && location !== undefined) {
        if (hop === maxRedirects) return yield* refuse(`the link redirects more than ${maxRedirects} times`)
        const from = url
        url = yield* Effect.try({ try: () => httpsUrl(location, from.href), catch: (error) => error as Refused })
        continue
      }
      if (response.status === 404) return yield* refuse(`${url.href} was not found`)
      if (response.status !== 200) return yield* refuse(`${url.host} answered ${response.status}`)
      const declared = Number(response.headers["content-length"] ?? "0")
      if (declared > limits.downloadBytes) return yield* refuse(`the download is larger than ${limits.downloadBytes} bytes`)

      const handle = yield* Effect.acquireRelease(
        Effect.promise(() => Fs.open(file, "wx")),
        (handle) => Effect.promise(() => handle.close())
      )
      let received = 0
      yield* response.stream.pipe(
        Stream.mapError((error) => new Refused({ reason: `the download from ${url.host} failed: ${error.message}` })),
        Stream.runForEach((chunk) => {
          received += chunk.length
          return received > limits.downloadBytes
            ? refuse(`the download is larger than ${limits.downloadBytes} bytes`)
            : Effect.promise(() => handle.write(chunk))
        })
      )
      return
    }
  }).pipe(Effect.scoped)

/** The fetch client for `download`: redirects come back to it instead of being followed. */
export const layerFetchHttpClient = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }))
)
