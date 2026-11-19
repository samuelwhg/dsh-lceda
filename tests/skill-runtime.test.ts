import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, Config } from '../src/index'

/**
 * Same shape the host loads the plugin with (`inject = ['tools']`), plus a skills
 * service, against real cordis: proves the bundled skill reaches the skills registry.
 */
describe('plugin wiring against real cordis', () => {
  it('registers tools, registers lceda-dev, and withdraws the skill on unload', async () => {
    const registered: Array<{ name: string, content: string }> = []
    const toolNames: string[] = []
    const ctx = new Context()
    ctx.plugin((c: Context) => {
      const skills = c.provide('skills' as never, {
        register: (skill: { name: string, content: string }) => {
          registered.push(skill)
          return () => { registered.splice(registered.indexOf(skill), 1) }
        },
      } as never)
      const tools = c.provide('tools' as never, {
        register: (tool: { name: string }) => { toolNames.push(tool.name) },
      } as never)
      c.effect(() => () => { skills(); tools() })
    })
    await new Promise((r) => setTimeout(r, 10))

    const fork = ctx.plugin({ inject, apply } as never, Config({} as never) as never)
    await new Promise((r) => setTimeout(r, 30))
    expect(toolNames).toHaveLength(9)
    expect(toolNames).toContain('lceda_report')
    expect(registered.map((s) => s.name)).toEqual(['lceda-dev'])
    expect(registered[0].content).toContain('勿整文件覆盖')

    await fork.dispose()
    await new Promise((r) => setTimeout(r, 10))
    expect(registered).toEqual([])
  })
})
