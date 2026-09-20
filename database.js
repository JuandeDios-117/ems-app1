require('dotenv').config();
const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

// Inicializar las tablas de la EMS en la nube
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
        comision_porcentaje INTEGER DEFAULT 30,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_ascensos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jefatura TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        nombre_ems TEXT NOT NULL,
        rango_actual TEXT NOT NULL,
        rango_propuesto TEXT NOT NULL,
        horas_hechas REAL DEFAULT 0,
        notas TEXT,
        actualizado_por TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS facturas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL,
        paciente TEXT NOT NULL,
        dni TEXT,
        total_cobrado REAL NOT NULL,
        coste_suministros REAL NOT NULL,
        fondo_hospital REAL NOT NULL,
        comision_medico REAL NOT NULL,
        items_json TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Tablas EMS sincronizadas con Turso.");
  } catch (err) {
    console.error("Error iniciando base de datos Turso:", err.message);
  }
})();

module.exports = db;