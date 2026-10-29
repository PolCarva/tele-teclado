import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { driverFor, type TvInfo } from '../brands';
import type { TvState } from '../tv/TvController';
import { Icon } from './Icon';
import { colors, radius, type } from './theme';

/** TVs found on the Wi-Fi, by name. Tap one to use it. */
export function TvList({
  state,
  onChoose,
  onRescan,
}: {
  state: TvState;
  onChoose: (tv: TvInfo) => void;
  onRescan: () => void;
}) {
  const { scanning, deep, tvs } = state.scan;
  // Keep the current TV in the list even if it didn't answer this scan.
  const list = [...tvs];
  if (state.tv && !list.some((tv) => tv.host === state.host)) list.unshift(state.tv);

  return (
    <View style={styles.wrap}>
      {list.map((tv) => {
        const current = tv.host === state.host;
        const live = current && (state.connection === 'ready' || state.connection === 'idle');
        return (
          <Pressable
            key={`${tv.brand}|${tv.host}`}
            onPress={() => onChoose(tv)}
            style={({ pressed }) => [styles.row, current && styles.rowCurrent, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${tv.name}${current ? ', tele actual' : ''}`}
          >
            <View style={[styles.tvIcon, current && styles.tvIconCurrent]}>
              <Icon name="tv" size={22} color={current ? colors.onFocus : colors.text} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>
                {tv.name}
              </Text>
              <Text style={styles.host} numberOfLines={1}>
                {[driverFor(tv.brand)?.label, tv.model, tv.host].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {current ? (
              <Text style={[styles.badge, { color: live ? colors.ok : colors.muted }]}>
                {live ? 'Conectada' : 'Elegida'}
              </Text>
            ) : (
              <Icon name="chevronRight" size={22} color={colors.faint} />
            )}
          </Pressable>
        );
      })}

      {scanning ? (
        <View style={styles.status}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.statusText}>
            {deep ? 'Buscando en cada dirección de tu Wi-Fi… puede tardar unos segundos.' : 'Buscando teles en tu Wi-Fi…'}
          </Text>
        </View>
      ) : list.length === 0 ? (
        <Text style={styles.statusText}>
          No encontré teles. Fijate que estén prendidas y conectadas a la misma Wi-Fi que el celular. Algunas
          teles tienen que tener activado el control desde el celular o la red (por ejemplo, Roku: «Control por apps
          móviles»; Sony: «Control remoto IP»).
          {Platform.OS === 'ios' ? ' En iPhone, la app también necesita el permiso «Red local».' : ''}
        </Text>
      ) : null}

      {!scanning ? (
        <View style={styles.actions}>
          <Pressable onPress={onRescan} style={styles.rescan} accessibilityRole="button">
            <Icon name="refresh" size={18} color={colors.accent} />
            <Text style={styles.rescanText}>Buscar de nuevo</Text>
          </Pressable>
          {Platform.OS === 'ios' && list.length === 0 ? (
            // iOS asks for "Local Network" only once; if it was denied, the switch is in the app's Settings.
            <Pressable onPress={() => void Linking.openSettings()} style={styles.rescan} accessibilityRole="button">
              <Text style={styles.rescanText}>Abrir Ajustes</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowCurrent: { borderColor: colors.focus },
  pressed: { opacity: 0.75 },
  tvIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tvIconCurrent: { backgroundColor: colors.focus },
  rowText: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: '600' },
  host: { color: colors.faint, fontSize: 12 },
  badge: { fontSize: 13, fontWeight: '600' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  statusText: { ...type.small, color: colors.muted },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  rescan: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 6 },
  rescanText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
