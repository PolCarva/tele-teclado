import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { TvState } from '../tv/TvController';
import { tv } from '../tv/useTv';
import { colors, radius, type } from './theme';

/** "Connect by address": for a TV the search doesn't find. The app works out the brand. */
export function ManualAddress({ state, label, onDone }: { state: TvState; label: string; onDone?: () => void }) {
  const [address, setAddress] = useState('');
  const [checking, setChecking] = useState(false);

  const connect = async () => {
    if (!address.trim() || checking) return;
    setChecking(true);
    await tv.chooseAddress(address);
    setChecking(false);
    onDone?.();
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.field}
          value={address}
          onChangeText={setAddress}
          onSubmitEditing={() => void connect()}
          returnKeyType="go"
          placeholder={state.host || '192.168.0.10'}
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={Platform.OS === 'android' ? 'visible-password' : 'numbers-and-punctuation'}
          accessibilityLabel="Dirección IP de la tele"
        />
        <Pressable
          onPress={() => void connect()}
          style={({ pressed }) => [styles.button, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
          accessibilityLabel="Conectar a esa dirección"
        >
          {checking ? <ActivityIndicator color={colors.onFocus} /> : <Text style={styles.buttonText}>Conectar</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  label: { ...type.small, color: colors.muted },
  row: { flexDirection: 'row', gap: 10 },
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
  button: {
    backgroundColor: colors.focus,
    borderRadius: radius.sm,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  buttonText: { color: colors.onFocus, fontSize: 15, fontWeight: '700' },
});
