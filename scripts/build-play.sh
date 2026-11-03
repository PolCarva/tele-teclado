#!/bin/bash
# Builds the Google Play bundle into dist/Teclado-TV.aab, signed with the upload key in
# ~/.teclado-tv/upload.properties (Google re-signs it with the app key). Keep that folder backed up.
set -euo pipefail
cd "$(dirname "$0")/.."

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

if [ ! -f "$HOME/.teclado-tv/upload.properties" ]; then
  echo "Falta la clave de subida de Google Play en ~/.teclado-tv/upload.properties" >&2
  exit 1
fi

npx expo prebuild --platform android --no-install </dev/null
(cd android && ./gradlew bundleRelease --console=plain -PtecladoPlay=true)
mkdir -p dist
cp android/app/build/outputs/bundle/release/app-release.aab dist/Teclado-TV.aab
echo "AAB: $(pwd)/dist/Teclado-TV.aab"
