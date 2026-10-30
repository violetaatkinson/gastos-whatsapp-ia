import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
    Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, getContentType,
    isJidBroadcast, isJidGroup, isJidNewsletter, jidNormalizedUser, normalizeMessageContent,
    useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { DATA_DIR, ensureEmployee, findEmployee, isMessageProcessed } from './db.js';
import { publish } from './events.js';
import { HELP, SUPPORTED, handleCommand, processInvoice } from './processor.js';

// WhatsApp Web vía Baileys: se vincula escaneando el QR que aparece en el panel.
// La sesión se guarda en data/whatsapp-session para no tener que volver a escanear.

const AUTH_DIR = path.join(DATA_DIR, 'whatsapp-session');
const logger = pino({ level: process.env.BAILEYS_LOG ?? 'silent' });
// En la demo cualquiera que escriba queda dado de alta; con "false" solo los empleados registrados en el panel.
const OPEN_SIGNUP = process.env.ALLOW_ANY_SENDER !== 'false';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // ignora mensajes antiguos que lleguen al reconectar
const COMMANDS = new Set(['borrar', 'resumen', 'ayuda', 'hola']);

let sock = null;
let retryTimer = null;
let retries = 0;
let state = { status: 'starting', qr: null, me: null, message: null };
const sentByBot = new Set();

function setState(patch) {
    state = { ...state, ...patch };
    publish('whatsapp', state);
}

export const getWhatsAppState = () => state;

const digits = (jid) => jid?.split('@')[0].split(':')[0] ?? null;
const isLid = (jid) => jid?.endsWith('@lid');

function scheduleRestart(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => startWhatsApp().catch((err) => console.error('WhatsApp:', err.message)), ms);
}

function wipeSession() {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

async function send(jid, content, options) {
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id) {
        sentByBot.add(sent.key.id);
        if (sentByBot.size > 500) sentByBot.delete(sentByBot.values().next().value);
    }
    return sent;
}

export async function startWhatsApp() {
    clearTimeout(retryTimer);
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch {
        // sin red para consultar la versión: Baileys usa la que trae por defecto
    }

    setState({ status: 'connecting', qr: null, message: null });
    const socket = makeWASocket({
        auth,
        version,
        logger,
        browser: Browsers.windows('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage: async () => undefined,
    });
    sock = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (socket !== sock) return; // evento de un socket ya sustituido
        if (qr) {
            const image = await QRCode.toDataURL(qr, { margin: 1, width: 360, color: { dark: '#18181b', light: '#ffffff' } });
            setState({ status: 'qr', qr: image });
        }
        if (connection === 'open') {
            retries = 0;
            const me = {
                name: socket.user?.name ?? socket.user?.verifiedName ?? null,
                phone: digits(socket.user?.id),
                jid: jidNormalizedUser(socket.user?.id),
                lid: socket.user?.lid ? jidNormalizedUser(socket.user.lid) : null,
            };
            console.log(`WhatsApp conectado como +${me.phone}${me.name ? ` (${me.name})` : ''}`);
            setState({ status: 'connected', qr: null, me, message: null, since: new Date().toISOString() });
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                console.log('WhatsApp: sesión cerrada desde el móvil. Generando un QR nuevo…');
                wipeSession();
                setState({ status: 'connecting', qr: null, me: null, message: 'Sesión cerrada. Escanea el nuevo QR.' });
                scheduleRestart(500);
            } else if (code === DisconnectReason.connectionReplaced) {
                setState({ status: 'disconnected', qr: null, message: 'La sesión se abrió en otro lugar. Pulsa "Reconectar".' });
            } else {
                const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(30000, 1000 * 2 ** retries++);
                setState({ status: state.me ? 'reconnecting' : 'connecting', qr: null });
                scheduleRestart(wait);
            }
        }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
        for (const m of messages) {
            onMessage(socket, m, type).catch((err) => console.error('Error con un mensaje de WhatsApp:', err));
        }
    });
}

export async function logoutWhatsApp() {
    try {
        await sock?.logout();
    } catch {
        // si ya estaba desconectado, basta con borrar la sesión
    }
    sock = null;
    wipeSession();
    setState({ status: 'connecting', qr: null, me: null, message: null });
    scheduleRestart(500);
}

export function reconnectWhatsApp() {
    try { sock?.end(undefined); } catch { /* ya cerrado */ }
    sock = null;
    retries = 0;
    scheduleRestart(0);
}

