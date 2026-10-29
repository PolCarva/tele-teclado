import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { TvState } from './src/tv/TvController';
import { tv, useTv } from './src/tv/useTv';
import { Backdrop } from './src/ui/Backdrop';
import { Icon } from './src/ui/Icon';
import { PairingView } from './src/ui/PairingView';
import { TvList } from './src/ui/TvList';
import { TvSheet } from './src/ui/TvSheet';
import { TypingView } from './src/ui/TypingView';
import { colors, radius, type } from './src/ui/theme';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const state = useTv();
  const insets = useSafeAreaInsets();
  const [tvSheet, setTvSheet] = useState(false);

  return (
    <View style={styles.root}>
      <Backdrop />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          {state.needsTv ? (
            <ChooseTv state={state} />
          ) : (
            <>
              <Header state={state} onPress={() => setTvSheet(true)} />
              {state.pairing ? <PairingView state={state} /> : <TypingView state={state} />}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <TvSheet visible={tvSheet} state={state} onClose={() => setTvSheet(false)} />
    </View>
  );
}

/** The TV in use and its status. Tap to see the TVs on the Wi-Fi. */
function Header({ state, onPress }: { state: TvState; onPress: () => void }) {
  const { color, label } = state.pairing
    ? { color: colors.warn, label: state.pairing.phase === 'waiting_accept' ? 'Esperando permiso' : 'Falta vincular' }
    : state.connection === 'ready' || state.connection === 'idle'
      ? { color: colors.ok, label: 'Conectada' }
      : state.connection === 'offline'
        ? { color: colors.bad, label: 'Sin conexión' }
        : { color: colors.warn, label: 'Conectando…' };
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.header, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
      accessibilityLabel={`${state.tvName}, ${label}. Tocá para elegir otra tele.`}
    >
      <View style={styles.tvBadge}>
        <Icon name="tv" size={22} color={colors.text} />
      </View>
      <View style={styles.headerText}>
        <Text style={styles.tvName} numberOfLines={1}>
          {state.tvName || 'Tu tele'}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={styles.statusText} numberOfLines={1}>
            {state.brandLabel ? `${label} · ${state.brandLabel}` : label}
          </Text>
        </View>
      </View>
      <Icon name="chevronDown" size={22} color={colors.muted} />
    </Pressable>
  );
}

/** First run: pick the TV from the ones on the Wi-Fi. */
function ChooseTv({ state }: { state: TvState }) {
  return (
    <View style={styles.choose}>
      <Text style={styles.brand}>Teclado TV</Text>
      <View style={styles.chooseTitles}>
        <Text style={styles.title}>Elegí tu tele</Text>
        <Text style={styles.subtitle}>Estas son las teles que encontré en tu Wi-Fi.</Text>
      </View>
      <TvList state={state} onChoose={(found) => tv.chooseTv(found)} onRescan={() => void tv.scanTvs({ deep: true })} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { paddingHorizontal: 18, gap: 22 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  tvBadge: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1, gap: 2 },
  tvName: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: colors.muted, fontSize: 13 },
  choose: { gap: 22 },
  brand: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  chooseTitles: { gap: 8 },
  title: { ...type.title, color: colors.text },
  subtitle: { ...type.body, color: colors.muted },
});
