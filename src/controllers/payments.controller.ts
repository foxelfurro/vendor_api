// =============================================================================
// CONTROLADOR DE PAGOS — Conekta (Checkout alojado)
// -----------------------------------------------------------------------------
// Flujo:
//   1. La cuenta ya existe (registerAccount la creó como 'pendiente').
//   2. crearCheckout() genera una orden con Checkout alojado en Conekta y
//      devuelve la URL a la que el frontend redirige.
//   3. La persona paga en la página segura de Conekta.
//   4. webhookConekta() recibe la confirmación y activa / extiende la cuenta.
//
// Métodos:
//   - modo 'recurrente' -> tarjeta + plan  -> cobro automático mensual.
//   - modo 'unico'      -> tarjeta / OXXO / SPEI -> 1 mes, renovación manual.
//     (Conekta solo permite suscripciones recurrentes con tarjeta.)
// =============================================================================

import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db';
import { conektaRequest, ConektaError } from '../config/conekta';
import { mensajeAmigablePago } from '../lib/conektaErrors';

// --- Configuración (ajustable por variables de entorno) ----------------------
const PRECIO_CENTAVOS = Number(process.env.CONEKTA_PRECIO_CENTAVOS) || 29900; // $299.00 MXN
const PLAN_ID = process.env.CONEKTA_PLAN_ID || 'lumin-suscripcion-mensual';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://lumin.qlatte.com').replace(/\/$/, '');

// Métodos de pago para los pagos ÚNICOS (no recurrentes), separados por coma.
// IMPORTANTE: incluir SOLO los que estén habilitados en la cuenta de Conekta.
// Pedir un método no habilitado hace que Conekta rechace la orden completa
// ("merchant does not accept this payment method"). Por eso el valor por defecto
// es solo 'card'; cuando OXXO (cash) y SPEI (bank_transfer) estén activos en el
// panel de Conekta, se cambia la variable a 'card,cash,bank_transfer'.
const METODOS_UNICO = (process.env.CONEKTA_METODOS || 'card')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

// =============================================================================
// Helpers
// =============================================================================

/** Conekta suele requerir un nombre con apellido; si solo hay uno, se completa. */
function nombreParaConekta(nombre: string): string {
  const limpio = (nombre || '').trim();
  return limpio.includes(' ') ? limpio : `${limpio} Joyería`;
}

/** Deduce el método de pago a partir de los cargos de una orden de Conekta. */
function detectarMetodo(orden: any): string | null {
  const cargo = orden?.charges?.data?.[0] ?? orden?.charges?.[0];
  const tipo: string = String(cargo?.payment_method?.type ?? cargo?.payment_method?.object ?? '');
  if (!tipo) return null;
  if (tipo.includes('card')) return 'card';
  if (tipo.includes('cash') || tipo.includes('oxxo')) return 'cash';
  if (tipo.includes('bank') || tipo.includes('spei')) return 'bank_transfer';
  return tipo;
}

/**
 * Asegura que el plan mensual exista en Conekta. Es "perezoso": la primera vez
 * lo consulta y, si no existe (404), lo crea. Después solo lo verifica una vez
 * por proceso.
 */
let planVerificado = false;
async function asegurarPlan(): Promise<void> {
  if (planVerificado) return;
  try {
    await conektaRequest('GET', `/plans/${PLAN_ID}`);
    planVerificado = true;
  } catch (err: any) {
    if (err instanceof ConektaError && err.status === 404) {
      await conektaRequest('POST', '/plans', {
        id: PLAN_ID,
        name: 'Suscripción Lumin (mensual)',
        amount: PRECIO_CENTAVOS,
        currency: 'MXN',
        interval: 'month',
        frequency: 1,
        trial_period_days: 0,
      });
      planVerificado = true;
    } else {
      throw err;
    }
  }
}

