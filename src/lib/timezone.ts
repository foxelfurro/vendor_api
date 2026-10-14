// =============================================================================
// Zona horaria del negocio
// -----------------------------------------------------------------------------
// El servidor y la base de datos operan en UTC, pero "hoy", "esta semana" y
// "este mes" deben calcularse en hora de México. Sin esto, después de las
// 6 pm (UTC-6) las ventas y cobros del día ya contaban como de mañana.
//
// México no usa horario de verano desde 2022: America/Mexico_City es UTC-6 fijo.
// =============================================================================

export const APP_TIMEZONE = 'America/Mexico_City';

/** Fecha de hoy en hora de México (tipo `date`). */
export const SQL_HOY = `(NOW() AT TIME ZONE '${APP_TIMEZONE}')::date`;

/**
 * Convierte una columna de fecha/hora a hora local de México (`timestamp`).
 * El cast a timestamptz hace que funcione igual si la columna es `timestamp`
 * (guardada en UTC con NOW()) o `timestamptz`.
 */
export const sqlLocal = (columna: string): string =>
  `(${columna}::timestamptz AT TIME ZONE '${APP_TIMEZONE}')`;
