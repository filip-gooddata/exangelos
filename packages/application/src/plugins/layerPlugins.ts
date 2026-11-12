import { Layer } from "effect"
import { layerPluginAccess } from "./layerPluginAccess.ts"
import { layerPluginSupervisor } from "./PluginSupervisor.ts"

/** The plugin half running inside the daemon: supervision, file watch and the real PluginAccess. */
export const layerPlugins = layerPluginAccess.pipe(Layer.provideMerge(layerPluginSupervisor))
