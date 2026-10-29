# Teclado TV

App para el celular (Android y iPhone): escribís en una caja de texto y aparece en la tele, por ejemplo en la búsqueda de YouTube, Netflix o cualquier campo de texto.

Habla directo con la tele por la Wi-Fi, usando el protocolo de cada marca. Funciona con varias marcas:

- **Android TV / Google TV** (TCL, Sony, Philips, Xiaomi, Sharp, Hisense, Chromecast con Google TV, Nvidia Shield…): escribe en vivo y además puede abrir la búsqueda de YouTube, Netflix, Prime Video, Disney+, HBO Max o Stremio. Probada con una TCL Android TV 11.
- **Samsung** (Tizen, 2016 en adelante): escribe cuando la tele tiene abierto su teclado.
- **LG** (webOS, 2014 en adelante): escribe en el campo de texto abierto.
- **Roku** (incluye teles Roku de TCL, Hisense, Sharp…): escribe letra por letra en el campo abierto.
- **Sony BRAVIA** sin Android (2013–2015) y como respaldo en las Android: escribe cuando la tele tiene su teclado abierto.
- **Panasonic VIERA** (2011 en adelante, con o sin cifrado): manda el texto completo de una vez.

No necesita la Mac prendida ni nada instalado en la tele. Las marcas que no son Android TV se agregaron en base a la documentación de cada protocolo y a proyectos de código abierto; se probaron contra teles simuladas armadas desde esas fuentes, pero no contra cada modelo real.

## Cómo se usa

- **La tele se encuentra sola.** La primera vez, la app busca las teles de tu Wi-Fi: si hay una sola, la usa; si hay varias, te las muestra por nombre y marca. Arriba está el nombre de la tele y su estado; tocándolo ves las teles de la Wi-Fi y podés cambiar. Si la tele cambia de dirección IP, la app la vuelve a encontrar sola.
- Abrís la app y el teclado ya está abierto. Escribís y tocás **Buscar** / **Enter** / **Enviar** (según la tele), o la tecla del teclado del celular. La cruz dentro de la caja borra lo escrito.
- **Según la marca:**
  - **Android TV:** aparece el selector "Buscar en" con íconos (YouTube, Netflix, Prime Video, Disney+, HBO Max, Stremio, o "App abierta (Enter)"). Sigue sola a la app abierta en la tele; podés cambiarla a mano. El texto aparece en vivo mientras escribís.
  - **Samsung, LG, Roku, Sony:** abrí un buscador o un campo de texto en la tele (por ejemplo la lupa de YouTube). Cuando la tele muestra su teclado, lo que escribís aparece ahí al instante. En Samsung, LG y Sony, si el campo ya tenía texto, la app lo trae y seguís editando.
  - **Panasonic:** no deja borrar desde el celular, así que escribís en el celular y tocás **Enviar**: el texto va completo. "Enter" confirma.
- **Tildes y ñ:** algunas apps de Android (YouTube, HBO Max, Netflix) las descartan; ahí la app manda la letra sin tilde. En los enlaces de búsqueda y en las demás marcas las tildes sí van.

## Vincular con la tele (una sola vez por celular)

La primera vez, cada marca pide algo distinto. La app te guía:

- **Android TV:** la tele muestra un código de 6 caracteres (números y letras A–F). Escribilo en las seis casillas.
- **Sony / Panasonic (con cifrado) :** la tele muestra un código de 4 números. Escribilo. En Sony, si no aparece, activá en la tele el control remoto por red.
- **Samsung / LG:** la tele pregunta "¿permitir este dispositivo?". Elegí **Permitir** (Sí) con el control de la tele.
- **Roku:** no hace falta vincular, pero el control por red tiene que estar activado en la tele: **Ajustes → Sistema → Ajustes avanzados del sistema → Control por apps móviles → Activado**. Si está en "Limitado", la app te lo avisa.

Queda vinculada; no hay que repetirlo salvo que borres la app o resetees la tele.

## Instalar

**iPhone:** en la App Store (enviada a revisión de Apple; mientras tanto, por **TestFlight**). La primera vez iOS pide permiso para buscar dispositivos en la red local: hay que aceptarlo.

