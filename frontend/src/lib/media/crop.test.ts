import { describe, expect, it } from 'vitest';
import { clampView, cropRect, zoomAt, type CropView } from './crop';

const base: CropView = { imgW: 1200, imgH: 800, view: 300, zoom: 1, x: 0, y: 0 };

describe('avatar crop geometry', () => {
  it('defaults to the centered square of the short side', () => {
    expect(cropRect(base)).toEqual({ sx: 200, sy: 0, side: 800 });
  });

  it('dragging right reveals the left part of the image', () => {
    const r = cropRect({ ...base, x: 75 }); // 75 view px = 200 source px at zoom 1
    expect(r).toEqual({ sx: 0, sy: 0, side: 800 });
  });

  it('never lets the image uncover the viewport', () => {
    expect(clampView({ ...base, x: 9999, y: -9999 })).toMatchObject({ x: 75, y: 0 });
    expect(clampView({ ...base, zoom: 10 }).zoom).toBe(4);
    expect(clampView({ ...base, zoom: 0.2 }).zoom).toBe(1);
  });

  it('zooming in shrinks the crop around the center', () => {
    expect(cropRect({ ...base, zoom: 2 })).toEqual({ sx: 400, sy: 200, side: 400 });
  });

  it('zooming at a point keeps that point fixed', () => {
    const v = zoomAt(base, 2, 100, 0);
    // source point under (100,0) before: 600 + 100/0.375 = 866.67; after must match
    const s = (300 / 800) * 2;
    expect(600 - v.x / s + 100 / s).toBeCloseTo(600 + 100 / 0.375, 5);
  });
});
