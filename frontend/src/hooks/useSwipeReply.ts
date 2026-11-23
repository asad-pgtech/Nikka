import { useCallback, useRef } from 'react';

/** Distance (px) the bubble must travel before releasing triggers a reply. */
export const SWIPE_THRESHOLD = 56;
const MAX_OFFSET = 80;
/** Movement before we decide whether the gesture is horizontal or vertical. */
const LOCK_DISTANCE = 8;

/**
 * Messenger-style swipe-to-reply for touch/pen. `direction` is the sign of the
 * allowed swipe (1 = rightwards, -1 = leftwards). The bubble is moved via the
 * returned `ref` directly (no re-render per frame) and `onProgress` reports
 * 0..1 so the caller can fade in a reply hint. Pair with `touch-action: pan-y`
 * so the browser keeps vertical scrolling and hands us horizontal moves.
 */
export function useSwipeReply<T extends HTMLElement>(
  onReply: (() => void) | undefined,
  direction: 1 | -1,
  onProgress?: (p: number) => void,
) {
  const ref = useRef<T>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const axis = useRef<'x' | 'y' | null>(null);
  const offset = useRef(0);
  const armed = useRef(false);
  const swiped = useRef(false);

  const apply = useCallback(
    (px: number, animate: boolean) => {
      offset.current = px;
      const el = ref.current;
      if (el) {
        el.style.transition = animate ? 'transform 180ms ease-out' : 'none';
        el.style.transform = px ? `translateX(${px}px)` : '';
      }
      onProgress?.(Math.min(1, Math.abs(px) / SWIPE_THRESHOLD));
    },
    [onProgress],
  );

  const end = useCallback(() => {
    if (!start.current) return;
    const fire = axis.current === 'x' && armed.current;
    swiped.current = axis.current === 'x' && Math.abs(offset.current) > LOCK_DISTANCE;
    start.current = null;
    axis.current = null;
    armed.current = false;
    apply(0, true);
    if (fire) onReply?.();
  }, [apply, onReply]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      swiped.current = false;
      if (!onReply || e.pointerType === 'mouse') return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      axis.current = null;
    },
    [onReply],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = start.current;
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!axis.current) {
        if (Math.hypot(dx, dy) < LOCK_DISTANCE) return;
        axis.current = Math.abs(dx) > Math.abs(dy) && Math.sign(dx) === direction ? 'x' : 'y';
        if (axis.current === 'x') (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      }
      if (axis.current !== 'x') return;
      // Clamp to the allowed direction, with rubber-band resistance past the threshold.
      const d = Math.max(0, dx * direction);
      const eased = d <= SWIPE_THRESHOLD ? d : SWIPE_THRESHOLD + (d - SWIPE_THRESHOLD) * 0.3;
      const px = Math.min(MAX_OFFSET, eased);
      const nowArmed = px >= SWIPE_THRESHOLD;
      if (nowArmed && !armed.current) navigator.vibrate?.(10);
      armed.current = nowArmed;
      apply(px * direction, false);
    },
    [apply, direction],
  );

  /** Swallow the click that follows a swipe so it doesn't open images etc. */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (swiped.current) {
      swiped.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  return {
    ref,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onClickCapture,
    },
  };
}
