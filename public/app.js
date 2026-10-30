const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const STATUS_LABEL = { pendiente: 'Pendiente', aprobado: 'Aprobada', rechazado: 'Rechazada' };
const DOC_LABEL = { factura_completa: 'Factura completa', factura_simplificada: 'Factura simplificada', otro: 'Otro justificante' };
const PAY_LABEL = { tarjeta: 'Tarjeta', efectivo: 'Efectivo', otro: 'Otro', desconocido: 'Desconocido' };
const VIEW_TITLE = { overview: 'Resumen', invoices: 'Facturas', employees: 'Empleados', whatsapp: 'WhatsApp' };
const STAGES = ['received', 'extracting', 'done'];

const state = {
    meta: null, view: 'overview', employees: [], invoices: [], overview: null,
    current: null, wa: { status: 'starting' }, feed: new Map(), fresh: new Set(),
};

// ---------- Utilidades ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n, currency = 'EUR') => (n == null ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(n));
const eurShort = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const esDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const initials = (name) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const utc = (sqlite) => new Date(`${sqlite.replace(' ', 'T')}Z`);
const phoneLabel = (p) => (/^\d+$/.test(p ?? '') ? `+${p}` : '—');
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
function ago(date) {
    const s = Math.round((date - Date.now()) / 1000);
    if (s > -45) return 'ahora mismo';
    if (s > -3600) return rtf.format(Math.round(s / 60), 'minute');
    if (s > -86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
}

async function api(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `Error ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
}

function toast(title, { text = '', kind = 'info', onClick } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `
        <div class="toast-icon">${icon(kind === 'success' ? 'check' : kind === 'warn' ? 'alert' : 'spark')}</div>
        <div class="toast-body"><div class="toast-title">${esc(title)}</div>${text ? `<div class="toast-text">${esc(text)}</div>` : ''}</div>`;
    if (onClick) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', onClick);
    }
    $('#toasts').append(el);
    setTimeout(() => {
        el.classList.add('is-leaving');
        el.addEventListener('animationend', () => el.remove());
    }, 4500);
}

/** Anima un número desde su valor actual hasta el nuevo. */
function countTo(el, value, format) {
    const from = Number(el.dataset.value ?? value);
    el.dataset.value = value;
    if (from === value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = format(value);
        return;
    }
    el.closest('.kpi')?.classList.remove('flash');
    void el.offsetWidth;
    el.closest('.kpi')?.classList.add('flash');
    const start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / 700);
        const eased = 1 - (1 - t) ** 3;
        el.textContent = format(from + (value - from) * eased);
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// ---------- Navegación ----------

function show(view) {
    state.view = view;
    if (!location.hash.startsWith('#factura-')) history.replaceState(null, '', view === 'overview' ? location.pathname : `#${view}`);
    $$('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.view === view));
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
    $('#page-title').textContent = VIEW_TITLE[view];
    $('#sidebar').classList.remove('is-open');
    if (view === 'invoices') loadInvoices();
    if (view === 'employees') loadEmployees();
    if (view === 'overview') loadOverview();
}

document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-view]');
    if (target) show(target.dataset.view);
});
$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));

// ---------- Resumen ----------

async function loadOverview() {
    state.overview = await api('/api/overview');
    renderOverview();
}

function renderOverview() {
    const o = state.overview;
    const monthName = new Date().toLocaleDateString('es-ES', { month: 'long' });
    const kpis = [
        ['spent', `Gasto en ${monthName}`, o.month.total, eur, `${o.all.count} facturas en total`],
        ['count', 'Facturas del mes', o.month.count, (n) => Math.round(n).toString(), `Registradas en ${monthName}`],
        ['vat', 'IVA deducible', o.month.deductible_tax, eur, 'Facturas completas del mes'],
        ['pending', 'Pendientes de revisar', o.month.pending ?? 0, (n) => Math.round(n).toString(), 'Requieren aprobación'],
    ];
    if (!$('#kpis').children.length) {
        $('#kpis').innerHTML = kpis.map(([key, label]) => `
            <div class="card kpi">
                <div class="kpi-label">${label}</div>
                <div class="kpi-value" data-kpi="${key}"></div>
                <div class="kpi-foot" data-foot="${key}"></div>
            </div>`).join('');
    }
    for (const [key, , value, format, foot] of kpis) {
        countTo($(`[data-kpi="${key}"]`), value, format);
        $(`[data-foot="${key}"]`).textContent = foot;
    }

    const total30 = o.daily.reduce((s, d) => s + d.total, 0);
    $('#daily-figure').innerHTML = `<strong>${eur(total30)}</strong><span>${o.daily.reduce((s, d) => s + d.count, 0)} facturas</span>`;
    renderDailyChart(o.daily);
    renderCategories(o.categories);
    renderTopEmployees(o.employees);
    renderRecent(o.recent);
    if (!state.feed.size) seedFeed(o.recent);
    updatePendingBadge(o.all.pending ?? 0);
}