// =============================================================================
// POST /payments/checkout  — crea el Checkout alojado y devuelve la URL de pago
// =============================================================================
export const crearCheckout = async (req: Request, res: Response): Promise<any> => {
  // modo: 'recurrente' (tarjeta, cobro automático) | 'unico' (1 mes; tarjeta/OXXO/SPEI)
  const { email, password, modo } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Ingresa tu correo y contraseña.' });
  }
  if (modo !== 'recurrente' && modo !== 'unico') {
    return res.status(400).json({ error: 'Selecciona una forma de pago válida.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, telefono, password_hash, suscripcion_estado, conekta_customer_id
       FROM usuarios WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No existe una cuenta con ese correo. Regístrate primero.' });
    }

    const user = rows[0];
    const passOk = await bcrypt.compare(password, user.password_hash);
    if (!passOk) {
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }

    const recurrente = modo === 'recurrente';
    const tipo = user.suscripcion_estado === 'pendiente' ? 'suscripcion_inicial' : 'renovacion';

    // Se registra el intento de pago ANTES de hablar con Conekta, para que el
    // webhook pueda conciliar la orden con este usuario.
    const pagoInsert = await pool.query(
      `INSERT INTO pagos (usuario_id, tipo, recurrente, monto, estado)
       VALUES ($1, $2, $3, $4, 'pendiente')
       RETURNING id`,
      [user.id, tipo, recurrente, PRECIO_CENTAVOS]
    );
    const pagoId: string = pagoInsert.rows[0].id;

    if (recurrente) {
      await asegurarPlan();
    }

    const checkout: any = {
      type: 'HostedPayment',
      allowed_payment_methods: recurrente ? ['card'] : METODOS_UNICO,
      success_url: `${FRONTEND_URL}/pago/resultado?ref=${pagoId}`,
      failure_url: `${FRONTEND_URL}/pago/resultado?ref=${pagoId}`,
      expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // expira en 24 h
    };
    if (recurrente) {
      checkout.plan_ids = [PLAN_ID];
    }

    const orden: any = await conektaRequest('POST', '/orders', {
      currency: 'MXN',
      customer_info: user.conekta_customer_id
        ? { customer_id: user.conekta_customer_id }
        : {
            name: nombreParaConekta(user.nombre),
            email: user.email,
            phone: user.telefono || '+520000000000',
          },
      line_items: [
        {
          name: recurrente ? 'Suscripción Lumin (mensual)' : 'Suscripción Lumin (1 mes)',
          quantity: 1,
          unit_price: PRECIO_CENTAVOS,
        },
      ],
      checkout,
    });

    const url: string | null = orden?.checkout?.url ?? null;
    if (!url) {
      throw new Error('Conekta no devolvió una URL de pago.');
    }

    await pool.query(
      `UPDATE pagos SET conekta_order_id = $1, conekta_checkout_id = $2, actualizado_en = NOW()
       WHERE id = $3`,
      [orden.id, orden?.checkout?.id ?? null, pagoId]
    );

    return res.status(200).json({ pago_id: pagoId, url });
  } catch (error: any) {
    console.error('🔥 ERROR AL CREAR CHECKOUT:', error);
    return res.status(400).json({ error: mensajeAmigablePago(error) });
  }
};

