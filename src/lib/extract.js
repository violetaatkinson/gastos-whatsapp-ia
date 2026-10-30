import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

export const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.6-flash';
// Si el principal está saturado (503/429) o tarda demasiado, se prueba con este.
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.8-flash';
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 30000);

export const CATEGORIES = [
    'comida', 'alojamiento', 'combustible', 'parking', 'peaje',
    'transporte', 'material', 'otros',
];
export const DOC_TYPES = ['factura_simplificada', 'factura_completa', 'otro'];
export const PAYMENT_METHODS = ['tarjeta', 'efectivo', 'otro', 'desconocido'];

const money = z.number().nullable();

const InvoiceSchema = z.object({
    es_factura: z.boolean().describe('false si la imagen no es una factura (completa o simplificada) ni un justificante de gasto'),
    motivo: z.string().nullable().describe('Si es_factura es false o la imagen es ilegible: explicación breve para el empleado'),
    tipo_documento: z.string().describe(`Uno de: ${DOC_TYPES.join(', ')}`),
    comercio: z.object({
        nombre: z.string().nullable(),
        nif: z.string().nullable().describe('NIF/CIF del emisor, sin espacios'),
        direccion: z.string().nullable(),
    }),
    numero: z.string().nullable().describe('Número de factura'),
    fecha: z.string().nullable().describe('Formato YYYY-MM-DD'),
    hora: z.string().nullable().describe('Formato HH:MM'),
    categoria: z.string().describe(`Una de: ${CATEGORIES.join(', ')}`),
    forma_pago: z.string().describe(`Una de: ${PAYMENT_METHODS.join(', ')}`),
    moneda: z.string().describe('Código ISO 4217, p. ej. EUR'),
    lineas_iva: z.array(z.object({
        tipo: z.number().describe('Porcentaje, p. ej. 10 o 21'),
        base: money,
        cuota: money,
    })),
    base_imponible: money,
    total_iva: money,
    total: money.describe('Importe total pagado, sin propina'),
    propina: money,
    nif_cliente: z.string().nullable().describe('NIF del destinatario si aparece (solo en facturas completas)'),
    conceptos: z.array(z.object({
        descripcion: z.string(),
        cantidad: z.number().nullable(),
        importe: money,
    })),
    descripcion: z.string().describe('Resumen de 3-8 palabras del gasto, p. ej. "Comida con cliente, 2 menús"'),
    confianza: z.string().describe('alta, media o baja según la legibilidad y coherencia de los datos'),
    avisos: z.array(z.string()).describe('Problemas detectados: importes ilegibles, factura cortada, falta NIF, etc.'),
});

const { $schema, ...JSON_SCHEMA } = z.toJSONSchema(InvoiceSchema);

const SYSTEM = `Extraes datos de facturas de gastos de empleados (completas o simplificadas; los tickets de caja son facturas simplificadas) (restaurantes, hoteles, gasolineras, parkings, peajes, transporte, compras) para un sistema de gestión de gastos en España.

Reglas:
- Transcribe solo lo que se lee en el documento. Si un dato no aparece o no se lee, usa null; no lo deduzcas ni lo inventes. La única excepción son los cálculos aritméticos directos (p. ej. base = total - IVA cuando ambos aparecen).
- Importes como números con punto decimal (12.50), sin símbolo de moneda.
- Si hay varios tipos de IVA, una entrada por tipo en lineas_iva. Si la factura dice "IVA incluido" sin desglose, deja lineas_iva vacío y base_imponible/total_iva en null.
- tipo_documento: "factura_completa" solo si figura el NIF y los datos del cliente destinatario; "factura_simplificada" para tickets de caja; "otro" para recibos, justificantes de pago con tarjeta sin detalle, etc.
- Si solo hay un comprobante de datáfono sin factura, extrae lo que haya y añade un aviso.
- Si la imagen no es un documento de gasto, marca es_factura=false y explica el motivo en una frase dirigida al empleado.`;

