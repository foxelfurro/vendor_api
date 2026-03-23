import { Request, Response } from 'express';
// Asegúrate de importar tu conexión a la base de datos (ajusta la ruta según tu proyecto)
import { pool } from '../config/db';

export const createUser = async (req: Request, res: Response): Promise<any> => {
    const { nombre, email, password, rol_id } = req.body;
    
    // 1. Validación básica de datos entrantes
    if (!nombre || !email || !password || !rol_id) {
        return res.status(400).json({ message: "Todos los campos (nombre, email, password, rol_id) son obligatorios" });
    }
    
    const marca_id = rol_id === 1 ? null : rol_id - 1; // Si es admin (rol_id=1), marca_id es null, sino es rol_id - 1
    
    try {
        const query = `
            WITH nuevo_usuario AS (
                INSERT INTO usuarios (id, nombre, email, password_hash, marca_id) 
                VALUES (gen_random_uuid(), $1, $2, crypt($3, gen_salt('bf', 10)), $4)
                RETURNING id
            )
            INSERT INTO usuario_roles (usuario_id, rol_id)
            SELECT id, $5::int FROM nuevo_usuario
            RETURNING usuario_id;
        `;
        
        const values = [nombre, email, password, marca_id, rol_id];
        const result = await pool.query(query, values);

        // 3. Capturamos el ID generado para devolverlo en la respuesta (opcional pero muy útil)
        const nuevoUsuarioId = result.rows[0]?.usuario_id;

        return res.status(201).json({ 
            message: "Personal registrado correctamente con su rol",
            usuario_id: nuevoUsuarioId
        });

    } catch (error: any) {
        console.error("Error al crear usuario:", error);
        
        // Manejo de correos duplicados (Unique Violation)
        if (error.code === '23505') {
            return res.status(400).json({ message: "Este correo ya está registrado" });
        }
        
        return res.status(500).json({ message: "Error interno al guardar en la base de datos" });
    }
};

export const createCatalogItem = async (req: Request, res: Response) => {
    // Usamos los nombres exactos de tu SQL
    const { sku, nombre, descripcion, precio_sugerido, ruta_imagen, categoria_id, marca_id } = req.body;

    try {
        const query = `
            INSERT INTO catalogo_maestro 
            (sku, nombre, descripcion, precio_sugerido, ruta_imagen, categoria_id, marca_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *;
        `;
        
        const values = [sku, nombre, descripcion, precio_sugerido, ruta_imagen, categoria_id, marca_id];
        const result = await pool.query(query, values);

        res.status(201).json({ 
            message: "Joya agregada exitosamente al catálogo maestro",
            joya: result.rows[0] 
        });
    } catch (error) {
        console.error("Error al insertar joya:", error);
        res.status(500).json({ message: "Error al guardar en la base de datos" });
    }
};
