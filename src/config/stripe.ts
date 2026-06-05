// =============================================================================
// Cliente de Stripe
// -----------------------------------------------------------------------------
// Se inicializa una única instancia del SDK de Stripe usando la clave secreta
// del entorno. Todos los módulos de pagos deben importar desde aquí.
// Docs: https://stripe.com/docs/api
// =============================================================================

import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('Falta la variable de entorno STRIPE_SECRET_KEY.');
}

// Se fija la versión de la API explícitamente. Así la forma de los objetos
// (p. ej. la ubicación de la suscripción dentro de un Invoice) es determinista
// y no depende de la versión por defecto configurada en el panel de Stripe.
// Debe coincidir con la versión para la que están generados los tipos del SDK.
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-04-22.dahlia',
});
