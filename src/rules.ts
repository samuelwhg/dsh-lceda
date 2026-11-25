/**
 * Design-rule planning for the autoroute cycle.
 *
 * Freerouting only sees what the Specctra DSN carries: per net-class track width,
 * clearance, the via padstack and the layer types. LCEDA net classes are grouping
 * only (name + nets + colour), so a width/clearance/via preset has to be written as
 * named rule sets in the board rule configuration and referenced from the net rules.
 */

export type NetKind = 'gnd' | 'power' | 'signal'

const GND = /(?:^|[/_.\-])(?:GND|AGND|DGND|PGND|EARTH|VSS)(?:$|[/_.\-])/i
const POWER = /(?:^|[/_.\-])(?:VCC|VDD|VBUS|VIN|VOUT|VSYS|VBAT|PWR|\d+V\d*|\d+V)(?:$|[/_.\-])/i

/** Which preset a net belongs to. EasyEDA nets arrive as `/NAME` or `+3V3`. */
export function netKind(net: string): NetKind {
  const n = net.replace(/^\//, '').replace(/^\+/, '')
  if (GND.test(n)) return 'gnd'
  if (POWER.test(n)) return 'power'
  return 'signal'
}

export interface Preset {
  signalWidth: number
  powerWidth: number
  gndWidth: number
  clearance: number
  viaPad: number
  viaHole: number
}

export const DEFAULT_PRESET: Preset = {
  signalWidth: 0.2,
  powerWidth: 0.5,
  gndWidth: 0.3,
  clearance: 0.15,
  viaPad: 0.6,
  viaHole: 0.3,
}

const mm = (v: number): string => String(Math.round(v * 1000) / 1000)

export interface RulePlan {
  /** named `Physics.Track` rule sets to add (rule names are value-derived, so a rerun reuses them) */
  track: { name: string; width: number }[]
  /** named `Spacing -> Safe Spacing` set whose cells are floored at `clearance` */
  spacing: { name: string; clearance: number }
  /** named `Physics -> Via Size` set */
  via: { name: string; pad: number; hole: number }
  /** net kind -> track set name */
  assign: Record<NetKind, string>
}

/** Named rule sets for a preset. Names encode the value, so applying twice is a no-op. */
export function planFor(p: Preset): RulePlan {
  const track: RulePlan['track'] = [
    { name: `track${mm(p.signalWidth)}`, width: p.signalWidth },
    { name: `track${mm(p.powerWidth)}`, width: p.powerWidth },
    { name: `track${mm(p.gndWidth)}`, width: p.gndWidth },
  ]
  return {
    track,
    spacing: { name: `clear${mm(p.clearance)}`, clearance: p.clearance },
    via: { name: `via${mm(p.viaPad)}x${mm(p.viaHole)}`, pad: p.viaPad, hole: p.viaHole },
    assign: { signal: track[0].name, power: track[1].name, gnd: track[2].name },
  }
}

/** Reject presets the board cannot carry before anything is written. */
export function checkPreset(p: Preset): void {
  for (const [k, v] of Object.entries(p)) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`preset ${k} must be a positive number (got ${String(v)})`)
  }
  if (p.viaHole >= p.viaPad) throw new Error(`preset viaHole (${p.viaHole}) must be smaller than viaPad (${p.viaPad})`)
  if (p.clearance > p.signalWidth) {
    throw new Error(
      `preset clearance (${p.clearance}) is wider than signalWidth (${p.signalWidth}): the autorouter would have no room ` +
        `to route (see README.md#configuration)`,
    )
  }
}
