/// <reference lib="dom" />
// Placeholder panel script until the real panel lands. In smoke mode it sends
// two lines through the relay and reports what came back.
import { Channel, invoke } from "@tauri-apps/api/core"

interface HostInfo {
  readonly smoke: boolean
  readonly platform: "macos" | "linux"
}

const longLine = "x".repeat(200_000)
const sent = `hello\n${longLine}\n`

const relayRoundTrip = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const decoder = new TextDecoder()
    let received = ""
    let connection = 0
    const events = new Channel<ArrayBuffer | { type: string; message?: string }>((message) => {
      if (message instanceof ArrayBuffer) {
        received += decoder.decode(message, { stream: true })
        if (received.length >= sent.length) {
          void invoke("relay_close", { connection })
          resolve(received)
        }
      } else {
        reject(new Error(`relay ${message.type}${message.message ? `: ${message.message}` : ""}`))
      }
    })
    invoke<number>("relay_open", { events })
      .then((id) => {
        connection = id
        return invoke("relay_write", new TextEncoder().encode(sent), {
          headers: { "exangelos-relay-connection": String(id) },
        })
      })
      .catch(reject)
  })

const main = async () => {
  const info = await invoke<HostInfo>("host_info")
  document.body.textContent = `Exangelos on ${info.platform}`
  if (!info.smoke) return
  try {
    const received = await relayRoundTrip()
    const ok = received === sent
    await invoke("host_smoke_report", {
      ok,
      report: `relay ${ok ? "ok" : "mismatch"}: sent ${sent.length} bytes, received ${received.length} bytes, first line ${JSON.stringify(received.split("\n")[0])}`,
    })
  } catch (error) {
    await invoke("host_smoke_report", { ok: false, report: `relay failed: ${String(error)}` })
  }
}

void main()
