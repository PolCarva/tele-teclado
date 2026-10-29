# Teclado TV

App para el celular (Android y iPhone): escribís en una caja de texto y aparece en la tele, por ejemplo en la búsqueda de YouTube, o busca directo en la app que elijas.

Habla directo con la tele por la Wi-Fi, con el mismo protocolo que usa el control remoto de Google ("Android TV Remote v2"). Funciona con teles Android TV y Google TV (probada con una TCL Android TV 11). No necesita la Mac prendida ni nada instalado en la tele.

## Cómo se usa

- **La tele se encuentra sola.** La primera vez, la app busca las teles de tu Wi-Fi: si hay una sola, la usa; si hay varias, te las muestra por nombre (el que tiene la tele, por ejemplo "Living TV"). Arriba en la pantalla está el nombre de la tele y su estado; tocándolo ves las teles de la Wi-Fi y podés cambiar. Si la tele cambia de dirección IP, la app la vuelve a encontrar sola.
- Abrís la app y el teclado ya está abierto. Escribís y tocás **Buscar** (o la tecla de buscar del teclado del celular). La cruz dentro de la caja borra lo escrito, también en la tele.
- **Buscar en:** el selector con íconos elige en qué app se busca: YouTube, Netflix, Prime Video, Disney+, HBO Max, Stremio, o "App abierta (Enter)".
  - Sigue solo a la tele: si en la tele está abierta una de esas apps, la elige ("En la tele"). En la pantalla de inicio elige YouTube. En cualquier otra app elige "App abierta", que escribe en el campo de la tele y aprieta Enter.
  - Si elegís otra a mano, queda elegida hasta que la tele cambie de app. Por ejemplo: estás en YouTube, elegís Prime Video y tocás Buscar; la tele abre Prime Video con la búsqueda.
- Mientras escribís en la misma app que está abierta en la tele, el texto aparece en la tele al instante. Si elegiste otra app, el texto se manda recién al tocar Buscar.
- **Tildes y ñ:** YouTube, HBO Max y Netflix las descartan, así que mientras escribís ahí la app manda la letra sin tilde (ñ → n). En YouTube y las apps con enlace de búsqueda, al tocar Buscar la búsqueda sí va con tildes.
- Disney+ (y a veces otras) puede pedir elegir perfil la primera vez que se abre; después sigue sola a la búsqueda.
- **HBO Max** abre su búsqueda y escribe el texto unos segundos después (en frío puede tardar hasta 20 s).
- **Netflix** no deja abrir su búsqueda desde afuera. Con Netflix elegida, el botón dice **Abrir** (abre la app y conserva el texto). Ya en Netflix, abrí su búsqueda con el control de la tele (la lupa) y tocá **Escribir**: el texto aparece ahí y, desde ese momento, lo que escribas se ve en vivo.
- Mientras la app está abierta, el teclado de pantalla de la tele queda reemplazado por el del celular. Cuando salís de la app (o después de 3 minutos sin escribir) vuelve el de la tele.

## Instalar

**iPhone (TestFlight):** la app se distribuye por TestFlight con un grupo interno de testers, con distribución automática: cada versión nueva que sube EAS les llega a la app **TestFlight** del iPhone. La primera vez iOS pide permiso para buscar dispositivos en la red local: hay que aceptarlo.

