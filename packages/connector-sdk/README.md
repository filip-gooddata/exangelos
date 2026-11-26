# Connector SDK

`Connector.make` turns a catalogue and handlers into a connector, `Connector.serve` serves it over stdio, and `ConnectorTest.makeClient` drives it in memory. The `template` connector shows a complete one.

## Waiting for a subject

When the subject is not readable yet, such as a conversation not yet in a local cache, stream `Connector.pending(reason, cursor)` instead of failing. The daemon keeps the cursor and shows `Waiting: <reason>` without an event, a wake or a failure; repeating the same item changes nothing, and the next `Connector.cursor` or event clears it. Keep secrets out of the reason anyway; the daemon also scrubs configured secrets and cuts it to 300 characters. To give up, end the stream with `Connector.end(reason)`: the subscribing session gets one ended wake with that reason.

The Watch request's `createdAt` is when the subscription was created, the same on every call including after a daemon restart, so it can serve as the cutoff for a subject that appears later. A daemon before Pending sends neither `createdAt` nor `acceptsPending`; the SDK then hands it each Pending item as a plain Cursor.

```ts
watch: ({ parameters, cursor, createdAt }) =>
  Stream.unwrap(Effect.map(cache.find(parameters.thread), (found) =>
    found === undefined
      ? Stream.make(Connector.pending("Not in the local cache yet", cursor ?? ""))
      : replies(found, cursor, createdAt)))
```

## Icon

The daemon asks a running connector for its logo and relays what it serves to the panel. By default the SDK serves the file the manifest `icon` names, as the template's `"icon": "icon.svg"` does, with no code. That file must stay inside the connector folder after links are resolved. Serve at most 32 KiB (`Connector.maxIconBytes`) of PNG or SVG; the daemon refuses anything else.

To find the logo at run time instead, give the handlers an `icon` hook:

```ts
readonly icon?: Effect.Effect<Connector.Icon | undefined, unknown, R>

interface Icon {
  readonly mediaType: "image/png" | "image/svg+xml"
  readonly bytes: Uint8Array
}
```

The daemon asks once each time the process starts, right after the handshake and while Configure may still run, so the hook must not depend on the configuration. Return `undefined` for no logo. A failure is logged to stderr and serves none, and the panel shows the connector's initials. `Connector.iconFile(path)` reads an `.svg` or `.png` of at most 32 KiB from anywhere; `Connector.manifestIcon` is the default.

For example, to serve the icon of an app installed on macOS, falling back to the manifest icon when the app is missing:

```ts
import { execFile } from "node:child_process"
import * as Os from "node:os"
import * as Path from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { Connector } from "@exangelos/connector-sdk"

const appIcon = (app: string) =>
  Effect.gen(function*() {
    const resources = Path.join(app, "Contents", "Resources")
    const plist = Path.join(app, "Contents", "Info.plist")
    const name = yield* Effect.tryPromise(() =>
      promisify(execFile)("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", plist])
    )
    const icns = Path.join(resources, Path.extname(name.stdout.trim()) ? name.stdout.trim() : `${name.stdout.trim()}.icns`)
    const png = Path.join(Os.tmpdir(), `${Path.basename(app, ".app")}-icon.png`)
    yield* Effect.tryPromise(() =>
      promisify(execFile)("/usr/bin/sips", ["-s", "format", "png", "-Z", "64", icns, "--out", png])
    )
    return yield* Connector.iconFile(png)
  }).pipe(Effect.orElse(() => Connector.manifestIcon))

// In Connector.make({ ..., handlers: Effect.succeed({ configure, describe, watch, icon: appIcon("/Applications/Example.app") }) })
```

Keep the PNG small: at 64 px most app icons fit well under 32 KiB.
