// =============================================================================
// Planes de suscripción — fuente única de verdad
// -----------------------------------------------------------------------------
// Checkout, webhook de Stripe y scripts de mantenimiento deben resolver planes
// SOLO a través de este módulo. El frontend envía el id del plan ('mini',
// 'avanzado', 'pro'); nunca decide el price_id que se cobra.
//
// Los price_id se pueden sobrescribir por entorno (útil para modo test de
// Stripe). Si no se definen, se usan los de producción.
// =============================================================================

export type PlanId = 'mini' | 'avanzado' | 'pro';

export interface PlanConfig {
  id: PlanId;
  priceId: string;
  /** Monto mensual en centavos de MXN (se registra en la tabla `pagos`). */
  montoCentavos: number;
  /** Días de prueba gratis al suscribirse por primera vez (0 = sin prueba). */
  trialDias: number;
}

export const PLANES: Record<PlanId, PlanConfig> = {
  mini: {
    id: 'mini',
    priceId: process.env.STRIPE_PRICE_MINI || 'price_1U5zclJR4YuhIwI0y4J8GX0h',
    montoCentavos: 9900,
    trialDias: 0,
  },
  avanzado: {
    id: 'avanzado',
    priceId: process.env.STRIPE_PRICE_AVANZADO || 'price_1U5zdgJR4YuhIwI0WdU4jWFg',
    montoCentavos: 19900,
    trialDias: 0,
  },
  pro: {
    id: 'pro',
    priceId: process.env.STRIPE_PRICE_PRO || 'price_1TaSbSJR4YuhIwI0RLOhH4rO',
    montoCentavos: 29900,
    trialDias: 7,
  },
};

/** Devuelve el plan por su id, o null si no es un plan válido. */
export function planPorId(id: unknown): PlanConfig | null {
  return typeof id === 'string' && id in PLANES ? PLANES[id as PlanId] : null;
}

/** Devuelve el plan que corresponde a un price_id de Stripe, o null si es desconocido. */
export function planPorPriceId(priceId: string | null | undefined): PlanConfig | null {
  if (!priceId) return null;
  return Object.values(PLANES).find((p) => p.priceId === priceId) ?? null;
}
