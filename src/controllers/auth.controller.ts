import { Request, Response } from 'express';
import { pool } from '../config/db';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middlewares/auth.middleware';
import bcrypt from 'bcrypt'; 
import crypto from 'crypto';
import nodemailer from 'nodemailer';


// 1. IMPORTACIÓN CORREGIDA: Usamos require directamente sobre una constante en minúsculas
const conekta = require('conekta');

// Configuramos la llave usando la variable de entorno que ya limpiamos (sin comillas)
conekta.api_key = process.env.CONEKTA_PRIVATE_KEY;
conekta.locale = 'es';

export const login = async (req: Request, res: Response): Promise<any> => {
  // 1. Recibimos el captcha_token desde el body (junto con email y password)
  const { email, password, captcha_token } = req.body;

  // Validación inmediata: si no hay token, no hay acceso
  if (!captcha_token) {
    return res.status(400).json({ error: 'Falta la verificación de seguridad (CAPTCHA).' });
  }

  try {
    // --- 🛡️ PASO A: VALIDACIÓN CON CLOUDFLARE ---
    const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    
    const captchaResponse = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${process.env.TURNSTILE_SECRET_KEY}&response=${captcha_token}`,
    });

    const captchaData = await captchaResponse.json();

    if (!captchaData.success) {
      console.error("❌ Fallo de Captcha:", captchaData['error-codes']);
      return res.status(403).json({ error: 'La verificación de seguridad ha fallado. Eres un bot 🤖' });
    }

    // --- 🔑 PASO B: LÓGICA DE LOGIN NORMAL (EL CADENERO) ---
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

    // EL CADENERO 🚨
    if (user.suscripcion_fin) {
      const ahora = new Date();
      const fechaFin = new Date(user.suscripcion_fin);

      if (fechaFin < ahora) {
        return res.status(403).json({ 
          error: 'Tu suscripción ha expirado. Por favor, renueva tu plan para acceder.' 
        });
      }
    }

    // Verificamos contraseña
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    // Generamos Token
    const token = jwt.sign(
      { user_id: user.id, rol: user.rol, marca_id: user.marca_id },
      process.env.JWT_SECRET as string,
      { expiresIn: '24h' }
    );

    return res.json({ token, user: { id: user.id, rol: user.rol, marca_id: user.marca_id } });

  } catch (error) {
    console.error("🔥 ERROR EN EL LOGIN:", error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

export const getMe = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.user_id;
  try {
    const query = `
      SELECT u.id, u.nombre, u.email, u.marca_id, ur.rol_id AS rol
      FROM usuarios u
      LEFT JOIN usuario_roles ur ON u.id = ur.usuario_id
      WHERE u.id = $1
    `;
    const { rows } = await pool.query(query, [userId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (error) {
    console.error("🔥 ERROR EN AUTH/ME:", error);
    res.status(500).json({ error: 'Error al obtener datos del usuario' });
  }
};

export const subscribeAndCreateAccount = async (req: Request, res: Response) => {
  const { token_id, nombre, email, password, captcha_token } = req.body;
  const isHuman = await verifyCaptcha(captcha_token);
  if (!isHuman) {
    return res.status(403).json({ success: false, error: 'Verificación de seguridad fallida.' });
  }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userCheck = await client.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if ((userCheck.rowCount ?? 0) > 0) {
      throw new Error('Este correo ya está registrado.');
    }

 // 2. COBRO CON CONEKTA (Adaptado para la versión 3.x)
    const orden: any = await new Promise((resolve, reject) => {
      conekta.Order.create({
        currency: "MXN",
        customer_info: {
          name: nombre,
          email: email,
          phone: "+521000000000"
        },
        line_items: [{
          name: "Licencia Vendor Hub",
          unit_price: 29900, 
          quantity: 1
        }],
        charges: [{
          payment_method: { type: "card", token_id: token_id }
        }]
      }, function(err: any, res: any) {
        // Esta es la función (callback) que Conekta estaba buscando
        if (err) {
          reject(err); // Si falla el pago, lo mandamos al catch
        } else {
          resolve(res); // Si es exitoso, guardamos el resultado en 'orden'
        }
      });
    });

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 1. CREAMOS EL USUARIO (Ya con su mes de suscripción incluido)
    const insertUserQuery = `
      INSERT INTO usuarios (
        id, nombre, email, password_hash, marca_id, 
        suscripcion_inicio, suscripcion_fin, suscripcion_estado
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4, 
        NOW(), NOW() + INTERVAL '1 month', 'activa'
      )
      RETURNING id;
    `;
    // Pasamos los 4 valores requeridos (el 1 es el marca_id por defecto)
    const newUserResult = await client.query(insertUserQuery, [nombre, email, hashedPassword, 1]);
    const newUserId = newUserResult.rows[0].id;

    // 2. ASIGNAMOS EL ROL DE VENDEDOR (Rol 2)
    const insertRoleQuery = `
      INSERT INTO usuario_roles (usuario_id, rol_id)
      VALUES ($1, $2);
    `;
    await client.query(insertRoleQuery, [newUserId, 2]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: '¡Bienvenido a Vendor Hub! Tu cuenta ha sido creada.',
      user_id: newUserId,
      orden_id: orden.id
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error("🔥 ERROR DETALLADO:", error);
    // Buscamos el mensaje de error de Conekta o el de la base de datos
    const msg = error.details?.[0]?.message || error.message || "Error en el proceso";
    res.status(400).json({ success: false, error: msg });
  } finally {
    client.release();
  }
  
};
// --- RENOVAR SUSCRIPCIÓN (Para usuarios vencidos) ---
export const renewSubscription = async (req: Request, res: Response): Promise<any> => {
  const { email, password, token_id, captcha_token } = req.body;
  const isHuman = await verifyCaptcha(captcha_token);
  if (!isHuman) {
    return res.status(403).json({ error: 'Verificación de seguridad fallida.' });
  }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Validamos que el usuario exista y la contraseña sea correcta
   const userQuery = 'SELECT id, nombre, password_hash FROM usuarios WHERE email = $1';
    const { rows } = await client.query(userQuery, [email]);

    if (rows.length === 0) return res.status(404).json({ error: 'No existe una cuenta con este correo.' });
    
    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Contraseña incorrecta.' });

    // 2. Cobramos con Conekta
    const orden: any = await new Promise((resolve, reject) => {
      conekta.Order.create({
        currency: "MXN",
        customer_info: { name: user.nombre, email: email, phone: "+521000000000" },
        line_items: [{ name: "Renovación Mensual Vendor Hub", unit_price: 29900, quantity: 1 }],
        charges: [{ payment_method: { type: "card", token_id: token_id } }]
      }, (err: any, res: any) => {
        if (err) reject(err); else resolve(res);
      });
    });

    // 3. Le sumamos 1 MES de tiempo a partir de HOY
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
    const msg = error.details?.[0]?.message || error.message || "Error al renovar.";
    return res.status(400).json({ success: false, error: msg });
  } finally {
    client.release();
  }
};

// --- 1. ENVIAR CORREO DE RECUPERACIÓN ---
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

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT),
      secure: false, // TLS
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      // Aumentamos los tiempos al máximo para que Render no tire la toalla
      connectionTimeout: 20000, // 20 segundos para conectar
      greetingTimeout: 20000,   // 20 segundos para el saludo SMTP
      socketTimeout: 30000,     // 30 segundos de espera total
    });

    const resetUrl = `https://vendor-client-prod.vercel.app/reset-password?token=${resetToken}`;

    const mailOptions = {
      from: `"Qlatte | Lumin" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: 'Recuperación de Contraseña - Qlatte Lumin',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Recuperación de Acceso</h2>
          <p>Hola, solicitaste restablecer tu contraseña para Qlatte | Lumin.</p>
          <p>Haz clic en el siguiente botón para crear una nueva contraseña. Este enlace es válido por 1 hora.</p>
          <a href="${resetUrl}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-top: 15px; font-weight: bold;">Restablecer mi contraseña</a>
          <p style="margin-top: 30px; font-size: 12px; color: #666;">Si tú no solicitaste esto, puedes ignorar este correo de forma segura.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
      
      // Si llega aquí, todo salió bien
      return res.status(200).json({ message: "Correo enviado con éxito." });

    } catch (error) {
      console.error("Error detallado:", error);
      
      // SI FALLA EL CORREO, RESPONDEMOS UN 200 O 400, PERO NO DEJAMOS EL 500
      return res.status(400).json({ 
        message: "No pudimos enviar el correo en este momento, pero tu solicitud fue procesada. Inténtalo de nuevo en un minuto." 
      });
    }
};


// --- 2. RESTABLECER LA CONTRASEÑA ---
export const resetPassword = async (req: Request, res: Response): Promise<any> => {
  const { token, newPassword } = req.body;

  try {
    // Buscamos a un usuario que tenga ese token y que el token no haya expirado
    const query = `
      SELECT id 
      FROM usuarios 
      WHERE reset_password_token = $1 AND reset_password_expires > NOW()
    `;
    const { rows } = await pool.query(query, [token]);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'El código es inválido o ha expirado. Vuelve a solicitar la recuperación.' });
    }

    const userId = rows[0].id;

    // Encriptamos la nueva contraseña
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Actualizamos la contraseña y limpiamos el token para que no se pueda volver a usar
    const updateQuery = `
      UPDATE usuarios 
      SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL 
      WHERE id = $2
    `;
    await pool.query(updateQuery, [hashedPassword, userId]);

    return res.status(200).json({ message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });

  } catch (error) {
    console.error('Error en resetPassword:', error);
    return res.status(500).json({ error: 'Error al actualizar la contraseña.' });
  }
};

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
    console.error("🔥 Error validando Captcha:", err);
    return false;
  }
};