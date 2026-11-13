declare const EXANGELOS_VERSION: string | undefined
declare const EXANGELOS_RELEASE_URL: string | undefined
declare const EXANGELOS_OFFICIAL_PLUGINS: ReadonlyArray<{ name: string; version: string; digest: string }> | undefined

const version = typeof EXANGELOS_VERSION === "string" ? EXANGELOS_VERSION : "0.0.0-dev"
const officialPlugins = typeof EXANGELOS_OFFICIAL_PLUGINS === "object" ? EXANGELOS_OFFICIAL_PLUGINS : []
const name = (process.argv[1] ?? "exangelos").split("/").pop()

if (process.argv.includes("--version")) console.log(`exangelos ${version}`)
else if (process.argv.includes("--release-url")) console.log(typeof EXANGELOS_RELEASE_URL === "string" ? EXANGELOS_RELEASE_URL : "")
else if (process.argv.includes("--official-plugins")) console.log(JSON.stringify(officialPlugins))
else console.log(`${name}: stand-in entry`)
