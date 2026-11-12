import { describe, expect, it } from "@effect/vitest"
import { renderPlist, renderSystemdUnit } from "@exangelos/service-manager"
import { awkward } from "./support.ts"

describe("rendering", () => {
  it("renders a LaunchAgent plist with every string XML-escaped", () => {
    expect(renderPlist(awkward)).toBe(
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
        `<plist version="1.0">`,
        `<dict>`,
        `  <key>Label</key>`,
        `  <string>exangelos.daemon</string>`,
        `  <key>ProgramArguments</key>`,
        `  <array>`,
        `    <string>/opt/My Apps/xng</string>`,
        `    <string>say &quot;hi&quot; &amp; 50% $HOME</string>`,
        `  </array>`,
        `  <key>EnvironmentVariables</key>`,
        `  <dict>`,
        `    <key>GREETING</key>`,
        `    <string>a &quot;b&quot; &amp; c 10% $X</string>`,
        `  </dict>`,
        `  <key>RunAtLoad</key>`,
        `  <true/>`,
        `  <key>KeepAlive</key>`,
        `  <dict>`,
        `    <key>SuccessfulExit</key>`,
        `    <false/>`,
        `  </dict>`,
        `  <key>StandardOutPath</key>`,
        `  <string>/tmp/x y/out.log</string>`,
        `  <key>StandardErrorPath</key>`,
        `  <string>/tmp/x y/err.log</string>`,
        `</dict>`,
        `</plist>`,
        ``
      ].join("\n")
    )
  })

  it("renders a systemd unit with quoted command words and escaped specifiers", () => {
    expect(renderSystemdUnit(awkward)).toBe(
      [
        `[Unit]`,
        `Description=Exangelos & "friends" 100%%`,
        ``,
        `[Service]`,
        `Type=exec`,
        `ExecStart="/opt/My Apps/xng" "say \\"hi\\" & 50%% $$HOME"`,
        `Environment="GREETING=a \\"b\\" & c 10%% $X"`,
        `Restart=on-failure`,
        `StandardOutput=append:/tmp/x y/out.log`,
        `StandardError=append:/tmp/x y/err.log`,
        ``,
        `[Install]`,
        `WantedBy=default.target`,
        ``
      ].join("\n")
    )
  })
})
