// =============================================================================
// Reparación de planes degradados por el webhook de Stripe
// -----------------------------------------------------------------------------
// Hasta la corrección de invoice.payment_succeeded, cada factura dejaba la
// cuenta en plan 'mini' aunque se pagara Avanzado o Pro. Este script compara,
// para cada usuaria con suscripción en Stripe, el precio que REALMENTE paga
// contra el plan guardado en la base.
//
// Uso:
//   npx ts-node src/scripts/repairPlans.ts            → solo muestra diferencias
//   npx ts-node src/scripts/repairPlans.ts --aplicar  → además las corrige
//   (compilado: node dist/scripts/repairPlans.js [--aplicar])
//
// Requiere DATABASE_URL y STRIPE_SECRET_KEY en el entorno.
// =============================================================================

import { pool } from '../config/db';
import { stripe } from '../config/stripe';
import { planPorPriceId } from '../config/plans';

const APLICAR = process.argv.includes('--aplicar');

// Solo se corrigen suscripciones que siguen vigentes en Stripe.
const ESTADOS_VIGENTES = ['active', 'trialing', 'past_due'];

interface Fila {
  id: string;
  email: string;
  suscripcion_plan: string | null;
  stripe_subscription_id: string;
}

async function main(): Promise<void> {
  const { rows } = await pool.query<Fila>(
    `SELECT id, email, suscripcion_plan, stripe_subscription_id
     FROM usuarios
     WHERE stripe_subscription_id IS NOT NULL
     ORDER BY email`
  );

  console.log(`Usuarias con suscripción en Stripe: ${rows.length}\n`);

  let diferencias = 0;
  let corregidas = 0;

  for (const u of rows) {
    let status = '';
    let priceId: string | null = null;
    try {
      const sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id);
      status = sub.status;
      priceId = sub.items?.data?.[0]?.price?.id ?? null;
    } catch (e) {
      console.warn(`! ${u.email}: no se pudo consultar ${u.stripe_subscription_id} en Stripe`);
      continue;
    }

    const planReal = planPorPriceId(priceId)?.id ?? null;

    if (!planReal) {
      console.warn(`! ${u.email}: precio desconocido (${priceId}), se omite`);
      continue;
    }
    if (!ESTADOS_VIGENTES.includes(status)) continue;
    if (planReal === u.suscripcion_plan) continue;

    diferencias += 1;
    console.log(`- ${u.email}: en base '${u.suscripcion_plan}' → paga '${planReal}' (Stripe: ${status})`);

    if (APLICAR) {
      await pool.query(`UPDATE usuarios SET suscripcion_plan = $1 WHERE id = $2`, [planReal, u.id]);
      corregidas += 1;
    }
  }

  console.log(`\nCon plan incorrecto: ${diferencias}`);
  if (APLICAR) {
    console.log(`Corregidas: ${corregidas}`);
  } else if (diferencias > 0) {
    console.log('Modo revisión: no se cambió nada. Ejecuta con --aplicar para corregir.');
  }
}

main()
  .catch((e) => {
    console.error('Error en repairPlans:', e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
