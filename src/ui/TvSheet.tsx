import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TvState } from '../tv/TvController';
import { tv } from '../tv/useTv';
import { Icon } from './Icon';
import { ManualAddress } from './ManualAddress';
import { PrivacyLink } from './PrivacyLink';
import { Sheet } from './Sheet';
import { TvList } from './TvList';
import { colors } from './theme';

/** "Tu tele": the TVs on the Wi-Fi, plus a manual address and re-pairing under "Avanzado". */
export function TvSheet({ visible, state, onClose }: { visible: boolean; state: TvState; onClose: () => void }) {
  const [advanced, setAdvanced] = useState(false);

  return (
    <Sheet visible={visible} title="Tu tele" subtitle="Teles encontradas en tu Wi-Fi" onClose={onClose}>
      <TvList
        state={state}
        onChoose={(found) => {
          tv.chooseTv(found);
          onClose();
        }}
        onRescan={() => void tv.scanTvs({ deep: true })}
      />

      <Pressable onPress={() => setAdvanced((v) => !v)} style={styles.advancedToggle} accessibilityRole="button">
        <Text style={styles.advancedText}>Avanzado</Text>
        <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={18} color={colors.muted} />
      </Pressable>

      {advanced ? (
        <View style={styles.advanced}>
          <ManualAddress state={state} label="Conectar por dirección (si la tele no aparece)" onDone={onClose} />
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
          <PrivacyLink />
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  advancedToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  advancedText: { color: colors.muted, fontSize: 15, fontWeight: '600' },
  advanced: { gap: 10 },
  link: { paddingVertical: 4 },
  linkText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
