# Gastos WhatsApp IA

**Gestión automática de gastos de empleados: envías la foto de la factura por WhatsApp, la IA extrae los datos contables y aparecen al instante en un panel web.**

![Panel de resumen](docs/panel-resumen.png)

## El problema

Los comerciales y técnicos que viajan acumulan facturas de restaurantes, gasolineras, hoteles, parkings y peajes. Hoy la empresa tiene dos opciones, y ninguna funciona bien:

- **Meter las facturas a mano**, línea a línea, en el sistema contable. Es lento y da errores.
- **Instalar una app de gastos por suscripción** que los empleados acaban olvidando.

## La solución

El empleado ya tiene WhatsApp abierto todo el día. Solo tiene que **hacer una foto a la factura y enviarla a un número de la empresa**:

1. El bot recibe la imagen (o el PDF) y responde al momento.
2. **Gemini** (IA de Google con visión) lee la factura y extrae proveedor, NIF, número, fecha y hora, base imponible, desglose de IVA, total, propina, forma de pago y categoría del gasto.
3. El bot **confirma en el chat** con el resumen de los datos.
4. La factura **aparece en el panel web en tiempo real**, con la imagen original, sin recargar la página.
5. Administración revisa, aprueba o rechaza, y **exporta a CSV** para el programa contable.

```
Empleado ──foto──▶ WhatsApp ──▶ Gemini (visión) ──▶ Base de datos ──▶ Panel web en tiempo real ──▶ CSV / ERP
          ◀──── confirmación con el desglose ────┘
```

## Para qué sirve este MVP

Es un **producto mínimo viable para hacer demos a clientes**. Funciona de verdad de principio a fin y se ejecuta en un solo ordenador, sin servidores ni configuración compleja:

- **Validar la idea** con empresas reales: lo que hace el empleado (enviar una foto por WhatsApp) es el mismo que tendría en producción.
- **Enseñar el valor en directo**: el cliente envía una factura desde su móvil y la ve aparecer en el panel en unos 3 segundos.
- **Servir de base técnica** para la versión de producción: el procesado y la base de datos ya están separados del canal de WhatsApp.

## Funcionalidades

**En WhatsApp**
- Vinculación escaneando un **código QR desde el panel**, igual que WhatsApp Web.
- Acepta fotos (JPG, PNG, WEBP) y PDF.
- Reacciona con ⏳ al recibir la factura y con ✅ al registrarla, y responde con el desglose.
- Comandos: **resumen** (gasto del mes), **borrar** (elimina la última factura pendiente) y **ayuda**.
- Avisa si la imagen no es una factura, si está borrosa o si parece duplicada.
- Para probar con un solo móvil, basta con enviarse la foto en el chat «Tú» (mensaje a ti mismo).

**En el panel web**
- **Tiempo real**: avisos y actividad en directo mientras la factura se procesa (recibida → leyendo con IA → registrada).
- **Resumen**: gasto del mes, número de facturas, IVA deducible, pendientes de revisar, gasto diario de los últimos 30 días y desglose por categoría y por empleado.
- **Facturas**: listado con miniatura de la imagen, filtros (fechas, empleado, categoría, estado, búsqueda) y exportación a CSV compatible con Excel en español.
- **Detalle de factura**: imagen original junto a los datos extraídos, todos editables. Avisos de revisión cuando la lectura tiene baja confianza o los importes no cuadran. Botones para aprobar o rechazar.
- **Empleados**: se dan de alta solos con su nombre de perfil de WhatsApp al enviar la primera factura; también se pueden añadir a mano.
- **Subida manual**: arrastrar una imagen o PDF al panel la procesa igual que si llegara por WhatsApp.
- Diseño corporativo, modo oscuro automático y adaptado a móvil.

| Detalle de una factura | Vincular WhatsApp |
|---|---|
| ![Detalle de factura](docs/detalle-factura.png) | ![Vincular WhatsApp](docs/vincular-whatsapp.png) |

## Puesta en marcha

