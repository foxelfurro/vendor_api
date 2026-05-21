import { Request, Response } from 'express';
import { pool } from '../config/db';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middlewares/auth.middleware';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const conekta = require('conekta');
conekta.api_key = process.env.CONEKTA_PRIVATE_KEY;
conekta.locale = 'es';

// --- FUNCIÓN DE AYUDA PARA VALIDAR CAPTCHA ---
const verifyCaptcha = async (token: string): Promise<boolean> => {
  if (!token) return false;
  try {
    const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${process.env.TURNSTILE_SECRET_KEY}&response=${token}`,
    });
    const data = await response.json();
    return data.success === true;
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
    // ✅ FIX #1: Ahora sí se valida el resultado del CAPTCHA antes de continuar
    const isHuman = await verifyCaptcha(captcha_token);
    if (!isHuman) {
      return res.status(403).json({ error: 'Verificación de seguridad fallida.' });
    }

    const query = `
      SELECT u.id, u.marca_id, u.password_hash, u.suscripcion_fin, ur.rol_id AS rol
      FROM usuarios u
      LEFT JOIN usuario_roles ur ON u.id = ur.usuario_id
      WHERE u.email = $1 AND u.activo = true
    `;
    const { rows } = await pool.query(query, [email]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    const user = rows[0];

    if (user.suscripcion_fin) {
      const ahora = new Date();
      const fechaFin = new Date(user.suscripcion_fin);

      if (fechaFin < ahora) {
        return res.status(403).json({
          error: 'Tu suscripción ha expirado. Por favor, renueva tu plan para acceder.',
        });
      }
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
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
             u.store_slug, u.telefono, u.store_name
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

export const subscribeAndCreateAccount = async (req: Request, res: Response): Promise<any> => {
  // ✅ FIX #3: Se recibe 'telefono' y 'marca_id' desde el body en lugar de valores hardcodeados
  const { token_id, nombre, email, password, captcha_token, telefono, marca_id } = req.body;

  const isHuman = await verifyCaptcha(captcha_token);
  if (!isHuman) {
    return res.status(403).json({ success: false, error: 'Verificación de seguridad fallida.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // PASO 1: Validar que el correo no exista
    const userCheck = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if ((userCheck.rowCount ?? 0) > 0) {
      throw new Error('Este correo ya está registrado.');
    }

    const nombreValido = nombre.trim().includes(' ')
      ? nombre.trim()
      : `${nombre.trim()} Joyeria`;

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // ✅ FIX CONDICIÓN DE CARRERA — PASO 2: Primero insertamos en BD (con activo = false)
    // Si Conekta falla después, el ROLLBACK limpia esto sin haber cobrado nada
    const insertUserQuery = `
      INSERT INTO usuarios (
        id, nombre, email, password_hash, marca_id,
        suscripcion_inicio, suscripcion_fin, suscripcion_estado, activo
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        NOW(), NOW() + INTERVAL '1 month', 'pendiente', false
      )
      RETURNING id;
    `;

    const newUserResult = await client.query(insertUserQuery, [
      nombre,
      email,
      hashedPassword,
      marca_id ?? 1,
    ]);
    const newUserId = newUserResult.rows[0].id;

    await client.query(
      `INSERT INTO usuario_roles (usuario_id, rol_id) VALUES ($1, $2)`,
      [newUserId, 2]
    );

    // ✅ FIX CONDICIÓN DE CARRERA — PASO 3: Ahora sí cobramos con Conekta
    // Si falla aquí, el ROLLBACK borra al usuario de BD. Nadie pagó sin tener cuenta.
    const orden: any = await new Promise((resolve, reject) => {
      conekta.Order.create(
        {
          currency: 'MXN',
          customer_info: {
            name: nombreValido,
            email: email,
            phone: telefono || '+521000000000',
          },
          line_items: [
            {
              name: 'Licencia Vendor Hub',
              unit_price: 29900,
              quantity: 1,
            },
          ],
          charges: [{ payment_method: { type: 'card', token_id: token_id } }],
        },
        function (err: any, result: any) {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });

    // ✅ FIX CONDICIÓN DE CARRERA — PASO 4: Cobro exitoso → activamos la cuenta
    await client.query(
      `UPDATE usuarios SET activo = true, suscripcion_estado = 'activa' WHERE id = $1`,
      [newUserId]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: '¡Bienvenido a Vendor Hub! Tu cuenta ha sido creada.',
      user_id: newUserId,
      orden_id: orden.id,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('ERROR DETALLADO:', error);
    const msg = error.details?.[0]?.message || error.message || 'Error en el proceso';
    res.status(400).json({ success: false, error: msg });
  } finally {
    client.release();
  }
};

// --- RENOVAR SUSCRIPCIÓN ---
export const renewSubscription = async (req: Request, res: Response): Promise<any> => {
  const { email, password, token_id, captcha_token } = req.body;

  const isHuman = await verifyCaptcha(captcha_token);
  if (!isHuman) {
    return res.status(403).json({ error: 'Verificación de seguridad fallida.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ✅ FIX #5: También traemos el teléfono real del usuario para Conekta
    const userQuery = 'SELECT id, nombre, password_hash, telefono FROM usuarios WHERE email = $1';
    const { rows } = await client.query(userQuery, [email]);

    if (rows.length === 0)
      return res.status(404).json({ error: 'No existe una cuenta con este correo.' });

    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Contraseña incorrecta.' });

    const nombreValidoRenovacion = user.nombre.trim().includes(' ')
      ? user.nombre.trim()
      : `${user.nombre.trim()} Joyeria`;

    const orden: any = await new Promise((resolve, reject) => {
      conekta.Order.create(
        {
          currency: 'MXN',
          customer_info: {
            name: nombreValidoRenovacion,
            email: email,
            phone: user.telefono || '+521000000000', // ✅ FIX #5: teléfono real del usuario
          },
          line_items: [
            { name: 'Renovación Mensual Vendor Hub', unit_price: 29900, quantity: 1 },
          ],
          charges: [{ payment_method: { type: 'card', token_id: token_id } }],
        },
        (err: any, res: any) => {
          if (err) reject(err);
          else resolve(res);
        }
      );
    });

    const updateQuery = `
      UPDATE usuarios
      SET suscripcion_fin = NOW() + INTERVAL '1 month', suscripcion_estado = 'activa'
      WHERE id = $1
    `;
    await client.query(updateQuery, [user.id]);

    await client.query('COMMIT');
    return res.status(200).json({ success: true, message: '¡Tu suscripción ha sido renovada con éxito!' });
  } catch (error: any) {
    await client.query('ROLLBACK');
    const msg = error.details?.[0]?.message || error.message || 'Error al renovar.';
    return res.status(400).json({ success: false, error: msg });
  } finally {
    client.release();
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

// ✅ FIX #4: Tipo de retorno corregido a void para consistencia con Express
export const logout = (req: Request, res: Response): void => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
  });

  res.json({ message: 'Sesión cerrada con éxito' });
};