**Android:** el instalador está en las [releases del repositorio](https://github.com/PolCarva/tele-teclado/releases) (`Teclado-TV.apk`). Localmente queda en `dist/Teclado-TV.apk`.

- Sin cable: pasá el APK al celular (Google Drive, WhatsApp a vos mismo, correo…) y abrilo. Android pide permiso para instalar apps de esa fuente: permitilo. Si Play Protect avisa que es una app desconocida, elegí "Instalar de todas formas".
- Con cable (depuración USB activada):

```bash
~/Library/Android/sdk/platform-tools/adb install -r dist/Teclado-TV.apk
```

Reinstalar encima de una versión anterior conserva la vinculación.

## Vincular con la tele (una sola vez por celular)

1. La tele prendida y el celular en la misma Wi-Fi.
2. Abrí **Teclado TV**. La tele muestra "Device pairing request" con un código de 6 caracteres (números y letras A-F).
3. Escribí ese código en las seis casillas. Listo: queda vinculada. No hay que volver a hacerlo, salvo que borres la app.

Si el código desaparece de la tele antes de escribirlo, tocá **Pedir otro código**.

## Si algo no anda

- **"Sin conexión":** fijate que la tele esté prendida y en la misma Wi-Fi. Tocá el nombre de la tele arriba y **Buscar de nuevo**. Si no aparece, en **Avanzado** podés poner la dirección a mano.
- **La tele pide vincular de nuevo** (por ejemplo, después de resetearla): escribí el código nuevo. También podés forzarlo en **Avanzado → Volver a vincular**.
- **No aparece el texto:** tiene que haber un campo de texto abierto en la tele (por ejemplo, la búsqueda de YouTube). Si la tele recién está abriendo la app, esperá un segundo.

## Para desarrollar

Es una app de Expo (SDK 58). Partes:

- `src/protocol/`: el protocolo Android TV Remote v2 en TypeScript (vinculación, sesión, mensajes protobuf, cálculo de diferencias de texto). Lo comparten la app y la herramienta de prueba de la Mac.
- `modules/tv-remote/`: módulo nativo con lo que JavaScript no puede hacer solo: el certificado del celular, la conexión TLS con ese certificado, la búsqueda de teles por mDNS/Bonjour y un par de ajustes guardados. Android en Kotlin (`android/`), iPhone en Swift (`ios/`, con Network.framework y el llavero).
- `src/tv/TvController.ts`: busca y recuerda la tele, mantiene la conexión, reintenta, pide vincular cuando hace falta, espeja la caja de texto en la tele y hace las búsquedas.
- `src/tv/apps.ts`: las apps del selector y el enlace de búsqueda de cada una.
- `App.tsx` y `src/ui/`: las pantallas (estilo Google TV: fondo oscuro, foco blanco).

Comandos:

```bash
npm run selftest
```

Pruebas sin tele: SHA-256, protobuf contra bytes de la librería de referencia, diferencias de texto, y el controlador contra una tele simulada (detección, selector, búsquedas).

```bash
npm run tv -- pair
```

Desde la Mac: vincula la Mac con la tele (la herramienta usa su propio certificado en `scripts/.identity/`). Después, por ejemplo:

```bash
npm run tv -- type "hola mundo"
```

Otros comandos: `key ENTER`, `link <url>`, `listen 30`, `steps wait:1000 text:hola key:DEL`. La dirección de la tele va en la variable `TV_HOST`.

APK de Android:

```bash
npm run build:android
```

iPhone con EAS (cuenta Expo `pablo-carvalho`, proyecto `tele-teclado`; las credenciales de Apple ya están guardadas en EAS):

```bash
eas build -p ios --profile production --auto-submit
```

Compila en la nube y sube la versión a TestFlight con la clave de App Store Connect configurada en `eas.json`.

Para probar en el simulador de iPhone, compilar con el equipo de Apple indicado: sin él, el simulador no le da a la app acceso al llavero (error -34018) y no puede guardar su certificado.

```bash
xcodebuild -workspace ios/TecladoTV.xcworkspace -scheme TecladoTV -configuration Release -sdk iphonesimulator -derivedDataPath ios/build DEVELOPMENT_TEAM=JZ9HBXGNK9 CODE_SIGN_IDENTITY=- build
```

`ios/` y `android/` se generan con `npx expo prebuild`. CocoaPods necesita `LANG=en_US.UTF-8`.

### Cómo se comporta la tele (probado con la TCL)

- Al conectarse un celular, el servicio remoto de la tele cambia su teclado al "teclado puente" (`ImeBridgeService`) en unos 0,2 s. Lo que llega antes se pierde, así que la app espera 0,7 s después de conectar antes de mandar texto.
- Cada mensaje de texto se **inserta** en el cursor; no reemplaza lo que hay. Por eso la app manda solo la diferencia, y borra con la tecla DEL.
- En YouTube, DEL con el campo vacío equivale a "volver"; la app nunca manda más borrados que lo que escribió.
- YouTube, HBO Max y Netflix no usan un campo de texto de Android (dibujan el suyo). El sistema convierte el texto que llega en pulsaciones de teclas, y las letras con tilde o la ñ no tienen tecla propia, así que se pierden.
- En YouTube, Enter aprieta la tecla marcada en su teclado de pantalla (escribe una "a"). Por eso "Buscar" usa un enlace de búsqueda, que abre los resultados y deja marcado el primer video.
- La tele solo acepta enlaces comunes (no `intent:`). Enlaces de búsqueda que funcionan (`src/tv/apps.ts`):
  - YouTube: `https://www.youtube.com/results?search_query=…`
  - Netflix: no tiene enlace de búsqueda que sirva en Android TV (`nflx://www.netflix.com/search?q=…` abre el inicio) e ignora los enlaces si ya está abierta. La app solo la abre con `nflx://www.netflix.com/browse`. Netflix tampoco deja capturar su pantalla ni expone sus textos, así que no hay forma de verificarla automáticamente.
  - Prime Video: `https://app.primevideo.com/search?phrase=…`
  - Disney+: `disneyplus://www.disneyplus.com/search?q=…`
  - HBO Max: `https://play.max.com/search` abre la búsqueda vacía y no avisa cuándo está lista. La app escribe el texto a los 3,5 y 8 s si Max ya estaba abierta, o a los 5, 12 y 20 s si recién arranca. Antes de cada reintento borra lo que dejó el anterior y espera 1,5 s: si llegan borrados y letras juntos, Max los mezcla. Borrar con el campo vacío no la saca de la búsqueda.
  - Stremio: `stremio:///search?search=…`
  - Paramount+ (sin sesión iniciada), DirecTV GO y Vera TV no tienen un enlace de búsqueda que sirva; usan "App abierta (Enter)".
- La tele avisa qué app está al frente cada vez que cambia; con eso se mueve el selector.
- Si hay dos conexiones a la vez, la tele solo hace caso a la última.
- La tele se anuncia en la red como `_androidtvremote2._tcp` con su nombre; la dirección IP la asigna el router y puede cambiar (pasó de `192.168.68.54` a `192.168.68.50` tras un reinicio).
