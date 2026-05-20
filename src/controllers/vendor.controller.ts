import { Request, Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { Resend } from 'resend'; 

// Inicializamos Resend (pon tu API key real en tu archivo .env)
const resend = new Resend(process.env.RESEND_API_KEY || 're_tu_api_key_aqui');

// GET /vendor/explore
// Muestra productos del catálogo de SU MARCA que AÚN NO están en su inventario
export const exploreCatalog = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const marcaId = req.user?.marca_id;
    
  try {
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
export const getInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;

  try {
    const query = `
      SELECT 
        iv.id AS inventario_id,
        iv.stock,
        iv.precio_personalizado,
        iv.producto_maestro_id,
        COALESCE(cm.sku, iv.sku_custom) AS sku,
        COALESCE(cm.nombre, iv.nombre_custom) AS nombre,
        COALESCE(cm.precio_sugerido, 0) AS precio_sugerido,
        COALESCE(cm.ruta_imagen, iv.imagen_custom) AS ruta_imagen,
        -- Bandera útil para el frontend:
        CASE WHEN iv.producto_maestro_id IS NULL THEN true ELSE false END AS es_custom
      FROM inventario_vendedor iv
      LEFT JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
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
      WITH nuevo_item AS (
        INSERT INTO inventario_vendedor 
          (vendedor_id, producto_maestro_id, stock, precio_personalizado)
        VALUES 
          ($1, $2, $3, $4)
        RETURNING *
      )
      SELECT ni.*, cm.ruta_imagen, cm.nombre, cm.sku
      FROM nuevo_item ni
      JOIN catalogo_maestro cm ON ni.producto_maestro_id = cm.id;
    `;
    
    const values = [vendorId, producto_maestro_id, stock, precio_personalizado];
    const { rows } = await pool.query(query, values);
    
    res.status(201).json({
      message: '¡Producto agregado a tu inventario exitosamente!',
      producto: rows[0]
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ 
        error: 'Esta joya ya está en tu inventario. Ve a la pestaña de "Inventario" para actualizar el stock.' 
      });
    }
    console.error("🔥 ERROR AL AGREGAR AL INVENTARIO:", error);
    res.status(500).json({ error: 'Hubo un error interno al guardar la joya en tu inventario.' });
  }
};

// PUT /vendor/inventory/:id
// Actualiza la cantidad de stock de un producto existente en el inventario
export const updateInventoryStock = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const { id } = req.params; 
  const { stock } = req.body;

  try {
    const query = `
      UPDATE inventario_vendedor
      SET stock = $1
      WHERE id = $2 AND vendedor_id = $3
      RETURNING *;
    `;
    const { rows } = await pool.query(query, [stock, id, vendorId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado en tu inventario.' });
    }

    res.json({
      message: 'Stock actualizado exitosamente.',
      producto: rows[0]
    });
  } catch (error) {
    console.error("🔥 ERROR AL ACTUALIZAR STOCK:", error);
    res.status(500).json({ error: 'Error al actualizar el stock del producto.' });
  }
};

// GET /store/:slug
// Endpoint PÚBLICO para ver el catálogo de una vendedora específica
export const getSellerCatalogBySlug = async (req: Request, res: Response) => {
  const { slug } = req.params;

  try {
    const userQuery = `SELECT id, nombre, telefono FROM usuarios WHERE store_slug = $1`;
    const userResult = await pool.query(userQuery, [slug]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Catálogo no encontrado.' });
    }

    const vendor = userResult.rows[0];

    const inventoryQuery = `
      SELECT 
        iv.id AS inventario_id,
        iv.stock,
        iv.precio_personalizado,
        cm.id AS producto_maestro_id,
        cm.nombre,
        cm.descripcion,
        cm.ruta_imagen,
        cm.precio_sugerido
      FROM inventario_vendedor iv
      INNER JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      WHERE iv.vendedor_id = $1 AND iv.stock > 0;
    `;
    const inventoryResult = await pool.query(inventoryQuery, [vendor.id]);

    res.json({
      vendor: {
        nombre: vendor.nombre,
        telefono: vendor.telefono,
      },
      products: inventoryResult.rows
    });

  } catch (error) {
    console.error("🔥 ERROR EN CATÁLOGO PÚBLICO:", error);
    res.status(500).json({ error: 'Error al cargar el catálogo.' });
  }
};

