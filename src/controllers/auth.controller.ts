/**
 * @file auth.controller.ts
 * @description Controlador de autenticación y gestión de cuentas.
 *
 * Endpoints que maneja:
 *  - POST /auth/login          → Inicio de sesión con CAPTCHA Turnstile.
 *  - GET  /auth/me             → Datos del usuario autenticado.
 *  - POST /auth/register       → Registro de cuenta nueva (inactiva hasta pagar).
 *  - POST /auth/forgot-password → Solicitud de recuperación de contraseña.
 *  - POST /auth/reset-password  → Restablecimiento de contraseña con token.
 *  - POST /auth/logout          → Cierre de sesión (borra la cookie JWT).
 */

import { Request, Response } from 'express';
import { pool } from '../config/db';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middlewares/auth.middleware';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Los pagos ya NO se procesan aquí: se manejan en payments.controller.ts
// mediante el Checkout alojado de Conekta.

// --- FUNCIÓN DE AYUDA PARA VALIDAR CAPTCHA (Cloudflare Turnstile) ---
const verifyCaptcha = async (token: string): Promise<boolean> => {
  if (!token) return false;

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error('Falta la variable de entorno TURNSTILE_SECRET_KEY.');
    return false;
  }

  try {
    const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

    // URLSearchParams codifica correctamente el cuerpo (evita romper la petición
    // si el token trae caracteres especiales).
    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token);

    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data: any = await response.json();

    if (data?.success !== true) {
      // Cloudflare devuelve el motivo en "error-codes" (ej. invalid-input-secret,
      // timeout-or-duplicate). Registrarlo facilita el diagnóstico.
      console.error('Verificación de CAPTCHA fallida. error-codes:', data?.['error-codes']);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error validando Captcha:', err);
    return false;
  }
};

