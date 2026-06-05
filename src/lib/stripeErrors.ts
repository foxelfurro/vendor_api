// =============================================================================
// Traducción de errores de Stripe a mensajes claros en español
// -----------------------------------------------------------------------------
// Stripe usa códigos bien documentados. Esta función los convierte en mensajes
// accionables para la persona usuaria.
// Docs: https://stripe.com/docs/error-codes
// =============================================================================

import Stripe from 'stripe';

/**
 * Devuelve un mensaje amigable a partir de cualquier error de Stripe
 * (StripeError, error de red, o Error genérico).
 */
export function mensajeAmigablePago(error: any): string {
  // Error de red: no llegamos a Stripe.
  if (error?.type === 'StripeConnectionError' || error?.code === 'ECONNREFUSED') {
    return 'No pudimos conectar con la pasarela de pagos. Revisa tu conexión e intenta de nuevo.';
  }

  // Error de autenticación: clave API incorrecta o revocada.
  if (error instanceof Stripe.errors.StripeAuthenticationError) {
    return 'Hay un problema de configuración con la pasarela de pagos. Contacta a soporte.';
  }

  // Errores de tarjeta (StripeCardError).
  if (error instanceof Stripe.errors.StripeCardError) {
    const code = error.code ?? '';
    switch (code) {
      case 'card_declined':
        return 'Tu banco rechazó el pago. Intenta con otra tarjeta o comunícate con tu banco.';
      case 'insufficient_funds':
        return 'La tarjeta no tiene fondos suficientes. Intenta con otra tarjeta u otro método de pago.';
      case 'expired_card':
        return 'La tarjeta está vencida. Revisa la fecha de expiración o usa otra tarjeta.';
      case 'incorrect_cvc':
      case 'invalid_cvc':
        return 'El código de seguridad (CVV) de la tarjeta es incorrecto.';
      case 'incorrect_number':
      case 'invalid_number':
        return 'El número de tarjeta no es válido. Verifícalo e intenta de nuevo.';
      case 'fraudulent':
        return 'El pago fue rechazado por motivos de seguridad. Comunícate con tu banco o usa otro método de pago.';
      case 'processing_error':
        return 'Hubo un problema temporal al procesar el pago. Espera un momento e intenta de nuevo.';
      default:
        return error.message || 'No pudimos procesar el pago. Intenta de nuevo o usa otro método de pago.';
    }
  }

  // Error de solicitud inválida (parámetros incorrectos, etc.)
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return 'Hay un problema con los datos del pago. Contacta a soporte si el error persiste.';
  }

  // Error de rate limit.
  if (error instanceof Stripe.errors.StripeRateLimitError) {
    return 'Demasiadas solicitudes en poco tiempo. Espera un momento e intenta de nuevo.';
  }

  // Genérico.
  return error?.message || 'No pudimos procesar el pago. Intenta de nuevo o usa otro método de pago.';
}
