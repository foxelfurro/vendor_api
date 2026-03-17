import { Request, Response } from 'express';
import { pool } from '../config/db';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middlewares/auth.middleware';

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  try {
    // Hacemos JOIN con usuario_roles para obtener el rol, y traemos password_hash
    const query = `
      SELECT 
        u.id, 
        u.marca_id, 
        ur.rol_id AS rol
      FROM usuarios u
      LEFT JOIN usuario_roles ur ON u.id = ur.usuario_id
      WHERE u.email = $1 AND u.password_hash = crypt($2, u.password_hash)
    `;
    const { rows } = await pool.query(query, [email, password]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas o usuario no encontrado' });
    }

    const user = rows[0];
    
    // Generamos el Token con la estructura correcta
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

// GET /auth/me
export const getMe = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.user_id;

  try {
    // Traemos los datos frescos de la base de datos
    const query = 'SELECT id, nombre, email, marca_id FROM usuarios WHERE id = $1';
    const { rows } = await pool.query(query, [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("🔥 ERROR EN AUTH/ME:", error);
    res.status(500).json({ error: 'Error al obtener datos del usuario' });
  }
};