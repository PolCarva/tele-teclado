# Plataformas que todavía no están (y qué haría falta)

Investigación del 29 de octubre de 2026: un investigador por plataforma (fuentes, código de referencia, reportes de usuarios) y un segundo que revisó cada conclusión buscando evidencia en contra. Regla de la app: no agregar una marca hasta que alguien haya visto el texto llegar a una tele real, para no prometer una escritura que podría no funcionar.

**Cobertura actual en el mercado objetivo:** Tizen, Android TV y webOS son el 72,4 % de las teles instaladas en Latinoamérica (Dataxis) y Roku lidera el tráfico y las ventas en México (Pixalate T4 2025: 30 %; Circana: ~40 % de las teles vendidas en México en 2026). Con Sony y Panasonic, la app ya cubre la gran mayoría.

| Plataforma | ¿Se puede escribir desde afuera? | Mercado objetivo | Decisión |
|---|---|---|---|
| Hisense VIDAA | Sin confirmar | Grande y creciendo (México, Europa) | Más adelante |
| Amazon Fire TV | Sí, en un solo equipo | Chico (8 % en México) | Más adelante |
| Apple TV | Sí, confirmado por varios | Chico en Latinoamérica | Más adelante |
| Vizio | Probable | Casi nulo fuera de EE.UU. | Más adelante |
| Philips sin Android (Saphi, Titan OS) | Sin confirmar | Titan crece en Argentina, Brasil y Uruguay | Más adelante |

## Hisense VIDAA

- **Qué hay:** broker MQTT dentro de la tele (puerto 36669, TLS). El emparejamiento con PIN y el algoritmo de credenciales están reproducidos y confirmados por usuarios en varios modelos (warrenrees/pyvidaa, stevene1919/hisense_vidaa #30). `src/net/mqtt.ts` ya sirve.
- **Qué falta:** nadie mostró el mensaje teléfono→tele que escribe texto funcionando en una tele real. El único código público (`platform_service/actions/txtinputdata` en stevene1919/hisense_vidaa) no está probado. Los firmwares nuevos además exigen el certificado de cliente de la app de Hisense.
- **Qué lo destraba:** una captura con una VIDAA real mientras la app oficial escribe (un cliente MQTT escuchando `#`, en firmwares donde los comodines andan), o que alguien con una VIDAA pruebe uno de los tres mensajes candidatos.

## Amazon Fire TV

- **Qué hay:** sin modo desarrollador, el servicio local de la tele (HTTPS 8080, se despierta por DIAL en 8009) con un PIN de 4 números, como la app oficial. Un mantenedor vio `POST /v1/FireTV/keyboard` escribir texto ASCII en un Fire TV Stick 4K Plus (LibreControl/fire-tv). Entra en la arquitectura sin código nativo nuevo (unas 350 líneas de TypeScript).
- **Qué falta:** una sola confirmación, sin probar tildes, borrado ni las teles Fire TV Edition. Las respuestas son 200 (o 500 en equipos viejos) aunque el texto no llegue, así que una falla no se nota.
- **Qué lo destraba:** una sesión con un Fire TV Stick barato (Fire OS 8): qué endpoint escribe, si reemplaza o agrega, si pasan á/ñ, si anda el borrado y si `GET /keyboard` devuelve el texto del campo.
- El camino por ADB (depuración USB por red) se descarta: exige modo desarrollador, no escribe tildes y no existe en Vega OS.

## Apple TV

- **Qué hay:** el protocolo Companion (el del control remoto de iOS) con la sesión de texto RTI (`_tiStart` / `_tiC`). Escribir en el campo confirmado en hardware real por usuarios y mantenedores independientes (pyatv, node-appletv-remote, Itsytv en la App Store, msthind04/AppleTV-Remote en Android), hasta tvOS 26.6.
- **Qué falta:** unas 2.300 líneas de TypeScript, la mitad criptografía de seguridad (SRP-6a 3072, Ed25519, X25519, ChaCha20-Poly1305, HKDF-SHA512, bplist/OPACK). Apple rompió clientes de terceros varias veces en 2025–2026 y cada arreglo necesitó un equipo para diagnosticar. En iPhone ya hay un teclado nativo para la Apple TV, así que el valor es sobre todo para Android.
- **Qué lo destraba:** un Apple TV prestado (4K de 2.ª o 3.ª generación) para probar; portar desde el código de pyatv 0.18.0.

## Vizio

- **Qué hay:** API SmartCast por HTTPS (7345/9000) con PIN; texto como una tecla ASCII por pedido (`PUT /key_command/`, codeset 0). Lo describe en detalle un solo usuario (2023–2024). Home Assistant tiene `send_text` desde 2026.9, sin reportes todavía.
- **Mercado:** los modelos mexicanos usaban VIA Plus; no hay presencia en Uruguay ni Argentina.
- **Qué lo destraba:** que alguien con una Vizio con firmware actual confirme que escribe en la búsqueda.

## Philips sin Android (Saphi, Titan OS)

- **Qué hay:** JointSpace (HTTPS 1926 con Digest y PIN): `POST /6/input/textentry {"currentstring": …}` está documentado, pero solo se vio andar en Philips con Android (que ya funcionan como Android TV). Titan OS (que crece en Argentina, Brasil y Uruguay) no tiene ninguna confirmación y su JointSpace se cuelga con ráfagas de pedidos.
- **Qué lo destraba:** alguien con una Philips Saphi o Titan que confirme que el teclado de la app oficial de Philips escribe, y que pruebe un `textentry` en el campo de URL del navegador.

## Fuentes principales

- VIDAA: github.com/warrenrees/pyvidaa (VIDAA_PROTOCOL_ANALYSIS.md), github.com/stevene1919/hisense_vidaa, github.com/V4n1X/ha_hisense_tv (docs/PROTOCOL.md).
- Fire TV: github.com/LibreControl/fire-tv (docs/protocol.md, docs/hardware-validation.md), github.com/mase1981/uc-intg-firetv.
- Apple TV: github.com/postlund/pyatv (protocols/companion), github.com/energee/node-appletv-remote, github.com/nickustinov/itsytv-core.
- Vizio: github.com/raman325/vizaio, github.com/exiva/Vizio_SmartCast_API, Home Assistant `vizio`.
- Philips: github.com/eslavnov/pylips, github.com/danielperna84/ha-philipsjs.
- Mercado: Pixalate (CTV share of voice 2025), Dataxis (base instalada Latinoamérica), Circana (ventas México 2026), Omdia (VIDAA en Europa).
