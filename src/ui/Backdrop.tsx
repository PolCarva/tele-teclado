import { StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { colors } from './theme';

/** Soft blue glow at the top of the screen, like the light of a TV in a dark room. */
export function Backdrop() {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="glow" cx="50%" cy="-8%" rx="95%" ry="55%">
          <Stop offset="0" stopColor={colors.glow} stopOpacity="0.55" />
          <Stop offset="1" stopColor={colors.bg} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={colors.bg} />
      <Rect width="100%" height="100%" fill="url(#glow)" />
    </Svg>
  );
}
