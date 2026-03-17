import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

// GET /vendor/explore
// Muestra productos del catálogo de SU MARCA que AÚN NO están en su inventario
export const exploreCatalog = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const marcaId = req.user?.marca_id;
    
  try {
    // Cambiamos catalogo_id por producto_maestro_id
    const query = `
      SELECT cm.* FROM catalogo_maestro cm
      LEFT JOIN inventario_vendedor iv 
        ON cm.id = iv.producto_maestro_id AND iv.vendedor_id = $1
      WHERE cm.marca_id = $2 
        AND iv.producto_maestro_id IS NULL;
    `;
    const { rows } = await pool.query(query, [vendorId, marcaId]);
    res.json(rows);
  } catch (error) {
    console.error("🔥 ERROR EN EXPLORE:", error);
    res.status(500).json({ error: 'Error al cargar el catálogo para explorar.' });
  }
};

// GET /vendor/inventory
// Muestra el inventario personal combinando datos del catálogo maestro
export const getInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;

  try {
    // Cambiamos iv.catalogo_id por iv.producto_maestro_id
    const query = `
      SELECT 
        iv.id AS inventario_id,
        iv.stock,
        iv.precio_personalizado,
        cm.id AS producto_maestro_id,
        cm.sku,
        cm.nombre,
        cm.precio_sugerido,
        cm.ruta_imagen
      FROM inventario_vendedor iv
      INNER JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      WHERE iv.vendedor_id = $1;
    `;
    const { rows } = await pool.query(query, [vendorId]);
    res.json(rows);
  } catch (error) {
    console.error("🔥 ERROR EN INVENTARIO:", error);
    res.status(500).json({ error: 'Error al cargar tu inventario personal.' });
  }
};

// POST /vendor/inventory
// Vincula un producto del catálogo maestro al inventario personal del vendedor
export const addToInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const { producto_maestro_id, stock, precio_personalizado } = req.body;

  try {
    const query = `
      INSERT INTO inventario_vendedor 
        (vendedor_id, producto_maestro_id, stock, precio_personalizado)
      VALUES 
        ($1, $2, $3, $4)
      RETURNING *;
    `;
    const values = [vendorId, producto_maestro_id, stock, precio_personalizado];
    
    const { rows } = await pool.query(query, values);
    
    res.status(201).json({
      message: '¡Producto agregado a tu inventario exitosamente!',
      producto: rows[0]
    });
  } catch (error: any) {
    console.error("🔥 ERROR AL AGREGAR AL INVENTARIO:", error);
    
    // Si la base de datos tiene una restricción de que no puedes agregar el mismo producto dos veces
    if (error.code === '23505') { 
      return res.status(400).json({ error: 'Este producto ya está en tu inventario.' });
    }

    res.status(500).json({ error: 'Error al agregar el producto a tu inventario.' });
  }
};

