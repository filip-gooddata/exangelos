import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { Effect, Result } from "effect"
import type { Connector } from "@exangelos/domain"

/** The largest icon file the daemon serves. */
export const maxIconBytes = 32 * 1024

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const prolog = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i

const isSvg = (bytes: Uint8Array) => {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return false
  }
  return /^<svg[\s/>]/.test(text.replace(prolog, ""))
}

/**
 * Checks icon bytes against the icon's file name: an `.svg` must be UTF-8 text whose root element is
 * `<svg>`, a `.png` must start with the PNG signature, and neither may exceed `maxIconBytes`.
 */
export const checkIcon = (relative: string, bytes: Uint8Array): Result.Result<Connector.Icon, string> => {
  const extension = Path.extname(relative).toLowerCase()
  if (extension !== ".svg" && extension !== ".png") return Result.fail(`the icon ${relative} is not an .svg or .png`)
  if (bytes.byteLength > maxIconBytes) {
    return Result.fail(`the icon ${relative} is ${bytes.byteLength} bytes, over the ${maxIconBytes} byte limit`)
  }
  if (extension === ".png") {
    return pngSignature.every((byte, index) => bytes[index] === byte)
      ? Result.succeed({ mediaType: "image/png", data: Buffer.from(bytes).toString("base64") })
      : Result.fail(`the icon ${relative} is not a PNG image`)
  }
  return isSvg(bytes)
    ? Result.succeed({ mediaType: "image/svg+xml", data: Buffer.from(bytes).toString("base64") })
    : Result.fail(`the icon ${relative} is not an SVG image`)
}

/**
 * Reads the manifest icon of the connector in `directory`, which must be an absolute, resolved path. The icon
 * must be a regular file inside the directory after links are resolved. Fails with the reason it is refused.
 */
export const readIcon = (directory: string, relative: string): Effect.Effect<Connector.Icon, string> =>
  Effect.gen(function*() {
    const path = Path.resolve(directory, relative)
    if (!path.startsWith(directory + Path.sep)) return yield* Effect.fail(`the icon ${relative} is outside the connector`)
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const [real, realDirectory] = await Promise.all([Fs.realpath(path), Fs.realpath(directory)])
        if (!real.startsWith(realDirectory + Path.sep)) return `the icon ${relative} leads outside the connector`
        const stat = await Fs.stat(real)
        if (!stat.isFile()) return `the icon ${relative} is not a file`
        if (stat.size > maxIconBytes) return `the icon ${relative} is ${stat.size} bytes, over the ${maxIconBytes} byte limit`
        return new Uint8Array(await Fs.readFile(real))
      },
      catch: () => `the icon ${relative} does not exist`
    })
    if (typeof bytes === "string") return yield* Effect.fail(bytes)
    return yield* Effect.fromResult(checkIcon(relative, bytes))
  })
