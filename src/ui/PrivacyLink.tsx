import { Linking, Pressable, StyleSheet, Text } from 'react-native';

import { colors } from './theme';

export const PRIVACY_URL = 'https://polcarva.github.io/tele-teclado/privacidad.html';

/** The privacy policy (Apple asks for it inside the app too). */
export function PrivacyLink() {
  return (
    <Pressable onPress={() => void Linking.openURL(PRIVACY_URL)} style={styles.link} accessibilityRole="link" hitSlop={8}>
      <Text style={styles.text}>Política de privacidad · la app no recopila datos</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { alignSelf: 'flex-start', paddingVertical: 4 },
  text: { color: colors.faint, fontSize: 13 },
});
