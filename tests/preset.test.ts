import { describe, expect, it } from 'vitest'
import { HOST_PRESET_ROW, hostPlugins, lcedaPreset, PERSONA_NAME, PERSONA_TEXT } from '../src/preset'

const row = (id: string, plugins: unknown[]) => ({ options: { name: HOST_PRESET_ROW, config: { id, plugins } } })

describe('hostPlugins', () => {
  it('returns the child list of the requested preset', () => {
    const plugins = [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }]
    expect(hostPlugins([row('minimal', []), row('standard', plugins)])).toEqual(plugins)
  })

  it('ignores other presets and non-preset rows', () => {
    expect(hostPlugins([{ options: { name: '@deepseek-ai/dsh-tool-fs' } }, row('minimal', [])])).toBeUndefined()
  })

  it('ignores a preset row without a plugins array', () => {
    expect(hostPlugins([{ options: { name: HOST_PRESET_ROW, config: { id: 'standard' } } }])).toBeUndefined()
  })
})

describe('lcedaPreset', () => {
  const standard = [
    { id: 'persona', name: PERSONA_NAME, config: { prefix: 'You are a coding agent powered by the {{model}} model.' } },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  ]

  it('swaps the persona in place and keeps the rest of the list', () => {
    const preset = lcedaPreset(standard)
    expect(preset.id).toBe('lceda')
    expect(preset.name).toBe('LCEDA hardware')
    expect(preset.plugins.map((p) => p.name)).toEqual([PERSONA_NAME, '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-bash'])
    expect((preset.plugins[0].config as { prefix: string }).prefix).toContain(PERSONA_TEXT)
    expect((preset.plugins[0].config as { prefix: string }).prefix).toContain('{{model}}')
  })

  it('adds a persona when the source list has none', () => {
    const preset = lcedaPreset([{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }])
    expect(preset.plugins.map((p) => p.name)).toEqual([PERSONA_NAME, '@deepseek-ai/dsh-tool-fs'])
  })

  it('does not mutate its input', () => {
    lcedaPreset(standard)
    expect(standard).toHaveLength(3)
    expect((standard[0].config as { prefix: string }).prefix).not.toContain(PERSONA_TEXT)
  })
})
