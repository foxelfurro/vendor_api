import { Request, Response } from 'express';
import { pool } from '../config/db';

export const registrarUsuario = async (req: Request, res: Response) => {
  const { nombre, email, password, rol } = req.body;

  try {
    // 1. Iniciamos una transacción para asegurar que ambos inserts funcionen juntos
    await pool.query('BEGIN');

    // 2. Insertar el nuevo usuario en la tabla 'usuarios'
    // Usamos pgcrypto para encriptar la contraseña igual que en el login
    const insertUserQuery = `
      INSERT INTO usuarios (nombre, email, password_hash) 
      VALUES ($1, $2, crypt($3, gen_salt('bf'))) 
      RETURNING id
    `;
    const userResult = await pool.query(insertUserQuery, [nombre, email, password]);
    const newUserId = userResult.rows[0].id;

    // 3. Asignar el rol al nuevo usuario en 'usuario_roles'
    const insertRoleQuery = `
      INSERT INTO usuario_roles (usuario_id, rol_id) 
      VALUES ($1, $2)
    `;
    // Si el frontend envía 'admin', le asignamos 1, sino 2 (vendedor)
    const rolId = rol === 'admin' ? 1 : 2; 
    await pool.query(insertRoleQuery, [newUserId, rolId]);

    // Confirmamos la transacción
    await pool.query('COMMIT');
    res.status(201).json({ message: 'Usuario creado exitosamente', id: newUserId });
  } catch (error) {
    // Si algo falla, deshacemos todo
    await pool.query('ROLLBACK');
    console.error("Error al registrar usuario:", error);
    res.status(500).json({ error: 'Error interno al crear el usuario' });
  }
};

export const registrarJoyaMaestra = async (req: Request, res: Response) => {
  const { nombre, codigo, precio_base, descripcion } = req.body;

  try {
    // Ajusta 'catalogo_maestro' si el nombre de tu tabla es diferente
    const query = `
      INSERT INTO catalogo_maestro (codigo, nombre, descripcion, precio_base) 
      VALUES ($1, $2, $3, $4) 
      RETURNING *
    `;
    const { rows } = await pool.query(query, [codigo, nombre, descripcion, precio_base]);
    
    res.status(201).json({ message: 'Joya registrada', joya: rows[0] });
  } catch (error) {
    console.error("Error al registrar joya:", error);
    res.status(500).json({ error: 'Error al registrar la joya en el catálogo' });
  }
};