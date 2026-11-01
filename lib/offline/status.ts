// Täckningsläget, delat mellan raden högst upp (OfflineBar) och sidorna som
// behöver veta om de visar sparad information (t.ex. jouren).
import { useSyncExternalStore } from 'react';

export type NetState = {
  offline: boolean;        // servern nås inte, appen visar sparat
  back: boolean;           // täckningen kom tillbaka efter att ha varit borta
  savedAt: number | null;  // äldsta sparade som visas
  miss: boolean;           // något på sidan fanns inte sparat
};

const initial: NetState = { offline: false, back: false, savedAt: null, miss: false };
let state: NetState = initial;
const subs = new Set<() => void>();

export const netState = () => state;

export function setNetState(patch: Partial<NetState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => { subs.delete(f); };
}

export function useNetState(): NetState {
  return useSyncExternalStore(subscribe, netState, () => initial);
}