function updatePendingBadge(n) {
    $('#nav-pending').hidden = !n;
    $('#nav-pending').textContent = n;
}

function barPath(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v) {
    if (v <= 0) return 100;
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function renderDailyChart(daily) {
    const el = $('#daily-chart');
    const W = el.clientWidth || 600;
    const H = 220;
    const pad = { top: 8, right: 0, bottom: 24, left: 48 };
    const iw = W - pad.left - pad.right;
    const ih = H - pad.top - pad.bottom;
    const max = niceMax(Math.max(...daily.map((d) => d.total)));
    const slot = iw / daily.length;
    const bw = Math.max(2, slot - 2);
    const y = (v) => pad.top + ih - (v / max) * ih;

    const grid = [0, 0.5, 1].map((f) => {
        const gy = y(max * f);
        return `<line class="grid-line" x1="${pad.left}" x2="${W}" y1="${gy}" y2="${gy}"/>
            <text class="axis-label" x="${pad.left - 8}" y="${gy + 4}" text-anchor="end">${eurShort(max * f)}</text>`;
    }).join('');

    const bars = daily.map((d, i) => {
        const x = pad.left + i * slot + 1;
        const h = d.total > 0 ? Math.max(2, (d.total / max) * ih) : 2;
        return `<path class="bar ${d.total > 0 ? '' : 'is-zero'}" data-i="${i}" d="${barPath(x, pad.top + ih - h, bw, h, 4)}"/>
            <rect class="bar-hit" data-i="${i}" x="${x - 1}" y="${pad.top}" width="${slot}" height="${ih}"/>`;
    }).join('');

    const last = daily.length - 1;
    const labels = daily.map((d, i) => (i % 7 === 0 ? last - i >= 4 : i === last)
        ? `<text class="axis-label" x="${pad.left + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${new Date(`${d.day}T00:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</text>`
        : '').join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gasto diario de los últimos 30 días">${grid}${bars}${labels}</svg>`;

    const tip = $('#tooltip');
    el.querySelectorAll('.bar-hit').forEach((hit) => {
        const d = daily[Number(hit.dataset.i)];
        const bar = el.querySelector(`.bar[data-i="${hit.dataset.i}"]`);
        hit.addEventListener('mouseenter', () => {
            bar.classList.add('is-hover');
            tip.innerHTML = `${new Date(`${d.day}T00:00:00`).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'long' })}<strong>${eur(d.total)}</strong>${d.count} ${d.count === 1 ? 'factura' : 'facturas'}`;
            tip.hidden = false;
        });
        hit.addEventListener('mousemove', (e) => {
            tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`;
            tip.style.top = `${e.clientY - tip.offsetHeight - 12}px`;
        });
        hit.addEventListener('mouseleave', () => {
            bar.classList.remove('is-hover');
            tip.hidden = true;
        });
    });
}

function hbars(rows, label, empty) {
    if (!rows.length) return `<div class="empty-small">${empty}</div>`;
    const max = Math.max(...rows.map((r) => r.total), 1);
    return `<div class="hbars">${rows.map((r) => `
        <div class="hbar">
            <div class="hbar-label">${label(r)}</div>
            <div class="hbar-track"><div class="hbar-fill" style="width:${(r.total / max) * 100}%"></div></div>
            <div class="hbar-value">${eur(r.total)}</div>
        </div>`).join('')}</div>`;
}

function renderCategories(rows) {
    $('#categories').innerHTML = hbars(rows, (r) => `${esc(cap(r.category ?? 'otros'))}<small>${r.count} ${r.count === 1 ? 'factura' : 'facturas'}</small>`, 'Sin gastos este mes');
}

function renderTopEmployees(rows) {
    $('#top-employees').innerHTML = hbars(rows, (r) => `${esc(r.name)}<small>${r.count} ${r.count === 1 ? 'factura' : 'facturas'}</small>`, 'Sin gastos este mes');
}

/** Miniatura de la imagen recibida (o icono si es PDF / no hay archivo). */
function thumb(i) {
    if (!i.file_path) return `<span class="thumb thumb-empty">${icon('receipt')}</span>`;
    if (i.mime === 'application/pdf') return `<span class="thumb thumb-pdf">PDF</span>`;
    return `<img class="thumb" src="/api/invoices/${i.id}/file" alt="" loading="lazy" width="36" height="36">`;
}

function invoiceRow(i, cols) {
    const review = i.confidence === 'baja' || i.warnings.length > 0 || i.duplicate_of;
    const cells = {
        date: `<td><div class="cell-main">${esDate(i.date)}</div><div class="cell-sub">#${i.id}${i.time ? ` · ${esc(i.time)}` : ''}</div></td>`,
        merchant: `<td><div class="merchant">${thumb(i)}<div>
            <div class="cell-main">${esc(i.merchant_name ?? 'Sin identificar')}${review ? `<span class="flag">${icon('alert')}Revisar</span>` : ''}</div>
            <div class="cell-sub">${esc(i.merchant_nif ?? '')}${i.doc_type === 'factura_completa' ? ' · Factura completa' : ''}</div></div></div></td>`,
        employee: `<td><div class="person"><span class="avatar">${esc(initials(i.employee_name))}</span><span>${esc(i.employee_name ?? '—')}</span></div></td>`,
        category: `<td>${esc(cap(i.category))}</td>`,
        base: `<td class="num">${eur(i.base_amount, i.currency)}</td>`,
        tax: `<td class="num">${eur(i.tax_amount, i.currency)}</td>`,
        total: `<td class="num cell-main">${eur(i.total, i.currency)}</td>`,
        status: `<td><span class="badge badge-${i.status}">${STATUS_LABEL[i.status]}</span></td>`,
    };
    return `<tr class="clickable ${state.fresh.has(i.id) ? 'is-new' : ''}" data-id="${i.id}">${cols.map((c) => cells[c]).join('')}</tr>`;
}

function renderRecent(rows) {
    $('#recent-rows').innerHTML = rows.map((i) => invoiceRow(i, ['merchant', 'employee', 'date', 'category', 'total', 'status'])).join('');
    $('#recent-empty').hidden = rows.length > 0;
}

// ---------- Actividad en directo ----------

function seedFeed(recent) {
    for (const i of recent.slice(0, 5).reverse()) {
        state.feed.set(`inv-${i.id}`, {
            id: `inv-${i.id}`, stage: 'done', employee: i.employee_name, invoiceId: i.id, hasImage: Boolean(i.file_path) && i.mime !== 'application/pdf',
            merchant: i.merchant_name, total: i.total, currency: i.currency, at: utc(i.received_at),
        });
    }
    renderFeed();
}

function onActivity(a) {
    const prev = state.feed.get(a.id) ?? { at: new Date() };
    state.feed.set(a.id, { ...prev, ...a });
    while (state.feed.size > 12) state.feed.delete(state.feed.keys().next().value);
    renderFeed();

    if (a.stage === 'received') {
        toast('Factura recibida', { text: `${a.employee} · leyendo con IA…` });
    } else if (a.stage === 'done') {
        state.fresh.add(a.invoiceId);
        setTimeout(() => state.fresh.delete(a.invoiceId), 3000);
        toast(`${a.merchant ?? 'Factura'} · ${eur(a.total, a.currency)}`, {
            kind: 'success',
            text: `Registrada en ${a.seconds?.toFixed(1).replace('.', ',')} s · ${a.employee}`,
            onClick: () => openInvoice(a.invoiceId),
        });
    } else if (a.stage === 'rejected' || a.stage === 'error') {
        toast(a.stage === 'rejected' ? 'No parece una factura' : 'Error al leer la factura', { kind: 'warn', text: a.message ?? '' });
    }
}

function renderFeed() {
    const items = [...state.feed.values()].reverse();
    $('#feed-empty').hidden = items.length > 0;
    $('#feed').innerHTML = items.map((a) => {
        const reached = STAGES.indexOf(a.stage);
        const failed = a.stage === 'error' || a.stage === 'rejected';
        const title = a.stage === 'done' ? esc(a.merchant ?? 'Factura registrada')
            : failed ? (a.stage === 'rejected' ? 'No es una factura' : 'Error de lectura')
                : a.stage === 'extracting' ? 'Leyendo con IA…' : 'Factura recibida';
        const sub = a.stage === 'done'
            ? `${esc(a.employee)} · ${a.seconds ? `procesada en ${a.seconds.toFixed(1).replace('.', ',')} s` : ago(a.at)}`
            : `${esc(a.employee)} · ${failed ? esc(a.message ?? '') : a.channel === 'panel' ? 'subida desde el panel' : 'vía WhatsApp'}`;
        return `
            <li class="feed-item ${a.invoiceId ? 'is-clickable' : ''}" data-stage="${a.stage}" ${a.invoiceId ? `data-invoice="${a.invoiceId}"` : ''}>
                ${a.stage === 'done' && a.hasImage
                    ? `<img class="feed-thumb" src="/api/invoices/${a.invoiceId}/file" alt="" width="32" height="32">`
                    : `<div class="feed-icon">${icon(a.stage === 'done' ? 'check' : failed ? 'alert' : 'spark')}</div>`}
                <div class="feed-body">
                    <div class="feed-title"><span>${title}</span>${a.stage === 'done' ? `<span class="feed-amount">${eur(a.total, a.currency)}</span>` : ''}</div>
                    <div class="feed-sub">${sub}</div>
                    ${a.stage !== 'done' && !failed ? `<div class="feed-progress">${STAGES.map((_, i) => `<i class="${i <= reached ? 'on' : ''}"></i>`).join('')}</div>` : ''}
                </div>
            </li>`;
    }).join('');
}

$('#feed').addEventListener('click', (e) => {
    const item = e.target.closest('[data-invoice]');
    if (item) openInvoice(Number(item.dataset.invoice));
});

// ---------- Facturas ----------

function filterParams() {
    const params = new URLSearchParams();
    for (const [k, v] of new FormData($('#filters'))) if (v) params.set(k, v);
    return params;
}

async function loadInvoices() {
    const params = filterParams();
    $('#export').href = `/api/export.csv?${params}`;
    const { invoices, stats } = await api(`/api/invoices?${params}`);
    state.invoices = invoices;
    const items = [
        ['Total', eur(stats.total)],
        ['Facturas', stats.count],
        ['IVA deducible', eur(stats.deductible_tax)],
        ['Pendientes', stats.pending ?? 0],
    ];
    $('#stats').innerHTML = items.map(([label, value]) => `
        <div class="card kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${esc(value)}</div></div>`).join('');
    $('#invoice-rows').innerHTML = invoices.map((i) => invoiceRow(i, ['date', 'merchant', 'employee', 'category', 'base', 'tax', 'total', 'status'])).join('');
    $('#invoices-empty').hidden = invoices.length > 0;
}

document.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) openInvoice(Number(row.dataset.id));
});

let filterTimer;
$('#filters').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(loadInvoices, 250);
});
$('#filters').addEventListener('submit', (e) => e.preventDefault());

