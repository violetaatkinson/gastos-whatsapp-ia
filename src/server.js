import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
    DATA_DIR, FILES_DIR, categoryBreakdown, createEmployee, dailyTotals, deactivateEmployee, deleteInvoice,
    ensureEmployee, getInvoice, invoiceStats, listEmployees, listInvoices, localDay, resetAll, topEmployees,
    updateEmployee, updateInvoice,
} from './lib/db.js';
import { CATEGORIES, DOC_TYPES, MODEL, PAYMENT_METHODS } from './lib/extract.js';
import { bus, publish } from './lib/events.js';
import { SUPPORTED, processInvoice } from './lib/processor.js';
import { getWhatsAppState, logoutWhatsApp, reconnectWhatsApp, startWhatsApp } from './lib/baileys.js';

// Un solo proceso: panel web + API + bot de WhatsApp (Baileys) + eventos en tiempo real.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Una sola instancia: dos procesos con la misma sesión de WhatsApp se expulsan mutuamente.
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const otherPid = Number(fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8'));
if (otherPid && otherPid !== process.pid) {
    try {
        process.kill(otherPid, 0);
        console.error(`Ya hay un servidor en marcha (PID ${otherPid}). Ciérralo antes de arrancar otro.`);
        process.exit(1);
    } catch {
        // el proceso anterior ya no existe
    }
}
fs.writeFileSync(PID_FILE, String(process.pid));
const releasePid = () => {
    try { if (fs.readFileSync(PID_FILE, 'utf8') === String(process.pid)) fs.rmSync(PID_FILE); } catch { /* ya borrado */ }
};
process.on('exit', releasePid);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
const PORT = Number(process.env.PORT ?? 3000);
// Sin autenticación todavía: por defecto solo accesible desde este equipo.
const HOST = process.env.HOST ?? '127.0.0.1';
const BRAND = {
    product: process.env.BRAND_NAME ?? 'Gastos',
    client: process.env.CLIENT_NAME ?? null,
};

const normalizePhone = (phone) => {
    const d = String(phone).replace(/\D/g, '');
    if (d.length < 8) throw new Error(`Número inválido: ${phone}`);
    return d;
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

const filtersOf = (q) => ({
    from: q.from, to: q.to, employee: q.employee, category: q.category, status: q.status, q: q.q,
});

app.get('/api/meta', (req, res) => {
    res.json({
        categories: CATEGORIES, docTypes: DOC_TYPES, paymentMethods: PAYMENT_METHODS,
        brand: BRAND, model: MODEL, geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    });
});

// ---------- Tiempo real (Server-Sent Events) ----------

app.get('/api/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    write({ type: 'whatsapp', data: getWhatsAppState() });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    bus.on('event', write);
    req.on('close', () => {
        clearInterval(heartbeat);
        bus.off('event', write);
    });
});

// ---------- WhatsApp ----------

app.get('/api/whatsapp', (req, res) => res.json(getWhatsAppState()));
app.post('/api/whatsapp/logout', async (req, res) => {
    await logoutWhatsApp();
    res.status(204).end();
});
app.post('/api/whatsapp/reconnect', (req, res) => {
    reconnectWhatsApp();
    res.status(204).end();
});

// ---------- Panel ----------

app.get('/api/overview', (req, res) => {
    // "Este mes" = registradas este mes, para que cuente lo recién enviado aunque la factura sea de otra fecha.
    const monthFilter = { from: `${localDay().slice(0, 7)}-01`, basis: 'received' };
    res.json({
        month: invoiceStats(monthFilter),
        all: invoiceStats({}),
        categories: categoryBreakdown(monthFilter),
        daily: dailyTotals(30),
        employees: topEmployees(monthFilter),
        recent: listInvoices({}).slice(0, 8),
    });
});

app.get('/api/invoices', (req, res) => {
    const filters = filtersOf(req.query);
    res.json({ invoices: listInvoices(filters), stats: invoiceStats(filters) });
});

app.get('/api/invoices/:id', (req, res) => {
    const invoice = getInvoice(Number(req.params.id));
    if (!invoice) return res.status(404).json({ error: 'No existe' });
    res.json(invoice);
});

app.get('/api/invoices/:id/file', (req, res) => {
    const invoice = getInvoice(Number(req.params.id));
    if (!invoice?.file_path) return res.status(404).end();
    res.type(invoice.mime).sendFile(path.join(FILES_DIR, path.basename(invoice.file_path)));
});

// Subida manual desde el panel: mismo proceso que si llegara por WhatsApp.
app.post('/api/invoices/upload', express.raw({ type: Object.keys(SUPPORTED), limit: '20mb' }), async (req, res) => {
    const mime = req.get('content-type')?.split(';')[0];
    if (!SUPPORTED[mime] || !Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'Sube una imagen (JPG, PNG, WEBP) o un PDF.' });
    }
    const employee = req.query.employee
        ? listEmployees().find((e) => e.id === Number(req.query.employee))
        : ensureEmployee({ phone: 'panel', name: 'Administración' });
    if (!employee) return res.status(400).json({ error: 'Empleado no encontrado' });
    const result = await processInvoice({ buffer: req.body, mime, employee, channel: 'panel' });
    if (!result.invoiceId) return res.status(422).json({ error: result.reply });
    res.status(201).json({ id: result.invoiceId });
});

