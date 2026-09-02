// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  attachChatZoom,
  CHAT_ZOOM_MAX,
  CHAT_ZOOM_MIN,
  CHAT_ZOOM_STORAGE_KEY,
  CHAT_ZOOM_VAR,
  clampZoom,
  loadChatZoom,
  saveChatZoom,
  stepZoom,
} from '../src/client/chat/chat-zoom.ts'

describe('chat zoom helpers', () => {
  it('clamps to the supported range', () => {
    expect(clampZoom(0.1)).toBe(CHAT_ZOOM_MIN)
    expect(clampZoom(5)).toBe(CHAT_ZOOM_MAX)
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(1.3, 1, 2)).toBe(1.3)
  })

  it('zooms in on negative delta and out on positive, staying clamped', () => {
    expect(stepZoom(1, -400)).toBeGreaterThan(1)
    expect(stepZoom(1, 400)).toBeLessThan(1)
    expect(stepZoom(1.5, -1e6)).toBe(CHAT_ZOOM_MAX)
    expect(stepZoom(1, 1e6)).toBe(CHAT_ZOOM_MIN)
  })

  it('round-trips the persisted scale, clamping out-of-range values', () => {
    localStorage.clear()
    expect(loadChatZoom()).toBe(1)
    saveChatZoom(1.25)
    expect(loadChatZoom()).toBe(1.25)
    localStorage.setItem(CHAT_ZOOM_STORAGE_KEY, '99')
    expect(loadChatZoom()).toBe(CHAT_ZOOM_MAX)
    localStorage.setItem(CHAT_ZOOM_STORAGE_KEY, 'garbage')
    expect(loadChatZoom()).toBe(1)
  })
})

function touchEvent(
  type: string,
  points: Array<{ clientX: number; clientY: number }>,
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const touches = Object.assign(points, { item: (index: number) => points[index] ?? null })
  Object.defineProperty(event, 'touches', { value: touches })
  return event as TouchEvent
}

describe('attachChatZoom', () => {
  let el: HTMLElement
  const saved: number[] = []
  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
    saved.length = 0
  })
  afterEach(() => {
    el.remove()
  })

  it('applies the loaded scale and updates it on ctrl+wheel, persisting', () => {
    const binding = attachChatZoom(el, {
      load: () => 1.1,
      save: (s) => {
        saved.push(s)
      },
    })
    expect(el.style.getPropertyValue(CHAT_ZOOM_VAR)).toBe('1.1')
    el.dispatchEvent(
      new WheelEvent('wheel', { ctrlKey: true, deltaY: -400, bubbles: true }),
    )
    const scaled = Number(el.style.getPropertyValue(CHAT_ZOOM_VAR))
    expect(scaled).toBeGreaterThan(1.1)
    expect(scaled).toBeLessThanOrEqual(CHAT_ZOOM_MAX)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toBe(scaled)
    binding.dispose()
  })

  it('ignores plain (non-ctrl) wheel so vertical scroll is untouched', () => {
    const binding = attachChatZoom(el, { load: () => 1 })
    el.dispatchEvent(
      new WheelEvent('wheel', { ctrlKey: false, deltaY: -400, bubbles: true }),
    )
    expect(el.style.getPropertyValue(CHAT_ZOOM_VAR)).toBe('')
    binding.dispose()
  })

  it('scales a two-finger touch gesture without intercepting one-finger touch', () => {
    const binding = attachChatZoom(el, {
      load: () => 1,
      save: (s) => {
        saved.push(s)
      },
    })
    el.dispatchEvent(
      touchEvent('touchstart', [
        { clientX: 0, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ]),
    )
    const pinch = touchEvent('touchmove', [
      { clientX: 0, clientY: 0 },
      { clientX: 150, clientY: 0 },
    ])
    el.dispatchEvent(pinch)
    expect(pinch.defaultPrevented).toBe(true)
    expect(el.style.getPropertyValue(CHAT_ZOOM_VAR)).toBe('1.5')
    expect(saved).toEqual([1.5])
    el.dispatchEvent(touchEvent('touchend', [{ clientX: 0, clientY: 0 }]))
    const scroll = touchEvent('touchmove', [{ clientX: 0, clientY: 20 }])
    el.dispatchEvent(scroll)
    expect(scroll.defaultPrevented).toBe(false)
    binding.dispose()
  })

  it('prevents default on ctrl+wheel and nowhere else', () => {
    const binding = attachChatZoom(el)
    const ctrl = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -100,
      cancelable: true,
      bubbles: true,
    })
    el.dispatchEvent(ctrl)
    expect(ctrl.defaultPrevented).toBe(true)
    const plain = new WheelEvent('wheel', {
      ctrlKey: false,
      cancelable: true,
      bubbles: true,
    })
    el.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    binding.dispose()
  })

  it('keeps the first visible row fixed while reader-owned content reflows', () => {
    const host = document.createElement('div')
    host.dataset.conversationScroll = ''
    const row = document.createElement('div')
    row.dataset.chatAnchorKey = 'row'
    host.append(el, row)
    Object.defineProperties(host, {
      clientHeight: { value: 500 },
      scrollHeight: { value: 1_000 },
      scrollTop: { value: 100, writable: true },
    })
    host.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect
    row.getBoundingClientRect = () => {
      const shifted = el.style.getPropertyValue(CHAT_ZOOM_VAR) === '' ? 0 : 50
      return { top: 100 + shifted, bottom: 140 + shifted } as DOMRect
    }
    const binding = attachChatZoom(el, { load: () => 1, save: () => {} })

    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -40 }))

    expect(host.scrollTop).toBe(150)
    binding.dispose()
    host.remove()
  })

  it('keeps a bottom-following transcript at its new floor', () => {
    const host = document.createElement('div')
    host.dataset.conversationScroll = ''
    host.append(el)
    Object.defineProperties(host, {
      clientHeight: { value: 500 },
      scrollHeight: {
        get: () => el.style.getPropertyValue(CHAT_ZOOM_VAR) === '' ? 1_000 : 1_200,
      },
      scrollTop: { value: 500, writable: true },
    })
    const binding = attachChatZoom(el, { load: () => 1, save: () => {} })

    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -40 }))

    expect(host.scrollTop).toBe(700)
    binding.dispose()
    host.remove()
  })

  it('resets the transcript scale and reports the default', () => {
    const changed: number[] = []
    const binding = attachChatZoom(el, {
      load: () => 1.4,
      save: (scale) => { saved.push(scale) },
      onChange: (scale) => { changed.push(scale) },
    })

    binding.reset()

    expect(el.style.getPropertyValue(CHAT_ZOOM_VAR)).toBe('')
    expect(saved).toEqual([1])
    expect(changed).toEqual([1.4, 1])
    binding.dispose()
  })

  it('cleanup removes the listeners and the scale var', () => {
    const binding = attachChatZoom(el, { load: () => 1.2, save: () => {} })
    binding.dispose()
    expect(el.style.getPropertyValue(CHAT_ZOOM_VAR)).toBe('')
    el.dispatchEvent(
      new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true }),
    )
    expect(el.style.getPropertyValue(CHAT_ZOOM_VAR)).toBe('')
  })
})
