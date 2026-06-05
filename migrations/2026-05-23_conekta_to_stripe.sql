-- =============================================================================
-- Migración: Conekta → Stripe
-- -----------------------------------------------------------------------------
-- Renombra las columnas de Conekta en las tablas `usuarios` y `pagos` a sus
-- equivalentes de Stripe. Ejecutar UNA sola vez en producción.
--
-- Antes de ejecutar:
--   1. Haz un backup de la base de datos.
--   2. Verifica que el servidor backend esté detenido o en modo mantenimiento.
--   3. Ejecuta en una transacción y revisa que no haya errores antes de COMMIT.
-- =============================================================================

BEGIN;

-- ── Tabla: usuarios ──────────────────────────────────────────────────────────

-- El ID del cliente en Conekta → ID del customer en Stripe
ALTER TABLE usuarios
  RENAME COLUMN conekta_customer_id TO stripe_customer_id;

-- El ID de la suscripción en Conekta → ID de la suscripción en Stripe
ALTER TABLE usuarios
  RENAME COLUMN conekta_subscription_id TO stripe_subscription_id;

-- ── Tabla: pagos ─────────────────────────────────────────────────────────────

-- El ID de la orden en Conekta → ID de la sesión de Checkout en Stripe
ALTER TABLE pagos
  RENAME COLUMN conekta_order_id TO stripe_session_id;

-- El ID del checkout en Conekta → ID del Payment Intent en Stripe
-- (lo usa Stripe internamente; se guarda para trazabilidad)
ALTER TABLE pagos
  RENAME COLUMN conekta_checkout_id TO stripe_payment_intent_id;

-- ── Limpieza de datos previos (opcional) ─────────────────────────────────────
-- Los valores anteriores de Conekta en estas columnas ya no son válidos para
-- Stripe. Se limpian para evitar confusiones; los usuarios deberán pagar de
-- nuevo si no tienen una suscripción activa en Stripe.
UPDATE usuarios SET stripe_customer_id     = NULL WHERE stripe_customer_id IS NOT NULL;
UPDATE usuarios SET stripe_subscription_id = NULL WHERE stripe_subscription_id IS NOT NULL;
UPDATE pagos   SET stripe_session_id       = NULL WHERE stripe_session_id IS NOT NULL;
UPDATE pagos   SET stripe_payment_intent_id = NULL WHERE stripe_payment_intent_id IS NOT NULL;

COMMIT;
