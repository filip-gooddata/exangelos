import { packagingVersion, releaseTagMismatch } from "../release.ts"

const tag = process.argv[2]
if (tag === undefined || tag === "") {
  console.error("check-release-tag needs the tag name")
  process.exit(2)
}

const mismatch = releaseTagMismatch(tag, packagingVersion())
if (mismatch !== undefined) {
  console.error(mismatch)
  process.exit(1)
}
