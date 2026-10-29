import { Pressable, StyleSheet, Text, View } from 'react-native';

import { appById, SEARCH_APPS, type TargetId } from '../tv/apps';
import type { TvState } from '../tv/TvController';
import { AppIcon } from './AppIcon';
import { Sheet } from './Sheet';
import { colors, radius } from './theme';

const TARGETS: TargetId[] = [...SEARCH_APPS.map((app) => app.id), 'enter'];

export function targetName(id: TargetId): string {
  return appById(id)?.name ?? 'App abierta';
}

export function isOpenOnTv(id: TargetId, tvApp: string): boolean {
  return !!appById(id)?.packages.includes(tvApp);
}

/** "Buscar en": the apps as a row of tiles, like the TV's app row, with a white focus ring. */
export function AppSheet({
  visible,
  state,
  onPick,
  onClose,
}: {
  visible: boolean;
  state: TvState;
  onPick: (id: TargetId) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      title="Buscar en"
      subtitle="Se elige sola según lo que esté abierto en la tele. Si elegís otra, queda hasta que la tele cambie de app."
      onClose={onClose}
    >
      <View style={styles.grid}>
        {TARGETS.map((id) => {
          const selected = id === state.target;
          const open = isOpenOnTv(id, state.tvApp);
          return (
            <Pressable
              key={id}
              onPress={() => {
                onPick(id);
                onClose();
              }}
              style={({ pressed }) => [styles.tile, selected && styles.tileSelected, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${targetName(id)}${open ? ', abierta en la tele' : ''}`}
            >
              <AppIcon id={id} size={58} />
              <Text style={styles.label} numberOfLines={1}>
                {targetName(id)}
              </Text>
              <Text style={[styles.note, open && styles.noteOpen]} numberOfLines={1}>
                {open ? 'En la tele' : id === 'enter' ? 'Con Enter' : appById(id)?.opensOnly ? 'Solo abre' : ' '}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 },
  tile: {
    width: '25%',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  tileSelected: { borderColor: colors.focus, backgroundColor: colors.surfaceRaised },
  pressed: { opacity: 0.75 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600' },
  note: { color: colors.faint, fontSize: 11 },
  noteOpen: { color: colors.ok },
});
