import { Schema } from "effect"

/** Jira answered 401: the email or API token is wrong or revoked. */
export class CredentialRejected extends Schema.TaggedError<CredentialRejected>()("CredentialRejected", {
  status: Schema.Finite
}) {}

/** Jira answered 404: the issue does not exist or the credential cannot see it. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  path: Schema.String
}) {}

/** Jira answered 429. `retryAfterSeconds` comes from the Retry-After header when it holds seconds. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfterSeconds: Schema.optionalKey(Schema.Finite)
}) {}

/** The site is not a Jira Cloud site reachable over https. */
export class UnsupportedSite extends Schema.TaggedError<UnsupportedSite>()("UnsupportedSite", {
  reason: Schema.String
}) {}

/** Any other HTTP status, or no response at all. */
export class HttpFailure extends Schema.TaggedError<HttpFailure>()("HttpFailure", {
  status: Schema.optionalKey(Schema.Finite),
  reason: Schema.String
}) {}

/** A response body did not have the documented shape. */
export class DecodeFailure extends Schema.TaggedError<DecodeFailure>()("DecodeFailure", {
  reason: Schema.String
}) {}

/** A JQL query matches more issues than the cursor may hold; the subscription should end with this reason. */
export class JqlResultTooLarge extends Schema.TaggedError<JqlResultTooLarge>()("JqlResultTooLarge", {
  limit: Schema.Finite
}) {}

export type JiraError =
  | CredentialRejected
  | NotFound
  | RateLimited
  | UnsupportedSite
  | HttpFailure
  | DecodeFailure
  | JqlResultTooLarge

/** A cursor string that is not one this plugin wrote for the same target. */
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {
  reason: Schema.String
}) {}
