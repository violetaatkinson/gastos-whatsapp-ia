import crypto from 'node:crypto';

// Cliente mínimo de la WhatsApp Business Cloud API (oficial de Meta).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

const REQUIRED = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET'];

export function checkConfig() {
    const missing = REQUIRED.filter((k) => !process.env[k]);
    if (missing.length) {
        throw new Error(`Faltan variables en .env: ${missing.join(', ')}. Mira .env.example.`);
    }
}

const graphUrl = (p) => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? 'v26.0'}/${p}`;

async function graph(p, { method = 'GET', body } = {}) {
    const res = await fetch(graphUrl(p), {
        method,
        headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const e = data.error ?? {};
        throw new Error(`WhatsApp API ${res.status}: ${e.message ?? 'error'}${e.code ? ` (código ${e.code})` : ''}`);
    }
    return data;
}

const messagesPath = () => `${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

/**
 * Envía un texto. Usa el teléfono si lo tenemos y, si no, el BSUID.
 * @param {{ phone?: string, userId?: string }} to
 * @param {string} text
 * @param {string} [replyTo] id del mensaje al que se responde (aparece citado)
 */
export function sendText({ phone, userId }, text, replyTo) {
    return graph(messagesPath(), {
        method: 'POST',
        body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            ...(phone ? { to: phone } : { recipient: userId }),
            type: 'text',
            text: { body: text },
            ...(replyTo ? { context: { message_id: replyTo } } : {}),
        },
    });
}

/** Marca el mensaje como leído y muestra "escribiendo…" (hasta 25 s o hasta que respondamos). */
export function markReadAndTyping(messageId) {
    return graph(messagesPath(), {
        method: 'POST',
        body: {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId,
            typing_indicator: { type: 'text' },
        },
    });
}

/** Descarga un adjunto recibido. El id caduca a los 7 días y la URL a los 5 minutos. */
export async function downloadMedia(mediaId) {
    const { url, mime_type: mime } = await graph(mediaId);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    if (!res.ok) throw new Error(`No se pudo descargar el archivo (${res.status})`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: mime?.split(';')[0] };
}

/** Comprueba que el webhook lo firma Meta (cabecera X-Hub-Signature-256). */
export function isValidSignature(rawBody, header) {
    if (!header?.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(rawBody).digest();
    const received = Buffer.from(header.slice(7), 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

/** "+34 612-345-678" -> "34612345678" */
export function normalizePhone(phone) {
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 8) throw new Error(`Número inválido: ${phone}`);
    return digits;
}
