import { binaryArchiveName, type ChecksumLine, findTarget } from "./release-files.ts"

export interface HomebrewRelease {
  readonly version: string
  readonly baseUrl: string
  readonly checksums: ReadonlyArray<ChecksumLine>
}

const description = "Daemon with which agents subscribe to events from external sources"

const sha256Of = (release: HomebrewRelease, file: string): string => {
  const line = release.checksums.find((entry) => entry.file === file)
  if (line === undefined) throw new Error(`SHA256SUMS has no line for ${file}`)
  return line.sha256
}

const binaryResource = (release: HomebrewRelease, platform: string, indent: string): string => {
  const file = binaryArchiveName(release.version, findTarget(platform))
  return `${indent}url "${release.baseUrl}/${file}"\n${indent}sha256 "${sha256Of(release, file)}"\n`
}

export const renderFormula = (release: HomebrewRelease): string => `class Exangelos < Formula
  desc "${description}"
  homepage "${release.baseUrl}"
  version "${release.version}"

  on_macos do
    on_arm do
${binaryResource(release, "darwin-arm64", "      ")}    end
    on_intel do
${binaryResource(release, "darwin-x64", "      ")}    end
  end

  on_linux do
    on_arm do
${binaryResource(release, "linux-arm64", "      ")}    end
    on_intel do
${binaryResource(release, "linux-x64", "      ")}    end
  end

  def install
    bin.install "exangelos"
    bin.install_symlink "exangelos" => "xng"
  end

  service do
    name macos: "exangelos.daemon", linux: "exangelos.daemon"
    run [opt_bin/"exangelos", "daemon"]
    keep_alive true
    environment_variables PATH: std_service_path_env
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/exangelos --version")
  end
end
`

// The tray stream's Tauri bundle is assumed to be named Exangelos.app, with the
// sidecar at Contents/MacOS/exangelos and a disk image named the Tauri way.
export const trayImageName = (version: string, arch: "aarch64" | "x64"): string => `Exangelos_${version}_${arch}.dmg`

export const renderCask = (release: HomebrewRelease): string => {
  const arm = release.checksums.find((line) => line.file === trayImageName(release.version, "aarch64"))
  const intel = release.checksums.find((line) => line.file === trayImageName(release.version, "x64"))
  const sha256 =
    arm !== undefined && intel !== undefined ? `sha256 arm:   "${arm.sha256}",\n         intel: "${intel.sha256}"` : "sha256 :no_check"
  return `cask "exangelos-app" do
  arch arm: "aarch64", intel: "x64"

  version "${release.version}"
  ${sha256}

  url "${release.baseUrl}/Exangelos_#{version}_#{arch}.dmg"
  name "Exangelos"
  desc "${description}"
  homepage "${release.baseUrl}"

  conflicts_with formula: "exangelos"

  app "Exangelos.app"
  binary "#{appdir}/Exangelos.app/Contents/MacOS/exangelos"
  binary "#{appdir}/Exangelos.app/Contents/MacOS/exangelos", target: "xng"
end
`
}
