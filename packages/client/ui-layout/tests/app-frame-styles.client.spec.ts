/** AppFrame style contracts for the narrow overlay drawer. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/AppFrame.module.css', import.meta.url)),
  'utf8',
)

/**
 * Declarations of one exact top-level selector, keyed by property (same idiom
 * as ui-sidebar's sidebar-styles spec). First match wins, so selectors that
 * also appear inside @media blocks (e.g. .scrim's reduced-motion kill) are
 * asserted with anchored regexes instead.
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

describe('AppFrame.module.css', () => {
  it('overlays the expanded narrow drawer without touching the track animation', () => {
    // The center spans every track behind the drawer; the sidebar stays a
    // normal grid item (position: relative just lifts z-index) above it, so
    // the collapse slide still rides the grid-track transition.
    expect(declarations('.frame[data-drawer] .centerCol')?.get('grid-column')).toBe('1 / -1')
    expect(declarations('.frame[data-drawer] .sidebarCol')?.get('position')).toBe('relative')
    expect(declarations('.frame[data-drawer] .sidebarCol')?.get('z-index')).toBe('12')
  })

  it('dims the full-frame backdrop with the lighter mask and fades it in and out', () => {
    // Base .scrim block (unindented, top-level): the media-query copy carries
    // only the reduced-motion transition kill, so it is asserted separately.
    const scrimBlock = [
      '\n.scrim {',
      '  position: absolute;',
      '  inset: 0;',
      '  z-index: 10;',
      '  background: var(--dsw-alias-bg-mask-2);',
      '  opacity: 0;',
      '  pointer-events: none;',
      '  transition: opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out);',
      '}',
    ].join('\n')
    expect(css).toContain(scrimBlock)
    const open = declarations('.frame[data-drawer] .scrim')
    expect(open?.get('opacity')).toBe('1')
    expect(open?.get('pointer-events')).toBe('auto')
  })
})
