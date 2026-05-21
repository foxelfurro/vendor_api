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
        // estado = true: las joyas creadas por un administrador nacen aprobadas
        // y visibles de inmediato en el catálogo maestro.
        const query = `
            INSERT INTO catalogo_maestro
            (sku, nombre, descripcion, precio_sugerido, ruta_imagen, categoria_id, marca_id, estado)
            VALUES ($1, $2, $3, $4, $5, $6, $7, true)
            RETURNING *;
        `;

        const values = [sku, nombre, descripcion, precio_sugerido, ruta_imagen, categoria_id, marca_id];
        const result = await pool.query(query, values);

        res.status(201).json({
            message: "Joya agregada exitosamente al catálogo maestro",
            joya: result.rows[0]
        });
    } catch (error: any) {
        console.error("Error al insertar joya:", error);

        // SKU duplicado (viola la restricción UNIQUE sku_unico)
        if (error.code === '23505') {
            return res.status(400).json({ message: "Ya existe una joya con ese SKU" });
        }
        // categoria_id (o marca_id) inexistente: viola la llave foránea
        if (error.code === '23503') {
            return res.status(400).json({ message: "La categoría o la marca seleccionada no existe" });
        }

        res.status(500).json({ message: "Error al guardar en la base de datos" });
    }
};

// GET /admin/categorias
// Lista las categorías disponibles para poblar el selector del panel de administración
export const getCategorias = async (_req: Request, res: Response): Promise<any> => {
    try {
        const query = `SELECT id, nombre FROM categorias ORDER BY nombre ASC;`;
        const result = await pool.query(query);
        return res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error al obtener categorías:", error);
        return res.status(500).json({ message: "Error al obtener las categorías" });
    }
};

// GET /admin/catalogo/pendientes
// Lista las joyas propias pendientes de aprobación (estado = false)
export const getPendingItems = async (_req: Request, res: Response): Promise<any> => {
    try {
        const query = `
            SELECT
                cm.id, cm.sku, cm.nombre, cm.descripcion, cm.ruta_imagen,
                cm.precio_sugerido, cm.categoria_id, cm.marca_id, cm.estado, cm.creado_por,
                u.nombre AS creador_nombre,
                u.email  AS creador_email,
                c.nombre AS categoria
            FROM catalogo_maestro cm
            LEFT JOIN usuarios u ON cm.creado_por = u.id
            LEFT JOIN categorias c ON cm.categoria_id = c.id
            WHERE cm.estado = false
            ORDER BY cm.nombre ASC;
        `;
        const result = await pool.query(query);
        return res.status(200).json(result.rows);
    } catch (error) {
        console.error("Error al obtener joyas pendientes:", error);
        return res.status(500).json({ message: "Error al obtener las joyas pendientes" });
    }
};

// PUT /admin/catalogo/:id
// Permite al administrador modificar una joya (incluida la asignación de categoría)
export const updateCatalogItem = async (req: Request, res: Response): Promise<any> => {
    const { id } = req.params;
    const { sku, nombre, descripcion, precio_sugerido, ruta_imagen, categoria_id, marca_id } = req.body;

    try {
        // categoria_id se asigna directamente (puede pasar de NULL a un valor real).
        // El resto de campos se conservan si llegan vacíos (COALESCE).
        // skus_anteriores: si el SKU cambia, el valor previo se archiva en el
        // historial (y se quita del historial el SKU que ahora pasa a ser actual).
        const query = `
            UPDATE catalogo_maestro
            SET sku             = COALESCE($1, sku),
                nombre          = COALESCE($2, nombre),
                descripcion     = COALESCE($3, descripcion),
                precio_sugerido = COALESCE($4, precio_sugerido),
                ruta_imagen     = COALESCE($5, ruta_imagen),
                categoria_id    = $6,
                marca_id        = COALESCE($7, marca_id),
                skus_anteriores = CASE
                    WHEN $1 IS NOT NULL AND sku IS NOT NULL AND $1 <> sku
                        THEN array_remove(array_append(skus_anteriores, sku), $1)
                    ELSE skus_anteriores
                END
            WHERE id = $8
            RETURNING *;
        `;
        const values = [
            sku ?? null, nombre ?? null, descripcion ?? null, precio_sugerido ?? null,
            ruta_imagen ?? null, categoria_id ?? null, marca_id ?? null, id
        ];
        const result = await pool.query(query, values);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Joya no encontrada" });
        }
        return res.status(200).json({ message: "Joya actualizada correctamente", joya: result.rows[0] });
    } catch (error: any) {
        if (error.code === '23505') {
            return res.status(400).json({ message: "Ya existe una joya con ese SKU" });
        }
        if (error.code === '23503') {
            return res.status(400).json({ message: "La categoría o la marca seleccionada no existe" });
        }
        console.error("Error al actualizar joya:", error);
        return res.status(500).json({ message: "Error al actualizar la joya" });
    }
};

// POST /admin/catalogo/:id/aprobar
// Aprueba una joya pendiente (estado = true). Exige que tenga categoría asignada.
export const approveCatalogItem = async (req: Request, res: Response): Promise<any> => {
    const { id } = req.params;

    try {
        const check = await pool.query(
            `SELECT categoria_id, estado FROM catalogo_maestro WHERE id = $1;`,
            [id]
        );
        if (check.rowCount === 0) {
            return res.status(404).json({ message: "Joya no encontrada" });
        }
        if (check.rows[0].categoria_id === null) {
            return res.status(400).json({ message: "Asigna una categoría a la joya antes de aprobarla" });
        }

        const result = await pool.query(
            `UPDATE catalogo_maestro SET estado = true WHERE id = $1 RETURNING id, nombre;`,
            [id]
        );
        return res.status(200).json({
            message: "Joya aprobada y publicada en el catálogo maestro",
            joya: result.rows[0]
        });
    } catch (error) {
        console.error("Error al aprobar joya:", error);
        return res.status(500).json({ message: "Error al aprobar la joya" });
    }
};

// DELETE /admin/catalogo/:id
// Rechaza una joya pendiente: la elimina del catálogo y de los inventarios que
// la referencian. Solo opera sobre joyas con estado = false.
export const rejectCatalogItem = async (req: Request, res: Response): Promise<any> => {
    const { id } = req.params;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const check = await client.query(
            `SELECT id FROM catalogo_maestro WHERE id = $1 AND estado = false;`,
            [id]
        );
        if (check.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Joya pendiente no encontrada" });
        }

        // Primero las referencias de inventario, luego la joya (respeta la FK).
        await client.query(`DELETE FROM inventario_vendedor WHERE producto_maestro_id = $1;`, [id]);
        await client.query(`DELETE FROM catalogo_maestro WHERE id = $1;`, [id]);

        await client.query('COMMIT');
        return res.status(200).json({ message: "Joya rechazada y eliminada" });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al rechazar joya:", error);
        return res.status(500).json({ message: "Error al rechazar la joya" });
    } finally {
        client.release();
    }
};

export const deleteUser = async (req: Request, res: Response): Promise<any> => {
    const { id } = req.params;
    
    try {
        const query = `
            UPDATE usuarios 
            SET activo = false 
            WHERE id = $1 
            RETURNING id;
        `;
        
        const result = await pool.query(query, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "El usuario no existe" });
        }

        return res.status(200).json({ message: "Usuario desactivado correctamente. Sus ventas y estadísticas se conservan." });

    } catch (error: any) {
        console.error("Error al desactivar usuario:", error);
        return res.status(500).json({ message: "Error interno al actualizar la base de datos" });
    }
};