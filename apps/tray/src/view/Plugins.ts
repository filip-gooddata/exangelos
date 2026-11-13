import type { Catalogue, Plugin } from "@exangelos/domain"
import { Result } from "effect"
import type { Html } from "foldkit/html"
import { Request } from "../state/Panel.ts"
import * as Facts from "./Facts.ts"
import { type ImportKind, Message, type Model } from "./Model.ts"
import { ask, button, fact, go, type H, header, mono, notices, pill, pluginBadge, section } from "./Parts.ts"

const plain = (h: H, model: Model, title: string, text: string): ReadonlyArray<Html> => [
  header(h, model, title),
  h.main([h.Class("body")], [...notices(h, model), h.p([h.Class("quiet-line")], [text])]),
  null
]

const loadedPlugins = (model: Model): Result.Result<ReadonlyArray<Plugin.Plugin>, string> => {
  const { state } = model
  switch (state._tag) {
    case "Loading":
      return Result.fail("Asking the daemon.")
    case "DaemonNotRunning":
      return Result.fail(`The daemon is not running: ${state.message}`)
    case "Ready":
      return Result.mapError(state.plugins, (reason) => `Could not load connectors: ${reason}`)
  }
}

const configuredByText = (plugin: Plugin.Plugin): string | undefined =>
  plugin.configuredBy === undefined ? undefined : `configured by ${Facts.actorName(plugin.configuredBy)}`

const pluginRow = (h: H, plugin: Plugin.Plugin): Html => {
  const configured = configuredByText(plugin)
  return h.keyed("button")(plugin.name, [
    h.Type("button"),
    h.Class("row plugin-row"),
    h.OnClick(go({ _tag: "Plugin", name: plugin.name }))
  ], [
    pluginBadge(h, plugin.name),
    h.span([h.Class("row-body")], [
      h.span([h.Class("row-line")], [
        h.span([h.Class("row-label")], [plugin.name]),
        mono(h, plugin.version, "plugin-version"),
        pill(h, Facts.trustText(plugin.trust))
      ]),
      h.span([h.Class("row-intent")], [Facts.originSummary(plugin.origin)]),
      h.span([h.Class("row-fact")], [
        mono(h, Facts.shortDigest(plugin.digest), "digest"),
        h.span([h.Class("sep")], [" · "]),
        `Configuration ${Facts.configurationText(plugin).toLowerCase()}`,
        configured === undefined ? null : `, ${configured}`,
        h.span([h.Class("sep")], [" · "]),
        Facts.processText(plugin.process)
      ])
    ])
  ])
}

const importKinds: ReadonlyArray<readonly [ImportKind, string]> = [
  ["ArchiveFile", "Archive file"],
  ["HttpsLink", "https link"],
  ["Directory", "Directory"],
  ["GitRepository", "Git repository"]
]

const locationField: Record<ImportKind, { readonly label: string; readonly placeholder: string }> = {
  ArchiveFile: { label: "Path to the archive file", placeholder: "/Users/you/Downloads/connector.tar.gz" },
  HttpsLink: { label: "https link", placeholder: "https://example.com/connector.tar.gz" },
  Directory: { label: "Path to the directory", placeholder: "/Users/you/connectors/linear-issues" },
  GitRepository: { label: "Repository URL", placeholder: "https://github.com/example/exangelos-linear" }
}

const textInput = (
  h: H,
  id: string,
  label: string,
  value: string,
  placeholder: string,
  toMessage: (value: string) => Message
): Html =>
  h.div([h.Class("field")], [
    h.label([h.Class("field-label"), h.For(id)], [label]),
    h.input([
      h.Id(id),
      h.Class("field-input mono"),
      h.Type("text"),
      h.Value(value),
      h.Placeholder(placeholder),
      h.Spellcheck(false),
      h.OnInput(toMessage)
    ])
  ])

