/** SettingsRoot rail trigger mobile touch-target style contract. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/SettingsRoot.module.css', import.meta.url)),
  'utf8',
)

function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
  }
  return found.size === 0 ? undefined : found
}

describe('SettingsRoot.module.css', () => {
  it('grows the rail trigger to 44px on narrow viewports', () => {
    // The media rule sits at EOF, so the last-match helper resolves the mobile
    // size; the desktop sheet keeps the 36px base earlier in the same sheet.
    expect(declarations('.trigger.rail')?.get('width')).toBe('44px')
    expect(declarations('.trigger.rail')?.get('height')).toBe('44px')
  })
})
