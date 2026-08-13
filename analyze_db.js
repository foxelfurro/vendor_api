const { Client } = require('pg');

// Remove sslmode from the end
const connectionString = 'postgresql://neondb_owner:npg_L9N4isCgJuVB@ep-frosty-firefly-a4w8fux6-pooler.us-east-1.aws.neon.tech/neondb';

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