// ---------- Detalle ----------

const options = (values, labels, selected) => values
    .map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(labels?.[v] ?? cap(v))}</option>`)
    .join('');

function field(label, name, value, { type = 'text', full = false, step } = {}) {
    return `<label class="${full ? 'full' : ''}">${label}
        <input name="${name}" type="${type}" ${step ? `step="${step}"` : ''} value="${esc(value)}"></label>`;
}

async function openInvoice(id) {
    const i = await api(`/api/invoices/${id}`);
    state.current = i;
    $('#drawer-title').textContent = i.merchant_name ?? `Factura #${i.id}`;
    $('#drawer-sub').textContent = `Factura #${i.id} · ${i.employee_name ?? '—'} · recibida ${ago(utc(i.received_at))}`;

    const fileUrl = `/api/invoices/${i.id}/file`;
    const channel = i.source_message_id ? 'Recibida por WhatsApp' : 'Subida desde el panel';
    $('#preview').innerHTML = !i.file_path
        ? `<div class="preview-empty">${icon('receipt')}<span>Sin imagen adjunta</span></div>`
        : `${i.mime === 'application/pdf'
            ? `<iframe src="${fileUrl}" title="Factura en PDF"></iframe>`
            : `<img src="${fileUrl}" alt="Imagen original de la factura">`}
           <div class="preview-bar"><span>${icon('chat')}${channel}</span><a href="${fileUrl}" target="_blank" rel="noopener">Abrir original</a></div>`;
    $('#preview img')?.addEventListener('click', (e) => e.target.classList.toggle('zoomed'));

    const alerts = [...i.warnings];
    if (i.confidence === 'baja') alerts.unshift('Lectura con baja confianza: revisa los importes.');
    if (i.duplicate_of) alerts.unshift(`Posible duplicado de la factura #${i.duplicate_of}.`);
    $('#alerts').innerHTML = `
        <div class="extracted-by">${icon('spark')}Datos extraídos automáticamente con ${esc(state.meta.model)} · confianza ${esc(i.confidence ?? 'media')}</div>
        ${alerts.length ? `<div style="margin-top:12px">${alerts.map((a) => `<div class="alert">${icon('alert')}<span>${esc(a)}</span></div>`).join('')}</div>` : ''}`;

    const employees = state.employees.length ? state.employees : await api('/api/employees');
    $('#invoice-form').innerHTML = `
        <label>Estado <select name="status">${options(['pendiente', 'aprobado', 'rechazado'], STATUS_LABEL, i.status)}</select></label>
        <label>Empleado <select name="employee_id">${employees.map((e) => `<option value="${e.id}" ${e.id === i.employee_id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
        ${field('Proveedor', 'merchant_name', i.merchant_name, { full: true })}
        ${field('NIF proveedor', 'merchant_nif', i.merchant_nif)}
        ${field('Nº factura', 'invoice_number', i.invoice_number)}
        ${field('Fecha', 'date', i.date, { type: 'date' })}
        ${field('Hora', 'time', i.time, { type: 'time' })}
        <label>Categoría <select name="category">${options(state.meta.categories, null, i.category)}</select></label>
        <label>Tipo <select name="doc_type">${options(state.meta.docTypes, DOC_LABEL, i.doc_type)}</select></label>
        ${field('Base imponible', 'base_amount', i.base_amount, { type: 'number', step: '0.01' })}
        ${field('IVA', 'tax_amount', i.tax_amount, { type: 'number', step: '0.01' })}
        ${field('Total', 'total', i.total, { type: 'number', step: '0.01' })}
        ${field('Propina', 'tip', i.tip, { type: 'number', step: '0.01' })}
        <label>Forma de pago <select name="payment_method">${options(state.meta.paymentMethods, PAY_LABEL, i.payment_method)}</select></label>
        ${field('NIF cliente', 'customer_nif', i.customer_nif)}
        ${field('Dirección del proveedor', 'merchant_address', i.merchant_address, { full: true })}
        ${field('Descripción', 'description', i.description, { full: true })}
        <label class="full">Notas internas <textarea name="notes">${esc(i.notes)}</textarea></label>`;

    const vat = i.vat_lines.length ? `
        <div>
            <div class="section-title">Desglose de IVA</div>
            <table class="mini-table">
                <tr><th>Tipo</th><th class="num">Base</th><th class="num">Cuota</th></tr>
                ${i.vat_lines.map((l) => `<tr><td>${l.tipo}%</td><td class="num">${eur(l.base, i.currency)}</td><td class="num">${eur(l.cuota, i.currency)}</td></tr>`).join('')}
            </table>
        </div>` : '';
    const items = i.items.length ? `
        <div>
            <div class="section-title">Conceptos</div>
            <table class="mini-table">
                <tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Importe</th></tr>
                ${i.items.map((l) => `<tr><td>${esc(l.descripcion)}</td><td class="num">${l.cantidad ?? ''}</td><td class="num">${eur(l.importe, i.currency)}</td></tr>`).join('')}
            </table>
        </div>` : '';
    $('#lines').innerHTML = vat + items;

    history.replaceState(null, '', `#factura-${i.id}`);
    $('#overlay').hidden = false;
    $('#drawer').classList.add('is-open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawer-close').focus({ focusVisible: false });
}

