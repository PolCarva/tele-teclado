// Dark, quiet palette in the spirit of Google TV: near-black, soft surfaces, white focus.

export const colors = {
  bg: '#0A0C10',
  glow: '#1F3D74',
  surface: '#14181F',
  surfaceRaised: '#1C212B',
  border: '#262C37',
  text: '#F1F3F6',
  muted: '#9AA3B1',
  faint: '#626B7A',
  accent: '#8AB4F8',
  /** TV-style focus: white fill, dark text. */
  focus: '#F1F3F6',
  onFocus: '#0A0C10',
  ok: '#5BD69B',
  warn: '#F6C453',
  bad: '#F28B82',
};

export const radius = { xl: 28, lg: 22, md: 16, sm: 12, pill: 999 };

export const type = {
  title: { fontSize: 30, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 20, fontWeight: '700' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
};
