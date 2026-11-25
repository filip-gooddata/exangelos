/** GitHub names an app `name` in some places and `name[bot]` in others. */
const bare = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "")

export const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && bare(a) === bare(b)
