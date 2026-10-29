import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { TvState } from '../tv/TvController';
import { tv } from '../tv/useTv';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { TvList } from './TvList';
import { colors, radius, type } from './theme';

/** "Tu tele": the TVs on the Wi-Fi, plus a manual address and re-pairing under "Avanzado". */
export function TvSheet({ visible, state, onClose }: { visible: boolean; state: TvState; onClose: () => void }) {
  const [advanced, setAdvanced] = useState(false);
  const [address, setAddress] = useState('');

  return (
    <Sheet visible={visible} title="Tu tele" subtitle="Teles encontradas en tu Wi-Fi" onClose={onClose}>
      <TvList
        state={state}
        onChoose={(found) => {
          tv.chooseTv(found);
          onClose();
        }}
        onRescan={() => void tv.scanTvs()}
      />

      <Pressable onPress={() => setAdvanced((v) => !v)} style={styles.advancedToggle} accessibilityRole="button">
        <Text style={styles.advancedText}>Avanzado</Text>
        <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={18} color={colors.muted} />
      </Pressable>

      {advanced ? (
        <View style={styles.advanced}>
          <Text style={styles.label}>Conectar por dirección (si la tele no aparece)</Text>
          <View style={styles.addressRow}>
            <TextInput
              style={styles.field}
              value={address}
              onChangeText={setAddress}
              placeholder={state.host || '192.168.0.10'}
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={Platform.OS === 'android' ? 'visible-password' : 'numbers-and-punctuation'}
              accessibilityLabel="Dirección de la tele"
            />
            <Pressable
              onPress={() => {
                if (!address.trim()) return;
                tv.chooseTv({ name: address.trim(), host: address.trim() });
                onClose();
              }}
              style={({ pressed }) => [styles.smallButton, pressed && { opacity: 0.8 }]}
              accessibilityRole="button"
            >
              <Text style={styles.smallButtonText}>Conectar</Text>
            </Pressable>
          </View>
          {state.host ? (
            <Pressable
              onPress={() => {
                void tv.pairAgain();
                onClose();
              }}
              style={styles.link}
              accessibilityRole="button"
            >
              <Text style={styles.linkText}>Volver a vincular con {state.tvName}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  advancedToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  advancedText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  advanced: { gap: 10 },
  label: { ...type.small, color: colors.muted },
  addressRow: { flexDirection: 'row', gap: 10 },
  field: {
    flex: 1,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  smallButton: {
    backgroundColor: colors.focus,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  smallButtonText: { color: colors.onFocus, fontSize: 15, fontWeight: '700' },
  link: { paddingVertical: 4 },
  linkText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