Requisitos: **Node.js 24 o superior** y una **clave de la API de Gemini** (gratuita en [Google AI Studio](https://aistudio.google.com/apikey)).

```bash
git clone https://github.com/violetaatkinson/gastos-whatsapp-ia.git
cd gastos-whatsapp-ia
npm install
cp .env.example .env      # y pega tu clave en GEMINI_API_KEY
npm start
```

1. Abre <http://localhost:3000>. La primera vez se muestra el código QR.
2. En el móvil: **WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo** y escanea el código.
3. Envía la foto de una factura a ese número (o a ti mismo en el chat «Tú»).

La sesión de WhatsApp se guarda en el equipo: no hace falta volver a escanear en cada arranque.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm start` | Panel web y bot de WhatsApp en <http://localhost:3000> |
| `npm run dev` | Igual, reiniciando al cambiar el código |
| `npm run reset` | Borra facturas y empleados (mantiene WhatsApp vinculado) |
| `npm run extract -- samples/factura-restaurante.png` | Prueba la extracción con Gemini sobre un archivo, sin WhatsApp |
| `npm run bot:meta` | Bot alternativo con la API oficial de WhatsApp Business (ver más abajo) |

## Configuración (`.env`)

| Variable | Para qué |
|---|---|
| `GEMINI_API_KEY` | **Obligatoria.** Clave para leer las facturas |
| `GEMINI_MODEL` | Modelo principal. Por defecto `gemini-3.6-flash` (unos 3 s por factura) |
| `GEMINI_FALLBACK_MODEL` | Se usa si el principal está saturado o no responde en 30 s. Por defecto `gemini-3.8-flash` |
| `BRAND_NAME` | Nombre del producto en el panel (por defecto «Gastos») |
| `CLIENT_NAME` | Nombre de la empresa a la que se hace la demo; aparece en la cabecera |
| `ALLOW_ANY_SENDER` | `true` (por defecto): cualquiera que escriba queda dado de alta. `false`: solo los empleados añadidos en el panel |
| `PORT` | Puerto del panel (3000) |

## Cómo está hecho

| Pieza | Tecnología |
|---|---|
| WhatsApp | [Baileys](https://github.com/WhiskeySockets/Baileys) (protocolo de WhatsApp Web, vinculación por QR) |
| Lectura de facturas | Gemini a través de `@google/genai`, con salida JSON validada con Zod |
| Servidor | Node.js + Express, en un único proceso |
| Tiempo real | Server-Sent Events (`/api/events`) |
| Base de datos | SQLite integrado en Node (`node:sqlite`) |
| Panel | HTML, CSS y JavaScript sin framework |

| Ruta | Contenido |
|---|---|
| `src/server.js` | Servidor: panel, API, eventos en tiempo real y arranque del bot |
| `src/lib/baileys.js` | WhatsApp: QR, reconexión, recepción de fotos y PDF, respuestas |
| `src/lib/processor.js` | Proceso común a todos los canales: Gemini → guardar → confirmar → avisar al panel |
| `src/lib/extract.js` | Instrucciones y esquema de extracción para Gemini, con modelo de respaldo |
| `src/lib/db.js` | Base de datos SQLite (`data/app.db`) |
| `src/lib/events.js` | Bus de eventos en tiempo real |
| `public/` | Panel web |
| `src/bot.js`, `src/lib/whatsapp.js` | Alternativa con la API oficial de Meta |

La carpeta `data/` (base de datos, imágenes de facturas y sesión de WhatsApp) y el archivo `.env` contienen datos personales y credenciales: están excluidos del repositorio.

## Problemas frecuentes

| Problema | Solución |
|---|---|
| El QR no aparece o caduca | Se renueva solo; si se queda parado, pulsa *Reconectar* en la sección WhatsApp |
| «Sesión cerrada» | Se desvinculó desde el móvil: aparece un QR nuevo automáticamente |
| Vincular otro número | *WhatsApp → Desvincular* y escanea con el otro móvil |
| «La clave de Gemini no es válida» | Revisa `GEMINI_API_KEY` en `.env` y reinicia |
| «Ya hay un servidor en marcha» | Solo puede haber uno a la vez (dos procesos se disputarían la sesión de WhatsApp); cierra el otro |
| Un mensaje no llega al panel | Mira la consola: cada mensaje recibido queda registrado. `BAILEYS_LOG=info` muestra más detalle |

## Del MVP a producción

- **WhatsApp oficial.** Baileys no es una API oficial y WhatsApp puede bloquear números que detecte como automatizados: para las demos, usa un número de prueba. En producción, el canal es la **API de WhatsApp Business de Meta**. `src/bot.js` ya la implementa y comparte base de datos y procesado con la demo.
- **Acceso al panel.** Ahora solo es accesible desde el propio ordenador (`127.0.0.1`); para publicarlo hay que añadir usuarios y contraseñas.
- **Integraciones** directas con el programa contable de cada cliente (Holded, Odoo, A3, Sage…). Hoy la integración es la exportación CSV.
- **Varias empresas** en la misma instalación, con los datos separados por cliente.
- **Digitalización certificada (AEAT)** si se quiere poder destruir el papel original.
