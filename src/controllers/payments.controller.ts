// =============================================================================
// CONTROLADOR DE PAGOS — Stripe (Checkout alojado + Billing Portal)
// -----------------------------------------------------------------------------
// Flujo de alta (suscripción nueva):
//   1. La cuenta ya existe (registerAccount la creó como 'pendiente').
//   2. crearCheckout() crea una Stripe Checkout Session en modo 'subscription'
//      y devuelve la URL a la que el frontend redirige.
//   3. La persona paga en la página segura de Stripe.
//   4. webhookStripe() recibe la confirmación firmada y activa / renueva la cuenta.
//
// Flujo de gestión (suscripción existente):
//   - Si la persona YA tiene una suscripción gestionable en Stripe, en lugar de
//     crear una suscripción nueva (lo que generaría cobros duplicados) se le
//     envía al Billing Portal de Stripe, donde puede actualizar su método de
//     pago, ver facturas, cancelar o reanudar.
//   - crearCheckout() detecta ese caso automáticamente; crearPortalAutenticado()
//     abre el portal directamente para un usuario con sesión activa.
//
// Variables de entorno requeridas:
//   STRIPE_SECRET_KEY        — clave secreta sk_live_... o sk_test_...
//   STRIPE_PRICE_ID          — ID del precio mensual (price_...) del producto
//   STRIPE_WEBHOOK_SECRET    — secreto del webhook (whsec_...)
//   FRONTEND_URL             — base URL del frontend (ej. https://lumin.qlatte.com)
//
// Requisito de panel: el Billing Portal debe estar habilitado en Stripe
//   (Settings → Billing → Customer portal) para que crearSesionPortal funcione.
// =============================================================================

import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { pool } from '../config/db';
import { stripe } from '../config/stripe';
import { mensajeAmigablePago } from '../lib/stripeErrors';
import { AuthRequest } from '../middlewares/auth.middleware';

// --- Configuración -----------------------------------------------------------
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://lumin.qlatte.com').replace(/\/$/, '');

// --- Tipos de Stripe ---------------------------------------------------------
// Se derivan de la firma de `constructEvent` en lugar de usar el namespace
// `Stripe.*`: con `module: commonjs` el import por defecto del SDK no expone
// ese namespace. Derivarlos del evento garantiza, además, que los tipos
// coincidan exactamente con la versión de API fijada (2026-04-22.dahlia).
type EventoStripe = ReturnType<typeof stripe.webhooks.constructEvent>;
type FacturaStripe = Extract<EventoStripe, { type: 'invoice.payment_succeeded' }>['data']['object'];
type SesionCheckoutStripe = Extract<EventoStripe, { type: 'checkout.session.completed' }>['data']['object'];
type SuscripcionStripe = Extract<EventoStripe, { type: 'customer.subscription.updated' }>['data']['object'];

// =============================================================================
// Billing Portal — helpers
// =============================================================================

// Estados de una suscripción de Stripe que la persona todavía puede gestionar
// desde el Billing Portal (actualizar tarjeta, ver facturas, cancelar, etc.).
// Quedan fuera 'canceled', 'incomplete' e 'incomplete_expired': en esos casos
// se necesita una suscripción nueva, así que el flujo sigue por el Checkout.
const ESTADOS_GESTIONABLES = ['active', 'trialing', 'past_due', 'unpaid', 'paused'];

/**
 * Busca en Stripe una suscripción "gestionable" del cliente y devuelve su id,
 * o null si no tiene ninguna. Se usa para evitar crear suscripciones duplicadas.
 */
async function buscarSuscripcionGestionable(customerId: string): Promise<string | null> {
  try {
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 20,
    });
    const gestionable = subs.data.find((s) => ESTADOS_GESTIONABLES.includes(s.status));
    return gestionable ? gestionable.id : null;
  } catch (e) {
    // Si falla la consulta a Stripe, se asume que no hay suscripción gestionable
    // para no bloquear el flujo (en el peor caso se ofrece el Checkout).
    console.warn('No se pudieron listar las suscripciones del cliente:', e);
    return null;
  }
}

