/**
 * Pinch-to-zoom (and ctrl+wheel) font scaling for the chat transcript only.
 * The scale lives on the transcript scroller as `--dsh-chat-font-scale` and
 * the CSS module applies it to the message column, so controls and application
 * chrome keep their fixed sizes. Scale changes preserve the row beneath the
 * gesture or the first visible row; bottom-following readers stay at the floor.
 * The browser delivers two-finger pinch through touch events, while desktop
 * trackpads and ctrl+wheel share the wheel path. Native page zoom remains
 * available outside the chat.
 * @module @deepseek-ai/dsh-client-ui-chat
 */

/** Low end of the chat font scale (a 16px message reads as ~12.8px). */
export const CHAT_ZOOM_MIN = 0.8

/** High end of the chat font scale (a 16px message reads as ~28.8px). */
export const CHAT_ZOOM_MAX = 1.8

/** Storage key for the persisted per-device scale. */
export const CHAT_ZOOM_STORAGE_KEY = 'dsh:chat-font-scale'

/** CSS custom property carrying the scale on the transcript scroller. */
export const CHAT_ZOOM_VAR = '--dsh-chat-font-scale'

/** Exponential smoothing constant mapping wheel deltas to scale steps. */
const ZOOM_SMOOTHING = 200

/**
 * Clamp a scale to a range, defaulting to the module bounds.
 * @param scale - candidate scale.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the scale clamped into `[min, max]`.
 */
export function clampZoom(
  scale: number,
  min = CHAT_ZOOM_MIN,
  max = CHAT_ZOOM_MAX,
): number {
  return Math.min(max, Math.max(min, scale))
}

/**
 * Apply a wheel delta to a scale: zoom in on negative deltaY, out on positive.
 * @param scale - current scale.
 * @param deltaY - wheel delta; negative zooms in.
 * @returns the smoothed scale clamped to the module bounds.
 */
export function stepZoom(scale: number, deltaY: number): number {
  return clampZoom(scale * Math.exp(-deltaY / ZOOM_SMOOTHING))
}

/**
 * Read the persisted scale, falling back to 1 when missing or unreadable.
 * @returns the stored scale clamped to the module bounds, or 1.
 */
export function loadChatZoom(): number {
  /* v8 ignore next -- localStorage is always present in the browser/jsdom. */
  if (typeof localStorage === 'undefined') return 1
  try {
    const raw = localStorage.getItem(CHAT_ZOOM_STORAGE_KEY)
    if (raw == null) return 1
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampZoom(parsed) : 1
  } catch {
    /* v8 ignore next -- storage reads never throw under the test env. */
    return 1
  }
}

/**
 * Persist a scale, rounding to two decimals to keep storage and style clean.
 * @param scale - scale to persist; clamped and rounded before storing.
 */
export function saveChatZoom(scale: number): void {
  /* v8 ignore next -- localStorage is always present in the browser/jsdom. */
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      CHAT_ZOOM_STORAGE_KEY,
      String(Math.round(clampZoom(scale) * 100) / 100),
    )
  } catch {
    /* v8 ignore next -- storage writes never throw under the test env. */
    // Storage can be unavailable (private mode, disabled cookies): the scale
    // still applies for the session even when it cannot survive a reload.
  }
}

/** Options overriding how {@link attachChatZoom} loads and persists the scale. */
export interface AttachChatZoomOptions {
  /** Scale loader override, for tests and alternate persistence. */
  readonly load?: () => number
  /** Scale saver override, for tests and alternate persistence. */
  readonly save?: (scale: number) => void
  /** Receives the loaded scale and every gesture or reset update. */
  readonly onChange?: (scale: number) => void
}

/** Controls one attached transcript zoom lifetime. */
export interface ChatZoomBinding {
  /** Restore the default transcript scale and persist it. */
  reset(): void
  /** Remove gesture listeners and the applied scale. */
  dispose(): void
}

/**
 * Bind a chat region to pinch and ctrl+wheel font scaling.
 * @param target - the transcript scroller receiving gestures and the scale variable.
 * @param options - optional persisted-scale load/save overrides.
 * @returns controls for resetting and disposing this attachment.
 */
