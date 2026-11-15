/** Top-level app phase. Holds no secrets: the controller (with keys) lives in services/session.ts. */
import { create } from 'zustand';

export type Phase = 'boot' | 'onboarding' | 'tasks' | 'lock' | 'unlocking' | 'unlocked';

interface SessionState {
  phase: Phase;
  /** Opaque push reference carried from a notification tap (spec F9). */
  pendingRef: string | null;
  /** Decoy task a notification said is "due today" (cosmetic, not persisted). */
  dueTodayTaskId: string | null;
  setPhase: (p: Phase) => void;
  setPendingRef: (ref: string | null) => void;
  setDueTodayTaskId: (id: string | null) => void;
}

export const useSession = create<SessionState>((set) => ({
  phase: 'boot',
  pendingRef: null,
  dueTodayTaskId: null,
  setPhase: (phase) => set({ phase }),
  setPendingRef: (pendingRef) => set({ pendingRef }),
  setDueTodayTaskId: (dueTodayTaskId) => set({ dueTodayTaskId }),
}));
