/**
 * Geometry for the square avatar cropper. The image is shown in a square viewport of `view` px,
 * scaled to cover it at zoom 1, and moved by `offset` (px, image center relative to view center).
 */
export interface CropView {
  imgW: number;
  imgH: number;
  view: number;
  zoom: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Display px per source px. */
export function scaleOf(v: Pick<CropView, 'imgW' | 'imgH' | 'view' | 'zoom'>): number {
  return (v.view / Math.min(v.imgW, v.imgH)) * v.zoom;
}

/** Clamp zoom and offset so the image always covers the whole viewport. */
export function clampView(v: CropView): CropView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
  const s = scaleOf({ ...v, zoom });
  const maxX = Math.max(0, (v.imgW * s - v.view) / 2);
  const maxY = Math.max(0, (v.imgH * s - v.view) / 2);
  const clamp = (n: number, m: number) => Math.min(m, Math.max(-m, n)) || 0; // `|| 0` drops -0
  return { ...v, zoom, x: clamp(v.x, maxX), y: clamp(v.y, maxY) };
}

/** Zoom around a point (`px`,`py` relative to view center) so that point stays under the finger. */
export function zoomAt(v: CropView, zoom: number, px = 0, py = 0): CropView {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const k = next / v.zoom;
  return clampView({ ...v, zoom: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
}

/** The visible square, in source image pixels. */
export function cropRect(v: CropView): { sx: number; sy: number; side: number } {
  const c = clampView(v);
  const s = scaleOf(c);
  const side = Math.min(c.view / s, c.imgW, c.imgH);
  const sx = c.imgW / 2 - c.x / s - side / 2;
  const sy = c.imgH / 2 - c.y / s - side / 2;
  return {
    sx: Math.min(c.imgW - side, Math.max(0, sx)),
    sy: Math.min(c.imgH - side, Math.max(0, sy)),
    side,
  };
}
