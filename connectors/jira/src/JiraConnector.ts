import { Effect, Option, Redacted, Ref, Stream } from "effect"
import { Catalogue, Connector } from "@exangelos/connector-sdk"
import * as Events from "./Events.ts"
import { GitHub } from "./GitHub.ts"
import type { GitHubError } from "./GitHub.ts"
import { JiraClient } from "./JiraClient.ts"
import { missingScopeReason } from "./JiraError.ts"
import type { JiraError } from "./JiraError.ts"
import { normaliseOptions, parseOptions } from "./Options.ts"
import { makeSite } from "./Site.ts"
import type { JiraSite } from "./Site.ts"
import { label, normalise, Parameters, parseTarget, subject } from "./Target.ts"
import { watch } from "./Watch.ts"

const parameters = Catalogue.parameters({ main: "target", schema: Parameters })

const configuration = [
  Catalogue.text("site", { label: "Jira Cloud site URL, such as https://acme.atlassian.net", secretDestination: true }),
  Catalogue.text("email", { label: "Atlassian account email" }),
  Catalogue.secret("token", { label: "API token" }),
  Catalogue.secret("githubToken", {
    label: "GitHub token that can read the repositories in githubRepo (only for GitHub signals)",
    required: false
  })
]

interface Configured {
  readonly site: JiraSite
  readonly githubToken: Redacted.Redacted<string> | undefined
}

const githubRefusal = (repo: string, error: GitHubError): string => {
  switch (error._tag) {
    case "GitHubRejected":
      return `GitHub rejected githubToken (HTTP ${error.status}). Configure the jira connector with a token that can read ${repo}.`
    case "GitHubNotFound":
      return `GitHub has no ${repo}, or that commit, or githubToken cannot read it.`
    case "GitHubRateLimited":
      return "GitHub is rate limiting githubToken. Try again later."
    case "GitHubFailure":
      return `Could not check ${repo} with GitHub: ${error.reason}`
  }
}

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

export const connector = Connector.make({
  events: Events.all,
  parameters,
  configuration,
  handlers: Effect.gen(function*() {
    const client = yield* JiraClient
    const github = yield* GitHub
    const configured = yield* Ref.make(Option.none<Configured>())
    return {
      configure: (values) =>
        makeSite({ url: values.site ?? "", email: values.email ?? "", token: Redacted.make(values.token ?? "") }).pipe(
          Effect.mapError(({ reason }) => new Connector.ConfigurationRejected({ reason })),
          Effect.flatMap((site) =>
            client.checkSite(site).pipe(
              Effect.mapError((error) => new Connector.ConfigurationRejected({ reason: refusal(site, error) })),
              Effect.flatMap((routed) =>
                Ref.set(
                  configured,
                  Option.some({
                    site: routed,
                    githubToken: values.githubToken === undefined || values.githubToken === ""
                      ? undefined
                      : Redacted.make(values.githubToken)
                  })
                )
              )
            )
          )
        ),
      describe: (input) =>
        Effect.gen(function*() {
          const target = yield* parseTarget(input).pipe(
            Effect.mapError(({ reason }) => new Connector.ParametersInvalid({ reason }))
          )
          const options = yield* parseOptions(input, target).pipe(
            Effect.mapError(({ reason }) => new Connector.ParametersInvalid({ reason }))
          )
          const current = Option.getOrUndefined(yield* Ref.get(configured))
          const site = current?.site
          const signals = options.github
          if (signals !== undefined && current !== undefined) {
            const token = current.githubToken
            if (token === undefined) {
              return yield* new Connector.ParametersInvalid({
                reason: "githubRepo needs a GitHub token: configure the jira connector with githubToken."
              })
            }
            yield* github.checkRepository(token, signals.repo).pipe(
              Effect.andThen(signals.sha === undefined ? Effect.void : github.checkCommit(token, signals.repo, signals.sha)),
              Effect.mapError((error) => new Connector.ParametersInvalid({ reason: githubRefusal(signals.repo, error) }))
            )
          }
          if (target.kind === "jql" && site !== undefined) {
            const invalid = (error: JiraError) =>
              new Connector.ParametersInvalid({
                reason: error._tag === "HttpFailure" && error.status === 400
                  ? "Jira refused the JQL query. Check its syntax and the fields it names."
                  : `Could not check the JQL query with Jira. ${refusal(site, error)}`
              })
            yield* client.checkJql({ site, jql: target.jql }).pipe(
              // A 401 through the gateway names a missing scope only once the same gateway accepts the token again.
              Effect.catchTag("CredentialRejected", (rejected) =>
                site.api === site.url || rejected.status !== 401
                  ? Effect.fail(invalid(rejected))
                  : client.resolveRoute(site).pipe(
                    Effect.matchEffect({
                      onFailure: (error) =>
                        Effect.fail(
                          new Connector.ParametersInvalid({
                            reason: `Could not check the JQL query with Jira. ${refusal(site, error)}`
                          })
                        ),
                      onSuccess: (route) =>
                        Effect.fail(
                          new Connector.ParametersInvalid({
                            reason: route.api === site.api
                              ? missingScopeReason(rejected.status)
                              : "Could not check the JQL query with Jira: the token now takes a different route than at configure. Configure the jira connector again."
                          })
                        )
                    })
                  )),
              Effect.mapError((error) => error instanceof Connector.ParametersInvalid ? error : invalid(error))
            )
          }
          return {
            subject: subject(target),
            label: label(target),
            parameters: { ...normalise(target), ...normaliseOptions(input, options) }
          }
        }),
      watch: ({ cursor, parameters: input }) =>
        Stream.unwrap(Effect.gen(function*() {
          const { githubToken, site } = yield* Ref.get(configured).pipe(
            Effect.flatMap(Effect.fromOption),
            Effect.mapError(() => new Connector.CredentialsRejected({ reason: "The Jira connector is not configured" }))
          )
          const target = yield* parseTarget(input).pipe(
            Effect.mapError(({ reason }) => new Connector.SourceFailed({ reason }))
          )
          const options = yield* parseOptions(input, target).pipe(
            Effect.mapError(({ reason }) => new Connector.SourceFailed({ reason }))
          )
          return watch({ client, github, site, target, options, githubToken, cursor })
        }))
    }
  })
})