function senderOf(m, selfChat) {
    if (selfChat) return { phone: state.me?.phone, userId: digits(state.me?.lid), name: state.me?.name ?? 'Yo' };
    const { remoteJid, remoteJidAlt } = m.key;
    const pn = [remoteJid, remoteJidAlt].find((j) => j?.endsWith('@s.whatsapp.net'));
    const lid = [remoteJid, remoteJidAlt].find(isLid);
    return { phone: digits(pn), userId: digits(lid), name: m.pushName };
}

const inFlight = new Set();

function isOwnChat(m) {
    const mine = new Set([state.me?.jid, state.me?.lid, jidNormalizedUser(sock?.user?.id), sock?.user?.lid && jidNormalizedUser(sock.user.lid)].filter(Boolean));
    return [m.key.remoteJid, m.key.remoteJidAlt].some((j) => j && mine.has(jidNormalizedUser(j)));
}

async function onMessage(socket, m, type) {
    const jid = m.key.remoteJid;
    if (!m.message || !jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;
    if (Number(m.messageTimestamp) * 1000 < Date.now() - MAX_AGE_MS) return;
    if (sentByBot.has(m.key.id)) return;

    // Chat "Mensaje a ti mismo": permite probar la demo con un solo móvil.
    // WhatsApp entrega estos mensajes como 'notify' o 'append' según el dispositivo: aceptamos ambos.
    const selfChat = isOwnChat(m);
    if (m.key.fromMe && !selfChat) return;

    const content = normalizeMessageContent(m.message);
    const kind = getContentType(content);
    if (kind !== 'reactionMessage' && kind !== 'protocolMessage' && kind !== 'senderKeyDistributionMessage') {
        console.log(`WhatsApp ← ${selfChat ? 'chat propio' : (m.pushName ?? digits(jid))} · ${kind} · ${type}`);
    }
    const text = (content?.conversation ?? content?.extendedTextMessage?.text ?? '').trim();
    const media = kind === 'imageMessage' ? content.imageMessage
        : kind === 'documentMessage' ? content.documentMessage
            : null;
    if (!media && !text) return; // reacciones, estados, mensajes de sistema…
    // En el chat propio solo atendemos fotos y comandos, para no responder a nuestras propias respuestas.
    if (selfChat && !media && !COMMANDS.has(text.toLowerCase())) return;

    const sender = senderOf(m, selfChat);
    const employee = OPEN_SIGNUP ? ensureEmployee(sender) : findEmployee(sender);
    if (!employee) {
        await send(jid, { text: 'Este número no está dado de alta en el sistema de gastos. Pide a administración que te registre.' });
        return;
    }

    socket.readMessages([m.key]).catch(() => {});
    if (!media) {
        await send(jid, { text: handleCommand(text, employee) }, { quoted: m });
        return;
    }

    // La misma foto puede llegar dos veces (notify + append, o al reconectar).
    if (inFlight.has(m.key.id) || isMessageProcessed(m.key.id)) return;
    inFlight.add(m.key.id);
    try {
        await handleMedia(socket, m, jid, media, employee);
    } finally {
        inFlight.delete(m.key.id);
    }
}

async function handleMedia(socket, m, jid, media, employee) {
    const mime = media.mimetype?.split(';')[0];
    if (!SUPPORTED[mime]) {
        await send(jid, { text: `Ese archivo no lo puedo leer. Envía una foto (JPG/PNG) o un PDF.\n\n${HELP}` }, { quoted: m });
        return;
    }

    await send(jid, { react: { text: '⏳', key: m.key } }).catch(() => {});
    socket.sendPresenceUpdate('composing', jid).catch(() => {});

    let reply;
    let ok = false;
    try {
        const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage });
        const result = await processInvoice({ buffer, mime, employee, channel: 'whatsapp', messageId: m.key.id });
        reply = result.reply;
        ok = Boolean(result.invoiceId);
    } catch (err) {
        console.error(`Error procesando la factura de ${employee.name}:`, err);
        reply = '❌ Ha habido un error procesando la factura. Inténtalo de nuevo en un momento.';
    }

    socket.sendPresenceUpdate('paused', jid).catch(() => {});
    await send(jid, { text: reply }, { quoted: m });
    await send(jid, { react: { text: ok ? '✅' : '⚠️', key: m.key } }).catch(() => {});
}
