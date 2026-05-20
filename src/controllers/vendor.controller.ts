import { Request, Response } from 'express'; // <-- Agregamos Request aquí
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
    // Modificamos la query para que devuelva los datos del catálogo maestro tras insertar
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
      producto: rows[0] // Ahora este objeto incluirá la ruta_imagen
    });
  } catch (error: any) {
    // ... resto del manejo de errores
  }
};

// PUT /vendor/inventory/:id
// Actualiza la cantidad de stock de un producto existente en el inventario
export const updateInventoryStock = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const { id } = req.params; // Este será el inventario_id
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
    // 1. Buscar la vendedora por su slug (Asegúrate de agregar la columna store_slug a tu tabla de usuarios)
    const userQuery = `SELECT id, nombre, telefono FROM usuarios WHERE store_slug = $1`;
    const userResult = await pool.query(userQuery, [slug]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Catálogo no encontrado.' });
    }

    const vendor = userResult.rows[0];

    // 2. Traer su inventario disponible haciendo JOIN con el catálogo maestro
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

    // 3. Enviar la data combinada
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
    // 1. Limpiamos los datos: slug en minúsculas sin caracteres raros, teléfono solo números
    const cleanSlug = store_slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const cleanPhone = telefono.replace(/\D/g, '');

    // 2. Verificamos que el slug no esté siendo usado por OTRA vendedora
    const checkQuery = 'SELECT id FROM usuarios WHERE store_slug = $1 AND id != $2';
    const checkResult = await pool.query(checkQuery, [cleanSlug, userId]);
    
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ error: 'Este nombre de tienda ya está en uso. Por favor elige otro.' });
    }

    // 3. Actualizamos los datos
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
export const addCustomToInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const { nombre, sku, stock, precio_personalizado } = req.body;

  if (!nombre || !sku || stock === undefined || precio_personalizado === undefined) {
    return res.status(400).json({ error: 'Faltan datos para crear tu joya personalizada.' });
  }

  try {
    const query = `
      INSERT INTO inventario_vendedor 
        (vendedor_id, producto_maestro_id, nombre_custom, sku_custom, stock, precio_personalizado)
      VALUES 
        ($1, NULL, $2, $3, $4, $5)
      RETURNING *;
    `;
    
    const values = [vendorId, nombre, sku, stock, precio_personalizado];
    const { rows } = await pool.query(query, values);
    
    res.status(201).json({
      message: '¡Joya personalizada agregada a tu inventario!',
      producto: rows[0] 
    });

  } catch (error: any) {
    console.error("🔥 ERROR AL AGREGAR JOYA CUSTOM:", error);
    res.status(500).json({ error: 'Hubo un error al guardar tu joya personalizada.' });
  }
};
import { Resend } from 'resend';

// Asegúrate de poner tu API Key real en tu archivo .env
const resend = new Resend(process.env.RESEND_API_KEY || 're_tu_api_key_aqui'); 

// POST /vendor/request-catalog
export const requestCatalogItem = async (req: AuthRequest, res: Response) => {
  const vendorEmail = req.user?.email || 'Vendedor Anónimo';
  const { busqueda, descripcion } = req.body;

  try {
    await resend.emails.send({
      from: 'Qlatte App <onboarding@resend.dev>', // Si ya tienes dominio verificado, usa el tuyo
      to: 'tu_correo_de_administrador@gmail.com', // El correo donde quieres recibir estas sugerencias
      subject: `💡 Nueva sugerencia de joya: "${busqueda}"`,
      html: `
        <h2>Un vendedor ha solicitado una nueva pieza para el Catálogo Maestro</h2>
        <p><strong>Buscó:</strong> ${busqueda}</p>
        <p><strong>Detalles adicionales:</strong> ${descripcion}</p>
        <hr />
        <p><small>Solicitud enviada desde la cuenta de: ${vendorEmail}</small></p>
      `
    });

    res.status(200).json({ message: "Sugerencia enviada correctamente." });
  } catch (error) {
    console.error("Error al enviar email con Resend:", error);
    res.status(500).json({ error: "Error al procesar la sugerencia." });
  }
};
