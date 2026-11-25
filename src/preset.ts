/** Agent preset shipped with the plugin: the host's standard preset plus an LCEDA persona. */
/** One child plugin row of an Agent preset, as the Cordis loader stores it. */
export interface PresetEntry {
  id?: unknown
  name?: unknown
  config?: Record<string, unknown>
  [key: string]: unknown
}

/** `config` of an `@deepseek-ai/dsh-agent-preset` row. */
export interface PresetDefinition {
  id: string
  name: string
  description: string
  order: number
  plugins: PresetEntry[]
}

/** Row name of a preset declaration. */
export const HOST_PRESET_ROW = '@deepseek-ai/dsh-agent-preset'
/** Preset id sessions record when they pick this one. */
export const PRESET_ID = 'lceda'
/** Host preset whose plugin list we extend. */
export const SOURCE_PRESET = 'standard'
export const PERSONA_NAME = '@deepseek-ai/dsh-persona'

export const PERSONA_TEXT =
  'On hardware work you drive LCEDA Pro (嘉立创 EDA) through the lceda_* tools: read the lceda-dev skill before touching a board, never write while the project is open in the GUI, and verify with lceda_check instead of assuming an edit landed.'

interface LoaderEntryLike {
  options?: { name?: unknown; config?: unknown }
}

/**
 * Child plugin list of a preset the host already declared.
 * Presets have no inheritance, so a plugin that ships its own preset has to copy
 * the list of an existing one instead of restating a list that drifts per release.
 */
export function hostPlugins(entries: Iterable<LoaderEntryLike>, id = SOURCE_PRESET): PresetEntry[] | undefined {
  for (const entry of entries) {
    if (entry?.options?.name !== HOST_PRESET_ROW) continue
    const config = entry.options.config as { id?: unknown; plugins?: unknown } | undefined
    if (config?.id !== id || !Array.isArray(config.plugins)) continue
    return config.plugins as PresetEntry[]
  }
  return undefined
}

/** Standard's plugin list with the LCEDA persona swapped in. */
export function lcedaPreset(plugins: PresetEntry[]): PresetDefinition {
  const persona: PresetEntry = {
    id: 'persona',
    name: PERSONA_NAME,
    config: { prefix: `You are a coding agent powered by the {{model}} model. ${PERSONA_TEXT}` },
  }
  return {
    id: PRESET_ID,
    name: 'LCEDA hardware',
    description:
      'Standard tools plus an LCEDA Pro (嘉立创 EDA) persona: board work through the lceda_* tools, verified before it is reported.',
    order: 6,
    plugins: [persona, ...plugins.filter((p) => !(p.id === 'persona' && p.name === PERSONA_NAME))],
  }
}
