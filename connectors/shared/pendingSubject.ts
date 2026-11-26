// Only contiguous successful observations in this Watch instance earn credit.
// A new instance deliberately forgets its previous wall-clock sample.
export const observationBudget = 2 * 60 * 60 * 1000

export const observedMillis = (elapsed: number, previous: number | undefined, now: number, poll: number) => {
  const gap = previous === undefined ? 0 : now - previous
  const maximum = Math.min(poll + 5000, 60000)
  return elapsed + (gap > 0 && gap <= maximum ? Math.min(gap, poll) : 0)
}

export const waitingCursor = (scope: string, elapsed: number, ledger: string) =>
  `waiting:${scope}:${elapsed}:${ledger}`

export const resumeWaiting = (scope: string, cursor: string | undefined) => {
  const match = cursor?.match(/^waiting:([a-f0-9]{64}):(0|[1-9][0-9]{0,6}):(4:[a-f0-9]{32}:[a-f0-9]{32})$/)
  return match && match[1] === scope && Number(match[2]) < observationBudget
    ? { elapsed: Number(match[2]), ledger: match[3]! }
    : undefined
}
