/**
 * Claude Code has no wake route in v1, so a wake for a standalone Claude Code session fails
 * without starting a process. `claude --bg --resume` on a session that is running starts a paid
 * copy of it rather than reaching the conversation the person sees. A Claude session inside T3 Code
 * has a T3 thread id and goes through the T3 adapter instead.
 */
export const noRoute = (subscription: string): string =>
  `Claude Code has no route into a running session; run \`exangelos wait ${subscription}\` in the session`
