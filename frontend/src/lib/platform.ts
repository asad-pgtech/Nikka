/** Platform detection used for install guidance (spec F1). */

export const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = (): boolean => /Android/i.test(navigator.userAgent);

export const isStandalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const pushSupported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Captured early so the install button can trigger Chrome's prompt later. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as BeforeInstallPromptEvent;
    installListeners.forEach((l) => l());
  });
}

export const canPromptInstall = () => deferredInstall !== null;

export function onInstallAvailable(cb: () => void): () => void {
  installListeners.add(cb);
  return () => installListeners.delete(cb);
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredInstall) return false;
  await deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  return outcome === 'accepted';
}

/**
 * iOS fires visibilitychange when the native photo/camera picker opens. Callers mark the picker as
 * active so auto-lock does not discard the vault mid-selection.
 */
let pickerActiveUntil = 0;
export const markPickerActive = (ms = 120_000) => (pickerActiveUntil = Date.now() + ms);
export const clearPickerActive = () => (pickerActiveUntil = 0);
export const isPickerActive = () => Date.now() < pickerActiveUntil;
