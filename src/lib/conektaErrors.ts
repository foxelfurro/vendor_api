// =============================================================================
// Traducción de errores de Conekta a mensajes claros en español
// -----------------------------------------------------------------------------
// Conekta devuelve errores técnicos (a veces en inglés, con `debug_message`).
// Esta función los convierte en algo accionable para la persona usuaria.
// =============================================================================

/**
 * Devuelve un mensaje amigable a partir de cualquier error de pago
 * (ConektaError, error de red, o Error genérico).
 */
export function mensajeAmigablePago(error: any): string {
  const detalles =
    error?.detalles ?? error?.raw?.details ?? error?.details ?? [];
  const primero = Array.isArray(detalles) ? detalles[0] : null;

  const code = String(primero?.code ?? '').toLowerCase();
  const debug = String(
    primero?.debug_message ?? primero?.message ?? error?.message ?? ''
  ).toLowerCase();

  const contiene = (...frases: string[]) =>
    frases.some((f) => debug.includes(f) || code.includes(f));

  // Falla de red al hablar con Conekta.
  if (error?.status === 0 || error?.raw?.network_error) {
    return 'No pudimos conectar con la pasarela de pagos. Revisa tu conexión e intenta de nuevo.';
  }

  // El caso reportado con tarjetas tipo Revolut y similares.
  if (
    contiene(
      'does not accept this payment method',
      'unsupported',
      'not supported',
      'payment method not available'
    )
  ) {
    return 'Tu banco o el tipo de tarjeta no permite este cobro. Intenta con otra tarjeta, o paga en efectivo en OXXO o por transferencia SPEI.';
  }

  if (contiene('insufficient', 'funds')) {
    return 'La tarjeta no tiene fondos suficientes. Intenta con otra tarjeta u otro método de pago.';
  }

  if (contiene('expired')) {
    return 'La tarjeta está vencida. Revisa la fecha de expiración o usa otra tarjeta.';
  }

  if (contiene('cvc', 'cvv', 'security code')) {
    return 'El código de seguridad (CVV) de la tarjeta es incorrecto.';
  }

  if (contiene('fraud', 'suspected', 'risk', 'blacklist')) {
    return 'El pago fue rechazado por motivos de seguridad. Comunícate con tu banco o usa otro método de pago.';
  }

  if (contiene('invalid') && contiene('number', 'card')) {
    return 'El número de tarjeta no es válido. Verifícalo e intenta de nuevo.';
  }

  if (contiene('declined', 'denied', 'rejected')) {
    return 'Tu banco rechazó el pago. Intenta con otra tarjeta o comunícate con tu banco.';
  }

  if (contiene('processing', 'try again', 'timeout', 'temporar')) {
    return 'Hubo un problema temporal al procesar el pago. Espera un momento e intenta de nuevo.';
  }

  if (contiene('authentication', 'unauthorized') || error?.status === 401) {
    return 'Hay un problema de configuración con la pasarela de pagos. Contacta a soporte.';
  }

  // Si Conekta trae un mensaje legible, úsalo; si no, uno genérico.
  return (
    primero?.message ||
    'No pudimos procesar el pago. Intenta de nuevo o usa otro método de pago.'
  );
}
