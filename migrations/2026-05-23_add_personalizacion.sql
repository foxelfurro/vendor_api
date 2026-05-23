-- =============================================================================
-- Migración: personalización visual de la tienda pública
-- Fecha: 2026-05-23
-- -----------------------------------------------------------------------------
-- Añade una columna JSONB a `usuarios` que guarda la personalización VISUAL de
-- la tienda pública de cada vendedora (color de acento, logo, banner, eslogan,
-- redes sociales y estilo). Es puramente estética: no cambia la lógica de
-- productos, precios ni filtros, que sigue siendo idéntica para todas.
--
-- Estructura esperada del objeto JSON:
--   {
--     "accent_color": "#18181b",
--     "logo_url":     "data:image/png;base64,...",
--     "banner_url":   "data:image/jpeg;base64,...",
--     "slogan":       "Catálogo Oficial",
--     "social":       { "instagram": "", "tiktok": "", "facebook": "" },
--     "card_style":   "rounded",   -- 'rounded' | 'square'
--     "theme":        "light"      -- 'light'   | 'dark'
--   }
--
-- Aplicar con:  psql "$DATABASE_URL" -f migrations/2026-05-23_add_personalizacion.sql
-- =============================================================================

ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS personalizacion JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.usuarios.personalizacion
  IS 'Personalización visual de la tienda pública (color, logo, banner, eslogan, redes, estilo). Solo estética.';
