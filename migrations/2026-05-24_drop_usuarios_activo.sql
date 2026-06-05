-- =============================================================================
-- Migración: eliminar la columna usuarios.activo
-- -----------------------------------------------------------------------------
-- La columna `activo` (boolean) era redundante con `suscripcion_estado`:
--   · activo = false  ⟺  suscripcion_estado = 'pendiente'  (cuenta sin pagar)
--   · activo = true   ⟺  la cuenta pagó al menos una vez
-- Ningún flujo de la aplicación volvía a poner `activo` en false salvo el
-- "soft delete" de administración, que ahora marca suscripcion_estado y
-- suscripcion_fin en su lugar.
--
-- A partir de esta migración el acceso se determina ÚNICAMENTE con:
--   · suscripcion_estado  → 'pendiente' bloquea el login (falta pagar)
--   · suscripcion_fin     → si ya pasó, la suscripción está vencida
--
-- Ejecutar UNA sola vez. Haz un backup antes de correrla en producción.
-- =============================================================================

BEGIN;

ALTER TABLE usuarios
  DROP COLUMN IF EXISTS activo;

COMMIT;
