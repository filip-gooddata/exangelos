/**
 * Paths with file system notices still settling, by the time of their first
 * notice. A path settles once the window has passed since that first notice,
 * so any number of notices for it inside the window yield one observation.
 */
export type Pending = ReadonlyMap<string, number>

export const none: Pending = new Map()

export const notice = (pending: Pending, path: string, at: number): Pending =>
  pending.has(path) ? pending : new Map(pending).set(path, at)

/** Splits off the paths whose window has closed by `now`, in path order. */
export const settled = (pending: Pending, now: number, window: number) => {
  const due: Array<string> = []
  const waiting = new Map<string, number>()
  for (const [path, first] of pending) {
    if (now - first >= window) due.push(path)
    else waiting.set(path, first)
  }
  return { due: due.sort(), pending: waiting as Pending }
}

/** The first notice time still waiting, if any. */
export const earliest = (pending: Pending): number | undefined => {
  let first: number | undefined
  for (const at of pending.values()) if (first === undefined || at < first) first = at
  return first
}
