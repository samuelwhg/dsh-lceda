import { describe, expect, it } from 'vitest'
import { checkPreset, DEFAULT_PRESET, netKind, planFor } from '../src/rules'

describe('net classification', () => {
  it('recognises grounds, whatever the prefix', () => {
    expect(netKind('GND')).toBe('gnd')
    expect(netKind('/GND')).toBe('gnd')
    expect(netKind('PGND_1')).toBe('gnd')
    expect(netKind('BATT_MINUS')).toBe('signal')
  })

  it('recognises power rails', () => {
    expect(netKind('+3V3')).toBe('power')
    expect(netKind('VCC_USB')).toBe('power')
    expect(netKind('VBUS')).toBe('power')
    expect(netKind('VBUS_MOD')).toBe('power')
  })

  it('leaves signals alone', () => {
    expect(netKind('OLED_SDA')).toBe('signal')
    expect(netKind('USB_DM')).toBe('signal')
    expect(netKind('SWCH')).toBe('signal')
  })
})

describe('rule plan', () => {
  it('names every set by its value, so a rerun reuses it', () => {
    const plan = planFor({ signalWidth: 0.2, powerWidth: 0.5, gndWidth: 0.3, clearance: 0.15, viaPad: 0.6, viaHole: 0.3 })
    expect(plan.track.map((t) => t.name)).toEqual(['track0.2', 'track0.5', 'track0.3'])
    expect(plan.spacing).toEqual({ name: 'clear0.15', clearance: 0.15 })
    expect(plan.via).toEqual({ name: 'via0.6x0.3', pad: 0.6, hole: 0.3 })
    expect(plan.assign).toEqual({ signal: 'track0.2', power: 'track0.5', gnd: 'track0.3' })
  })

  it('refuses presets the board cannot carry', () => {
    expect(() => checkPreset(DEFAULT_PRESET)).not.toThrow()
    expect(() => checkPreset({ ...DEFAULT_PRESET, signalWidth: 0 })).toThrow(/positive number/)
    expect(() => checkPreset({ ...DEFAULT_PRESET, viaHole: 0.6 })).toThrow(/smaller than viaPad/)
    expect(() => checkPreset({ ...DEFAULT_PRESET, clearance: 0.5 })).toThrow(/no room/)
  })
})
