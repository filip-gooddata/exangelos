declare const EXANGELOS_VERSION: string | undefined

/** The version the build defines for the whole binary, the same value apps/cli reports. */
export const version: string = typeof EXANGELOS_VERSION === "string" ? EXANGELOS_VERSION : "0.0.0-dev"
