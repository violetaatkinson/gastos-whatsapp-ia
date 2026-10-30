import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const FILES_DIR = path.join(DATA_DIR, 'facturas');
fs.mkdirSync(FILES_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS employees (
        id          INTEGER PRIMARY KEY,
        phone       TEXT NOT NULL UNIQUE,
        wa_user_id  TEXT UNIQUE,  -- BSUID de WhatsApp: identifica al usuario aunque oculte su número
        name        TEXT NOT NULL,
        department  TEXT,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoices (
        id               INTEGER PRIMARY KEY,
        employee_id      INTEGER REFERENCES employees(id),
        status           TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (status IN ('pendiente', 'aprobado', 'rechazado')),
        received_at      TEXT NOT NULL DEFAULT (datetime('now')),
        file_path        TEXT,
        mime             TEXT,
        doc_type         TEXT,
        merchant_name    TEXT,
        merchant_nif     TEXT,
        merchant_address TEXT,
        invoice_number    TEXT,
        date             TEXT,
        time             TEXT,
        category         TEXT,
        payment_method   TEXT,
        currency         TEXT NOT NULL DEFAULT 'EUR',
        base_amount      REAL,
        tax_amount       REAL,
        total            REAL,
        tip              REAL,
        customer_nif     TEXT,
        description      TEXT,
        vat_lines        TEXT NOT NULL DEFAULT '[]',
        items            TEXT NOT NULL DEFAULT '[]',
        confidence       TEXT,
        warnings         TEXT NOT NULL DEFAULT '[]',
        duplicate_of     INTEGER,
        notes            TEXT,
        raw              TEXT,
        updated_at       TEXT
    );

    CREATE INDEX IF NOT EXISTS invoices_date ON invoices(date);
    CREATE INDEX IF NOT EXISTS invoices_employee ON invoices(employee_id);
`);

// Migración: id del mensaje de WhatsApp, para no procesar dos veces la misma foto.
if (!db.prepare('PRAGMA table_info(invoices)').all().some((c) => c.name === 'source_message_id')) {
    db.exec('ALTER TABLE invoices ADD COLUMN source_message_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS invoices_source_message ON invoices(source_message_id)');

export function isMessageProcessed(messageId) {
    return Boolean(db.prepare('SELECT 1 FROM invoices WHERE source_message_id = ?').get(messageId));
}

const JSON_FIELDS = ['vat_lines', 'items', 'warnings'];

function hydrate(row) {
    if (!row) return null;
    const out = { ...row };
    for (const f of JSON_FIELDS) out[f] = JSON.parse(out[f] ?? '[]');
    return out;
}

// ---------- Empleados ----------

/**
 * Busca al empleado por teléfono o, si WhatsApp no lo envía, por su BSUID.
 * La primera vez que llegan ambos, guarda el BSUID para reconocerlo después.
 */
export function findEmployee({ phone, userId }) {
    let employee = phone
        ? db.prepare('SELECT * FROM employees WHERE phone = ? AND active = 1').get(phone)
        : null;
    if (employee && userId && employee.wa_user_id !== userId) {
        db.prepare('UPDATE employees SET wa_user_id = NULL WHERE wa_user_id = ?').run(userId);
        db.prepare('UPDATE employees SET wa_user_id = ? WHERE id = ?').run(userId, employee.id);
        employee = { ...employee, wa_user_id: userId };
    }
    if (!employee && userId) {
        employee = db.prepare('SELECT * FROM employees WHERE wa_user_id = ? AND active = 1').get(userId);
    }
    return employee ?? null;
}

/**
 * Modo demo: da de alta automáticamente a quien escriba al bot.
 * Si WhatsApp no revela el número (solo su LID), se guarda como "lid-<id>".
 */
export function ensureEmployee({ phone, userId, name }) {
    const found = findEmployee({ phone, userId });
    if (found) return found;
    const id = createEmployee({ phone: phone ?? `lid-${userId}`, name: name || 'Empleado sin nombre' });
    if (userId) {
        db.prepare('UPDATE employees SET wa_user_id = NULL WHERE wa_user_id = ? AND id <> ?').run(userId, id);
        db.prepare('UPDATE employees SET wa_user_id = ? WHERE id = ?').run(userId, id);
    }
    return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
}

export function listEmployees() {
    return db.prepare(`
        SELECT e.*, COUNT(t.id) AS invoice_count, COALESCE(SUM(t.total), 0) AS total_spent
        FROM employees e LEFT JOIN invoices t ON t.employee_id = e.id
        WHERE e.active = 1
        GROUP BY e.id ORDER BY e.name
    `).all();
}

export function createEmployee({ phone, name, department }) {
    const existing = db.prepare('SELECT id FROM employees WHERE phone = ?').get(phone);
    if (existing) {
        db.prepare('UPDATE employees SET name = ?, department = ?, active = 1 WHERE id = ?')
            .run(name, department ?? null, existing.id);
        return existing.id;
    }
    return Number(db.prepare('INSERT INTO employees (phone, name, department) VALUES (?, ?, ?)')
        .run(phone, name, department ?? null).lastInsertRowid);
}

export function updateEmployee(id, { name, department }) {
    db.prepare('UPDATE employees SET name = ?, department = ? WHERE id = ?').run(name, department ?? null, id);
}

/** Baja lógica: sus invoices se conservan. */
export function deactivateEmployee(id) {
    db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(id);
}

// ---------- Invoices ----------

export function insertInvoice(t) {
    const result = db.prepare(`
        INSERT INTO invoices (
            employee_id, file_path, mime, doc_type, merchant_name, merchant_nif, merchant_address,
            invoice_number, date, time, category, payment_method, currency, base_amount, tax_amount,
            total, tip, customer_nif, description, vat_lines, items, confidence, warnings,
            duplicate_of, raw, source_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...[
        t.employee_id, t.file_path, t.mime, t.doc_type, t.merchant_name, t.merchant_nif,
        t.merchant_address, t.invoice_number, t.date, t.time, t.category, t.payment_method,
        t.currency ?? 'EUR', t.base_amount, t.tax_amount, t.total, t.tip, t.customer_nif,
        t.description, JSON.stringify(t.vat_lines ?? []), JSON.stringify(t.items ?? []),
        t.confidence, JSON.stringify(t.warnings ?? []), t.duplicate_of,
        JSON.stringify(t.raw ?? null), t.source_message_id,
    ].map((v) => v ?? null)); // node:sqlite no acepta undefined
    return Number(result.lastInsertRowid);
}

export function getInvoice(id) {
    return hydrate(db.prepare(`
        SELECT t.*, e.name AS employee_name, e.phone AS employee_phone
        FROM invoices t LEFT JOIN employees e ON e.id = t.employee_id
        WHERE t.id = ?
    `).get(id));
}

// Fecha de registro en hora local (received_at se guarda en UTC).
const RECEIVED_DAY = "date(t.received_at, 'localtime')";

/**
 * basis 'invoice' filtra por la fecha de la factura (contabilidad);
 * 'received' por el día en que llegó (panel: "este mes" incluye lo recién enviado aunque la factura sea antigua).
 */
function whereClause({ from, to, employee, category, status, q, basis = 'invoice' } = {}) {
    const conds = [];
    const params = [];
    const day = basis === 'received' ? RECEIVED_DAY : `COALESCE(t.date, ${RECEIVED_DAY})`;
    if (from) { conds.push(`${day} >= ?`); params.push(from); }
    if (to) { conds.push(`${day} <= ?`); params.push(to); }
    if (employee) { conds.push('t.employee_id = ?'); params.push(Number(employee)); }
    if (category) { conds.push('t.category = ?'); params.push(category); }
    if (status) { conds.push('t.status = ?'); params.push(status); }
    if (q) {
        conds.push('(t.merchant_name LIKE ? OR t.merchant_nif LIKE ? OR t.invoice_number LIKE ? OR t.description LIKE ?)');
        params.push(...Array(4).fill(`%${q}%`));
    }
    return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export function listInvoices(filters) {
    const { sql, params } = whereClause(filters);
    return db.prepare(`
        SELECT t.*, e.name AS employee_name
        FROM invoices t LEFT JOIN employees e ON e.id = t.employee_id
        ${sql}
        ORDER BY t.received_at DESC, t.id DESC
    `).all(...params).map(hydrate);
}

export function invoiceStats(filters) {
    const { sql, params } = whereClause(filters);
    return db.prepare(`
        SELECT
            COUNT(*)                                              AS count,
            COALESCE(SUM(t.total), 0)                             AS total,
            COALESCE(SUM(t.tax_amount), 0)                        AS tax,
            COALESCE(SUM(CASE WHEN t.doc_type = 'factura_completa'
                              THEN t.tax_amount END), 0)          AS deductible_tax,
            SUM(t.status = 'pendiente')                           AS pending
        FROM invoices t ${sql}
    `).get(...params);
}

const EDITABLE = [
    'employee_id', 'status', 'doc_type', 'merchant_name', 'merchant_nif', 'merchant_address',
    'invoice_number', 'date', 'time', 'category', 'payment_method', 'currency', 'base_amount',
    'tax_amount', 'total', 'tip', 'customer_nif', 'description', 'notes',
];

export function updateInvoice(id, fields) {
    const keys = Object.keys(fields).filter((k) => EDITABLE.includes(k));
    if (!keys.length) return;
    db.prepare(`UPDATE invoices SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...keys.map((k) => fields[k] === '' ? null : fields[k]), id);
}

export function deleteInvoice(id) {
    const invoice = db.prepare('SELECT file_path FROM invoices WHERE id = ?').get(id);
    if (!invoice) return false;
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    if (invoice.file_path) fs.rmSync(path.join(FILES_DIR, invoice.file_path), { force: true });
    return true;
}

/** Mismo proveedor + número de factura + total → probablemente enviado dos veces. */
export function findDuplicate({ merchant_nif, merchant_name, invoice_number, total, date }) {
    if (total == null) return null;
    const row = invoice_number
        ? db.prepare(`SELECT id FROM invoices WHERE invoice_number = ? AND ABS(total - ?) < 0.005
                      AND (merchant_nif = ? OR merchant_name = ?) LIMIT 1`)
            .get(invoice_number, total, merchant_nif ?? '', merchant_name ?? '')
        : db.prepare(`SELECT id FROM invoices WHERE date = ? AND ABS(total - ?) < 0.005
                      AND (merchant_nif = ? OR merchant_name = ?) LIMIT 1`)
            .get(date ?? '', total, merchant_nif ?? '', merchant_name ?? '');
    return row?.id ?? null;
}

export function lastInvoiceOf(employeeId) {
    return hydrate(db.prepare('SELECT * FROM invoices WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employeeId));
}

export function monthSummary(employeeId, month /* YYYY-MM */) {
    return db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
        FROM invoices WHERE employee_id = ? AND strftime('%Y-%m', received_at, 'localtime') = ?
    `).get(employeeId, month);
}

/** YYYY-MM-DD en hora local. */
export const localDay = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- Analítica del panel ----------

export function categoryBreakdown(filters) {
    const { sql, params } = whereClause(filters);
    return db.prepare(`
        SELECT t.category AS category, COUNT(*) AS count, COALESCE(SUM(t.total), 0) AS total
        FROM invoices t ${sql}
        GROUP BY t.category ORDER BY total DESC
    `).all(...params);
}

/** Gasto registrado por día de los últimos `days` días (incluidos los días sin gasto). */
export function dailyTotals(days = 30) {
    const rows = db.prepare(`
        SELECT date(received_at, 'localtime') AS day, SUM(total) AS total, COUNT(*) AS count
        FROM invoices
        WHERE date(received_at, 'localtime') >= date('now', 'localtime', ?)
        GROUP BY day
    `).all(`-${days - 1} days`);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = localDay(new Date(Date.now() - i * 86400000));
        out.push({ day, total: byDay.get(day)?.total ?? 0, count: byDay.get(day)?.count ?? 0 });
    }
    return out;
}

export function topEmployees(filters, limit = 5) {
    const { sql, params } = whereClause(filters);
    return db.prepare(`
        SELECT e.id, e.name, e.department, COUNT(t.id) AS count, COALESCE(SUM(t.total), 0) AS total
        FROM invoices t JOIN employees e ON e.id = t.employee_id ${sql}
        GROUP BY e.id ORDER BY total DESC LIMIT ?
    `).all(...params, limit);
}

/** Borra todas las facturas y empleados (botón "Reiniciar demo"). */
export function resetAll() {
    db.exec('DELETE FROM invoices; DELETE FROM employees;');
    for (const f of fs.readdirSync(FILES_DIR)) fs.rmSync(path.join(FILES_DIR, f), { force: true });
}
