import { Effect } from "effect"
import type { Redacted } from "effect"
import { UnsupportedSite } from "./JiraError.ts"

/** Where requests go and the credential they carry. `url` is an https origin without a trailing slash. */
export interface JiraSite {
  readonly url: string
  readonly email: string
  readonly token: Redacted.Redacted<string>
}

/** Checks that the site URL is https, since the token is sent there, and keeps only its origin. */
export const makeSite = (input: {
  readonly url: string
  readonly email: string
  readonly token: Redacted.Redacted<string>
}): Effect.Effect<JiraSite, UnsupportedSite> => {
  const url = input.url.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  if (scheme === null) {
    return Effect.fail(new UnsupportedSite({ reason: "The site URL is not a valid URL." }))
  }
  if (scheme[1]?.toLowerCase() !== "https") {
    return Effect.fail(new UnsupportedSite({ reason: "The site URL must use https." }))
  }
  const authority = url.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? ""
  if (authority.includes("@")) {
    return Effect.fail(new UnsupportedSite({ reason: "The site URL must not contain a user name or password." }))
  }
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(authority)) {
    return Effect.fail(new UnsupportedSite({ reason: "The site URL has no valid host." }))
  }
  return Effect.succeed({ url: `https://${authority.toLowerCase()}`, email: input.email, token: input.token })
}

export const browseLink = (siteUrl: string, issueKey: string): string =>
  `${siteUrl}/browse/${encodeURIComponent(issueKey)}`
