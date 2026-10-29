#!/bin/bash
# Builds the iPhone app with Xcode and uploads it to App Store Connect, without EAS.
# Signing is automatic: Xcode fetches the certificate and profile with the same App Store Connect
# API key that eas.json uses (the key file stays in ~/.appstoreconnect/private_keys).
# The version comes from app.json (expo.version, ios.buildNumber): bump buildNumber before each upload.
set -euo pipefail
cd "$(dirname "$0")/.."
export LANG=en_US.UTF-8

read -r KEY_PATH KEY_ID ISSUER TEAM < <(node -e '
const ios = require("./eas.json").submit.production.ios;
console.log(ios.ascApiKeyPath.replace("$HOME", process.env.HOME), ios.ascApiKeyId, ios.ascApiKeyIssuerId, ios.appleTeamId);')
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER")
OUT=ios/build/release
mkdir -p "$OUT"

npx expo prebuild --platform ios </dev/null

xcodebuild -workspace ios/TecladoTV.xcworkspace -scheme TecladoTV -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/TecladoTV.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic "${AUTH[@]}" archive

cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${UPLOAD_DESTINATION:-upload}</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

# destination=upload sends the build to App Store Connect; UPLOAD_DESTINATION=export only writes the .ipa.
xcodebuild -exportArchive -archivePath "$OUT/TecladoTV.xcarchive" -exportPath "$OUT" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" "${AUTH[@]}"
echo "Listo. Apple tarda unos minutos en procesar la build; después: node scripts/app-store.mjs build"