// =============================================================================
// GET /payments/estado/:pagoId  — la página de retorno consulta el estado aquí
// =============================================================================
export const estadoPago = async (req: Request, res: Response): Promise<any> => {
  const { pagoId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT estado, tipo, metodo, recurrente FROM pagos WHERE id = $1`,
      [pagoId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Pago no encontrado.' });
    }
    return res.json(rows[0]);
  } catch (error) {
    console.error('ERROR AL CONSULTAR EL PAGO:', error);
    return res.status(500).json({ error: 'Error al consultar el pago.' });
  }
};

// =============================================================================
// POST /webhooks/conekta/:secret  — Conekta notifica aquí cada evento
// =============================================================================
export const webhookConekta = async (req: Request, res: Response): Promise<any> => {
  // Seguridad: el secreto viaja en la URL registrada en el panel de Conekta.
  if (req.params.secret !== process.env.CONEKTA_WEBHOOK_SECRET) {
    return res.status(404).json({ error: 'No encontrado.' });
  }

  const evento = req.body || {};
  const tipo: string = evento?.type || '';
  const objeto: any = evento?.data?.object || {};
  console.log(`📨 Webhook Conekta recibido: ${tipo || '(sin tipo)'}`);

  // Para eventos de fallo se vuelca el detalle completo del payload: así queda
  // visible el failure_code / failure_message / debug_message exacto de Conekta.
  if (/failed|declined|canceled|expired|fraud/.test(tipo)) {
    try {
      console.log('   ⚠️  Detalle del evento de fallo:', JSON.stringify(objeto, null, 2));
    } catch {
      console.log('   ⚠️  Detalle del evento de fallo: no se pudo serializar.');
    }
  }

  try {
    if (tipo === 'order.paid') {
      await procesarOrdenPagada(objeto);
    } else if (tipo === 'order.expired') {
      await marcarPagoCerrado(objeto?.id, 'expirado');
    } else if (tipo === 'order.canceled' || tipo === 'order.declined') {
      await marcarPagoCerrado(objeto?.id, 'fallido');
    } else if (tipo === 'order.pending_payment') {
      await registrarMetodoPendiente(objeto);
    } else if (tipo === 'subscription.paid') {
      await procesarSuscripcionPagada(objeto);
    } else if (
      tipo === 'subscription.created' ||
      tipo === 'subscription.updated' ||
      tipo === 'subscription.resumed'
    ) {
      await vincularSuscripcion(objeto);
    } else if (tipo === 'subscription.payment_failed') {
      await marcarSuscripcionFallida(objeto);
    } else if (
      tipo === 'subscription.canceled' ||
      tipo === 'subscription.expired' ||
      tipo === 'subscription.paused'
    ) {
      await marcarSuscripcionInactiva(objeto, tipo);
    }
    // Los demás eventos se ignoran de forma silenciosa.
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(`🔥 ERROR procesando webhook "${tipo}":`, error);
    // Un 500 hace que Conekta reintente el envío más tarde.
    return res.status(500).json({ error: 'Error procesando el evento.' });
  }
};

// =============================================================================
// Lógica de webhook
// =============================================================================

/** order.paid: confirma el pago, activa la cuenta y extiende la vigencia. */
async function procesarOrdenPagada(orderObj: any): Promise<void> {
  const orderId: string | undefined = orderObj?.id;
  if (!orderId) return;

  // Verificación: se re-consulta la orden directamente a Conekta (fuente de verdad).
  let orden: any = orderObj;
  try {
    orden = await conektaRequest('GET', `/orders/${orderId}`);
  } catch {
    /* si la re-consulta falla, se usa el payload del evento */
  }
  if (orden?.payment_status !== 'paid') return;

  const { rows } = await pool.query(
    `SELECT id, usuario_id, estado FROM pagos WHERE conekta_order_id = $1`,
    [orderId]
  );
  if (rows.length === 0) return;
  const pago = rows[0];
  if (pago.estado === 'pagado') return; // idempotencia

  const metodo = detectarMetodo(orden);
  const customerId = orden?.customer_info?.customer_id ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE pagos SET estado = 'pagado', metodo = COALESCE($1, metodo), actualizado_en = NOW()
       WHERE id = $2`,
      [metodo, pago.id]
    );
    await client.query(
      `UPDATE usuarios
       SET activo = true,
           suscripcion_estado = 'activa',
           suscripcion_inicio = COALESCE(suscripcion_inicio, NOW()),
           suscripcion_fin = GREATEST(COALESCE(suscripcion_fin, NOW()), NOW()) + INTERVAL '1 month',
           conekta_customer_id = COALESCE($1, conekta_customer_id)
       WHERE id = $2`,
      [customerId, pago.usuario_id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** order.expired / canceled / declined: cierra el intento de pago pendiente. */
async function marcarPagoCerrado(orderId: string | undefined, estado: string): Promise<void> {
  if (!orderId) return;
  await pool.query(
    `UPDATE pagos SET estado = $1, actualizado_en = NOW()
     WHERE conekta_order_id = $2 AND estado = 'pendiente'`,
    [estado, orderId]
  );
}

/** order.pending_payment: OXXO/SPEI generó la referencia; se guarda el método. */
async function registrarMetodoPendiente(orderObj: any): Promise<void> {
  const orderId: string | undefined = orderObj?.id;
  const metodo = detectarMetodo(orderObj);
  if (!orderId || !metodo) return;
  await pool.query(
    `UPDATE pagos SET metodo = $1, actualizado_en = NOW()
     WHERE conekta_order_id = $2 AND estado = 'pendiente'`,
    [metodo, orderId]
  );
}

/**
 * subscription.paid: un cobro recurrente se concretó. Es el ÚNICO evento de
 * suscripción que activa o renueva la cuenta, porque representa un pago real.
 * billing_cycle_end (epoch en segundos) es la fuente de verdad de la vigencia;
 * usarlo hace idempotente el reprocesar el mismo evento.
 */
async function procesarSuscripcionPagada(subObj: any): Promise<void> {
  const subId: string | undefined = subObj?.id;
  const customerId: string | undefined = subObj?.customer_id;
  if (!subId) return;

  const usuario = await localizarUsuario(subId, customerId);
  if (!usuario) return;

  const cicloFin: number | undefined = subObj?.billing_cycle_end;
  const finISO = cicloFin ? new Date(cicloFin * 1000).toISOString() : null;

  await pool.query(
    `UPDATE usuarios
     SET conekta_subscription_id = $1,
         conekta_customer_id = COALESCE(conekta_customer_id, $2),
         suscripcion_estado = 'activa',
         activo = true,
         suscripcion_inicio = COALESCE(suscripcion_inicio, NOW()),
         suscripcion_fin = COALESCE($3::timestamp, suscripcion_fin, NOW() + INTERVAL '1 month')
     WHERE id = $4`,
    [subId, customerId ?? null, finISO, usuario.id]
  );
}

/**
 * subscription.created / updated / resumed: eventos de ciclo de vida.
 * SOLO vinculan los identificadores de Conekta con el usuario. NUNCA activan la
 * cuenta ni cambian la vigencia. El acceso se otorga exclusivamente con un pago
 * confirmado (order.paid o subscription.paid); así, una suscripción creada pero
 * no pagada jamás concede acceso.
 */
async function vincularSuscripcion(subObj: any): Promise<void> {
  const subId: string | undefined = subObj?.id;
  const customerId: string | undefined = subObj?.customer_id;
  if (!subId) return;

  const usuario = await localizarUsuario(subId, customerId);
  if (!usuario) return;

  await pool.query(
    `UPDATE usuarios
     SET conekta_subscription_id = $1,
         conekta_customer_id = COALESCE(conekta_customer_id, $2)
     WHERE id = $3`,
    [subId, customerId ?? null, usuario.id]
  );
}

/** subscription.payment_failed: Conekta reintentará; solo se marca el estado. */
async function marcarSuscripcionFallida(subObj: any): Promise<void> {
  const subId: string | undefined = subObj?.id;
  if (!subId) return;
  await pool.query(
    `UPDATE usuarios SET suscripcion_estado = 'pago_fallido' WHERE conekta_subscription_id = $1`,
    [subId]
  );
}

/** subscription.canceled / expired / paused: marca el estado de la suscripción. */
async function marcarSuscripcionInactiva(subObj: any, tipo: string): Promise<void> {
  const subId: string | undefined = subObj?.id;
  if (!subId) return;
  const estado = tipo.includes('canceled')
    ? 'cancelada'
    : tipo.includes('paused')
    ? 'pausada'
    : 'expirada';
  // El acceso se controla por suscripcion_fin: al vencer, el login lo bloquea.
  await pool.query(
    `UPDATE usuarios SET suscripcion_estado = $1 WHERE conekta_subscription_id = $2`,
    [estado, subId]
  );
}

/** Localiza al usuario dueño de una suscripción (por sub id, customer id o correo). */
async function localizarUsuario(
  subId: string,
  customerId?: string
): Promise<{ id: string } | null> {
  let r = await pool.query('SELECT id FROM usuarios WHERE conekta_subscription_id = $1', [subId]);
  if (r.rows.length > 0) return r.rows[0];

  if (customerId) {
    r = await pool.query('SELECT id FROM usuarios WHERE conekta_customer_id = $1', [customerId]);
    if (r.rows.length > 0) return r.rows[0];

    // Último recurso: re-consultar el cliente en Conekta y emparejar por correo.
    try {
      const cliente: any = await conektaRequest('GET', `/customers/${customerId}`);
      if (cliente?.email) {
        r = await pool.query('SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)', [
          cliente.email,
        ]);
        if (r.rows.length > 0) return r.rows[0];
      }
    } catch {
      /* ignorar */
    }
  }
  return null;
}
