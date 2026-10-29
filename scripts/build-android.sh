#!/bin/bash
# Builds the installable APK into dist/Teclado-TV.apk (no Metro needed to run it).
set -euo pipefail
cd "$(dirname "$0")/.."

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

npx expo prebuild --platform android --no-install </dev/null
# Phones are ARM; leaving out x86 keeps the APK small.
(cd android && ./gradlew assembleRelease --console=plain -PreactNativeArchitectures=arm64-v8a,armeabi-v7a)
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk dist/Teclado-TV.apk
echo "APK: $(pwd)/dist/Teclado-TV.apk"
