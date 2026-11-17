/** Client-side previews. Thumbnails travel inside the encrypted envelope, so keep them small (< ~20 KB). */
import type { MediaDescriptor } from '../crypto/message';

const THUMB_MAX = 320;
const THUMB_QUALITY = 0.6;

export function classifyFile(file: File): MediaDescriptor['kind'] {
  const t = file.type.toLowerCase();
  if (t === 'image/gif') return 'gif';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'file';
}

function drawThumb(source: CanvasImageSource, w: number, h: number): string {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', THUMB_QUALITY);
}

export async function imageThumbnail(blob: Blob): Promise<{ thumb: string; width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { thumb: drawThumb(img, img.naturalWidth, img.naturalHeight), width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function videoPoster(
  blob: Blob,
): Promise<{ thumb?: string; width?: number; height?: number; durationMs?: number }> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('video load failed'));
      }),
      8000,
    );
    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined;
    video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
    await withTimeout(new Promise<void>((resolve) => (video.onseeked = () => resolve())), 4000).catch(() => undefined);
    const { videoWidth: width, videoHeight: height } = video;
    const thumb = width && height ? drawThumb(video, width, height) : undefined;
    return { thumb, width, height, durationMs };
  } catch {
    return {};
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

const AVATAR_SIZE = 256;
/** Avatars travel inside one encrypted envelope (64 KB cap incl. JSON + base64), so stay well below. */
const AVATAR_MAX_CHARS = 40_000;

/**
 * Crop an image to a square (the given source rect, or the centered square) and encode it as a small
 * JPEG data: URL.
 */
export async function makeAvatar(
  blob: Blob,
  crop?: { sx: number; sy: number; side: number },
): Promise<string> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const side = crop?.side ?? Math.min(bitmap.width, bitmap.height);
    const sx = crop?.sx ?? (bitmap.width - side) / 2;
    const sy = crop?.sy ?? (bitmap.height - side) / 2;
    const size = Math.max(1, Math.round(Math.min(AVATAR_SIZE, side)));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff'; // transparent PNGs would turn black in JPEG
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    for (const quality of [0.85, 0.75, 0.6, 0.45]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= AVATAR_MAX_CHARS) return url;
    }
    throw new Error('That picture could not be made small enough.');
  } finally {
    bitmap.close();
  }
}

/** Accept only small inline JPEG/PNG/WebP data URLs from peers. */
export function isValidAvatar(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 60_000 &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)
  );
}