app.patch('/api/invoices/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getInvoice(id)) return res.status(404).json({ error: 'No existe' });
    try {
        updateInvoice(id, req.body);
        publish('invoices', { id, action: 'updated' });
        res.json(getInvoice(id));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/invoices/:id', (req, res) => {
    const id = Number(req.params.id);
    const ok = deleteInvoice(id);
    if (ok) publish('invoices', { id, action: 'deleted' });
    res.status(ok ? 204 : 404).end();
});

app.post('/api/reset', (req, res) => {
    resetAll();
    publish('invoices', { action: 'reset' });
    res.status(204).end();
});

// ---------- Empleados ----------

app.get('/api/employees', (req, res) => res.json(listEmployees()));

app.post('/api/employees', (req, res) => {
    const { phone, name, department } = req.body ?? {};
    if (!phone || !name?.trim()) return res.status(400).json({ error: 'Teléfono y nombre son obligatorios' });
    try {
        const id = createEmployee({ phone: normalizePhone(phone), name: name.trim(), department: department?.trim() || null });
        publish('invoices', { action: 'employees' });
        res.status(201).json({ id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.patch('/api/employees/:id', (req, res) => {
    const { name, department } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    updateEmployee(Number(req.params.id), { name: name.trim(), department: department?.trim() || null });
    publish('invoices', { action: 'employees' });
    res.status(204).end();
});

app.delete('/api/employees/:id', (req, res) => {
    deactivateEmployee(Number(req.params.id));
    publish('invoices', { action: 'employees' });
    res.status(204).end();
});

// ---------- Exportación CSV (formato Excel en español) ----------

const num = (n) => (n == null ? '' : n.toFixed(2).replace('.', ','));
const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const COLUMNS = [
    ['Nº', (i) => i.id],
    ['Fecha', (i) => i.date],
    ['Hora', (i) => i.time],
    ['Empleado', (i) => i.employee_name],
    ['Proveedor', (i) => i.merchant_name],
    ['NIF proveedor', (i) => i.merchant_nif],
    ['Nº factura', (i) => i.invoice_number],
    ['Tipo', (i) => i.doc_type],
    ['Categoría', (i) => i.category],
    ['Base imponible', (i) => num(i.base_amount)],
    ['IVA', (i) => num(i.tax_amount)],
    ['Total', (i) => num(i.total)],
    ['Propina', (i) => num(i.tip)],
    ['Moneda', (i) => i.currency],
    ['Desglose IVA', (i) => i.vat_lines.map((l) => `${l.tipo}%: base ${num(l.base)} cuota ${num(l.cuota)}`).join(' | ')],
    ['Forma de pago', (i) => i.payment_method],
    ['NIF cliente', (i) => i.customer_nif],
    ['Descripción', (i) => i.description],
    ['Estado', (i) => i.status],
    ['Notas', (i) => i.notes],
    ['Recibida', (i) => i.received_at],
];

app.get('/api/export.csv', (req, res) => {
    const rows = listInvoices(filtersOf(req.query));
    const lines = [
        COLUMNS.map(([h]) => h).join(';'),
        ...rows.map((i) => COLUMNS.map(([, get]) => cell(get(i))).join(';')),
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="facturas-${stamp}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
});

const server = app.listen(PORT, HOST, () => {
    console.log(`Panel en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!process.env.GEMINI_API_KEY) console.warn('Aviso: falta GEMINI_API_KEY en .env; las facturas no se podrán leer.');
    if (process.env.WHATSAPP_DISABLED !== 'true') {
        startWhatsApp().catch((err) => console.error('No se pudo iniciar WhatsApp:', err.message));
    }
});
server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `El puerto ${PORT} ya está en uso.` : err.message);
    process.exit(1);
});
