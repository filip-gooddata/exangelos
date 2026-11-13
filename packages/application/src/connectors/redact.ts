/**
 * Replaces every occurrence of each secret in `text` with `[secret]`. Matches are found in the
 * original text and merged before anything is replaced, so overlapping secrets leave no fragment.
 */
export const redact = (text: string, secrets: ReadonlyArray<string>): string => {
  const hidden = new Array<boolean>(text.length).fill(false)
  for (const secret of secrets) {
    if (secret === "") continue
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      hidden.fill(true, at, at + secret.length)
    }
  }
  let out = ""
  for (let i = 0; i < text.length; i++) {
    if (!hidden[i]) out += text[i]
    else if (i === 0 || !hidden[i - 1]) out += "[secret]"
  }
  return out
}