function closeDrawer() {
    $('#drawer').classList.remove('is-open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#overlay').hidden = true;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    state.current = null;
}

function formValues() {
    const data = Object.fromEntries(new FormData($('#invoice-form')));
    for (const k of ['base_amount', 'tax_amount', 'total', 'tip']) data[k] = data[k] === '' ? null : Number(data[k]);
    data.employee_id = Number(data.employee_id);
    return data;
}

async function save(extra = {}, message = 'Cambios guardados') {
    if (!state.current) return;
    try {
        await api(`/api/invoices/${state.current.id}`, { method: 'PATCH', body: { ...formValues(), ...extra } });
        toast(message, { kind: 'success' });
        closeDrawer();
    } catch (err) {
        toast(err.message, { kind: 'warn' });
    }
}

$('#btn-save').addEventListener('click', () => save());
$('#btn-approve').addEventListener('click', () => save({ status: 'aprobado' }, 'Factura aprobada'));
$('#btn-reject').addEventListener('click', () => save({ status: 'rechazado' }, 'Factura rechazada'));
$('#btn-delete').addEventListener('click', async () => {
    if (!state.current || !confirm(`¿Eliminar la factura #${state.current.id}? No se puede deshacer.`)) return;
    await api(`/api/invoices/${state.current.id}`, { method: 'DELETE' });
    toast('Factura eliminada');
    closeDrawer();
});
$('#drawer-close').addEventListener('click', closeDrawer);
$('#overlay').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------- Empleados ----------

