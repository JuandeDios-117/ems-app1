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
    // 1. USUARIOS (Con permisos personalizados de pestañas)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT DEFAULT 'N/A',
        nombre TEXT NOT NULL,
        usuario TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        rango TEXT DEFAULT 'Sin Rango (Pendiente)',
        rol TEXT DEFAULT 'empleado',
        permisos_custom TEXT DEFAULT '',
        horas_semana TEXT DEFAULT '',
        fecha_ingreso TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await db.execute("ALTER TABLE usuarios ADD COLUMN discord_id TEXT DEFAULT 'N/A'"); } catch (e) {}
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN horas_semana TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN fecha_ingreso TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE usuarios ADD COLUMN permisos_custom TEXT DEFAULT ''"); } catch (e) {}

    // 2. ASCENSOS & EVALUACIONES
    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_ascensos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jefatura TEXT NOT NULL,
        discord_id TEXT DEFAULT 'N/A',
        nombre_ems TEXT DEFAULT '',
        nombre TEXT NOT NULL,
        rango_actual TEXT NOT NULL,
        rango_postular TEXT DEFAULT '',
        rango_propuesto TEXT DEFAULT '',
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
    try { await db.execute("ALTER TABLE registro_ascensos ADD COLUMN descripcion TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE registro_ascensos ADD COLUMN rango_postular TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE registro_ascensos ADD COLUMN rango_propuesto TEXT DEFAULT ''"); } catch (e) {}

    // 3. FORMACIONES Y LIMBO DE ASPIRANTES
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
      CREATE TABLE IF NOT EXISTS aspirantes_limbo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT DEFAULT 'N/A',
        nombre TEXT NOT NULL,
        fecha_ingreso TEXT DEFAULT '',
        notas TEXT DEFAULT 'Pendiente de Instrucción IC',
        registrado_por TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. COORDINACIÓN (Con rango_postular para ascensos a Coordinador y Jefaturas)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS registro_coordinacion (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT DEFAULT 'N/A',
        supervisor TEXT NOT NULL,
        rango TEXT DEFAULT 'Supervisor',
        rango_postular TEXT DEFAULT 'Supervisor',
        horas_semana TEXT DEFAULT '',
        estado TEXT DEFAULT 'Activo',
        desempeno TEXT DEFAULT 'Excelente',
        feedback_semanal TEXT DEFAULT '',
        pdf_feedback TEXT DEFAULT '',
        nombre_pdf TEXT DEFAULT '',
        actualizado_por TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await db.execute("ALTER TABLE registro_coordinacion ADD COLUMN horas_semana TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE registro_coordinacion ADD COLUMN desempeno TEXT DEFAULT 'Excelente'"); } catch (e) {}
    try { await db.execute("ALTER TABLE registro_coordinacion ADD COLUMN pdf_feedback TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE registro_coordinacion ADD COLUMN nombre_pdf TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE registro_coordinacion ADD COLUMN rango_postular TEXT DEFAULT 'Supervisor'"); } catch (e) {}

    // 5. TESORERÍA & PAGOS
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

    // 6. ESTADO DE TABLAS LISTAS + SELECCIÓN MANUAL DE EMS DE LA SEMANA
    await db.execute(`
      CREATE TABLE IF NOT EXISTS control_tablas_listas (
        jefatura TEXT PRIMARY KEY,
        esta_lista INTEGER DEFAULT 0,
        fecha_hora_mexico TEXT DEFAULT '',
        marcado_por TEXT DEFAULT '',
        ems_semana_nombre TEXT DEFAULT '',
        ems_semana_discord TEXT DEFAULT '',
        ems_semana_horas TEXT DEFAULT ''
      )
    `);

    try { await db.execute("ALTER TABLE control_tablas_listas ADD COLUMN ems_semana_nombre TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE control_tablas_listas ADD COLUMN ems_semana_discord TEXT DEFAULT ''"); } catch (e) {}
    try { await db.execute("ALTER TABLE control_tablas_listas ADD COLUMN ems_semana_horas TEXT DEFAULT ''"); } catch (e) {}

    const jefaturas = ['cirugia', 'medicina', 'enfermeria', 'formaciones'];
    for (const j of jefaturas) {
      await db.execute({
        sql: "INSERT OR IGNORE INTO control_tablas_listas (jefatura, esta_lista, fecha_hora_mexico, marcado_por, ems_semana_nombre, ems_semana_discord, ems_semana_horas) VALUES (?, 0, '', '', '', '', '')",
        args: [j]
      });
    }

    // 7. HISTORIAL DE DESPIDOS (Control de Bajas)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS historial_despidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT DEFAULT 'N/A',
        nombre TEXT NOT NULL,
        rango_anterior TEXT NOT NULL,
        jefatura TEXT DEFAULT '',
        fecha_despido TEXT NOT NULL,
        motivo TEXT DEFAULT 'Baja por evaluación / Faltas',
        registrado_por TEXT DEFAULT 'Sistema',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 8. HISTORIAL DEL ÚLTIMO REPORTE SEMANAL
    await db.execute(`
      CREATE TABLE IF NOT EXISTS historial_reportes (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        reporte_json TEXT NOT NULL,
        fecha TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 9. CONFIGURACIÓN DEL SISTEMA (WEBHOOK DISCORD)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS configuracion_sistema (
        clave TEXT PRIMARY KEY,
        valor TEXT DEFAULT ''
      )
    `);

    await db.execute({
      sql: "INSERT OR IGNORE INTO configuracion_sistema (clave, valor) VALUES ('discord_webhook', ?)",
      args: [process.env.DISCORD_WEBHOOK_URL || '']
    });

    console.log("[DB] Base de datos verificada y sincronizada al 100% con todas las expansiones.");
  } catch (err) {
    console.error("[DB ERROR]:", err.message);
  }
})();

module.exports = db;