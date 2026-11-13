declare const EXANGELOS_VERSION: string | undefined
declare const EXANGELOS_RELEASE_URL: string | undefined
declare const EXANGELOS_OFFICIAL_CONNECTORS: ReadonlyArray<{ name: string; version: string; digest: string }> | undefined

const version = typeof EXANGELOS_VERSION === "string" ? EXANGELOS_VERSION : "0.0.0-dev"
const officialConnectors = typeof EXANGELOS_OFFICIAL_CONNECTORS === "object" ? EXANGELOS_OFFICIAL_CONNECTORS : []
const name = (process.argv[1] ?? "exangelos").split("/").pop()

if (process.argv.includes("--version")) console.log(`exangelos ${version}`)
else if (process.argv.includes("--release-url")) console.log(typeof EXANGELOS_RELEASE_URL === "string" ? EXANGELOS_RELEASE_URL : "")
else if (process.argv.includes("--official-connectors")) console.log(JSON.stringify(officialConnectors))
else console.log(`${name}: stand-in entry`)
