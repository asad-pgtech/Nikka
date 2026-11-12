/**
 * Voice notes (spec F8). Cross-platform playback strategy:
 *  - Prefer recording AAC in MP4 (iOS Safari always; recent Chrome on Android too). Plays everywhere.
 *  - If the browser can only record WebM/Opus, transcode to 16 kHz mono WAV on the sender so iOS can play it.
 */

const PREFERRED_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];

export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
}

export interface VoiceRecording {
  blob: Blob;
  mime: string;
  durationMs: number;
}

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = pickRecorderMime();
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size > 0 && this.chunks.push(e.data);
    this.recorder.start(250);
    this.startedAt = performance.now();
  }

  get elapsedMs(): number {
    return this.recorder ? performance.now() - this.startedAt : 0;
  }

  async stop(): Promise<VoiceRecording | null> {
    const rec = this.recorder;
    if (!rec) return null;
    const durationMs = Math.round(performance.now() - this.startedAt);
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    this.release();
    const recordedType = (rec.mimeType || pickRecorderMime() || 'audio/webm').split(';')[0];
    const raw = new Blob(this.chunks, { type: recordedType });
    this.chunks = [];
    if (recordedType.includes('webm') || recordedType.includes('ogg')) {
      try {
        return { blob: await transcodeToWav(raw), mime: 'audio/wav', durationMs };
      } catch {
        return { blob: raw, mime: recordedType, durationMs };
      }
    }
    return { blob: raw, mime: recordedType, durationMs };
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.release();
    this.chunks = [];
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}

const WAV_RATE = 16_000;

export async function transcodeToWav(blob: Blob): Promise<Blob> {
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * WAV_RATE));
    const offline = new OfflineAudioContext(1, frames, WAV_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), WAV_RATE);
  } finally {
    void ctx.close();
  }
}

export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