async function loadEmployees() {
    state.employees = await api('/api/employees');
    $('#employee-rows').innerHTML = state.employees.map((e) => `
        <tr>
            <td><div class="person"><span class="avatar">${esc(initials(e.name))}</span><span class="cell-main">${esc(e.name)}</span></div></td>
            <td class="tabular">${esc(phoneLabel(e.phone))}</td>
            <td>${esc(e.department ?? '—')}</td>
            <td class="num">${e.invoice_count}</td>
            <td class="num cell-main">${eur(e.total_spent)}</td>
            <td class="num"><button class="btn btn-danger-ghost" data-remove="${e.id}">Dar de baja</button></td>
        </tr>`).join('');
    $('#employees-empty').hidden = state.employees.length > 0;

    const select = $('#filters [name=employee]');
    const current = select.value;
    select.innerHTML = `<option value="">Todos</option>${state.employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}`;
    select.value = current;
}

$('#employee-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        await api('/api/employees', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        e.target.reset();
        toast('Empleado añadido', { kind: 'success' });
    } catch (err) {
        toast(err.message, { kind: 'warn' });
    }
});

$('#employee-rows').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-remove]')?.dataset.remove;
    if (!id) return;
    const emp = state.employees.find((x) => x.id === Number(id));
    if (!confirm(`¿Dar de baja a ${emp.name}? Sus facturas se conservan.`)) return;
    await api(`/api/employees/${id}`, { method: 'DELETE' });
    toast('Empleado dado de baja');
});

