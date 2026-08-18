/** Button mobile touch-target style contract. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/Button.module.css', import.meta.url)),
  'utf8',
)

describe('Button.module.css', () => {
  it('grows the standard action form to 44px on narrow viewports only', () => {
    // The block sits at EOF, so capture to end.
    const media = /@media \(max-width: 1023px\)\s*\{([\s\S]*)$/.exec(css)?.[1] ?? ''
    expect(media).toContain('.md {')
    expect(media).toContain('height: 44px')
    // The desktop form keeps the frozen 36px height.
    expect(css).toMatch(/\.md \{\n  height: 36px;\n\}/)
  })
})