const importSection = (h: H, model: Model): Html => {
  const kind = model.importing
  return section(h, "Import a connector", [
    h.p([h.Class("quiet-line")], ["It stays inert until you read its origin and checksum and enable it."]),
    h.div([h.Class("import-kinds"), h.Role("group"), h.AriaLabel("Import from")], importKinds.map(([choice, label]) =>
      h.button([
        h.Type("button"),
        h.Class(choice === kind ? "choice choice-on" : "choice"),
        h.AriaPressed(choice === kind ? "true" : "false"),
        h.OnClick(Message.ChoseImport({ kind: choice === kind ? null : choice }))
      ], [label])
    )),
    kind === null ? null : textInput(
      h,
      "import-location",
      locationField[kind].label,
      model.importLocation,
      locationField[kind].placeholder,
      (value) => Message.EditedImportLocation({ value })
    ),
    kind === "GitRepository"
      ? textInput(h, "import-ref", "Ref", model.importRef, "v0.3.1", (value) => Message.EditedImportRef({ value }))
      : null
  ])
}

const importFooter = (h: H, model: Model): Html => {
  if (model.importing === null) return null
  const source = Facts.importSource(model.importing, model.importLocation, model.importRef)
  return h.footer([h.Class("bar bar-bottom actions")], [
    h.span([h.Class("bar-spacer")], []),
    button(h, "Cancel", Message.ChoseImport({ kind: null })),
    button(h, "Import", source === undefined ? Message.ChoseImport({ kind: model.importing }) : Message.Requested({
      request: Request.ImportPlugin({ source })
    }), { tone: "primary", disabled: source === undefined || model.busy })
  ])
}

export const plugins = (h: H, model: Model): ReadonlyArray<Html> => {
  const loaded = loadedPlugins(model)
  return [
    header(h, model, "Connectors"),
    h.main([h.Class("body")], [
      ...notices(h, model),
      Result.isFailure(loaded)
        ? h.p([h.Class(model.state._tag === "Ready" ? "load-error" : "quiet-line")], [loaded.failure])
        : loaded.success.length === 0
        ? h.p([h.Class("quiet-line")], ["No connectors yet. Import one below."])
        : h.section([h.Class("plugin-list"), h.AriaLabel("Connectors")], loaded.success.map((plugin) => pluginRow(h, plugin))),
      importSection(h, model)
    ]),
    importFooter(h, model)
  ]
}

const factsSection = (h: H, model: Model, plugin: Plugin.Plugin): Html => {
  const configured = configuredByText(plugin)
  return h.section([h.Class("section plugin-facts")], [
    fact(h, "Version", plugin.version, { mono: true }),
    ...Facts.originRows(plugin.origin).map(([label, value]) => fact(h, label, value, { mono: label !== "Source" })),
    fact(h, "Digest", plugin.digest, { mono: true }),
    fact(h, "Trust", Facts.trustText(plugin.trust)),
    fact(h, "Process", Facts.processText(plugin.process)),
    fact(h, "Configuration", configured === undefined ? Facts.configurationText(plugin) : `${Facts.configurationText(plugin)}, ${configured}`),
    plugin.unavailableSince === undefined ? null : fact(h, "Unavailable", Facts.ago(model.now, plugin.unavailableSince))
  ])
}

const enableStep = (h: H): Html =>
  section(h, "Enable", [
    h.p([], [
      "Read the origin and the sha256 digest above before you enable it. Once enabled, it runs on your machine. If its files change after you read the digest, the daemon refuses."
    ]),
    h.p([h.Class("quiet-line")], ["Configure it after you enable it."])
  ])

const fieldId = (field: Catalogue.ConfigurationField) => `configuration-${field.key}`

const fieldLabel = (h: H, field: Catalogue.ConfigurationField): Html =>
  h.label([h.Class("field-label"), h.For(fieldId(field))], [
    field.label,
    field.required ? h.span([h.Class("field-required")], [" required"]) : null
  ])