// ---------- WhatsApp ----------

const WA_TEXT = {
    starting: ['Iniciando…', 'WhatsApp'],
    connecting: ['Conectando…', 'WhatsApp'],
    reconnecting: ['Reconectando…', 'WhatsApp'],
    qr: ['Sin vincular', 'Escanea el código QR'],
    connected: ['Conectado', ''],
    disconnected: ['Desconectado', 'Pulsa para reconectar'],
};

function renderWhatsApp(wa) {
    const prev = state.wa.status;
    state.wa = wa;
    const connected = wa.status === 'connected';
    const [title, sub] = WA_TEXT[wa.status] ?? WA_TEXT.connecting;

    $('#wa-chip .status-dot').dataset.status = wa.status;
    $('#wa-chip-title').textContent = `WhatsApp · ${title}`;
    $('#wa-chip-sub').textContent = connected ? `+${wa.me?.phone ?? ''}` : sub;

    $('#connect-banner').hidden = connected;
    $('#qr-frame').dataset.status = wa.status;
    $('#qr-img').hidden = wa.status !== 'qr' || !wa.qr;
    if (wa.qr) $('#qr-img').src = wa.qr;
    $('#qr-connected').hidden = !connected;
    $('#qr-placeholder').hidden = connected || (wa.status === 'qr' && wa.qr);
    $('#qr-placeholder-text').textContent = wa.status === 'disconnected' ? (wa.message ?? 'Desconectado') : 'Generando código…';
    $('#qr-hint').textContent = connected ? 'Las facturas que lleguen se publican en el panel al instante.' : 'El código se renueva automáticamente.';

    $('#wa-eyebrow').textContent = connected ? 'Conectado' : 'Vinculación';
    $('#wa-title').textContent = connected ? 'WhatsApp listo para recibir facturas' : 'Conecta el WhatsApp de la empresa';
    $('#wa-desc').textContent = connected
        ? 'Cada foto o PDF que llegue al chat se lee con IA, se confirma al empleado y aparece en el panel sin recargar.'
        : 'Los empleados envían la foto de la factura a este número y el sistema la registra sola.';
    $('#wa-steps').hidden = connected;
    $('#wa-account').hidden = !connected;
    $('#wa-howto').hidden = !connected;
    $('#wa-logout').hidden = !connected;
    if (connected) {
        $('#wa-name').textContent = wa.me?.name ?? '—';
        $('#wa-phone').textContent = `+${wa.me?.phone ?? ''}`;
        $('#wa-howto-phone').textContent = `+${wa.me?.phone ?? ''}`;
        $('#wa-since').textContent = wa.since ? new Date(wa.since).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '—';
    }
    if (connected && prev !== 'connected' && prev !== 'starting') {
        toast('WhatsApp conectado', { kind: 'success', text: `+${wa.me?.phone ?? ''} listo para recibir facturas` });
    }
}

