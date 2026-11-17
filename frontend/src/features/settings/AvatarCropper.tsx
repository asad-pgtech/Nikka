/** Square/circle cropper for the profile picture: drag to move, pinch / wheel / slider to zoom. */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { Sheet } from '@/components/ui';
import { clampView, cropRect, MAX_ZOOM, MIN_ZOOM, scaleOf, zoomAt, type CropView } from '@/lib/media/crop';

const VIEW = 280;

export function AvatarCropper({
  file,
  onCancel,
  onSave,
}: {
  file: File;
  onCancel: () => void;
  onSave: (crop: { sx: number; sy: number; side: number }) => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [view, setView] = useState<CropView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (!w || !h) setError('This picture could not be opened.');
    else setView({ imgW: w, imgH: h, view: VIEW, zoom: 1, x: 0, y: 0 });
  };

  /** Pointer position relative to the viewport center. */
  const local = (x: number, y: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };

  const onDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && view) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
    }
  };

  const onMove = (e: ReactPointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !view) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const zoom = (pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.dist;
      setView((v) => v && zoomAt(v, zoom, mid.x, mid.y));
    } else if (pointers.current.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setView((v) => v && clampView({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  };

  const onUp = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onWheel = (e: WheelEvent) => {
    if (!view) return;
    const p = local(e.clientX, e.clientY);
    setView((v) => v && zoomAt(v, v.zoom * Math.exp(-e.deltaY / 400), p.x, p.y));
  };

  const save = async () => {
    if (!view) return;
    setBusy(true);
    setError('');
    try {
      await onSave(cropRect(view));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the picture.');
      setBusy(false);
    }
  };

  const s = view ? scaleOf(view) : 1;
  return (
    <Sheet title="Move and scale" onClose={busy ? () => undefined : onCancel}>
      <div className="stack" style={{ alignItems: 'center' }}>
        <div
          ref={box}
          className="cropper"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={onWheel}
          aria-label="Drag to move the picture, pinch or scroll to zoom"
        >
          {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              onLoad={onLoad}
              onError={() => setError('This picture could not be opened.')}
              style={
                view
                  ? {
                      width: view.imgW * s,
                      height: view.imgH * s,
                      transform: `translate(${view.x - (view.imgW * s) / 2}px, ${view.y - (view.imgH * s) / 2}px)`,
                    }
                  : { visibility: 'hidden' }
              }
            />
          )}
          <div className="cropper-mask" aria-hidden="true" />
        </div>
        <input
          type="range"
          className="cropper-zoom"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={view?.zoom ?? 1}
          disabled={!view}
          aria-label="Zoom"
          onChange={(e) => setView((v) => v && zoomAt(v, Number(e.target.value)))}
        />
        {error && (
          <span className="error-text" role="alert">
            {error}
          </span>
        )}
        <div className="row" style={{ width: '100%' }}>
          <button className="btn secondary grow" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn grow" onClick={() => void save()} disabled={!view || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
