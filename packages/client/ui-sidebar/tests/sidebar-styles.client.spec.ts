/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SidebarRoot.module.css', () => {
  it('shares and cancels the wide shell trailing padding structurally', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('12px')
    expect(root?.get('padding')).toBe(
      'calc(6px + env(safe-area-inset-top)) var(--dsh-sidebar-inline-padding) calc(6px + env(safe-area-inset-bottom))',
    )
    expect(declarations('.root.collapsed')?.get('padding')).toBe(
      'calc(18px + env(safe-area-inset-top)) 10px calc(6px + env(safe-area-inset-bottom))',
    )
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
    expect(declarations('.collapsed .regionArea')?.get('margin-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('padding-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('margin-right')).toBe('0')
  })

  it('moves the four upper controls while the settings seat only fades', () => {
    const animation = 'rail-in 150ms var(--ds-ease-in-out) backwards'
    for (const selector of [
      '.railIn .iconButton',
      '.railIn .newSession',
      '.railIn .regionArea',
    ]) {
      expect(declarations(selector)?.get('animation')).toBe(animation)
    }
    expect(declarations('.railIn .footArea')?.get('animation')).toBe(
      'rail-fade-in 150ms var(--ds-ease-in-out) backwards',
    )
    expect(css).toMatch(
      /@keyframes rail-in\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: translateX\(49px\);\s*}\s*}/,
    )
    expect(css).toMatch(/@keyframes rail-fade-in\s*\{\s*from\s*\{\s*opacity: 0;\s*}\s*}/)
  })

  it('gives shell rail controls the same base anchor for their shared translation', () => {
    expect(declarations('.collapsed .logoRow')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('align-self')).toBe('flex-start')
    expect(declarations('.collapsed .newSession')?.get('width')).toBe('36px')
  })

  it('grows the rail controls to 44px touch targets on narrow viewports only', () => {
    // The block sits at EOF (the last rule in the sheet), so capture to end.
    const media = /@media \(max-width: 1023px\)\s*\{([\s\S]*)$/.exec(css)?.[1] ?? ''
    // The 56px rail is contract-frozen: 44px controls fit by taking the side
    // padding from 10 to 6px (44 + 2*6 = 56); the safe-area insets survive.
    expect(media).toContain('padding: calc(18px + env(safe-area-inset-top)) 6px')
    expect(media).toContain('.collapsed .iconButton,')
    expect(media).toContain('.collapsed .newSession {')
    expect(media).toContain('width: 44px')
    expect(media).toContain('height: 44px')
    // The desktop rail keeps the frozen 36px controls.
    expect(declarations('.collapsed .newSession')?.get('width')).toBe('36px')
  })

  it('also grows the overlay drawer controls to the touch floor on narrow viewports', () => {
    const media = /@media \(max-width: 1023px\)\s*\{([\s\S]*)$/.exec(css)?.[1] ?? ''
    expect(media).toContain('.iconButton {')
    expect(media).toContain('width: 40px')
    expect(media).toContain('height: 40px')
    expect(media).toContain('.newSession {')
    expect(media).toContain('min-height: 40px')
  })
})
