import { Request, Response } from 'express';
import { pool } from '../config/db';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middlewares/auth.middleware';
import bcrypt from 'bcrypt'; 


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
      WHERE u.email = $1
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
