import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { appById } from '../tv/apps';
import type { TvState } from '../tv/TvController';
import { tv } from '../tv/useTv';
import { AppIcon } from './AppIcon';
import { AppSheet, isOpenOnTv, targetName } from './AppSheet';
import { Icon } from './Icon';
import { colors, radius, type } from './theme';

/** Main screen: the text box, where to search, and the search button. */
export function TypingView({ state }: { state: TvState }) {
  const [text, setText] = useState('');
  const [clearToken, setClearToken] = useState(state.clearToken);
  const [focused, setFocused] = useState(false);
  const [picking, setPicking] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);

  const [remoteToken, setRemoteToken] = useState(state.remoteText?.token ?? 0);

  // The controller asks to empty the box (search sent, TV changed app…).
  if (clearToken !== state.clearToken) {
    setClearToken(state.clearToken);
    setText('');
  }
  // The TV field already has text (its keyboard just opened): continue from there.
  if (state.remoteText && remoteToken !== state.remoteText.token) {
    setRemoteToken(state.remoteText.token);
    setText(state.remoteText.text);
  }

  // Keep the keyboard up: open the app and type.
  useEffect(() => {
    // Two tries: right after pairing, Android may ignore the first one while the previous screen goes away.
    const focus = () => {
      setTimeout(() => input.current?.focus(), 250);
      setTimeout(() => input.current?.focus(), 900);
    };
    focus();
    const sub = AppState.addEventListener('change', (next) => next === 'active' && focus());
    return () => sub.remove();
  }, []);

  const change = (next: string) => {
    setText(next);
    tv.setText(next);
  };
  const submit = () => {
    tv.submit();
    input.current?.focus();
  };

  const target = state.target;
  const openOnTv = isOpenOnTv(target, state.tvApp);

  return (
    <View style={styles.body}>
      <View style={[styles.field, focused && styles.fieldFocused]}>
        <TextInput
          ref={input}
          style={styles.input}
          value={text}
          onChangeText={change}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="¿Qué querés buscar?"
          placeholderTextColor={colors.faint}
          returnKeyType={state.compose ? 'send' : state.appLinks ? 'search' : 'done'}
          submitBehavior="submit"
          onSubmitEditing={submit}
          autoFocus
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          accessibilityLabel="Texto para la tele"
        />
        {text ? (
          <Pressable
            onPress={() => {
              change('');
              input.current?.focus();
            }}
            hitSlop={10}
            style={styles.clear}
            accessibilityRole="button"
            accessibilityLabel="Borrar"
          >
            <Icon name="close" size={18} color={colors.text} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.actions}>
        {state.appLinks ? (
          <Pressable
            onPress={() => setPicking(true)}
            style={({ pressed }) => [styles.appChip, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Buscar en ${targetName(target)}. Tocá para cambiar.`}
          >
            <AppIcon id={target} size={34} />
            <View style={styles.appChipText}>
              <Text style={styles.caption} numberOfLines={1}>
                {openOnTv ? 'En la tele' : 'Buscar en'}
              </Text>
              <Text style={styles.appName} numberOfLines={1}>
                {targetName(target)}
              </Text>
            </View>
            <Icon name="chevronDown" size={20} color={colors.muted} />
          </Pressable>
        ) : null}
        {state.appLinks || state.compose || state.canSubmit ? (
          <Pressable
            onPress={submit}
            style={({ pressed }) => [styles.primary, !state.appLinks && styles.primaryWide, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={submitLabel(state)}
          >
            <Icon
              name={state.compose ? 'send' : target === 'enter' || !state.appLinks ? 'keyboardReturn' : 'search'}
              size={20}
              color={colors.onFocus}
            />
            <Text style={styles.primaryText}>{submitLabel(state)}</Text>
          </Pressable>
        ) : null}
        {state.compose && state.canSubmit ? (
          <Pressable
            onPress={() => {
              tv.pressEnter();
              input.current?.focus();
            }}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Enter en la tele"
          >
            <Icon name="keyboardReturn" size={20} color={colors.text} />
            <Text style={styles.secondaryText}>Enter</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.hint}>{hintFor(state)}</Text>

      <AppSheet
        visible={picking && state.appLinks}
        state={state}
        onPick={(id) => tv.setTarget(id)}
        onClose={() => {
          setPicking(false);
          setTimeout(() => input.current?.focus(), 250);
        }}
      />
    </View>
  );
}

function submitLabel(state: TvState): string {
  if (state.compose) return 'Enviar';
  if (!state.appLinks) return 'Enter';
  const app = appById(state.target);
  if (!app) return 'Enter';
  if (app.opensOnly) return app.packages.includes(state.tvApp) ? 'Escribir' : 'Abrir';
  return 'Buscar';
}

function hintFor(state: TvState): string {
  if (state.problem) return state.problem;
  if (state.connection === 'offline') {
    return `No encuentro ${state.tvName || 'la tele'}. Fijate que esté prendida y en la misma Wi-Fi.`;
  }
  if (state.compose) {
    return `Abrí un buscador o un campo de texto en la tele. Escribí acá y tocá «Enviar»: ${state.brandLabel || 'esta tele'} no deja borrar desde el celular, así que el texto va completo de una vez.`;
  }
  if (!state.appLinks && state.tvKeyboard === false) {
    return 'Abrí un buscador o un campo de texto en la tele: cuando aparezca su teclado, lo que escribas acá aparece ahí.';
  }
  if (!state.appLinks) {
    return state.canSubmit
      ? 'Abrí un buscador o un campo de texto en la tele: lo que escribas aparece ahí. «Enter» lo confirma.'
      : 'Abrí un buscador o un campo de texto en la tele: lo que escribas aparece ahí. Para buscar, usá el control de la tele.';
  }
  const app = appById(state.target);
  if (!app) return 'Lo que escribas aparece en el campo de texto abierto en la tele. «Enter» lo confirma.';
  if (app.opensOnly) {
    return app.packages.includes(state.tvApp)
      ? `${app.name} no deja abrir su búsqueda desde el celular: abrila con el control y tocá «Escribir». Después, lo que escribas aparece ahí.`
      : `«Abrir» abre ${app.name} en la tele. Después abrí su búsqueda con el control y tocá «Escribir».`;
  }
  if (app.typeAfterOpen) return `${app.name} abre su búsqueda y escribe el texto unos segundos después.`;
  if (app.packages.includes(state.tvApp)) return `Lo que escribas aparece en ${app.name}. «Buscar» muestra los resultados.`;
  return `«Buscar» abre ${app.name} en la tele con lo que escribiste.`;
}

const styles = StyleSheet.create({
  body: { gap: 16 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingLeft: 20,
    paddingRight: 14,
    minHeight: 84,
  },
  fieldFocused: { borderColor: colors.accent },
  input: { flex: 1, color: colors.text, fontSize: 26, fontWeight: '500', paddingVertical: 18 },
  clear: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flexDirection: 'row', gap: 10 },
  appChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: 10,
    paddingRight: 14,
    height: 58,
  },
  appChipText: { flex: 1 },
  caption: { color: colors.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase' },
  appName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.focus,
    borderRadius: radius.pill,
    paddingHorizontal: 22,
    height: 58,
  },
  primaryWide: { flex: 1, justifyContent: 'center' },
  secondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 20,
    height: 58,
  },
  secondaryText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  primaryText: { color: colors.onFocus, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.8 },
  hint: { ...type.small, color: colors.muted, paddingHorizontal: 4 },
});