const configurationField = (h: H, model: Model, plugin: Plugin.Plugin, field: Catalogue.ConfigurationField): Html => {
  const value = model.configuration[field.key] ?? ""
  const edit = (next: string) => Message.EditedConfiguration({ key: field.key, value: next })
  const secret = Facts.isSecretField(field)
  const status = secret
    ? h.span([h.Class("field-status")], [Facts.secretStored(plugin) ? "set" : "not set"])
    : null
  if (field._tag === "Choice") {
    return h.div([h.Class("field")], [
      fieldLabel(h, field),
      h.select([h.Id(fieldId(field)), h.Class("field-input"), h.OnChange(edit)], [
        h.option([h.Value(""), h.Selected(value === "")], [secret ? "Keep the stored choice" : "Choose"]),
        ...field.choices.map((choice) => h.option([h.Value(choice), h.Selected(value === choice)], [choice]))
      ]),
      status
    ])
  }
  return h.div([h.Class("field")], [
    fieldLabel(h, field),
    h.input([
      h.Id(fieldId(field)),
      h.Class(secret ? "field-input" : "field-input mono"),
      h.Type(secret ? "password" : "text"),
      h.Value(value),
      h.Spellcheck(false),
      h.Autocomplete(secret ? "new-password" : "off"),
      h.Placeholder(secret ? "Type to replace it" : ""),
      h.OnInput(edit)
    ]),
    status
  ])
}

const configurationSection = (h: H, model: Model, plugin: Plugin.Plugin): Html => {
  const fields = Facts.configurationFields(plugin)
  return section(h, "Configuration", [
    plugin.configuration._tag === "Rejected"
      ? h.p([h.Class("notice notice-refused"), h.Role("alert")], [`Rejected by the source: ${plugin.configuration.reason}`])
      : null,
    plugin.catalogue === undefined
      ? h.p([h.Class("quiet-line")], ["Its configuration form is not available yet. The daemon reads it once the connector runs."])
      : fields.length === 0
      ? h.p([h.Class("quiet-line")], ["This connector needs no configuration."])
      : h.div([h.Class("configuration-form")], [
        h.p([h.Class("quiet-line")], ["Fields you leave empty keep their stored values. Secrets go to the system keychain."]),
        ...fields.map((field) => configurationField(h, model, plugin, field))
      ])
  ])
}

const inertFooter = (h: H, model: Model, plugin: Plugin.Plugin): Html =>
  h.footer([h.Class("bar bar-bottom actions")], [
    ask(h, model, "Remove", Request.RemovePlugin({ name: plugin.name }), "danger"),
    h.span([h.Class("bar-spacer")], []),
    ask(h, model, "Enable", Request.EnablePlugin({ name: plugin.name, digest: plugin.digest }), "primary")
  ])

const enabledFooter = (h: H, model: Model, plugin: Plugin.Plugin): Html => {
  const values = Facts.filledValues(Facts.configurationFields(plugin), model.configuration)
  const empty = Object.keys(values).length === 0
  return h.footer([h.Class("bar bar-bottom actions")], [
    ask(h, model, "Disable", Request.DisablePlugin({ name: plugin.name }), "danger"),
    ask(h, model, "Remove", Request.RemovePlugin({ name: plugin.name }), "danger"),
    h.span([h.Class("bar-spacer")], []),
    button(h, "Save", Message.Requested({ request: Request.ConfigurePlugin({ name: plugin.name, values }) }), {
      tone: "primary",
      disabled: empty || model.busy
    })
  ])
}

export const plugin = (h: H, model: Model, name: string): ReadonlyArray<Html> => {
  const loaded = loadedPlugins(model)
  if (Result.isFailure(loaded)) return plain(h, model, name, loaded.failure)
  const found = loaded.success.find((p) => p.name === name)
  if (found === undefined) return plain(h, model, name, `The daemon has no connector ${name}.`)
  const inert = found.trust === "inert"
  return [
    header(h, model, found.name),
    h.main([h.Class("body")], [
      ...notices(h, model),
      factsSection(h, model, found),
      inert ? enableStep(h) : configurationSection(h, model, found)
    ]),
    inert ? inertFooter(h, model, found) : enabledFooter(h, model, found)
  ]
}
