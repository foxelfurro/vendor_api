import { pool } from './src/config/db';

async function run() {
  try {
    await pool.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS suscripcion_plan VARCHAR(20) DEFAULT \'ninguno\'');
    console.log('Exito');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
run();
