/**
 * Mobile touch-target style contract: the composer send circle,
 * toolbar controls, and the hero workspace trigger grow above their 28/34px
 * desktop sizes on narrow viewports. Reads the sheets directly, the same
 * idiom as ui-sidebar's sidebar-styles spec.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const inputBar = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/InputBar.module.css', import.meta.url)),
  'utf8',
)
const hero = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/HeroShell.module.css', import.meta.url)),
  'utf8',
)
const conversationRoot = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)),
  'utf8',
)

/** The trailing narrow-viewport block (both sheets end with it). */
function narrowBlock(css: string): string {
  return /@media \(max-width: 1023px\)\s*\{([\s\S]*)$/.exec(css)?.[1] ?? ''
}

describe('mobile touch targets', () => {
  it('grows the composer send circle, attach, and selects on narrow viewports', () => {
    const block = narrowBlock(inputBar)
    expect(block).toContain('.primary {')
    expect(block).toContain('width: 40px')
    expect(block).toContain('height: 40px')
    expect(block).toContain('.add {')
    expect(block).toContain('.select {')
    expect(block).toContain('height: 40px')
  })

  it('grows the hero workspace trigger on narrow viewports', () => {
    const block = narrowBlock(hero)
    expect(block).toContain('.workspace {')
    expect(block).toContain('min-height: 40px')
  })

  it('keeps the docked composer clear of the home indicator', () => {
    expect(inputBar).toMatch(
      /padding: 0 var\(--dsh-composer-side-clearance\) calc\(8px \+ env\(safe-area-inset-bottom\)\);/,
    )
  })

  it('wraps the hero workspace row so the preset chip never clips on narrow viewports', () => {
    const block = narrowBlock(conversationRoot)
    expect(block).toContain('.heroWorkspaceRow {')
    expect(block).toContain('flex-wrap: wrap')
    expect(block).toContain('row-gap: 8px')
  })
})
