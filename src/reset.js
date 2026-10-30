import { resetAll } from './lib/db.js';

// Vacía facturas y empleados (no toca la sesión de WhatsApp). Uso: npm run reset
resetAll();
console.log('Datos borrados. La sesión de WhatsApp se conserva.');