**Android:** el instalador está en las [releases del repositorio](https://github.com/PolCarva/tele-teclado/releases) (`Teclado-TV.apk`). Localmente queda en `dist/Teclado-TV.apk`.

- Sin cable: pasá el APK al celular (Google Drive, WhatsApp a vos mismo, correo…) y abrilo. Permití instalar de esa fuente; si Play Protect avisa, "Instalar de todas formas".
- Con cable (depuración USB activada):

```bash
~/Library/Android/sdk/platform-tools/adb install -r dist/Teclado-TV.apk
```

Reinstalar encima de una versión anterior conserva la vinculación.

## Si algo no anda

- **"Sin conexión":** fijate que la tele esté prendida y en la misma Wi-Fi. Tocá el nombre de la tele arriba y **Buscar de nuevo** (hace una búsqueda más a fondo, dirección por dirección). Si no aparece, en **Avanzado** podés poner la dirección a mano: la app detecta sola la marca.
- **No aparece el texto:** tiene que haber un campo de texto abierto en la tele (por ejemplo, su búsqueda). En Samsung/LG/Sony hay que ver el teclado de la tele; en Roku, el control por red tiene que estar "Activado".
- **La tele pide vincular de nuevo** (por ejemplo, después de resetearla): seguí los pasos otra vez. En Android TV podés forzarlo en **Avanzado → Volver a vincular**.
- **iPhone y marcas que no son Android TV:** iOS no deja mandar los mensajes de descubrimiento "multicast" sin un permiso especial de Apple, así que en iPhone la app encuentra esas teles por Bonjour o escaneando la red (**Buscar de nuevo**). En Android las encuentra directo.

## Para desarrollar

Es una app de Expo (SDK 58). Partes:

- `src/protocol/`: el protocolo Android TV Remote v2 en TypeScript (vinculación, sesión, mensajes protobuf, diferencias de texto). Lo comparten la app y la herramienta de la Mac.
- `src/net/`: las piezas de red compartidas sobre sockets crudos: HTTP/1.1, WebSocket (RFC 6455), MQTT, SHA-1/MD5/HMAC, AES-128-CBC y un parser de URL. Así las marcas que usan TLS con certificados propios, WebSockets o MQTT funcionan igual en Android y iPhone, sin chocar con las políticas de tráfico de cada sistema.
- `src/brands/`: un conector por marca (`androidtv`, `samsung`, `lg`, `roku`, `sony`, `panasonic`) detrás de una interfaz común (`Driver`/`TvSession`), más el descubrimiento multi-marca (mDNS, SSDP y sondeo de puertos) en `discovery.ts`.
- `src/tv/TvController.ts`: busca y recuerda la tele, mantiene la conexión, pide vincular, espeja la caja de texto en la tele y hace las búsquedas. No conoce ningún protocolo: habla con el conector de la marca.
- `src/tv/apps.ts`: las apps del selector de Android TV y el enlace de búsqueda de cada una.
- `modules/tv-remote/`: módulo nativo con lo que JavaScript no puede hacer solo: el certificado del celular, abrir sockets (TCP, TLS, o TLS con ese certificado), buscar teles (mDNS/Bonjour, SSDP, sondeo de puertos), datos de la red Wi-Fi y bytes aleatorios. Android en Kotlin, iPhone en Swift.
- `App.tsx` y `src/ui/`: las pantallas (estilo Google TV: fondo oscuro, foco blanco).

Comandos:

```bash
npm run selftest
```

Pruebas sin tele: SHA-256/SHA-1/MD5/HMAC y AES contra `node:crypto`, protobuf contra bytes de la librería de referencia, los clientes HTTP/WebSocket/MQTT contra servidores reales (`node:http`, el paquete `ws`, el broker `aedes`), el cifrado de Panasonic contra sus vectores publicados, y cada conector de marca contra una tele simulada armada desde las fuentes del protocolo (vinculación, detección del teclado, escritura, borrado, Enter).

```bash
npm run tv -- type "hola mundo"
```

Desde la Mac: vincula la Mac con una tele Android y escribe (la herramienta usa su propio certificado en `scripts/.identity/`). Otros comandos: `pair`, `key ENTER`, `link <url>`, `listen 30`. La dirección va en `TV_HOST`.

APK de Android:

```bash
npm run build:android
```

iPhone con EAS (cuenta Expo `pablo-carvalho`, proyecto `tele-teclado`; las credenciales de Apple ya están en EAS):

```bash
eas build -p ios --profile production --auto-submit
```

Compila en la nube y sube la versión a TestFlight. Sin EAS, `scripts/build-ios.sh` compila con Xcode en la Mac y sube la build con la misma clave de App Store Connect (antes, subí `ios.buildNumber` en `app.json`).

Ficha de la App Store: el texto, las URLs, la clasificación por edad y las notas para la revisión de Apple están en `store/app-store.json`, y las capturas en `store/screenshots/`. Se suben con `node scripts/app-store.mjs listing|screenshots`, se elige la build con `build`, se revisa con `status` y se manda a revisión con `submit`. La ayuda y la política de privacidad son `docs/` (GitHub Pages: https://polcarva.github.io/tele-teclado/).

Para el simulador, compilar con el equipo de Apple (`DEVELOPMENT_TEAM=JZ9HBXGNK9`), si no el simulador no le da acceso al llavero (error -34018). `ios/` y `android/` se generan con `npx expo prebuild`; CocoaPods necesita `LANG=en_US.UTF-8`.

### Cómo se comporta cada tele

Lo del Android TV (probado con la TCL) sigue igual que antes: al conectarse, la tele cambia a su "teclado puente" en ~0,2 s (la app espera 0,7 s), el texto se inserta en el cursor, YouTube/Max/Netflix descartan tildes, Enter en YouTube aprieta la tecla marcada (por eso "Buscar" usa un enlace), y los enlaces de búsqueda por app están en `src/tv/apps.ts`.

Lo de las demás marcas viene de la investigación de protocolos (resumida en los comentarios de cada archivo de `src/brands/`). Puntos que todavía no se pudieron probar contra un modelo real, y que la app maneja con cuidado:

- **Samsung / LG:** si el campo reemplaza o inserta el texto está confirmado solo en algunos años; la app usa el modo que indica cada protocolo y se sincroniza con lo que la tele informa de su teclado. Apps con teclado propio (a veces YouTube/Netflix) no levantan el teclado del sistema; ahí la escritura no llega.
- **Sony / Panasonic:** si las tildes llegan intactas no está confirmado en todos los modelos.
- **Roku:** la escritura necesita el modo "Activado"; en "Limitado" (el valor por defecto en varios modelos nuevos) la app avisa que hay que cambiar el ajuste.

No se incluyeron (todavía) Vizio (solo EE.UU., sin tildes) ni Hisense VIDAA (el envío de texto no está confirmado en ningún modelo real), para no prometer una escritura que podría no funcionar.
