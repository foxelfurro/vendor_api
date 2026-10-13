const { Client } = require('pg');

require('dotenv').config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Falta la variable de entorno DATABASE_URL.');
  process.exit(1);
}

const client = new Client({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function analyze() {
  try {
    await client.connect();
    console.log("Conectado a la base de datos.");

    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);

    const tables = res.rows.map(r => r.table_name);
    console.log("\\nTablas encontradas:", tables);

    for (const table of tables) {
      console.log("\\n--- Estructura de la tabla: " + table + " ---");
      const cols = await client.query(`
        SELECT column_name, data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
      `, [table]);
      
      console.table(cols.rows);
    }

  } catch (err) {
    console.error("Error analizando la base de datos:", err);
  } finally {
    await client.end();
  }
}

analyze();
