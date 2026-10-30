import express from 'express';
import {
    checkConfig, downloadMedia, isValidSignature, markReadAndTyping, sendText,
} from './lib/whatsapp.js';
import { findEmployee } from './lib/db.js';
import { HELP, SUPPORTED, handleCommand, processInvoice } from './lib/processor.js';

// Alternativa para producción: webhook de la WhatsApp Business Cloud API (oficial de Meta).
// La demo usa Baileys (src/server.js); este bot comparte con ella la base de datos y el procesado.
// Va en un puerto aparte del panel para poder exponerlo a internet sin exponer el panel.
const PORT = Number(process.env.WEBHOOK_PORT ?? 3001);
const HOST = process.env.WEBHOOK_HOST ?? '127.0.0.1';

async function handleInvoice(media, employee) {
    const declared = media.mime_type?.split(';')[0];
    if (!SUPPORTED[declared]) return 'Ese tipo de archivo no lo puedo leer. Envía una foto (JPG/PNG) o un PDF.';
    const download = await downloadMedia(media.id);
    const mime = SUPPORTED[download.mime] ? download.mime : declared;
    const { reply } = await processInvoice({ buffer: download.buffer, mime, employee, channel: 'meta' });
    return reply;
}

// Meta puede reenviar el mismo mensaje si tardamos en responder: ignoramos repetidos.
const seen = new Set();
function alreadySeen(id) {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    return false;
}

async function onMessage(message) {
    if (alreadySeen(message.id)) return;
    // Desde junio de 2026 el teléfono puede no venir (usuarios con nombre de usuario); el BSUID siempre viene.
    const sender = { phone: message.from, userId: message.from_user_id };
    const employee = findEmployee(sender);
    if (!employee) {
        console.log(`Mensaje de número no registrado: ${sender.phone ?? sender.userId}`);
        await sendText(sender, 'Este número no está dado de alta en el sistema de gastos. Pide a administración que te registre.');
        return;
    }

    markReadAndTyping(message.id).catch((err) => console.warn(err.message));

    let reply;
    try {
        if (message.type === 'image') {
            reply = await handleInvoice(message.image, employee);
        } else if (message.type === 'document') {
            reply = await handleInvoice(message.document, employee);
        } else if (message.type === 'text') {
            reply = handleCommand(message.text.body, employee);
        } else {
            reply = `Solo puedo leer fotos o PDFs de facturas.\n\n${HELP}`;
        }
    } catch (err) {
        console.error(`Error procesando mensaje de ${employee.name}:`, err);
        reply = '❌ Ha habido un error procesando la factura. Inténtalo de nuevo en un momento.';
    }
    await sendText(sender, reply, message.id);
}

try {
    checkConfig();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

const app = express();

// Verificación inicial: Meta llama a esta URL al configurar el webhook.
app.get('/webhook', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe'
        && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN;
    if (!ok) return res.sendStatus(403);
    console.log('Webhook verificado por Meta.');
    res.send(req.query['hub.challenge']);
});

// Mensajes entrantes. Necesitamos el cuerpo sin parsear para comprobar la firma.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    if (!isValidSignature(req.body, req.get('x-hub-signature-256'))) {
        console.warn('Webhook con firma inválida: descartado.');
        return res.sendStatus(401);
    }
    res.sendStatus(200); // responder rápido; el procesado sigue en segundo plano

    const payload = JSON.parse(req.body.toString('utf8'));
    for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
            for (const message of change.value?.messages ?? []) {
                onMessage(message).catch((err) => console.error('Error respondiendo:', err.message));
            }
        }
    }
});

app.listen(PORT, HOST, () => {
    console.log(`Bot de facturas (Meta) escuchando en http://${HOST}:${PORT}/webhook`);
});
