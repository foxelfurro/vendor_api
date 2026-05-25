-- =============================================================================
-- Migración QA: integridad de inventario_vendedor + índice de ventas
-- -----------------------------------------------------------------------------
-- 1. inventario_vendedor NO tenía una restricción única sobre
--    (vendedor_id, producto_maestro_id). El backend (addToInventory) ya asume
--    que existe: atrapa el error 23505 para avisar "ya está en tu inventario".
--    Sin la restricción ese manejo nunca se dispara y una vendedora puede
--    quedar con la misma joya duplicada en su vitrina.
--
-- 2. La tabla `ventas` se consulta intensamente filtrando por vendedor_id
--    (historial y dashboard) sin un índice de apoyo.
--
-- La migración primero CONSOLIDA cualquier duplicado existente (sin perder
-- stock ni ventas) y después crea la restricción y el índice.
--
-- Es idempotente: puede re-ejecutarse sin efectos adversos.
-- Haz un backup antes de correrla en producción.
-- =============================================================================

BEGIN;

-- ── 1. Consolidar duplicados de inventario_vendedor ─────────────────────────
-- Para cada grupo (vendedor_id, producto_maestro_id) se conserva la fila de
-- menor id (la más antigua) como "superviviente".

-- 1a. Repuntar las ventas de las filas duplicadas hacia la superviviente,
--     para no violar la llave foránea ventas.inventario_id al borrarlas.
WITH grupos AS (
  SELECT id,
         MIN(id) OVER (PARTITION BY vendedor_id, producto_maestro_id) AS superviviente
  FROM inventario_vendedor
)
UPDATE ventas v
SET inventario_id = g.superviviente
FROM grupos g
WHERE v.inventario_id = g.id
  AND g.id <> g.superviviente;

-- 1b. Sumar el stock de los duplicados en la fila superviviente.
WITH grupos AS (
  SELECT id, stock,
         MIN(id) OVER (PARTITION BY vendedor_id, producto_maestro_id) AS superviviente
  FROM inventario_vendedor
),
sumas AS (
  SELECT superviviente, SUM(COALESCE(stock, 0)) AS stock_total
  FROM grupos
  GROUP BY superviviente
)
UPDATE inventario_vendedor iv
SET stock = s.stock_total
FROM sumas s
WHERE iv.id = s.superviviente;

-- 1c. Eliminar las filas duplicadas (ya sin ventas que las referencien).
WITH grupos AS (
  SELECT id,
         MIN(id) OVER (PARTITION BY vendedor_id, producto_maestro_id) AS superviviente
  FROM inventario_vendedor
)
DELETE FROM inventario_vendedor iv
USING grupos g
WHERE iv.id = g.id
  AND g.id <> g.superviviente;

-- ── 2. Restricción única (idempotente) ──────────────────────────────────────
-- Una vendedora no puede tener la misma joya del catálogo dos veces.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventario_vendedor_vendedor_producto_unico'
  ) THEN
    ALTER TABLE inventario_vendedor
      ADD CONSTRAINT inventario_vendedor_vendedor_producto_unico
      UNIQUE (vendedor_id, producto_maestro_id);
  END IF;
END $$;

-- ── 3. Índice para acelerar consultas de ventas por vendedora ───────────────
-- Sirve al historial de ventas y a las consultas del dashboard
-- (filtran por vendedor_id y ordenan / acotan por fecha).
CREATE INDEX IF NOT EXISTS idx_ventas_vendedor_fecha
  ON ventas (vendedor_id, fecha);

COMMIT;
