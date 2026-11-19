import { describe, expect, it } from 'vitest'
import { connectivity, diffNets, normalizeCsv, parseProtel2 } from '../src/decode'

describe('normalizeCsv', () => {
  it('converts UTF-16LE BOM csv to utf8', () => {
    const src = '位号,值\nR1,10k\n'
    const buf = Buffer.from('\ufeff' + src, 'utf16le')
    expect(normalizeCsv(buf).toString('utf8')).toBe(src)
  })
  it('leaves utf8 untouched', () => {
    const buf = Buffer.from('a,b\n1,2\n', 'utf8')
    expect(normalizeCsv(buf).toString('utf8')).toBe('a,b\n1,2\n')
  })
})

describe('parseProtel2', () => {
  const text = ['[', 'C5', 'CAP-0805', ']', '(', 'GND', 'C5-1 CAP-0805-1 Passive', 'U1-7 QFN-32-7 Passive', ')', '(', 'VSYS', 'C5-2 CAP-0805-2 Passive', ')'].join('\n')
  it('maps component pins to nets', () => {
    const nl = parseProtel2(text)
    expect(nl.comps.C5['1']).toBe('GND')
    expect(nl.comps.C5['2']).toBe('VSYS')
    expect(nl.comps.U1['7']).toBe('GND')
  })
  it('collects net nodes', () => {
    const nl = parseProtel2(text)
    expect(nl.nets.GND).toEqual(['C5-1', 'U1-7'])
  })
  it('handles refs containing underscores and dashes in pin suffix', () => {
    const nl = parseProtel2(['[', 'R_MISO', ']', '(', 'PN532_MISO', 'R_MISO-2 x Passive', ')'].join('\n'))
    expect(nl.comps.R_MISO['2']).toBe('PN532_MISO')
  })
})

describe('connectivity', () => {
  it('joins pad-track-pad chains and reports isolated nets', () => {
    const pads = [
      { id: 'A.1', net: 'N', x: 0, y: 0, layer: 1 },
      { id: 'B.1', net: 'N', x: 100, y: 0, layer: 1 },
      { id: 'C.1', net: 'M', x: 0, y: 50, layer: 1 },
      { id: 'D.1', net: 'M', x: 90, y: 50, layer: 1 },
    ]
    const segs = [{ net: 'N', ax: 0, ay: 0, bx: 100, by: 0, layer: 1 }]
    const iso = connectivity(pads, segs, [])
    expect(iso.N).toBeUndefined()
    expect(iso.M).toEqual(['C.1', 'D.1'])
  })
  it('through pads bridge layers', () => {
    const pads = [
      { id: 'T.1', net: 'N', x: 0, y: 0, layer: 1, through: true },
      { id: 'B.1', net: 'N', x: 0, y: 0, layer: 2 },
    ]
    expect(connectivity(pads, [], []).N).toBeUndefined()
  })
})

describe('diffNets', () => {
  it('counts checked and lists mismatches including missing keys', () => {
    const r = diffNets({ 'R1|1': 'BAT' }, { 'R1|1': 'BAT', 'R1|2': 'GND' })
    expect(r.checked).toBe(2)
    expect(r.mismatches).toEqual([{ key: 'R1|2', actual: '', expected: 'GND' }])
  })
})