export const login = async (req: Request, res: Response): Promise<any> => {
  const { email, password, captcha_token } = req.body;

  if (!captcha_token) {
    return res.status(400).json({ error: 'Falta la verificación de seguridad (CAPTCHA).' });
  }

  try {
    // Valida el CAPTCHA antes de continuar
    const isHuman = await verifyCaptcha(captcha_token);
    if (!isHuman) {
      return res.status(403).json({ error: 'Verificación de seguridad fallida.' });
    }

    const query = `
      SELECT u.id, u.marca_id, u.password_hash, u.suscripcion_fin, u.suscripcion_estado,
             u.activo, ur.rol_id AS rol
      FROM usuarios u
      LEFT JOIN usuario_roles ur ON u.id = ur.usuario_id
      WHERE LOWER(u.email) = LOWER($1)
    `;
    const { rows } = await pool.query(query, [email]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    const user = rows[0];

    // Se valida la contraseña antes de revelar cualquier estado de la cuenta.
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    // Cuenta registrada pero sin suscripción pagada todavía.
    if (!user.activo && user.suscripcion_estado === 'pendiente') {
      return res.status(403).json({
        error: 'Tu cuenta está registrada pero aún no tiene una suscripción activa. Completa tu pago para entrar.',
        code: 'PENDING_SUBSCRIPTION',
      });
    }

    if (!user.activo) {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a soporte.' });
    }

    // Suscripción vencida.
    if (user.suscripcion_fin && new Date(user.suscripcion_fin) < new Date()) {
      return res.status(403).json({
        error: 'Tu suscripción ha expirado. Renueva tu plan para acceder.',
        code: 'EXPIRED_SUBSCRIPTION',
      });
    }

    const token = jwt.sign(
      { user_id: user.id, rol: user.rol, marca_id: user.marca_id },
      process.env.JWT_SECRET as string,
      { expiresIn: '24h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 24 * 60 * 60 * 1000,
      domain: '.qlatte.com',
    });

    return res.json({
      user: {
        id: user.id,
        rol: user.rol,
        marca_id: user.marca_id,
      },
    });
  } catch (error) {
    console.error('ERROR EN EL LOGIN:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

export const getMe = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.user_id;
  try {
    const query = `
      SELECT u.id, u.nombre, u.email, u.marca_id, u.suscripcion_fin, u.suscripcion_estado, ur.rol_id AS rol,
             u.store_slug, u.telefono, u.store_name, u.personalizacion
      FROM usuarios u
      LEFT JOIN usuario_roles ur ON u.id = ur.usuario_id
      WHERE u.id = $1
    `;
    const { rows } = await pool.query(query, [userId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json(rows[0]);
  } catch (error) {
    console.error('ERROR EN GET /me:', error);
    res.status(500).json({ error: 'Error al obtener datos del usuario' });
  }
};

// =============================================================================
// REGISTRO DE CUENTA  (paso 1 de 2 — SIN cobro)
// -----------------------------------------------------------------------------
// Crea la cuenta INACTIVA (activo = false, suscripcion_estado = 'pendiente').
// El cobro de la suscripción es un paso aparte (payments.controller.ts), de modo
// que si el pago no se concreta la cuenta no se pierde: la persona puede iniciar
// el pago después con su correo y contraseña.
// =============================================================================
export const registerAccount = async (req: Request, res: Response): Promise<any> => {
  const { nombre, email, password, telefono, marca_id, captcha_token } = req.body;

  if (!nombre?.trim() || !email?.trim() || !password) {
    return res.status(400).json({ error: 'Faltan datos obligatorios: nombre, correo y contraseña.' });
  }

  const isHuman = await verifyCaptcha(captcha_token);
  if (!isHuman) {
    return res.status(403).json({ error: 'Verificación de seguridad fallida.' });
  }

  const correo = email.trim().toLowerCase();

  try {
    const existe = await pool.query('SELECT id FROM usuarios WHERE LOWER(email) = $1', [correo]);
    if ((existe.rowCount ?? 0) > 0) {
      return res.status(409).json({
        error: 'Este correo ya está registrado. Inicia sesión o, si te falta pagar, completa tu suscripción.',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const insertUserQuery = `
      INSERT INTO usuarios (
        id, nombre, email, password_hash, telefono, marca_id,
        suscripcion_estado, activo
      )
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pendiente', false)
      RETURNING id;
    `;
    const result = await pool.query(insertUserQuery, [
      nombre.trim(),
      correo,
      hashedPassword,
      telefono?.trim() || null,
      marca_id ?? 1,
    ]);
    const newUserId = result.rows[0].id;

    await pool.query(
      'INSERT INTO usuario_roles (usuario_id, rol_id) VALUES ($1, $2)',
      [newUserId, 2]
    );

    return res.status(201).json({
      success: true,
      message: 'Cuenta creada. El siguiente paso es activar tu suscripción.',
      user_id: newUserId,
      email: correo,
    });
  } catch (error) {
    console.error('ERROR EN REGISTRO DE CUENTA:', error);
    return res.status(500).json({ error: 'No pudimos crear tu cuenta. Intenta de nuevo en un momento.' });
  }
};

// --- ENVIAR CORREO DE RECUPERACIÓN ---
export const forgotPassword = async (req: Request, res: Response): Promise<any> => {
  const { email } = req.body;

  try {
    const queryUser = 'SELECT id, email FROM usuarios WHERE email = $1';
    const { rows } = await pool.query(queryUser, [email]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No existe una cuenta con este correo.' });
    }

    const user = rows[0];
    const resetToken = crypto.randomBytes(20).toString('hex');

    const updateQuery = `
      UPDATE usuarios
      SET reset_password_token = $1, reset_password_expires = NOW() + INTERVAL '1 hour'
      WHERE id = $2
    `;
    await pool.query(updateQuery, [resetToken, user.id]);

    const resetUrl = `https://lumin.qlatte.com/reset-password?token=${resetToken}`;

    const { data, error } = await resend.emails.send({
      from: 'Qlatte | Lumin <admin@qlatte.com>',
      to: [user.email],
      subject: 'Recuperación de Contraseña - Qlatte Lumin',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Recuperación de Acceso</h2>
          <p>Hola, solicitaste restablecer tu contraseña para Qlatte | Lumin.</p>
          <p>Haz clic en el siguiente botón para crear una nueva contraseña. Este enlace es válido por 1 hora.</p>
          <a href="${resetUrl}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-top: 15px; font-weight: bold;">Restablecer mi contraseña</a>
          <p style="margin-top: 30px; font-size: 12px; color: #666;">Si tú no solicitaste esto, puedes ignorar este correo de forma segura.</p>
        </div>
      `,
    });

    if (error) {
      console.error('Error de Resend:', error);
      return res.status(400).json({
        message:
          'No pudimos enviar el correo en este momento, pero tu solicitud fue procesada. Inténtalo de nuevo en un minuto.',
      });
    }

    return res.status(200).json({ message: 'Correo enviado con éxito.' });
  } catch (error) {
    console.error('Error detallado en DB o servidor:', error);
    return res.status(400).json({
      message: 'Ocurrió un error inesperado. Inténtalo de nuevo en un minuto.',
    });
  }
};

// --- RESTABLECER LA CONTRASEÑA ---
export const resetPassword = async (req: Request, res: Response): Promise<any> => {
  const { token, newPassword } = req.body;

  try {
    const query = `
      SELECT id
      FROM usuarios
      WHERE reset_password_token = $1 AND reset_password_expires > NOW()
    `;
    const { rows } = await pool.query(query, [token]);

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ error: 'El código es inválido o ha expirado. Vuelve a solicitar la recuperación.' });
    }

    const userId = rows[0].id;

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    const updateQuery = `
      UPDATE usuarios
      SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL
      WHERE id = $2
    `;
    await pool.query(updateQuery, [hashedPassword, userId]);

    return res
      .status(200)
      .json({ message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
  } catch (error) {
    console.error('Error en resetPassword:', error);
    return res.status(500).json({ error: 'Error al actualizar la contraseña.' });
  }
};

// Cierre de sesión: elimina la cookie JWT del cliente
export const logout = (req: Request, res: Response): void => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
  });

  res.json({ message: 'Sesión cerrada con éxito' });
};
