/**
 * Pinch-to-zoom (and ctrl+wheel) font scaling for the chat transcript only.
 * The scale lives on the chat root as `--dsh-chat-font-scale` and the CSS
 * module applies it with the `zoom` property, so the composer, the sidebar,
 * and the rest of the UI keep their fixed sizes. The browser delivers a
 * two-finger pinch uses touch events while desktop trackpads and ctrl+wheel
 * share the wheel path. Native page zoom remains available outside the chat.
 * @module @deepseek-ai/dsh-client-ui-conversation
 */

/** Low end of the chat font scale (a 16px message reads as ~12.8px). */
export const CHAT_ZOOM_MIN = 0.8

/** High end of the chat font scale (a 16px message reads as ~28.8px). */
export const CHAT_ZOOM_MAX = 1.8

/** Storage key for the persisted per-device scale. */
export const CHAT_ZOOM_STORAGE_KEY = 'dsh:chat-font-scale'

/** CSS custom property carrying the scale on the chat root. */
export const CHAT_ZOOM_VAR = '--dsh-chat-font-scale'

/** Exponential smoothing constant mapping wheel deltas to scale steps. */
const ZOOM_SMOOTHING = 200

/** Clamp a scale to a range, defaulting to the module bounds. */
export function clampZoom(
  scale: number,
  min = CHAT_ZOOM_MIN,
  max = CHAT_ZOOM_MAX,
): number {
  return Math.min(max, Math.max(min, scale))
}

/** Apply a wheel delta to a scale: zoom in on negative deltaY, out on positive. */
export function stepZoom(scale: number, deltaY: number): number {
  return clampZoom(scale * Math.exp(-deltaY / ZOOM_SMOOTHING))
}

/** Read the persisted scale, falling back to 1 when missing or unreadable. */
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

/** Persist a scale, rounding to two decimals to keep storage and style clean. */
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

export interface AttachChatZoomOptions {
  /** Scale loader override, for tests and alternate persistence. */
  readonly load?: () => number
  /** Scale saver override, for tests and alternate persistence. */
  readonly save?: (scale: number) => void
}

/**
 * Bind a chat region to pinch and ctrl+wheel font scaling.
 * @param target - the chat root element receiving the scale var.
 * @param options - optional persisted-scale load/save overrides.
 * @returns a cleanup that removes the listeners and the scale var.
 */
export function attachChatZoom(
  target: HTMLElement,
  options: AttachChatZoomOptions = {},
): () => void {
  const load = options.load ?? loadChatZoom
  const save = options.save ?? saveChatZoom
  let scale = clampZoom(load())
  const render = (): void => {
    if (scale === 1) target.style.removeProperty(CHAT_ZOOM_VAR)
    else target.style.setProperty(CHAT_ZOOM_VAR, String(scale))
  }
  render()

  const update = (next: number): void => {
    scale = clampZoom(next)
    save(scale)
    render()
  }

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey) return
    event.preventDefault()
    update(stepZoom(scale, event.deltaY))
  }
  target.addEventListener('wheel', onWheel, { passive: false })

  const distance = (touches: TouchList): number | undefined => {
    if (touches.length !== 2) return undefined
    const first = touches.item(0)
    const second = touches.item(1)
    if (first === null || second === null) return undefined
    return Math.hypot(
      first.clientX - second.clientX,
      first.clientY - second.clientY,
    )
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
    update((touchBase.scale * current) / touchBase.distance)
  }
  const onTouchEnd = (event: TouchEvent): void => {
    if (event.touches.length < 2) touchBase = undefined
  }
  target.addEventListener('touchstart', onTouchStart)
  target.addEventListener('touchmove', onTouchMove, { passive: false })
  target.addEventListener('touchend', onTouchEnd)
  target.addEventListener('touchcancel', onTouchEnd)

  return () => {
    target.removeEventListener('wheel', onWheel)
    target.removeEventListener('touchstart', onTouchStart)
    target.removeEventListener('touchmove', onTouchMove)
    target.removeEventListener('touchend', onTouchEnd)
    target.removeEventListener('touchcancel', onTouchEnd)
    target.style.removeProperty(CHAT_ZOOM_VAR)
  }
}
