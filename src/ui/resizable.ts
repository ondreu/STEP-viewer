/**
 * Make a floating side panel user-resizable via a small grip in its
 * bottom-right corner. Dragging the grip sets an explicit width/height on the
 * panel (overriding the CSS defaults), clamped to sensible min/max bounds.
 *
 * Used by the structure tree and annotations panels so their fixed 240px width
 * and 45vh height can be adjusted to fit large assemblies.
 */
export function makeResizable(
  panel: HTMLElement,
  opts: { minWidth?: number; minHeight?: number } = {},
): void {
  const minWidth = opts.minWidth ?? 180;
  const minHeight = opts.minHeight ?? 120;

  const grip = panel.createDiv({ cls: "step-viewer-resize-grip" });
  grip.setAttribute("aria-label", "Resize panel");

  let start: { x: number; y: number; w: number; h: number } | null = null;

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    grip.setPointerCapture(e.pointerId);
    panel.addClass("is-resizing");
  });

  grip.addEventListener("pointermove", (e) => {
    if (!start) return;
    // Cap to the viewport so the panel can't grow off-screen.
    const maxW = window.innerWidth - 40;
    const maxH = window.innerHeight - 40;
    const w = clamp(start.w + (e.clientX - start.x), minWidth, maxW);
    const h = clamp(start.h + (e.clientY - start.y), minHeight, maxH);
    panel.style.width = `${w}px`;
    // Explicit height must also lift the CSS max-height cap to take effect.
    panel.style.height = `${h}px`;
    panel.style.maxHeight = `${h}px`;
  });

  const end = (e: PointerEvent): void => {
    if (!start) return;
    grip.releasePointerCapture?.(e.pointerId);
    panel.removeClass("is-resizing");
    start = null;
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
