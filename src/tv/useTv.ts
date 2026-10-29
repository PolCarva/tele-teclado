import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { nativeTransport, settings } from './nativeTransport';
import { TvController, type TvState } from './TvController';

// One controller for the whole app: one connection to the TV.
export const tv = new TvController(nativeTransport, settings);

/** Current TV state; connects while the app is on screen and lets go in the background. */
export function useTv(): TvState {
  const [state, setState] = useState(tv.getState());

  useEffect(() => tv.subscribe(setState), []);

  useEffect(() => {
    tv.setActive(AppState.currentState === 'active');
    const sub = AppState.addEventListener('change', (next) => tv.setActive(next === 'active'));
    return () => sub.remove();
  }, []);

  return state;
}
