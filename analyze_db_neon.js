const { neon } = require('@neondatabase/serverless');

require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta la variable de entorno DATABASE_URL.');
  process.exit(1);
}
const sql = neon(connectionString);

async function analyze() {
  try {
    console.log("Conectando a Neon Serverless (Vía HTTP)...");

    const tablesRes = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;

    const tables = tablesRes.map(r => r.table_name);
    
    if (tables.length === 0) {
      console.log("No se encontraron tablas en la base de datos.");
      return;
    }

    console.log("\\nTablas encontradas:", tables);

    for (const table of tables) {
      console.log("\\n--- Estructura de la tabla: " + table + " ---");
      const cols = await sql`
        SELECT column_name, data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
      `;
      
      console.table(cols);
    }

  } catch (err) {
    console.error("Error analizando la base de datos:", err);
  }
}

analyze();
