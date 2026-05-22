// =============================================================================
// Cliente REST de Conekta
// -----------------------------------------------------------------------------
// En lugar del SDK legacy `conekta` (callbacks, deprecado) se llama directamente
// a la API REST v2.2.0. Esto es estable, sin dependencias y totalmente tipado.
// Docs: https://developers.conekta.com/reference
// =============================================================================

const CONEKTA_API_URL = 'https://api.conekta.io';
// Versión de la API. Conekta versiona por el header Accept.
const CONEKTA_API_VERSION = 'application/vnd.conekta-v2.2.0+json';

/**
 * Error tipado de Conekta. Conserva el detalle crudo para poder mapearlo a un
 * mensaje amigable (ver lib/conektaErrors.ts).
 */
export class ConektaError extends Error {
  public status: number;
  public detalles: any[];
  public raw: any;

  constructor(message: string, status: number, raw: any) {
    super(message);
    this.name = 'ConektaError';
    this.status = status;
    this.raw = raw;
    this.detalles = Array.isArray(raw?.details) ? raw.details : [];
  }
}

/**
 * Realiza una petición autenticada a la API de Conekta.
 * Lanza ConektaError si la respuesta no es 2xx.
 */
export async function conektaRequest<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const apiKey = process.env.CONEKTA_PRIVATE_KEY;
  if (!apiKey) {
    throw new Error('Falta la variable de entorno CONEKTA_PRIVATE_KEY.');
  }

  let respuesta: Response;
  try {
    respuesta = await fetch(`${CONEKTA_API_URL}${path}`, {
      method,
      headers: {
        Accept: CONEKTA_API_VERSION,
        'Content-Type': 'application/json',
        'Accept-Language': 'es',
        Authorization: `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    // Falla de red / DNS / timeout: no llegamos a Conekta.
    throw new ConektaError(
      'No pudimos conectar con la pasarela de pagos. Intenta de nuevo en un momento.',
      0,
      { network_error: String(err?.message || err) }
    );
  }

  const texto = await respuesta.text();
  let data: any = null;
  try {
    data = texto ? JSON.parse(texto) : null;
  } catch {
    data = texto;
  }

  if (!respuesta.ok) {
    const msg =
      data?.details?.[0]?.message ||
      data?.message ||
      `Error de Conekta (HTTP ${respuesta.status})`;
    throw new ConektaError(msg, respuesta.status, data);
  }

  return data as T;
}