$('#wa-reconnect').addEventListener('click', () => api('/api/whatsapp/reconnect', { method: 'POST' }));
$('#wa-logout').addEventListener('click', async () => {
    if (!confirm('¿Desvincular este WhatsApp? Tendrás que volver a escanear el código.')) return;
    await api('/api/whatsapp/logout', { method: 'POST' });
});

// ---------- Subida manual ----------

async function upload(file) {
    if (!file) return;
    try {
        const res = await fetch('/api/invoices/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Error ${res.status}`);
    } catch (err) {
        toast('No se pudo procesar', { kind: 'warn', text: err.message });
    }
}

$('#btn-upload').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
    upload(e.target.files[0]);
    e.target.value = '';
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    $('#dropzone').hidden = false;
});
document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropzone').hidden = true;
    upload(e.dataTransfer.files[0]);
});

// ---------- Tiempo real ----------

let refreshTimer;
function refreshData() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        await loadOverview();
        if (state.view === 'invoices') await loadInvoices();
        if (state.view === 'employees' || state.view === 'invoices') await loadEmployees();
        else state.employees = await api('/api/employees');
    }, 120);
}

function connectEvents() {
    const source = new EventSource('/api/events');
    source.onopen = () => $('#live').classList.add('is-on');
    source.onerror = () => $('#live').classList.remove('is-on'); // EventSource reintenta solo
    source.onmessage = (msg) => {
        const { type, data } = JSON.parse(msg.data);
        if (type === 'whatsapp') renderWhatsApp(data);
        if (type === 'activity') onActivity(data);
        if (type === 'invoices') refreshData();
    };
}

// Tiempos relativos ("hace 3 minutos") y redimensionado del gráfico
setInterval(() => state.feed.size && renderFeed(), 30000);
let resizeTimer;
addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.overview && renderDailyChart(state.overview.daily), 150);
});

// ---------- Inicio ----------

state.meta = await api('/api/meta');
const { product, client } = state.meta.brand;
$('#brand-name').textContent = product;
document.title = `${product} · Panel de facturas`;
if (client) {
    $('#client-tag').textContent = client;
    $('#client-tag').hidden = false;
}
$('#employees-lead').textContent = 'Quien envía una factura al WhatsApp queda dado de alta automáticamente con su nombre de perfil. También puedes añadirlos a mano.';
$('#filters [name=category]').innerHTML += state.meta.categories.map((c) => `<option value="${c}">${cap(c)}</option>`).join('');
if (!state.meta.geminiConfigured) toast('Falta la clave de Gemini', { kind: 'warn', text: 'Añade GEMINI_API_KEY en el archivo .env y reinicia.' });

renderWhatsApp(await api('/api/whatsapp'));
await loadEmployees();
await loadOverview();
connectEvents();

const linked = location.hash.match(/^#factura-(\d+)$/);
if (linked) openInvoice(Number(linked[1])).catch(() => toast('Esa factura no existe', { kind: 'warn' }));
else if (VIEW_TITLE[location.hash.slice(1)]) show(location.hash.slice(1));
else if (state.wa.status === 'qr') show('whatsapp'); // primera vez: directo al QR