export function attachChatZoom(
  target: HTMLElement,
  options: AttachChatZoomOptions = {},
): ChatZoomBinding {
  const load = options.load ?? loadChatZoom
  const save = options.save ?? saveChatZoom
  let scale = clampZoom(load())
  const render = (): void => {
    if (scale === 1) target.style.removeProperty(CHAT_ZOOM_VAR)
    else target.style.setProperty(CHAT_ZOOM_VAR, String(scale))
    options.onChange?.(scale)
  }
  render()

  const update = (next: number): void => {
    scale = Math.round(clampZoom(next) * 100) / 100
    save(scale)
    render()
  }

  const updateAnchored = (next: number, point?: { x: number; y: number }): void => {
    const scrollHost = target.closest<HTMLElement>('[data-conversation-scroll]') ?? target
    const hostRect = scrollHost.getBoundingClientRect()
    const rows = [...scrollHost.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden])')]
    const pointed = point === undefined || typeof target.ownerDocument.elementFromPoint !== 'function'
      ? null
      : target.ownerDocument.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-chat-anchor-key]')
    const anchor = pointed ?? rows.find((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > hostRect.top && rect.top < hostRect.bottom
    })
    const anchorTop = anchor?.getBoundingClientRect().top
    const followsBottom = scrollHost.scrollHeight - scrollHost.clientHeight - scrollHost.scrollTop <= 1
    update(next)
    if (followsBottom) {
      scrollHost.scrollTop = scrollHost.scrollHeight - scrollHost.clientHeight
    } else if (anchor !== undefined && anchorTop !== undefined) {
      scrollHost.scrollTop += anchor.getBoundingClientRect().top - anchorTop
    }
  }

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey) return
    event.preventDefault()
    updateAnchored(stepZoom(scale, event.deltaY), { x: event.clientX, y: event.clientY })
  }
  target.addEventListener('wheel', onWheel, { passive: false })

  const touchPair = (touches: TouchList): readonly [Touch, Touch] | undefined => {
    if (touches.length !== 2) return undefined
    const first = touches.item(0)
    const second = touches.item(1)
    return first === null || second === null ? undefined : [first, second]
  }
  const distance = (touches: TouchList): number | undefined => {
    const pair = touchPair(touches)
    return pair === undefined
      ? undefined
      : Math.hypot(pair[0].clientX - pair[1].clientX, pair[0].clientY - pair[1].clientY)
  }
  let touchBase: { distance: number; scale: number } | undefined
  const onTouchStart = (event: TouchEvent): void => {
    const initial = distance(event.touches)
    touchBase = initial === undefined ? undefined : { distance: initial, scale }
  }
  const onTouchMove = (event: TouchEvent): void => {
    const current = distance(event.touches)
    if (
      touchBase === undefined ||
      current === undefined ||
      touchBase.distance === 0
    )
      return
    event.preventDefault()
    const pair = touchPair(event.touches)
    const point = pair === undefined
      ? undefined
      : {
        x: (pair[0].clientX + pair[1].clientX) / 2,
        y: (pair[0].clientY + pair[1].clientY) / 2,
      }
    updateAnchored((touchBase.scale * current) / touchBase.distance, point)
  }
  const onTouchEnd = (event: TouchEvent): void => {
    if (event.touches.length < 2) touchBase = undefined
  }
  target.addEventListener('touchstart', onTouchStart)
  target.addEventListener('touchmove', onTouchMove, { passive: false })
  target.addEventListener('touchend', onTouchEnd)
  target.addEventListener('touchcancel', onTouchEnd)

  return {
    reset: () => { updateAnchored(1) },
    dispose: () => {
      target.removeEventListener('wheel', onWheel)
      target.removeEventListener('touchstart', onTouchStart)
      target.removeEventListener('touchmove', onTouchMove)
      target.removeEventListener('touchend', onTouchEnd)
      target.removeEventListener('touchcancel', onTouchEnd)
      target.style.removeProperty(CHAT_ZOOM_VAR)
    },
  }
}
