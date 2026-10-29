import { useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { TvState } from '../tv/TvController';
import { tv } from '../tv/useTv';
import { colors, radius, type } from './theme';

const LENGTH = 6;

/** Pairing: the TV shows a 6-character code; it goes in six boxes here. */
export function PairingView({ state }: { state: TvState }) {
  const pairing = state.pairing!;
  const [code, setCode] = useState('');
  const [shownError, setShownError] = useState(pairing.error);
  const input = useRef<ComponentRef<typeof TextInput>>(null);

  // After a wrong code, start over with empty boxes.
  if (shownError !== pairing.error) {
    setShownError(pairing.error);
    if (pairing.error) setCode('');
  }

  const change = (next: string) => {
    const clean = next.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, LENGTH);
    setCode(clean);
    if (clean.length === LENGTH) void tv.submitCode(clean);
  };

  const waiting = pairing.phase === 'waiting_code' || pairing.phase === 'checking';

  return (
    <View style={styles.body}>
      <View style={styles.titles}>
        <Text style={styles.title}>Vinculá tu celular</Text>
        <Text style={styles.subtitle}>
          Escribí el código que aparece en {state.tvName || 'la tele'}. Se hace una sola vez.
        </Text>
      </View>

      {pairing.phase === 'requesting' ? (
        <View style={styles.inline}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.subtitle}>Pidiéndole el código a la tele…</Text>
        </View>
      ) : null}

      {waiting ? (
        <Pressable onPress={() => input.current?.focus()} style={styles.boxes} accessibilityLabel="Código de la tele">
          {Array.from({ length: LENGTH }, (_, i) => {
            const char = code[i] ?? '';
            const active = i === code.length && pairing.phase === 'waiting_code';
            return (
              <View key={i} style={[styles.box, active && styles.boxActive, char !== '' && styles.boxFilled]}>
                <Text style={styles.boxText}>{char}</Text>
              </View>
            );
          })}
          <TextInput
            ref={input}
            value={code}
            onChangeText={change}
            autoFocus
            autoCapitalize="characters"
            autoCorrect={false}
            keyboardType={Platform.OS === 'android' ? 'visible-password' : 'ascii-capable'}
            maxLength={LENGTH}
            editable={pairing.phase === 'waiting_code'}
            caretHidden
            style={styles.hiddenInput}
          />
        </Pressable>
      ) : null}

      {pairing.phase === 'checking' ? (
        <View style={styles.inline}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.subtitle}>Comprobando…</Text>
        </View>
      ) : null}
      {pairing.error ? <Text style={styles.error}>{pairing.error}</Text> : null}
      {pairing.phase === 'failed' ? (
        <Pressable
          onPress={() => tv.requestNewCode()}
          style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Pedir otro código</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 24, paddingTop: 12 },
  titles: { gap: 8 },
  title: { ...type.title, color: colors.text },
  subtitle: { ...type.body, color: colors.muted },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  boxes: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  box: {
    flex: 1,
    aspectRatio: 0.8,
    maxWidth: 58,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxFilled: { backgroundColor: colors.surfaceRaised },
  boxActive: { borderColor: colors.focus },
  boxText: { color: colors.text, fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hiddenInput: { position: 'absolute', opacity: 0, width: 1, height: 1 },
  error: { ...type.body, color: colors.bad },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.focus,
    borderRadius: radius.pill,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  buttonText: { color: colors.onFocus, fontSize: 16, fontWeight: '700' },
});