/**
 * Crea una sesión del Billing Portal de Stripe y devuelve su URL.
 * Requiere tener habilitado el portal en el panel:
 *   Settings → Billing → Customer portal.
 */
async function crearSesionPortal(customerId: string): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${FRONTEND_URL}/login`,
  });
  return session.url;
}

// =============================================================================
// POST /payments/checkout  — inicia el pago de la suscripción
// -----------------------------------------------------------------------------
// Si la persona ya tiene una suscripción gestionable en Stripe, devuelve la URL
// del Billing Portal (modo 'portal'); si no, crea una Checkout Session para una
// suscripción nueva (modo 'checkout'). El frontend solo redirige a `url`.
// =============================================================================
export const crearCheckout = async (req: Request, res: Response): Promise<any> => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Ingresa tu correo y contraseña.' });
  }
  if (!STRIPE_PRICE_ID) {
    console.error('Falta STRIPE_PRICE_ID en variables de entorno.');
    return res.status(500).json({ error: 'Error de configuración del servidor.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, telefono, password_hash, suscripcion_estado, stripe_customer_id
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

    // Si ya tiene un cliente en Stripe con una suscripción gestionable, se le
    // envía al Billing Portal en lugar de crear otra suscripción (lo que
    // generaría un cobro duplicado).
    if (user.stripe_customer_id) {
      const subExistente = await buscarSuscripcionGestionable(user.stripe_customer_id);
      if (subExistente) {
        const url = await crearSesionPortal(user.stripe_customer_id);
        return res.status(200).json({ modo: 'portal', url });
      }
    }

    const tipo = user.suscripcion_estado === 'pendiente' ? 'suscripcion_inicial' : 'renovacion';

    // Se registra el intento de pago ANTES de hablar con Stripe, para poder
    // vincular el webhook con este usuario via metadata.
    const pagoInsert = await pool.query(
      `INSERT INTO pagos (usuario_id, tipo, recurrente, monto, estado)
       VALUES ($1, $2, true, $3, 'pendiente')
       RETURNING id`,
      [user.id, tipo, 29900] // $299.00 MXN en centavos
    );
    const pagoId: string = pagoInsert.rows[0].id;

    // Parámetros de cliente: si ya tiene un customer en Stripe se reutiliza;
    // si no, Stripe lo crea en el Checkout y el webhook lo guardará.
    const customerParam: Record<string, string> = user.stripe_customer_id
      ? { customer: user.stripe_customer_id }
      : { customer_email: user.email };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ...customerParam,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${FRONTEND_URL}/pago/resultado?pago_id=${pagoId}&session_id=${pagoId}`,
      cancel_url: `${FRONTEND_URL}/suscripcion`,
      // Metadatos para poder conciliar en el webhook.
      metadata: { pago_id: pagoId, usuario_id: user.id },
      subscription_data: {
        metadata: { pago_id: pagoId, usuario_id: user.id },
      },
    });

    // Guardar el ID de la sesión de Stripe en la tabla de pagos.
    await pool.query(
      `UPDATE pagos SET stripe_session_id = $1, actualizado_en = NOW() WHERE id = $2`,
      [session.id, pagoId]
    );

    return res.status(200).json({ modo: 'checkout', pago_id: pagoId, url: session.url });
  } catch (error: any) {
    console.error('Error en crearCheckout:', error);
    return res.status(400).json({ error: mensajeAmigablePago(error) });
  }
};

