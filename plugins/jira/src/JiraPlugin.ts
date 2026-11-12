import { Effect, Option, Redacted, Ref, Stream } from "effect"
import { Catalogue, Plugin } from "@exangelos/plugin-sdk"
import * as Events from "./Events.ts"
import { JiraClient } from "./JiraClient.ts"
import type { JiraError } from "./JiraError.ts"
import { makeSite } from "./Site.ts"
import type { JiraSite } from "./Site.ts"
import { label, normalise, Parameters, parseTarget, subject } from "./Target.ts"
import { watch } from "./Watch.ts"

const parameters = Catalogue.parameters({ main: "target", schema: Parameters })

const configuration = [
  Catalogue.text("site", { label: "Jira Cloud site URL, such as https://acme.atlassian.net", secretDestination: true }),
  Catalogue.text("email", { label: "Atlassian account email" }),
  Catalogue.secret("token", { label: "API token" })
]

const refusal = (site: JiraSite, error: JiraError): string => {
  switch (error._tag) {
    case "CredentialRejected":
      return `Jira rejected the email and API token (HTTP ${error.status}). Check both, and that the token is not revoked.`
    case "UnsupportedSite":
      return error.reason
    case "NotFound":
      return `${site.url} does not answer as a Jira Cloud site.`
    case "RateLimited":
      return "Jira is rate limiting this account. Try again later."
    case "HttpFailure":
      return `Could not check ${site.url}: ${error.status === undefined ? "" : `HTTP ${error.status}, `}${error.reason}`
    case "DecodeFailure":
      return `${site.url} answered in a shape Jira Cloud does not use: ${error.reason}`
    case "JqlResultTooLarge":
      return `Unexpected answer from ${site.url}.`
  }
}

export const plugin = Plugin.make({
  events: Events.all,
  parameters,
  configuration,
  handlers: Effect.gen(function*() {
    const client = yield* JiraClient
    const configured = yield* Ref.make(Option.none<JiraSite>())
    return {
      configure: (values) =>
        makeSite({ url: values.site ?? "", email: values.email ?? "", token: Redacted.make(values.token ?? "") }).pipe(
          Effect.mapError(({ reason }) => new Plugin.ConfigurationRejected({ reason })),
          Effect.flatMap((site) =>
            client.checkSite(site).pipe(
              Effect.mapError((error) => new Plugin.ConfigurationRejected({ reason: refusal(site, error) })),
              Effect.flatMap((routed) => Ref.set(configured, Option.some(routed)))
            )
          )
        ),
      describe: (input) =>
        Effect.gen(function*() {
          const target = yield* parseTarget(input).pipe(
            Effect.mapError(({ reason }) => new Plugin.ParametersInvalid({ reason }))
          )
          const site = Option.getOrUndefined(yield* Ref.get(configured))
          if (target.kind === "jql" && site !== undefined) {
            yield* client.checkJql({ site, jql: target.jql }).pipe(
              Effect.mapError((error) =>
                new Plugin.ParametersInvalid({
                  reason: error._tag === "HttpFailure" && error.status === 400
                    ? "Jira refused the JQL query. Check its syntax and the fields it names."
                    : `Could not check the JQL query with Jira. ${refusal(site, error)}`
                })
              )
            )
          }
          return { subject: subject(target), label: label(target), parameters: normalise(target) }
        }),
      watch: ({ cursor, parameters: input }) =>
        Stream.unwrap(Effect.gen(function*() {
          const site = yield* Ref.get(configured).pipe(
            Effect.flatMap(Effect.fromOption),
            Effect.mapError(() => new Plugin.CredentialsRejected({ reason: "The Jira plugin is not configured" }))
          )
          const target = yield* parseTarget(input).pipe(
            Effect.mapError(({ reason }) => new Plugin.SourceFailed({ reason }))
          )
          return watch({ client, site, target, cursor })
        }))
    }
  })
})
