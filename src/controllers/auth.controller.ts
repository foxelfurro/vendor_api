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

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  try {
    const query = `
      SELECT u.id, u.marca_id, u.password_hash, ur.rol_id AS rol
      FROM usuarios u
      LEFT JOIN usuario_roles ur ON u.id = ur.usuario_id
      WHERE u.email = $1 AND u.activo = true
    `;
    const { rows } = await pool.query(query, [email]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    const user = rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const token = jwt.sign(
      { user_id: user.id, rol: user.rol, marca_id: user.marca_id },
      process.env.JWT_SECRET as string,
      { expiresIn: '24h' }
    );

    res.json({ token, user: { id: user.id, rol: user.rol, marca_id: user.marca_id } });
  } catch (error) {
    console.error("🔥 ERROR EN EL LOGIN:", error);
    res.status(500).json({ error: 'Error interno del servidor' });
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
  const { token_id, nombre, email, password } = req.body;
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
          unit_price: 50000, 
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

    const insertUserQuery = `
      INSERT INTO usuarios (id, nombre, email, password_hash, marca_id)
      VALUES (gen_random_uuid(), $1, $2, $3, $4)
      RETURNING id;
    `;
    const newUserResult = await client.query(insertUserQuery, [nombre, email, hashedPassword, 1]);
    const newUserId = newUserResult.rows[0].id;

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
    const resetExpires = new Date();
    resetExpires.setHours(resetExpires.getHours() + 1); // Expira en 1 hora

    const updateQuery = `
      UPDATE usuarios 
      SET reset_password_token = $1, reset_password_expires = $2 
      WHERE id = $3
    `;
    await pool.query(updateQuery, [resetToken, resetExpires, user.id]);

    // 👇 CONFIGURACIÓN PARA TU DOMINIO PRIVADO DE QLATTE 👇
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST, // Ej: mail.qlatte.com
      port: Number(process.env.EMAIL_PORT) || 465,
      secure: true, 
      auth: {
        user: process.env.EMAIL_USER, // soporte@qlatte.com
        pass: process.env.EMAIL_PASS, // tu contraseña real
      },
    });

    // OJO: Cambia este 'localhost:5173' por tu URL de Vercel cuando lo subas a producción
    const resetUrl = `http://localhost:5173/reset-password?token=${resetToken}`;

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
    return res.status(200).json({ message: 'Correo de recuperación enviado con éxito.' });

  } catch (error) {
    console.error('Error en forgotPassword:', error);
    return res.status(500).json({ error: 'Error al procesar la solicitud.' });
  }
};


// --- 2. RESTABLECER LA CONTRASEÑA ---
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
      return res.status(400).json({ error: 'El código es inválido o ha expirado. Vuelve a solicitar la recuperación.' });
    }

    const userId = rows[0].id;

    // Encriptamos la nueva contraseña
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Actualizamos la base de datos y "quemamos" el token para que no se use dos veces
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