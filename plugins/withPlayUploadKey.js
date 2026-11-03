// Signs the Google Play build (bundleRelease with -PtecladoPlay=true) with the upload key in
// ~/.teclado-tv/upload.properties. Every other release build (the GitHub APK) keeps the signature it
// always had, so it still installs over earlier versions. The key never lives in the repo.
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// teclado-tv: play upload key';

module.exports = function withPlayUploadKey(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;
    if (gradle.includes(MARK)) return cfg;
    gradle = gradle.replace(
      /signingConfigs \{\n/,
      `signingConfigs {
        ${MARK}
        upload {
            def props = new Properties()
            def file = new File(System.getProperty('user.home'), '.teclado-tv/upload.properties')
            if (file.exists()) {
                file.withInputStream { props.load(it) }
                storeFile new File(props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            }
        }
`,
    );
    gradle = gradle.replace(
      /(release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/,
      "$1signingConfig findProperty('tecladoPlay') ? signingConfigs.upload : signingConfigs.debug",
    );
    cfg.modResults.contents = gradle;
    return cfg;
  });
};
