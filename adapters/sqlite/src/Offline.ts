import * as fs from "node:fs"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { Connector } from "@exangelos/domain"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(Connector.Connector)))

/**
 * The stored connectors, for when the daemon is not running. Opens the database read-only, so it
 * runs no migrations and holds no lock once it returns; none when there is no database yet.
 */
export const connectors = (filename: string): ReadonlyArray<Connector.Connector> => {
  if (!fs.existsSync(filename)) return []
  const db = new Database(filename, { readonly: true })
  try {
    return db.query<{ record: string }, []>("SELECT record FROM connectors ORDER BY name").all().map((row) =>
      decode(row.record)
    )
  } finally {
    db.close()
  }
}
