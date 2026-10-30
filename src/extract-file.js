import fs from 'node:fs';
import path from 'node:path';
import { MODEL, extractInvoice } from './lib/extract.js';

// Prueba la extracción con un archivo local, sin WhatsApp ni base de datos.
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

const file = process.argv[2];
const mime = file && MIME[path.extname(file).toLowerCase()];
if (!file || !mime || !fs.existsSync(file)) {
    console.error('Uso: npm run extract -- ruta/a/factura.jpg   (jpg, png, webp, gif o pdf)');
    process.exit(1);
}

try {
    const started = Date.now();
    const result = await extractInvoice(fs.readFileSync(file), mime);
    const { raw, ...invoice } = result.invoice;
    console.log(JSON.stringify({ isInvoice: result.isInvoice, reason: result.reason, ...invoice }, null, 2));
    console.log(`\n${result.model ?? MODEL} · ${result.usage.input_tokens} tokens entrada, ${result.usage.output_tokens} salida · ${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
