import { Result } from "effect"
import { Base64 } from "effect/encoding"
import type { Connector } from "@exangelos/domain"

/** The largest logo the daemon relays from a connector, in decoded bytes. */
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
 * Checks a logo a connector served against its media type: a PNG must start with the PNG signature, an SVG
 * must be UTF-8 text whose root element is `<svg>`, and neither may exceed `maxIconBytes`. Fails with the reason.
 */
export const checkIcon = (icon: Connector.Icon): Result.Result<Connector.Icon, string> => {
  if (icon.data.length > Math.ceil(maxIconBytes / 3) * 4) return Result.fail(`its icon is over the ${maxIconBytes} byte limit`)
  const decoded = Base64.decode(icon.data)
  if (Result.isFailure(decoded)) return Result.fail("its icon is not base64")
  const bytes = decoded.success
  if (bytes.byteLength > maxIconBytes) return Result.fail(`its icon is ${bytes.byteLength} bytes, over the ${maxIconBytes} byte limit`)
  if (icon.mediaType === "image/png") {
    return pngSignature.every((byte, index) => bytes[index] === byte) ? Result.succeed(icon) : Result.fail("its icon is not a PNG image")
  }
  return isSvg(bytes) ? Result.succeed(icon) : Result.fail("its icon is not an SVG image")
}
