import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    FILES_DIR, deleteInvoice, findDuplicate, insertInvoice, lastInvoiceOf, localDay, monthSummary,
} from './db.js';
import { MODEL, extractInvoice } from './extract.js';
import { publish } from './events.js';

// Lógica común a cualquier canal (WhatsApp con Baileys, API de Meta o subida desde el panel):
// recibe el archivo, lo lee con Gemini, lo guarda y devuelve el texto de respuesta para el chat.

export const SUPPORTED = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'application/pdf': '.pdf',
};

export const HELP = `Envíame una *foto de la factura* (o el PDF) y la registro automáticamente.

Comandos:
• *borrar*: elimina la última factura que enviaste (si aún está pendiente)
• *resumen*: tus gastos de este mes`;

const eur = (n, currency = 'EUR') =>
    n == null ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(n);
const esDate = (iso) => (iso ? iso.split('-').reverse().join('/') : 'sin fecha');

function summary(t, id, duplicateOf) {
    const vat = t.vat_lines.length
        ? t.vat_lines.map((l) => `IVA ${l.tipo}%: ${eur(l.cuota, t.currency)}`).join(' · ')
        : 'IVA incluido';
    const lines = [
        `✅ *Factura #${id} procesada correctamente*`,
        '',
        `🏢 ${t.merchant_name ?? 'Comercio sin identificar'}${t.merchant_nif ? ` · ${t.merchant_nif}` : ''}`,
        `📅 ${esDate(t.date)}${t.time ? ` · ${t.time}` : ''}`,
        `🏷️ ${t.category[0].toUpperCase()}${t.category.slice(1)}`,
        `💶 Base ${eur(t.base_amount, t.currency)} · ${vat}`,
        `*Total: ${eur(t.total, t.currency)}*`,
    ];
    if (t.doc_type === 'factura_completa') lines.push('🧾 Factura completa (IVA deducible)');
    if (duplicateOf) lines.push('', `⚠️ Parece duplicada de la factura #${duplicateOf}. Si es un error, escribe *borrar*.`);
    if (t.confidence === 'baja' || t.warnings.length) {
        lines.push('', `⚠️ Revisar: ${t.warnings.join('; ') || 'lectura con baja confianza'}`);
    }
    lines.push('', 'Ya está disponible en el panel de gastos.');
    return lines.join('\n');
}

/** Mensaje corto para el panel; el detalle completo queda en la consola. */
function friendlyError(err) {
    const msg = String(err?.message ?? err);
    if (/GEMINI_API_KEY/.test(msg)) return 'Falta GEMINI_API_KEY en .env';
    if (/API_KEY_INVALID|API key not valid/i.test(msg)) return 'La clave de Gemini no es válida';
    if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) return 'Cuota de Gemini agotada; prueba en unos minutos';
    if (/not found|NOT_FOUND|404/i.test(msg)) return `El modelo ${MODEL} no está disponible para esta clave`;
    return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
}

/**
 * Procesa una factura recibida y publica su progreso en el panel.
 * @returns {Promise<{ reply: string, invoiceId?: number }>}
 */
export async function processInvoice({ buffer, mime, employee, channel = 'whatsapp', messageId = null }) {
    const activity = crypto.randomUUID();
    const step = (stage, extra = {}) => publish('activity', {
        id: activity, stage, channel, employee: employee.name, ...extra,
    });

    if (!SUPPORTED[mime]) {
        return { reply: 'Ese tipo de archivo no lo puedo leer. Envía una foto (JPG/PNG) o un PDF.' };
    }

    step('received');
    const started = Date.now();
    let result;
    try {
        step('extracting', { model: MODEL });
        result = await extractInvoice(buffer, mime);
    } catch (err) {
        console.error(`Error extrayendo factura de ${employee.name}:`, err.message);
        step('error', { message: friendlyError(err) });
        return { reply: '❌ No he podido leer la factura ahora mismo. Inténtalo de nuevo en un momento.' };
    }

    if (!result.isInvoice) {
        step('rejected', { message: result.reason });
        return {
            reply: `🤔 No he podido registrarla: ${result.reason ?? 'no parece una factura.'}\nPrueba con otra foto, bien iluminada y con la factura entera.`,
        };
    }

    const fileName = `${Date.now()}-${employee.id}${SUPPORTED[mime]}`;
    fs.writeFileSync(path.join(FILES_DIR, fileName), buffer);

    const duplicateOf = findDuplicate(result.invoice);
    const id = insertInvoice({
        ...result.invoice,
        employee_id: employee.id,
        file_path: fileName,
        mime,
        duplicate_of: duplicateOf,
        source_message_id: messageId,
    });
    const seconds = (Date.now() - started) / 1000;
    console.log(`#${id} ${employee.name}: ${result.invoice.merchant_name} ${result.invoice.total} · ${seconds.toFixed(1)} s · ${result.usage.input_tokens}+${result.usage.output_tokens} tokens`);

    step('done', {
        invoiceId: id,
        merchant: result.invoice.merchant_name,
        total: result.invoice.total,
        currency: result.invoice.currency,
        hasImage: mime !== 'application/pdf',
        seconds,
    });
    publish('invoices', { id, action: 'created' });
    return { reply: summary(result.invoice, id, duplicateOf), invoiceId: id };
}

export function handleCommand(text, employee) {
    const cmd = text.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (cmd === 'borrar') {
        const last = lastInvoiceOf(employee.id);
        if (!last) return 'No tienes facturas registradas.';
        if (last.status !== 'pendiente') return `La factura #${last.id} ya está ${last.status === 'aprobado' ? 'aprobada' : 'rechazada'} y no se puede borrar desde aquí.`;
        deleteInvoice(last.id);
        publish('invoices', { id: last.id, action: 'deleted' });
        return `🗑️ Factura #${last.id} (${last.merchant_name ?? 'sin comercio'}, ${eur(last.total)}) eliminada.`;
    }
    if (cmd === 'resumen') {
        const month = localDay().slice(0, 7);
        const s = monthSummary(employee.id, month);
        return `📊 Este mes llevas *${s.count}* facturas por un total de *${eur(s.total)}*.`;
    }
    return `Hola, ${employee.name.split(' ')[0]} 👋\n\n${HELP}`;
}
