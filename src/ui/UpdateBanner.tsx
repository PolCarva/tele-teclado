import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AvailableUpdate } from '../update/updates';
import { Icon } from './Icon';
import { colors, radius, type } from './theme';

const HOW: Record<AvailableUpdate['source'], string> = {
  appstore: 'Actualizala desde la App Store para tener las últimas mejoras.',
  play: 'Se actualiza desde Google Play, sin salir de la app.',
  github: 'Bajá el APK nuevo y abrilo para instalarlo encima de esta versión.',
};

/** "Hay una versión nueva", with Actualizar and Ahora no. */
export function UpdateBanner({ update, onInstall, onLater }: { update: AvailableUpdate; onInstall: () => void; onLater: () => void }) {
  const title = update.version ? `Hay una versión nueva (${update.version})` : 'Hay una versión nueva';
  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.row}>
        <View style={styles.badge}>
          <Icon name="download" size={20} color={colors.accent} />
        </View>
        <View style={styles.text}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.body}>{HOW[update.source]}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={onLater}
          style={({ pressed }) => [styles.later, pressed && styles.pressed]}
          accessibilityRole="button"
          hitSlop={6}
        >
          <Text style={styles.laterText}>Ahora no</Text>
        </Pressable>
        <Pressable
          onPress={onInstall}
          style={({ pressed }) => [styles.install, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={update.source === 'github' ? 'Actualizar: baja el APK nuevo' : 'Actualizar'}
        >
          <Text style={styles.installText}>Actualizar</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 14,
  },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  badge: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  body: { ...type.small, color: colors.muted },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
  later: { paddingHorizontal: 14, height: 40, justifyContent: 'center' },
  laterText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  install: {
    backgroundColor: colors.focus,
    borderRadius: radius.pill,
    paddingHorizontal: 18,
    height: 40,
    justifyContent: 'center',
  },
  installText: { color: colors.onFocus, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.8 },
});