let client;
function getClient() {
    if (!process.env.GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY en .env');
    return (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
}

/** Normaliza un valor libre a uno de la lista (tolerante a mayúsculas/acentos). */
function pick(value, allowed, fallback) {
    const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    return allowed.find((a) => norm(a) === norm(value)) ?? fallback;
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function generate(parts, model, { withSchema = true, thinking = true } = {}) {
    return getClient().models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
            systemInstruction: withSchema
                ? SYSTEM
                : `${SYSTEM}\n\nResponde solo con un JSON que cumpla este esquema:\n${JSON.stringify(JSON_SCHEMA)}`,
            responseMimeType: 'application/json',
            ...(withSchema ? { responseJsonSchema: JSON_SCHEMA } : {}),
            // Transcribir una factura no necesita razonamiento largo: con LOW responde en 1-3 s.
            ...(thinking ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
            // Sin reintentos largos del SDK: si falla, pasamos al modelo de respaldo.
            httpOptions: { timeout: TIMEOUT_MS, retryOptions: { attempts: 1 } },
        },
    });
}

const isOverloaded = (err) => [429, 500, 503, 504].includes(err?.status)
    || /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|timed? ?out|abort/i.test(err?.message ?? '');

/** Llama al modelo adaptándose a lo que acepte: esquema JSON, nivel de razonamiento y modelo de respaldo. */
async function generateWithFallback(parts) {
    // Principal → respaldo → principal otra vez: las saturaciones de Gemini suelen durar segundos.
    const models = [MODEL, FALLBACK_MODEL, MODEL];
    let lastError;
    for (const model of models) {
        const opts = { withSchema: true, thinking: true };
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                return await generate(parts, model, opts);
            } catch (err) {
                lastError = err;
                if (err?.status === 400 && /thinking/i.test(err.message) && opts.thinking) { opts.thinking = false; continue; }
                if (err?.status === 400 && /schema/i.test(err.message) && opts.withSchema) { opts.withSchema = false; continue; }
                if (isOverloaded(err) || err?.status === 404) {
                    console.warn(`Gemini ${model} no disponible (${err.status ?? err.message.slice(0, 60)}); probando el respaldo…`);
                    break;
                }
                throw err;
            }
        }
    }
    throw lastError;
}

/**
 * Extrae los datos de una factura con Gemini.
 * @param {Buffer} buffer contenido del archivo
 * @param {string} mime image/jpeg, image/png, image/webp, image/gif o application/pdf
 */
export async function extractInvoice(buffer, mime) {
    const parts = [
        { inlineData: { mimeType: mime, data: buffer.toString('base64') } },
        { text: 'Extrae los datos de esta factura.' },
    ];

    const response = await generateWithFallback(parts);

    const finish = response.candidates?.[0]?.finishReason;
    if (finish === 'SAFETY' || response.promptFeedback?.blockReason) throw new Error('El modelo rechazó procesar la imagen.');
    if (finish === 'MAX_TOKENS') throw new Error('Respuesta truncada (MAX_TOKENS).');
    const text = response.text?.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (!text) throw new Error('El modelo no devolvió datos.');
    const parsed = InvoiceSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`Respuesta del modelo con formato inesperado: ${parsed.error.issues[0]?.message}`);
    const r = parsed.data;

    const warnings = [...r.avisos];
    const vatSum = r.lineas_iva.reduce((s, l) => s + (l.cuota ?? 0), 0);
    const base = r.base_imponible ?? (r.lineas_iva.length ? r.lineas_iva.reduce((s, l) => s + (l.base ?? 0), 0) : null);
    const tax = r.total_iva ?? (r.lineas_iva.length ? vatSum : null);
    if (base != null && tax != null && r.total != null && Math.abs(base + tax - r.total) > 0.05) {
        warnings.push(`Base + IVA (${(base + tax).toFixed(2)}) no cuadra con el total (${r.total.toFixed(2)})`);
    }

    return {
        isInvoice: r.es_factura,
        reason: r.motivo,
        invoice: {
            doc_type: pick(r.tipo_documento, DOC_TYPES, 'factura_simplificada'),
            merchant_name: r.comercio.nombre,
            merchant_nif: r.comercio.nif?.replace(/[\s.-]/g, '').toUpperCase() || null,
            merchant_address: r.comercio.direccion,
            invoice_number: r.numero,
            date: /^\d{4}-\d{2}-\d{2}$/.test(r.fecha ?? '') ? r.fecha : null,
            time: r.hora,
            category: pick(r.categoria, CATEGORIES, 'otros'),
            payment_method: pick(r.forma_pago, PAYMENT_METHODS, 'desconocido'),
            currency: (r.moneda || 'EUR').toUpperCase(),
            base_amount: round2(base),
            tax_amount: round2(tax),
            total: round2(r.total),
            tip: round2(r.propina),
            customer_nif: r.nif_cliente,
            description: r.descripcion,
            vat_lines: r.lineas_iva,
            items: r.conceptos,
            confidence: pick(r.confianza, ['alta', 'media', 'baja'], 'media'),
            warnings,
            raw: r,
        },
        usage: {
            input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
            output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model: response.modelVersion ?? MODEL,
    };
}
