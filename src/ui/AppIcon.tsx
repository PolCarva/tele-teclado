import { Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { ICON_PATHS } from '../tv/appIcons';
import type { TargetId } from '../tv/apps';

// Material "keyboard_return" glyph (Apache 2.0), for "type and press Enter".
const ENTER_PATH = 'M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z';

type IconStyle = { bg: string; fg: string; path?: string; text?: string; scale?: number; border?: boolean };

const ICONS: Record<TargetId, IconStyle> = {
  youtube: { bg: '#FF0000', fg: '#FFFFFF', path: ICON_PATHS.youtube },
  netflix: { bg: '#000000', fg: '#E50914', path: ICON_PATHS.netflix, border: true },
  prime: { bg: '#00A8E1', fg: '#FFFFFF', text: 'prime' },
  disney: { bg: '#0B1A4A', fg: '#FFFFFF', text: 'D+' },
  max: { bg: '#000000', fg: '#FFFFFF', path: ICON_PATHS.hbomax, scale: 0.86, border: true },
  stremio: { bg: '#685CEE', fg: '#FFFFFF', path: ICON_PATHS.stremio },
  enter: { bg: '#2A303B', fg: '#F2F4F7', path: ENTER_PATH },
};

// The App Store build shows neutral initials instead of the apps' logos and colors: App Review
// can flag third-party logos (guideline 5.2.1). The names next to them still say which app it is.
const NEUTRAL = { bg: '#2A303B', fg: '#F2F4F7' };
const INITIALS: Record<TargetId, IconStyle> = {
  youtube: { ...NEUTRAL, text: 'Y' },
  netflix: { ...NEUTRAL, text: 'N' },
  prime: { ...NEUTRAL, text: 'P' },
  disney: { ...NEUTRAL, text: 'D' },
  max: { ...NEUTRAL, text: 'M' },
  stremio: { ...NEUTRAL, text: 'S' },
  enter: ICONS.enter,
};

/** Rounded square with the app's logo, in the app's colors (initials on iPhone). */
export function AppIcon({ id, size = 36 }: { id: TargetId; size?: number }) {
  const icon = (Platform.OS === 'ios' ? INITIALS : ICONS)[id];
  const glyph = size * (icon.scale ?? 0.6);
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: size * 0.24, backgroundColor: icon.bg },
        icon.border && styles.border,
      ]}
    >
      {icon.path ? (
        <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <Path d={icon.path} fill={icon.fg} />
        </Svg>
      ) : (
        <Text
          style={{ color: icon.fg, fontWeight: '800', fontSize: size * ((icon.text?.length ?? 0) > 2 ? 0.3 : 0.42) }}
          allowFontScaling={false}
        >
          {icon.text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  border: { borderWidth: 1, borderColor: '#2A303B' },
});