// PUT /vendor/store-settings
export const updateStoreSettings = async (req: AuthRequest, res: Response): Promise<any> => {
  const userId = req.user?.user_id;
  const { store_slug, telefono } = req.body;

  if (!store_slug || !telefono) {
    return res.status(400).json({ error: 'El nombre de la tienda y el teléfono son obligatorios.' });
  }

  try {
    const cleanSlug = store_slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const cleanPhone = telefono.replace(/\D/g, '');

    const checkQuery = 'SELECT id FROM usuarios WHERE store_slug = $1 AND id != $2';
    const checkResult = await pool.query(checkQuery, [cleanSlug, userId]);
    
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ error: 'Este nombre de tienda ya está en uso. Por favor elige otro.' });
    }

    const updateQuery = `
      UPDATE usuarios 
      SET store_slug = $1, telefono = $2 
      WHERE id = $3 
      RETURNING store_slug, telefono;
    `;
    const { rows } = await pool.query(updateQuery, [cleanSlug, cleanPhone, userId]);

    return res.json({ 
      message: '¡Configuración de tienda guardada exitosamente!', 
      data: rows[0] 
    });

  } catch (error) {
    console.error(" ERROR AL ACTUALIZAR TIENDA:", error);
    return res.status(500).json({ error: 'Error al actualizar la configuración de tu tienda.' });
  }
};

// POST /vendor/inventory/custom
// Registra una joya propia del vendedor y ENVÍA NOTIFICACIÓN SILENCIOSA
export const addCustomToInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const vendorEmail = req.user?.email || 'Vendedor Anónimo'; 
  const { nombre, sku, stock, precio_personalizado } = req.body;

  if (!nombre || !sku || stock === undefined || precio_personalizado === undefined) {
    return res.status(400).json({ error: 'Faltan datos para crear tu joya personalizada.' });
  }

  try {
    // 1. Guardar la joya "custom" en la tabla pivote
    const query = `
      INSERT INTO inventario_vendedor 
        (vendedor_id, producto_maestro_id, nombre_custom, sku_custom, stock, precio_personalizado)
      VALUES 
        ($1, NULL, $2, $3, $4, $5)
      RETURNING *;
    `;
    
    const values = [vendorId, nombre, sku, stock, precio_personalizado];
    const { rows } = await pool.query(query, values);
    
    // 2. MAGIA SILENCIOSA: Notificar al administrador por correo en segundo plano (sin await)
   resend.emails.send({
      // EL FROM TIENE QUE SER EL DE RESEND (obligatorio hasta verificar el dominio)
      from: 'Notificaciones Qlatte <onboarding@resend.dev>', 
      
      // EL TO DEBE SER TU CORREO DE CUENTA (el cual es admin@qlatte.com)
      to: 'admin@qlatte.com', 
      
      subject: `💎 Nueva Pieza Propia: ${nombre}`,
  
      html: `
        <h2>Un vendedor ha registrado una pieza fuera del catálogo maestro</h2>
        <p>Esta información te sirve como estudio de mercado pasivo para futuras actualizaciones.</p>
        <ul>
          <li><strong>Vendedor:</strong> ${vendorEmail}</li>
          <li><strong>Nombre de la pieza:</strong> ${nombre}</li>
          <li><strong>SKU asignado:</strong> ${sku}</li>
          <li><strong>Precio de venta:</strong> $${precio_personalizado}</li>
        </ul>
      `
    }).catch(err => console.error("Error silencioso de Resend:", err));

    // 3. Responder de inmediato al frontend
    res.status(201).json({
      message: '¡Joya personalizada agregada a tu inventario!',
      producto: rows[0] 
    });

  } catch (error: any) {
    console.error("🔥 ERROR AL AGREGAR JOYA CUSTOM:", error);
    res.status(500).json({ error: 'Hubo un error al guardar tu joya personalizada.' });
  }
};
