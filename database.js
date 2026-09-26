require('dotenv').config();
const { createClient } = require('@libsql/client');

let url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();

if (url.startsWith('libsql://')) {
  url = url.replace('libsql://', 'https://');
}

const db = createClient({
  url,
  authToken
});

(async function initDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        usuario TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        rango TEXT DEFAULT 'Supervisor',
        rol TEXT DEFAULT 'empleado',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_ascensos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jefatura TEXT NOT NULL,
        discord_id TEXT DEFAULT 'N/A',
        nombre_ems TEXT DEFAULT '',
        nombre TEXT DEFAULT '',
        rango_actual TEXT NOT NULL,
        rango_propuesto TEXT DEFAULT '',
        rango_postular TEXT DEFAULT '',
        faltas TEXT DEFAULT 'NINGUNA',
        horas_semana TEXT DEFAULT '00 HRS 00:00',
        examen TEXT DEFAULT 'NO APLICA',
        descripcion TEXT DEFAULT '',
        actualizado_por TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migraciones = [
      "ALTER TABLE registro_ascensos ADD COLUMN nombre TEXT DEFAULT ''",
      "ALTER TABLE registro_ascensos ADD COLUMN rango_postular TEXT DEFAULT ''",
      "ALTER TABLE registro_ascensos ADD COLUMN faltas TEXT DEFAULT 'NINGUNA'",
      "ALTER TABLE registro_ascensos ADD COLUMN horas_semana TEXT DEFAULT '00 HRS 00:00'",
      "ALTER TABLE registro_ascensos ADD COLUMN examen TEXT DEFAULT 'NO APLICA'",
      "ALTER TABLE registro_ascensos ADD COLUMN descripcion TEXT DEFAULT ''"
    ];

    for (const sql of migraciones) {
      try {
        await db.execute(sql);
      } catch (e) {
        // Ignorar si la columna ya existe
      }
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_formaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instructor TEXT NOT NULL,
        rango TEXT NOT NULL,
        instrucciones_hechas INTEGER DEFAULT 0,
        total_pago REAL DEFAULT 0,
        notas TEXT DEFAULT '',
        actualizado_por TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("[DB] Tablas y columnas verificadas en Turso.");
  } catch (err) {
    console.error("[DB ERROR]:", err.message);
  }
})();

module.exports = db;