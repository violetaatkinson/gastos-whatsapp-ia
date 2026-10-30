import { EventEmitter } from 'node:events';

// Bus interno: el bot publica aquí y el servidor lo reenvía al panel por Server-Sent Events.
//   'whatsapp'  estado de la conexión (qr, conectando, conectado…)
//   'activity'  progreso de una factura que se está procesando
//   'invoices'  cambió alguna factura: el panel recarga los datos
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const publish = (type, data = {}) => bus.emit('event', { type, data, at: new Date().toISOString() });
