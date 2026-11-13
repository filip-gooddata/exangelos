import { Effect } from "effect"
import type { Redacted } from "effect"
import { UnsupportedSite } from "./JiraError.ts"

/**
 * Where requests go and the credential they carry. `url` is the site's https origin without a
 * trailing slash; browse links always use it. `api` is the base REST paths go to: the site itself
 * for a classic API token, or the Atlassian gateway for a scoped one (see `JiraClient.resolveRoute`).
 */
export interface JiraSite {
  readonly url: string
  readonly api: string
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
  const origin = `https://${authority.toLowerCase()}`
  return Effect.succeed({ url: origin, api: origin, email: input.email, token: input.token })
}

export const browseLink = (siteUrl: string, issueKey: string): string =>
  `${siteUrl}/browse/${encodeURIComponent(issueKey)}`

/** The Atlassian gateway base that serves a scoped API token for the site with this cloud id. */
export const gatewayApi = (cloudId: string): string => `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}`
