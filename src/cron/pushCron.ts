import cron from 'node-cron';
import { pool } from '../config/db';
import webpush from 'web-push';

export const startPushCron = () => {
  // Se ejecuta todos los días a las 9:00 AM (hora del servidor)
  cron.schedule('0 9 * * *', async () => {
    console.log('⏳ Ejecutando Cron Job de Notificaciones Push...');
    try {
      // 1. Obtener vendedores que tienen clientas con fecha_proximo_pago <= HOY y saldo > 0
      const query = `
        SELECT c.vendedor_id, COUNT(c.id) as total_cobros
        FROM clientas c
        WHERE c.saldo_pendiente > 0 AND c.fecha_proximo_pago <= CURRENT_DATE
        GROUP BY c.vendedor_id
      `;
      const { rows: cobrosPendientes } = await pool.query(query);

      // 2. Por cada vendedor, buscar sus suscripciones y mandar el Push
      for (const cobro of cobrosPendientes) {
        const vendorId = cobro.vendedor_id;
        const total = cobro.total_cobros;

        const subQuery = `SELECT subscription FROM push_subscriptions WHERE vendedor_id = $1`;
        const { rows: subs } = await pool.query(subQuery, [vendorId]);

        for (const subRow of subs) {
          const subscription = subRow.subscription;
          
          const payload = JSON.stringify({
            title: 'Lumin - Recordatorios de Cobro',
            body: `Tienes ${total} clienta(s) con pagos programados para hoy. ¡Abre la app para mandarles un recordatorio!`,
            url: '/dashboard'
          });

          try {
            await webpush.sendNotification(subscription, payload);
          } catch (pushErr: any) {
             // Si el error es 410 o 404, significa que el usuario revocó el permiso del navegador
             if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
               await pool.query(`DELETE FROM push_subscriptions WHERE subscription->>'endpoint' = $1`, [subscription.endpoint]);
             } else {
               console.error('Error sending push:', pushErr);
             }
          }
        }
      }
      console.log('✅ Cron Job finalizado');
    } catch (error) {
      console.error('Error en cron job de push:', error);
    }
  });
};
