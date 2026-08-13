-- 1. Crear tabla de clientas
CREATE TABLE clientas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendedor_id UUID REFERENCES usuarios(id),
  nombre VARCHAR(255) NOT NULL,
  telefono VARCHAR(20),
  detalles JSONB, -- Para guardar tallas de anillo, material favorito, etc.
  saldo_pendiente NUMERIC DEFAULT 0.00,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Modificar la tabla ventas existente para asociarla a una clienta y soportar abonos
ALTER TABLE ventas ADD COLUMN clienta_id UUID REFERENCES clientas(id);
ALTER TABLE ventas ADD COLUMN estado_pago VARCHAR(50) DEFAULT 'PAGADO'; -- Valores esperados: 'PAGADO' o 'EN_ABONOS'
ALTER TABLE ventas ADD COLUMN saldo_restante NUMERIC DEFAULT 0.00;

-- 3. Crear tabla de abonos (pagos en plazos)
CREATE TABLE abonos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id UUID REFERENCES ventas(id),
  monto NUMERIC NOT NULL,
  fecha TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Indice opcional para búsquedas rápidas por vendedor
CREATE INDEX idx_clientas_vendedor ON clientas(vendedor_id);
