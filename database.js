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
        discord_id TEXT DEFAULT 'N/A',
        nombre TEXT NOT NULL,
        usuario TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        rango TEXT DEFAULT 'Sin Rango (Pendiente)',
        rol TEXT DEFAULT 'empleado',
        horas_semana TEXT DEFAULT '',
        fecha_ingreso TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await db.execute("ALTER TABLE usuarios ADD COLUMN discord_id TEXT DEFAULT 'N/A'"); } catch (e) {}
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN horas_semana TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN fecha_ingreso TEXT DEFAULT ''"); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_ascensos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jefatura TEXT NOT NULL,
        discord_id TEXT DEFAULT 'N/A',
        nombre_ems TEXT DEFAULT '',
        nombre TEXT NOT NULL,
        rango_actual TEXT NOT NULL,
        rango_propuesto TEXT DEFAULT '',
        rango_postular TEXT DEFAULT '',
        faltas TEXT DEFAULT 'NINGUNA',
        horas_semana TEXT DEFAULT '',
        examen TEXT DEFAULT 'NO APLICA',
        estado TEXT DEFAULT 'Activo',
        descripcion TEXT DEFAULT '',
        fecha_ingreso TEXT DEFAULT '',
        actualizado_por TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await db.execute("ALTER TABLE registro_ascensos ADD COLUMN estado TEXT DEFAULT 'Activo'"); } catch (e) {}
    try { await db.execute("ALTER TABLE registro_ascensos ADD COLUMN fecha_ingreso TEXT DEFAULT ''"); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_formaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instructor TEXT NOT NULL,
        rango TEXT NOT NULL,
        instrucciones_hechas INTEGER DEFAULT 0,
        instrucciones_totales INTEGER DEFAULT 0,
        total_pago REAL DEFAULT 0,
        notas TEXT DEFAULT '',
        actualizado_por TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await db.execute("ALTER TABLE registro_formaciones ADD COLUMN instrucciones_totales INTEGER DEFAULT 0"); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_coordinacion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT DEFAULT 'N/A',
        supervisor TEXT NOT NULL,
        rango TEXT DEFAULT 'Supervisor',
        horas_semana TEXT DEFAULT '',
        estado TEXT DEFAULT 'Activo',
        feedback_semanal TEXT DEFAULT '',
        pdf_feedback TEXT DEFAULT '',
        nombre_pdf TEXT DEFAULT '',
        actualizado_por TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_pagos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        personal TEXT NOT NULL,
        rango TEXT NOT NULL,
        concepto TEXT NOT NULL,
        cantidad REAL DEFAULT 0,
        estado TEXT DEFAULT 'Pendiente',
        pagado_por TEXT DEFAULT 'Pendiente',
        fecha_pago TEXT DEFAULT '',
        registrado_por TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // TABLA PARA EL ESTADO DE TABLA LISTA (CIRUGÍA, MEDICINA, ENFERMERÍA)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS control_tablas_listas (
        jefatura TEXT PRIMARY KEY,
        esta_lista INTEGER DEFAULT 0,
        fecha_hora_mexico TEXT DEFAULT '',
        marcado_por TEXT DEFAULT ''
      )
    `);

    // Inicializar estados de tablas si no existen
    const jefaturas = ['cirugia', 'medicina', 'enfermeria'];
    for (const j of jefaturas) {
      await db.execute({
        sql: "INSERT OR IGNORE INTO control_tablas_listas (jefatura, esta_lista, fecha_hora_mexico, marcado_por) VALUES (?, 0, '', '')",
        args: [j]
      });
    }

    console.log("[DB] Base de datos Turso lista con control de horas, totales de formación y estados de tabla.");
  } catch (err) {
    console.error("[DB ERROR]:", err.message);
  }
})();

module.exports = db;