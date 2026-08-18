/**
 * AgentPresetSeat touch-target contract, asserted against the CSS text on
 * disk: the preset chip grows to the same touch floor as the workspace
 * trigger it shares the hero row with on narrow viewports.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/AgentPresetSeat.module.css', import.meta.url)),
  'utf8',
)

/** The trailing narrow-viewport block (the sheet's last rule). */
function narrowBlock(source: string): string {
  return /@media \(max-width: 1023px\)\s*\{([\s\S]*)$/.exec(source)?.[1] ?? ''
}

describe('AgentPresetSeat touch target', () => {
  it('grows the preset chip to the hero touch floor on narrow viewports', () => {
    const block = narrowBlock(css)
    expect(block).toContain('.seat {')
    expect(block).toContain('min-height: 40px')
  })
})
