import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import type { ChatMessage } from '@/domain/types';
import { useLongPress } from '@/hooks/useLongPress';
import { useSwipeReply } from '@/hooks/useSwipeReply';
import { downloadMedia, mediaUrl } from '@/services/media';
import { getController } from '@/services/session';
import { useChat } from '@/state/chat';
import { formatBytes, formatDuration, formatTime } from './format';

interface Props {
  msg: ChatMessage;
  replied?: ChatMessage;
  onActions: () => void;
  /** Swipe-to-reply handler; omit to disable the gesture. */
  onReply?: () => void;
  onRetry: () => void;
}

export const MessageBubble = memo(function MessageBubble({ msg, replied, onActions, onReply, onRetry }: Props) {
  const longPress = useLongPress(onActions, 500);
  const hintRef = useRef<HTMLSpanElement>(null);
  const onProgress = useCallback((p: number) => {
    const el = hintRef.current;
    if (!el) return;
    el.style.opacity = String(p);
    el.style.transform = `translateY(-50%) scale(${0.5 + p * 0.5})`;
  }, []);
  // Swipe toward the middle of the screen: incoming → right, outgoing → left.
  const swipe = useSwipeReply<HTMLDivElement>(msg.deleted ? undefined : onReply, msg.dir === 'out' ? -1 : 1, onProgress);
  return (
    <div className={`msg-row ${msg.dir}`} {...swipe.handlers}>
      {onReply && !msg.deleted && (
        <span className="swipe-hint" ref={hintRef} aria-hidden="true">
          <Icon name="reply" size={18} />
        </span>
      )}
      <div className={`bubble${msg.deleted ? ' deleted' : ''}`} ref={swipe.ref} {...longPress}>
        {replied && (
          <div className="reply">{replied.deleted ? 'Deleted message' : (replied.body ?? replied.caption ?? 'Attachment')}</div>
        )}
        {msg.deleted ? (
          'This message was deleted'
        ) : (
          <>
            {msg.media && <MediaContent msg={msg} />}
            {msg.kind === 'text' && msg.body}
            {msg.caption && <div>{msg.caption}</div>}
          </>
        )}
        <div className="meta">
          {formatTime(msg.ts)}
          {msg.dir === 'out' && <StatusIcon msg={msg} onRetry={onRetry} />}
        </div>
      </div>
    </div>
  );
});

function StatusIcon({ msg, onRetry }: { msg: ChatMessage; onRetry: () => void }) {
  switch (msg.status) {
    case 'sending':
      return <Icon name="clock" size={13} label="Sending" />;
    case 'sent':
      return <Icon name="check" size={14} label="Sent" />;
    case 'delivered':
      return <Icon name="doubleCheck" size={16} label="Delivered" />;
    case 'read':
      return (
        <span style={{ color: '#a5f3fc' }}>
          <Icon name="doubleCheck" size={16} label="Read" />
        </span>
      );
    case 'failed':
      return (
        <button
          onClick={onRetry}
          style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, display: 'inline-flex', gap: 2 }}
          aria-label="Failed to send. Tap to retry"
        >
          <Icon name="alert" size={14} /> Retry
        </button>
      );
    default:
      return null;
  }
}

function MediaContent({ msg }: { msg: ChatMessage }) {
  const media = msg.media!;
  const transfer = useChat((s) => s.transfers[msg.id]);
  const cachedUrl = useChat((s) => s.mediaUrls[media.blobId]);
  const [url, setUrl] = useState<string | null>(cachedUrl ?? null);
  const [missing, setMissing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const ctrl = getController();

  useEffect(() => {
    let alive = true;
    void mediaUrl(ctrl, media).then((u) => {
      if (!alive) return;
      setUrl(u);
      setMissing(!u);
    });
    return () => {
      alive = false;
    };
    // Re-check when a download completes (the message object is replaced).
  }, [ctrl, media, msg]);

  const download = () => void downloadMedia(ctrl, msg).catch(() => undefined);
  const progress = transfer && !transfer.error ? Math.round((transfer.done / transfer.total) * 100) : null;
  const preview = media.thumb;

  const progressBar =
    progress !== null ? (
      <div className="progress" aria-label={`Transfer ${progress}%`}>
        <div style={{ width: `${progress}%` }} />
      </div>
    ) : null;

  if (!url) {
    return (
      <div>
        {preview && <img className="media" src={preview} alt="" style={{ filter: 'blur(2px)' }} />}
        <div className="attachment">
          <Icon name={media.kind === 'audio' ? 'mic' : media.kind === 'file' ? 'file' : 'image'} />
          <div className="grow small">
            <div className="ellipsis">{media.name ?? labelFor(media.kind)}</div>
            <div className="tiny" style={{ opacity: 0.8 }}>
              {msg.mediaExpired ? 'No longer available' : formatBytes(media.size)}
              {media.durationMs ? ` · ${formatDuration(media.durationMs)}` : ''}
            </div>
          </div>
          {msg.dir === 'in' && missing && !msg.mediaExpired && progress === null && (
            <button className="icon-btn" onClick={download} aria-label="Download" style={{ color: 'inherit' }}>
              <Icon name="download" />
            </button>
          )}
        </div>
        {progressBar}
      </div>
    );
  }

  let body: JSX.Element;
  switch (media.kind) {
    case 'image':
    case 'gif':
      body = (
        <button onClick={() => setFullscreen(true)} style={{ padding: 0, border: 'none', background: 'none', display: 'block', width: '100%' }} aria-label="Open image">
          <img className="media" src={url} alt={media.name ?? 'Photo'} />
        </button>
      );
      break;
    case 'video':
      body = <video className="media" src={url} poster={preview} controls playsInline preload="metadata" />;
      break;
    case 'audio':
      body = (
        <div className="stack" style={{ gap: 2 }}>
          <audio src={url} controls preload="metadata" />
          {media.durationMs ? <span className="tiny">{formatDuration(media.durationMs)}</span> : null}
        </div>
      );
      break;
    default:
      body = (
        <a className="attachment" href={url} download={media.name ?? 'file'} style={{ color: 'inherit' }}>
          <Icon name="file" />
          <div className="grow small">
            <div className="ellipsis">{media.name ?? 'File'}</div>
            <div className="tiny">{formatBytes(media.size)}</div>
          </div>
        </a>
      );
  }

  return (
    <>
      {body}
      {progressBar}
      {fullscreen && (
        <div className="lightbox" onClick={() => setFullscreen(false)} role="dialog" aria-label="Image viewer">
          <button className="icon-btn close" aria-label="Close" onClick={() => setFullscreen(false)}>
            <Icon name="close" />
          </button>
          <img src={url} alt={media.name ?? 'Photo'} />
        </div>
      )}
    </>
  );
}

function labelFor(kind: string): string {
  return { image: 'Photo', video: 'Video', audio: 'Voice message', gif: 'GIF', file: 'File' }[kind] ?? 'File';
}