// =============================================================================
// POST /payments/portal  — abre el Billing Portal para el usuario autenticado
// -----------------------------------------------------------------------------
// Lo usa el aviso de renovación dentro de la app (sesión activa), de modo que la
// persona no tenga que volver a teclear su correo y contraseña.
// =============================================================================
export const crearPortalAutenticado = async (req: AuthRequest, res: Response): Promise<any> => {
  const userId = req.user?.user_id;

  try {
    const { rows } = await pool.query(
      `SELECT stripe_customer_id FROM usuarios WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const customerId: string | null = rows[0].stripe_customer_id;
    if (!customerId) {
      // No tiene cliente en Stripe todavía: aún no hay nada que gestionar.
      // El frontend cae al flujo público de suscripción (Checkout).
      return res.status(409).json({
        error: 'Aún no tienes una suscripción registrada para gestionar.',
        code: 'NO_CUSTOMER',
      });
    }

    const url = await crearSesionPortal(customerId);
    return res.status(200).json({ url });
  } catch (error: any) {
    console.error('Error en crearPortalAutenticado:', error);
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
// POST /webhooks/stripe  — Stripe notifica aquí cada evento (firma HMAC)
// =============================================================================
export const webhookStripe = async (req: Request, res: Response): Promise<any> => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return res.status(400).json({ error: 'Falta la firma del webhook.' });
  }

  let evento: EventoStripe;
  try {
    // req.body debe ser el Buffer raw (configurado en index.ts con express.raw).
    evento = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error('Firma de webhook inválida:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const tipo: string = evento.type;
  console.log(`Webhook Stripe recibido: ${tipo}`);

  try {
    // Se hace switch sobre `evento.type` (no sobre la copia `tipo`) para que
    // TypeScript acote `evento.data.object` al tipo correcto en cada caso.
    switch (evento.type) {
      // Checkout completado: primer pago de la suscripción.
      case 'checkout.session.completed':
        await procesarCheckoutCompletado(evento.data.object);
        break;

      // Renovación mensual exitosa (y también el primer cobro si aplica).
      case 'invoice.payment_succeeded':
        await procesarFacturaPagada(evento.data.object);
        break;

      // Cobro fallido (Stripe reintentará según la configuración del panel).
      case 'invoice.payment_failed':
        await marcarPagoFallido(evento.data.object);
        break;

      // Suscripción cancelada o expirada.
      case 'customer.subscription.deleted':
        await marcarSuscripcionInactiva(evento.data.object, 'cancelada');
        break;

      // Cambios de estado de la suscripción (pausa, reanudación, etc.).
      case 'customer.subscription.updated':
        await manejarActualizacionSuscripcion(evento.data.object);
        break;

      default:
        // Eventos no manejados se ignoran silenciosamente.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(`Error procesando webhook "${tipo}":`, error);
    // Un 500 hace que Stripe reintente el envío más tarde.
    return res.status(500).json({ error: 'Error procesando el evento.' });
  }
};

// =============================================================================
// Lógica de webhook
// =============================================================================

/**
 * Extrae el id de un campo de Stripe que puede venir como string (sin expandir)
 * o como objeto expandido. Devuelve null si no hay valor.
 */
function idDe(
  ref: string | { id: string } | null | undefined
): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/**
 * Obtiene el id de la suscripción asociada a una factura.
 * En la API de Stripe 2026-04-22.dahlia el Invoice ya NO tiene el campo
 * `subscription` en la raíz: vive en `parent.subscription_details.subscription`.
 * Como respaldo se busca en la línea de suscripción de la factura.
 */
function subscriptionIdDeFactura(invoice: FacturaStripe): string | null {
  const desdeParent = idDe(invoice.parent?.subscription_details?.subscription);
  if (desdeParent) return desdeParent;

  const lineaSub = invoice.lines?.data?.find((l) => l.subscription)?.subscription;
  return idDe(lineaSub);
}

/**
 * checkout.session.completed: el Checkout se completó.
 * La fuente de verdad del cobro es invoice.payment_succeeded; aquí guardamos
 * los identificadores de Stripe y activamos la cuenta como respaldo cuando el
 * pago ya está cubierto.
 */
async function procesarCheckoutCompletado(session: SesionCheckoutStripe): Promise<void> {
  const pagoId: string | undefined = session.metadata?.pago_id;
  const customerId: string | null = idDe(session.customer);
  const subscriptionId: string | null = idDe(session.subscription);

  if (!pagoId) {
    console.warn('checkout.session.completed: sin pago_id en metadata.');
    return;
  }

  const { rows } = await pool.query(
    `SELECT usuario_id FROM pagos WHERE id = $1`,
    [pagoId]
  );
  if (rows.length === 0) return;
  const usuarioId: string = rows[0].usuario_id;

  // Vincular los identificadores de Stripe con el usuario.
  await pool.query(
    `UPDATE usuarios
     SET stripe_customer_id     = COALESCE($1, stripe_customer_id),
         stripe_subscription_id = COALESCE($2, stripe_subscription_id)
     WHERE id = $3`,
    [customerId, subscriptionId, usuarioId]
  );

  // Si el pago ya está cubierto, activar aquí como respaldo. Se obtiene la
  // vigencia REAL desde la suscripción para que activarCuenta sea idempotente
  // con invoice.payment_succeeded (de lo contrario, según el orden en que
  // lleguen los webhooks, se extendería el período dos veces).
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    let finISO: string | null = null;
    if (subscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const periodoFin = sub.items?.data?.[0]?.current_period_end;
        if (periodoFin) finISO = new Date(periodoFin * 1000).toISOString();
      } catch (e) {
        console.warn('No se pudo recuperar la suscripción para calcular la vigencia:', e);
      }
    }
    await activarCuenta(usuarioId, pagoId, subscriptionId, finISO);
  }
}

/**
 * invoice.payment_succeeded: un cobro (inicial o de renovación) se concretó.
 * Esta es la fuente de verdad para activar y extender la suscripción.
 */
async function procesarFacturaPagada(invoice: FacturaStripe): Promise<void> {
  const customerId: string | null = idDe(invoice.customer);
  const subscriptionId: string | null = subscriptionIdDeFactura(invoice);

  if (!customerId && !subscriptionId) return;

  // Localizar el usuario por customer_id o subscription_id.
  const usuario = await localizarUsuario(
    customerId ?? undefined,
    subscriptionId ?? undefined
  );
  if (!usuario) {
    console.warn('invoice.payment_succeeded: usuario no encontrado para customer', customerId);
    return;
  }

  // La vigencia la marca el período de la línea de suscripción de la factura
  // (fuente de verdad de Stripe).
  const lineaConPeriodo = invoice.lines?.data?.find((l) => l.period?.end);
  const periodEnd: number | undefined = lineaConPeriodo?.period?.end;
  const finISO = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;

  // Localizar el pago pendiente más reciente de este usuario para marcarlo pagado.
  const { rows: pagos } = await pool.query(
    `SELECT id FROM pagos
     WHERE usuario_id = $1 AND estado = 'pendiente'
     ORDER BY creado_en DESC LIMIT 1`,
    [usuario.id]
  );
  const pagoId: string | null = pagos.length > 0 ? pagos[0].id : null;

  await activarCuenta(usuario.id, pagoId, subscriptionId ?? null, finISO);
}

/**
 * Activa la cuenta y fija la vigencia de la suscripción.
 * Se llama tanto desde checkout.session.completed como desde invoice.payment_succeeded.
 *
 * IMPORTANTE: es idempotente. `finISO` siempre es una fecha ABSOLUTA tomada de
 * Stripe (no un incremento), así que ejecutar esta función varias veces para el
 * mismo cobro deja `suscripcion_fin` en el mismo valor. Esto evita que, según el
 * orden en que lleguen los webhooks, se sume el período dos veces.
 */
async function activarCuenta(
  usuarioId: string,
  pagoId: string | null,
  subscriptionId: string | null,
  finISO: string | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (pagoId) {
      await client.query(
        `UPDATE pagos
         SET estado = 'pagado', metodo = 'card', actualizado_en = NOW()
         WHERE id = $1 AND estado = 'pendiente'`,
        [pagoId]
      );
    }

    await client.query(
      `UPDATE usuarios
       SET suscripcion_estado     = 'activa',
           suscripcion_inicio     = COALESCE(suscripcion_inicio, NOW()),
           -- Vigencia: la fecha absoluta de Stripe si está disponible; si no,
           -- se conserva la actual; como último recurso, un mes desde ahora.
           suscripcion_fin        = COALESCE($1::timestamp, suscripcion_fin, NOW() + INTERVAL '1 month'),
           stripe_subscription_id = COALESCE($2, stripe_subscription_id)
       WHERE id = $3`,
      [finISO, subscriptionId, usuarioId]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * invoice.payment_failed: el cobro no se pudo realizar.
 * Stripe reintentará según la política del panel (Smart Retries).
 */
async function marcarPagoFallido(invoice: FacturaStripe): Promise<void> {
  const subscriptionId = subscriptionIdDeFactura(invoice);
  if (!subscriptionId) return;
  await pool.query(
    `UPDATE usuarios SET suscripcion_estado = 'pago_fallido'
     WHERE stripe_subscription_id = $1`,
    [subscriptionId]
  );
}

/**
 * customer.subscription.deleted: suscripción cancelada definitivamente.
 * El acceso se controla por suscripcion_fin; al vencer, el login lo bloquea.
 */
async function marcarSuscripcionInactiva(sub: SuscripcionStripe, estado: string): Promise<void> {
  const subId: string | undefined = sub?.id;
  if (!subId) return;
  await pool.query(
    `UPDATE usuarios SET suscripcion_estado = $1
     WHERE stripe_subscription_id = $2`,
    [estado, subId]
  );
}

/**
 * customer.subscription.updated: maneja cambios de estado relevantes.
 * Por ejemplo, cuando Stripe pausa o reactiva la suscripción por Smart Retries.
 */
async function manejarActualizacionSuscripcion(sub: SuscripcionStripe): Promise<void> {
  const subId: string | undefined = sub?.id;
  const status: string = sub?.status ?? '';
  if (!subId) return;

  // Solo actualizamos el estado si es algo relevante; 'active' se gestiona
  // por invoice.payment_succeeded y no se toca aquí para evitar colisiones.
  const mapaEstados: Record<string, string> = {
    canceled: 'cancelada',
    unpaid: 'pago_fallido',
    paused: 'pausada',
    past_due: 'pago_fallido',
  };

  const estadoLocal = mapaEstados[status];
  if (!estadoLocal) return;

  await pool.query(
    `UPDATE usuarios SET suscripcion_estado = $1
     WHERE stripe_subscription_id = $2`,
    [estadoLocal, subId]
  );
}

/**
 * Localiza al usuario por stripe_customer_id o stripe_subscription_id.
 */
async function localizarUsuario(
  customerId?: string,
  subscriptionId?: string
): Promise<{ id: string } | null> {
  if (subscriptionId) {
    const r = await pool.query(
      `SELECT id FROM usuarios WHERE stripe_subscription_id = $1`,
      [subscriptionId]
    );
    if (r.rows.length > 0) return r.rows[0];
  }

  if (customerId) {
    const r = await pool.query(
      `SELECT id FROM usuarios WHERE stripe_customer_id = $1`,
      [customerId]
    );
    if (r.rows.length > 0) return r.rows[0];

    // Último recurso: consultar el email del customer en Stripe y emparejar.
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (customer && !customer.deleted && customer.email) {
        const r2 = await pool.query(
          `SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)`,
          [customer.email]
        );
        if (r2.rows.length > 0) return r2.rows[0];
      }
    } catch {
      /* ignorar si falla la consulta a Stripe */
    }
  }

  return null;
}
