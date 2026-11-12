import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Sheet } from '@/components/ui';
import type { ChatMessage } from '@/domain/types';
import { VoiceRecorder } from '@/lib/media/voice';
import { clearPickerActive, markPickerActive } from '@/lib/platform';
import { prepareFile, sendMedia } from '@/services/media';
import { getController } from '@/services/session';
import { formatDuration } from './format';

interface Props {
  peer: string;
  replyTo: ChatMessage | null;
  onClearReply: () => void;
}

export function Composer({ peer, replyTo, onClearReply }: Props) {
  const [text, setText] = useState('');
  const [showAttach, setShowAttach] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<VoiceRecorder | null>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ctrl = getController();

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setElapsed(recorder.current?.elapsedMs ?? 0), 250);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => () => recorder.current?.cancel(), []);

  const sendText = () => {
    if (!text.trim()) return;
    void ctrl.sendText(peer, text, replyTo?.id);
    setText('');
    onClearReply();
  };

  const pick = (input: HTMLInputElement | null) => {
    setShowAttach(false);
    markPickerActive();
    input?.click();
  };

  const onFiles = async (files: FileList | null) => {
    clearPickerActive();
    if (!files?.length) return;
    setError('');
    for (const file of Array.from(files)) {
      if (file.size > ctrl.config.max_file_bytes) {
        setError(`"${file.name}" is larger than ${Math.round(ctrl.config.max_file_bytes / 1024 / 1024)} MB.`);
        continue;
      }
      try {
        const prepared = await prepareFile(file);
        void sendMedia(ctrl, peer, prepared, undefined, replyTo?.id).catch(() => undefined);
      } catch {
        setError('Could not attach that file.');
      }
    }
    onClearReply();
  };

  const startRecording = async () => {
    setError('');
    try {
      const r = new VoiceRecorder();
      await r.start();
      recorder.current = r;
      setElapsed(0);
      setRecording(true);
    } catch {
      setError('Microphone unavailable. Allow microphone access in settings.');
    }
  };

  const stopRecording = async (send: boolean) => {
    const r = recorder.current;
    recorder.current = null;
    setRecording(false);
    if (!r) return;
    if (!send) {
      r.cancel();
      return;
    }
    const rec = await r.stop();
    if (!rec || rec.durationMs < 500) return;
    const ext = rec.mime.includes('mp4') || rec.mime.includes('aac') ? 'm4a' : rec.mime.includes('wav') ? 'wav' : 'webm';
    const file = new File([rec.blob], `voice.${ext}`, { type: rec.mime });
    const prepared = await prepareFile(file, { kind: 'audio', durationMs: rec.durationMs, name: undefined });
    void sendMedia(ctrl, peer, prepared, undefined, replyTo?.id).catch(() => undefined);
    onClearReply();
  };

  return (
    <>
      {replyTo && (
        <div className="reply-preview">
          <Icon name="reply" size={16} />
          <span className="grow ellipsis">{replyTo.body ?? replyTo.caption ?? 'Attachment'}</span>
          <button className="icon-btn" onClick={onClearReply} aria-label="Cancel reply">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}
      {error && (
        <div className="error-text" role="alert" style={{ padding: '4px 12px' }}>
          {error}
        </div>
      )}
      <div className="composer">
        {recording ? (
          <>
            <button className="icon-btn" onClick={() => void stopRecording(false)} aria-label="Cancel recording">
              <Icon name="trash" />
            </button>
            <div className="recording" role="status">
              <span className="rec-dot" /> {formatDuration(elapsed)}
            </div>
            <button className="icon-btn" onClick={() => void stopRecording(true)} aria-label="Send voice message">
              <Icon name="send" />
            </button>
          </>
        ) : (
          <>
            <button className="icon-btn" onClick={() => setShowAttach(true)} aria-label="Attach">
              <Icon name="attach" />
            </button>
            <textarea
              rows={1}
              value={text}
              placeholder="Message"
              aria-label="Message"
              maxLength={8000}
              onChange={(e) => {
                setText(e.target.value);
                if (e.target.value) ctrl.sendTyping(peer, true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
                  e.preventDefault();
                  sendText();
                }
              }}
            />
            {text.trim() ? (
              <button className="icon-btn" onClick={sendText} aria-label="Send">
                <Icon name="send" />
              </button>
            ) : (
              <button className="icon-btn" onClick={() => void startRecording()} aria-label="Record voice message">
                <Icon name="mic" />
              </button>
            )}
          </>
        )}
      </div>

      <input ref={libraryInput} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => void onFiles(e.target.files).finally(() => (e.target.value = ''))} />
      <input ref={cameraInput} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => void onFiles(e.target.files).finally(() => (e.target.value = ''))} />
      <input ref={fileInput} type="file" hidden onChange={(e) => void onFiles(e.target.files).finally(() => (e.target.value = ''))} />

      {showAttach && (
        <Sheet onClose={() => setShowAttach(false)}>
          <button className="menu-item" onClick={() => pick(libraryInput.current)}>
            Photo or video
          </button>
          <button className="menu-item" onClick={() => pick(cameraInput.current)}>
            Camera
          </button>
          <button className="menu-item" onClick={() => pick(fileInput.current)}>
            File, audio or GIF
          </button>
          <button className="menu-item" onClick={() => setShowAttach(false)}>
            Cancel
          </button>
        </Sheet>
      )}
    </>
  );
}
