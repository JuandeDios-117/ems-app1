require('dotenv').config();
const express = require('express');
const http = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const db = require('./database'); 
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(compression());
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ limit: '35mb', extended: true }));
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
});

app.get('/ping', (req, res) => res.status(200).send('OK'));

const onlineSockets = new Map();
io.on('connection', (socket) => {
    socket.on('user_connected', (userData) => {
        if (userData && userData.id) {
            onlineSockets.set(socket.id, {
                id: Number(userData.id),
                nombre: userData.nombre,
                usuario: userData.usuario,
                rango: userData.rango,
                rol: userData.rol
            });
            emitirUsuariosOnline();
        }
    });

    socket.on('disconnect', () => {
        if (onlineSockets.has(socket.id)) {
            onlineSockets.delete(socket.id);
            emitirUsuariosOnline();
        }
    });
});

function emitirUsuariosOnline() {
    const unicos = new Map();
    for (const u of onlineSockets.values()) unicos.set(u.id, u);
    io.emit('online_users_update', Array.from(unicos.values()));
}

function notificar(evento, data = {}) {
    io.emit('db_update', { evento, ...data });
}

function parsearHorasServer(str) {
    if (!str) return 0;
    const limpio = String(str).toUpperCase().replace('HRS', '').replace('HR', '').trim();
    const partes = limpio.split(':');
    const h = parseFloat(partes[0]) || 0;
    const m = partes[1] ? (parseFloat(partes[1]) || 0) / 60 : 0;
    return Math.max(0, h + m);
}

function dividirMensajeDiscord(texto, maxLen = 1950) {
    if (texto.length <= maxLen) return [texto];
    const lineas = texto.split('\n');
    const partes = [];
    let actual = '';
    for (const linea of lineas) {
        if ((actual + '\n' + linea).length > maxLen) {
            partes.push(actual);
            actual = linea;
        } else {
            actual = actual ? actual + '\n' + linea : linea;
        }
    }
    if (actual) partes.push(actual);
    return partes;
}

const JERARQUIA_SERVER = {
    "Celador/a": 1,
    "Auxiliar de Enfermería": 2,
    "Enfermero": 3,
    "Enfermero/a General": 4,
    "Enfermero/a Especialista": 5,
    "Estudiante": 6,
    "Interno/a": 7,
    "Residente": 8,
    "Subespecialista": 9,
    "Especialista": 10,
    "Formador": 10.5,
    "Supervisor": 11,
    "Coordinador": 12,
    "Jefe de Formaciones": 13,
    "Director de Enfermería": 14,
    "Jefe de Medicina": 15,
    "Jefe de Cirugía": 16,
    "Jefa de Cirugía": 16,
    "Subdirectora": 17,
    "Director (Admin)": 18
};

const CARGOS_JEFATURA_LISTA = [
    "Jefe de Formaciones",
    "Director de Enfermería",
    "Jefe de Medicina",
    "Jefe de Cirugía",
    "Jefa de Cirugía",
    "Subdirectora",
    "Director (Admin)"
];

function obtenerPermisosAutoPorCargo(rango) {
    const r = (rango || '').toLowerCase();
    if (r.includes('cirug')) return 'cirugia,censo';
    if (r.includes('medicin')) return 'medicina,censo';
    if (r.includes('enferm')) return 'enfermeria,censo';
    if (r.includes('formac')) return 'formaciones,censo';
    if (r.includes('coordinador')) return 'coordinacion,cirugia,medicina,enfermeria,censo';
    if (r.includes('supervisor')) return 'coordinacion';
    if (r.includes('subdirectora') || r.includes('director (admin)')) {
        return 'cirugia,medicina,enfermeria,formaciones,coordinacion,pagos,censo,despidos';
    }
    return '';
}

async function sincronizarRangoYPermisosUsuario(nombre, discordId, nuevoRango) {
    const permisosAuto = obtenerPermisosAutoPorCargo(nuevoRango);
    const nuevoRol = (nuevoRango === 'Subdirectora' || nuevoRango === 'Director (Admin)') ? 'admin' : null;

    const userCheck = await db.execute({
        sql: "SELECT id, permisos_custom, rol FROM usuarios WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?)) OR (discord_id != 'N/A' AND discord_id != '' AND discord_id = ?)",
        args: [(nombre || '').trim(), (discordId || '').trim()]
    });

    if (userCheck.rows && userCheck.rows.length > 0) {
        for (const u of userCheck.rows) {
            const actuales = (u.permisos_custom || '').split(',').map(s => s.trim()).filter(Boolean);
            const nuevos = permisosAuto.split(',').map(s => s.trim()).filter(Boolean);
            const combinados = Array.from(new Set([...actuales, ...nuevos])).join(',');

            await db.execute({
                sql: "UPDATE usuarios SET rango = ?, rol = COALESCE(?, rol), permisos_custom = ? WHERE id = ?",
                args: [nuevoRango, nuevoRol, combinados, u.id]
            });
            notificar('usuario_modificado', { usuario_id: Number(u.id), rango: nuevoRango, rol: nuevoRol || u.rol, permisos_custom: combinados });
        }
    }
}

// Evita duplicar el mismo pago pendiente el mismo día si desmarcan y vuelven a marcar la tabla
async function registrarPagoSinDuplicar(personal, rango, concepto, cantidad, hoy, registradoPor) {
    const check = await db.execute({
        sql: "SELECT id FROM registro_pagos WHERE LOWER(TRIM(personal)) = LOWER(TRIM(?)) AND concepto = ? AND estado = 'Pendiente' AND fecha_pago = ?",
        args: [personal.trim(), concepto.trim(), hoy]
    });

    if (check.rows && check.rows.length > 0) {
        await db.execute({
            sql: "UPDATE registro_pagos SET cantidad = ?, rango = ? WHERE id = ?",
            args: [cantidad, rango || 'Personal EMS', check.rows[0].id]
        });
        return false;
    } else {
        await db.execute({
            sql: `INSERT INTO registro_pagos (personal, rango, concepto, cantidad, estado, pagado_por, fecha_pago, registrado_por)
                  VALUES (?, ?, ?, ?, 'Pendiente', 'Pendiente', ?, ?)`,
            args: [personal.trim(), rango || 'Personal EMS', concepto.trim(), cantidad, hoy, registradoPor || 'Sistema Automático']
        });
        return true;
    }
}

async function sumarInstruccionFormador(nombreFormador) {
    if (!nombreFormador) return;
    const formadorClean = nombreFormador.trim();
    const formadorCheck = await db.execute({
        sql: "SELECT id, instrucciones_hechas FROM registro_formaciones WHERE LOWER(TRIM(instructor)) = LOWER(?)",
        args: [formadorClean]
    });

    if (formadorCheck.rows && formadorCheck.rows.length > 0) {
        const fId = formadorCheck.rows[0].id;
        const nuevas = Number(formadorCheck.rows[0].instrucciones_hechas || 0) + 1;
        await db.execute({
            sql: "UPDATE registro_formaciones SET instrucciones_hechas = ?, total_pago = ? WHERE id = ?",
            args: [nuevas, nuevas * 50000, fId]
        });
    } else {
        await db.execute({
            sql: "INSERT INTO registro_formaciones (instructor, rango, instrucciones_hechas, instrucciones_totales, total_pago, notas, actualizado_por) VALUES (?, 'Formador', 1, 0, 50000, 'Ingreso de aspirante', ?)",
            args: [formadorClean, formadorClean]
        });
    }
}

// 1. REGISTRO & LOGIN
app.post('/api/register', async (req, res) => {
    const { nombre, usuario, password, discord_id } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();
    const discordLimpio = (discord_id || '').replace(/[^0-9]/g, '');

    if (!nombre || !userClean || !password) {
        return res.status(400).json({ error: "Faltan campos por completar." });
    }

    try {
        const checkUser = await db.execute({
            sql: "SELECT id FROM usuarios WHERE LOWER(usuario) = ?",
            args: [userClean]
        });

        if (checkUser.rows && checkUser.rows.length > 0) {
            return res.status(400).json({ error: "El usuario ya existe." });
        }

        if (discordLimpio) {
            const checkDiscord = await db.execute({
                sql: "SELECT id FROM usuarios WHERE discord_id = ?",
                args: [discordLimpio]
            });
            if (checkDiscord.rows && checkDiscord.rows.length > 0) {
                return res.status(400).json({ error: "Este Discord ID ya tiene cuenta." });
            }
        }

        const count = await db.execute("SELECT COUNT(*) as total FROM usuarios");
        const esPrimero = Number(count.rows[0].total) === 0;

        let rangoAsignado = esPrimero ? 'Director (Admin)' : 'Sin Rango (Pendiente)';
        let rolAsignado = esPrimero ? 'admin' : 'empleado';

        if (!esPrimero && discordLimpio) {
            const matchAscensos = await db.execute({
                sql: "SELECT rango_actual FROM registro_ascensos WHERE discord_id = ? LIMIT 1",
                args: [discordLimpio]
            });
            if (matchAscensos.rows && matchAscensos.rows.length > 0) {
                rangoAsignado = matchAscensos.rows[0].rango_actual;
            } else {
                const matchCoord = await db.execute({
                    sql: "SELECT rango FROM registro_coordinacion WHERE discord_id = ? LIMIT 1",
                    args: [discordLimpio]
                });
                if (matchCoord.rows && matchCoord.rows.length > 0) {
                    rangoAsignado = matchCoord.rows[0].rango;
                }
            }
        }

        const permisosAuto = obtenerPermisosAutoPorCargo(rangoAsignado);
        const hoy = new Date().toISOString().split('T')[0];

        const result = await db.execute({
            sql: "INSERT INTO usuarios (nombre, usuario, password, discord_id, rango, rol, permisos_custom, fecha_ingreso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            args: [nombre.trim(), userClean, String(password), discordLimpio || 'N/A', rangoAsignado, rolAsignado, permisosAuto, hoy]
        });

        notificar('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre: nombre.trim(), usuario: userClean, rango: rangoAsignado, rol: rolAsignado, permisos_custom: permisosAuto });
    } catch (e) {
        res.status(500).json({ error: "Error registrando usuario." });
    }
});

app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    if (!userClean || !password) {
        return res.status(400).json({ error: "Ingresa credenciales." });
    }

    try {
        const sql = `SELECT id, nombre, usuario, discord_id, COALESCE(rango, 'Sin Rango (Pendiente)') as rango, COALESCE(rol, 'empleado') as rol, COALESCE(permisos_custom, '') as permisos_custom, fecha_ingreso FROM usuarios WHERE LOWER(TRIM(usuario)) = ? AND password = ?`;
        const result = await db.execute({ sql, args: [userClean, String(password)] });
        
        if (!result.rows || result.rows.length === 0) {
            return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        }

        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: "Error de autenticación." });
    }
});

// 2. PANEL ADMIN, PERMISOS PERSONALIZADOS & WEBHOOK CONFIG
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, discord_id, nombre, usuario, COALESCE(rango, 'Sin Rango (Pendiente)') as rango, COALESCE(rol, 'empleado') as rol, COALESCE(permisos_custom, '') as permisos_custom, fecha_ingreso, horas_semana FROM usuarios ORDER BY id ASC");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { rango, rango_actual, rol, permisos_custom, discord_id, horas_semana, fecha_ingreso, nombre, password } = req.body;
    const rangoFinal = rango || rango_actual || null;
    let discordLimpio = discord_id !== undefined && discord_id !== null ? String(discord_id).replace(/[^0-9]/g, '') : null;

    let permisosStr = null;
    if (permisos_custom !== undefined) {
        permisosStr = Array.isArray(permisos_custom) ? permisos_custom.join(',') : String(permisos_custom);
    }

    try {
        await db.execute({
            sql: `UPDATE usuarios SET 
                    rango = COALESCE(?, rango), 
                    rol = COALESCE(?, rol),
                    permisos_custom = COALESCE(?, permisos_custom),
                    discord_id = COALESCE(?, discord_id),
                    horas_semana = COALESCE(?, horas_semana),
                    fecha_ingreso = COALESCE(?, fecha_ingreso),
                    nombre = COALESCE(?, nombre),
                    password = COALESCE(?, password)
                  WHERE id = ?`,
            args: [rangoFinal, rol || null, permisosStr, discordLimpio, horas_semana !== undefined ? horas_semana : null, fecha_ingreso || null, nombre ? nombre.trim() : null, password ? String(password) : null, req.params.id]
        });
        notificar('usuario_modificado', { usuario_id: Number(req.params.id), rango: rangoFinal, rol, permisos_custom: permisosStr });
        res.json({ message: "Cuenta y permisos actualizados con éxito." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/usuarios/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [req.params.id] });
        notificar('usuario_eliminado', { usuario_id: Number(req.params.id) });
        res.json({ message: "Usuario eliminado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// CONFIGURACIÓN Y ENVÍO DE WEBHOOK DISCORD
app.get('/api/config/webhook', async (req, res) => {
    try {
        const result = await db.execute("SELECT valor FROM configuracion_sistema WHERE clave = 'discord_webhook'");
        const url = (result.rows && result.rows.length > 0) ? result.rows[0].valor : (process.env.DISCORD_WEBHOOK_URL || '');
        res.json({ webhook_url: url });
    } catch (e) {
        res.json({ webhook_url: '' });
    }
});

app.post('/api/config/webhook', async (req, res) => {
    const { webhook_url } = req.body;
    try {
        await db.execute({
            sql: "INSERT OR REPLACE INTO configuracion_sistema (clave, valor) VALUES ('discord_webhook', ?)",
            args: [(webhook_url || '').trim()]
        });
        res.json({ message: "Webhook de Discord guardado exitosamente." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/discord/enviar-reporte', async (req, res) => {
    const { contenido } = req.body;
    if (!contenido || !contenido.trim()) {
        return res.status(400).json({ error: "El contenido del reporte está vacío." });
    }

    try {
        const result = await db.execute("SELECT valor FROM configuracion_sistema WHERE clave = 'discord_webhook'");
        let webhookUrl = (result.rows && result.rows.length > 0) ? result.rows[0].valor : '';
        if (!webhookUrl) webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';

        if (!webhookUrl || !webhookUrl.startsWith('https://discord')) {
            return res.status(400).json({ error: "No hay una URL de Webhook válida configurada. Agrégala primero en el Panel de Cuentas." });
        }

        const fragmentos = dividirMensajeDiscord(contenido.trim(), 1950);

        for (const fragmento of fragmentos) {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: "EMS Origen Roleplay · Dirección",
                    content: fragmento
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                return res.status(500).json({ error: `Discord rechazó el envío (${response.status}): ${errText}` });
            }
        }

        res.json({ message: "¡Reporte publicado exitosamente en el canal de Discord!" });
    } catch (e) {
        res.status(500).json({ error: "Error al conectar con Discord: " + e.message });
    }
});

// 3. REGISTROS DE EVALUACIÓN
app.get('/api/ascensos', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM registro_ascensos ORDER BY id DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/ascensos', async (req, res) => {
    const { jefatura, discord_id, nombre, fecha_ingreso, actualizado_por, es_aspirante_formacion } = req.body;
    if (!jefatura || !nombre) {
        return res.status(400).json({ error: "Ingresa el nombre del personal." });
    }

    const discordLimpio = (discord_id || '').replace(/[^0-9]/g, '') || 'N/A';
    const fechaHoy = fecha_ingreso || new Date().toISOString().split('T')[0];
    const rangoBase = jefatura === 'enfermeria' ? 'Celador/a' : 'Estudiante';
    const marcaPrueba = es_aspirante_formacion ? 'PRUEBA_ACTIVA' : '';

    try {
        await db.execute({
            sql: `INSERT INTO registro_ascensos (
                    jefatura, discord_id, nombre_ems, nombre, rango_actual, rango_postular, rango_propuesto,
                    faltas, horas_semana, examen, estado, descripcion, fecha_ingreso, actualizado_por
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                jefatura, discordLimpio, nombre.trim(), nombre.trim(), rangoBase, rangoBase, rangoBase,
                'NINGUNA', '', 'NO APLICA', 'Activo', marcaPrueba, fechaHoy, actualizado_por || 'Jefatura'
            ]
        });

        if (es_aspirante_formacion && actualizado_por) {
            await sumarInstruccionFormador(actualizado_por);
            notificar('formaciones_actualizadas');
        }

        notificar('ascensos_actualizados', { jefatura });
        res.json({ message: "Personal ingresado con éxito." });
    } catch (e) {
        console.error("Error Ascensos POST:", e);
        res.status(500).json({ error: e.message });
    }
});

// ACTUALIZACIÓN EN TIEMPO REAL
app.put('/api/ascensos/:id', async (req, res) => {
    const { jefatura, discord_id, nombre, rango_actual, rango_postular, faltas, horas_semana, examen, estado, descripcion, fecha_ingreso } = req.body;
    let discordLimpio = discord_id !== undefined && discord_id !== null ? String(discord_id).replace(/[^0-9]/g, '') || 'N/A' : null;

    try {
        const actualRes = await db.execute({
            sql: "SELECT * FROM registro_ascensos WHERE id = ?",
            args: [req.params.id]
        });

        if (!actualRes.rows || actualRes.rows.length === 0) {
            return res.status(404).json({ error: "Registro no encontrado." });
        }

        const registroActual = actualRes.rows[0];

        let nuevaJefatura = jefatura !== undefined ? jefatura : registroActual.jefatura;
        let nuevoRangoActual = rango_actual !== undefined ? rango_actual : registroActual.rango_actual;
        let nuevoRangoPostular = rango_postular !== undefined ? rango_postular : registroActual.rango_postular;
        let nuevoExamen = examen !== undefined ? examen : registroActual.examen;

        // Transferencia inmediata si alguien en el limbo de Enfermería aprueba el examen hacia Cirugía o Medicina
        if (registroActual.jefatura === 'enfermeria' && (nuevoRangoActual === 'Estudiante' || nuevoRangoActual === 'Interno/a')) {
            if (nuevoExamen === 'REALIZADO') {
                if (nuevoRangoPostular && nuevoRangoPostular.includes('(Cirugía)')) {
                    nuevaJefatura = 'cirugia';
                    nuevoRangoActual = nuevoRangoPostular.replace(' (Cirugía)', '').replace(' (Doble)', '').trim();
                    nuevoRangoPostular = nuevoRangoActual;
                    nuevoExamen = 'NO APLICA';
                } else if (nuevoRangoPostular && nuevoRangoPostular.includes('(Medicina)')) {
                    nuevaJefatura = 'medicina';
                    nuevoRangoActual = nuevoRangoPostular.replace(' (Medicina)', '').replace(' (Doble)', '').trim();
                    nuevoRangoPostular = nuevoRangoActual;
                    nuevoExamen = 'NO APLICA';
                }
            }
        }

        await db.execute({
            sql: `UPDATE registro_ascensos SET 
                    jefatura = COALESCE(?, jefatura),
                    discord_id = COALESCE(?, discord_id),
                    nombre = COALESCE(?, nombre),
                    nombre_ems = COALESCE(?, nombre_ems),
                    rango_actual = COALESCE(?, rango_actual),
                    rango_postular = COALESCE(?, rango_postular),
                    rango_propuesto = COALESCE(?, rango_propuesto),
                    faltas = COALESCE(?, faltas),
                    horas_semana = COALESCE(?, horas_semana),
                    examen = COALESCE(?, examen),
                    estado = COALESCE(?, estado),
                    descripcion = COALESCE(?, descripcion),
                    fecha_ingreso = COALESCE(?, fecha_ingreso)
                  WHERE id = ?`,
            args: [
                nuevaJefatura, discordLimpio, nombre ? nombre.trim() : null, nombre ? nombre.trim() : null,
                nuevoRangoActual, nuevoRangoPostular, nuevoRangoPostular, faltas || null, horas_semana !== undefined ? horas_semana.trim() : null,
                nuevoExamen, estado || null, descripcion !== undefined ? descripcion.trim() : null,
                fecha_ingreso !== undefined ? fecha_ingreso.trim() : null, req.params.id
            ]
        });

        notificar('ascensos_actualizados');
        res.json({ message: "Actualizado correctamente." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// OBTENER EL ÚLTIMO REPORTE SEMANAL GUARDADO
app.get('/api/ascensos/ultimo-reporte', async (req, res) => {
    try {
        const result = await db.execute("SELECT reporte_json, fecha, updated_at FROM historial_reportes WHERE id = 1");
        if (!result.rows || result.rows.length === 0) {
            return res.status(404).json({ error: "Aún no se ha generado ningún reporte semanal en el sistema." });
        }
        const row = result.rows[0];
        res.json({
            reporte: JSON.parse(row.reporte_json),
            fecha: row.fecha,
            updated_at: row.updated_at
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// APLICAR ASCENSOS GLOBAL (NO DUPLICA BONOS EN TESORERÍA, SUMA TOTALES EN FORMACIONES Y TRANSFIERE A COORDINACIÓN/JEFATURAS)
app.post('/api/ascensos/aplicar-todos-global', async (req, res) => {
    try {
        const [todosRes, coordRes, controlRes] = await Promise.all([
            db.execute("SELECT * FROM registro_ascensos WHERE jefatura IN ('enfermeria', 'cirugia', 'medicina')"),
            db.execute("SELECT * FROM registro_coordinacion"),
            db.execute("SELECT * FROM control_tablas_listas")
        ]);

        const todos = todosRes.rows || [];
        const listaCoord = coordRes.rows || [];
        const controles = controlRes.rows || [];

        const hoy = new Date().toISOString().split('T')[0];

        // Leer los EMS de la semana elegidos manualmente por cada Jefatura
        const emsManual = { enfermeria: null, medicina: null, cirugia: null };
        for (const c of controles) {
            if (['enfermeria', 'medicina', 'cirugia'].includes(c.jefatura) && c.ems_semana_nombre && c.ems_semana_nombre.trim() !== '') {
                emsManual[c.jefatura] = {
                    nombre: c.ems_semana_nombre,
                    discord_id: c.ems_semana_discord || 'N/A',
                    horas: c.ems_semana_horas || 'Destacado',
                    rango: 'EMS de la Semana'
                };
            }
        }

        const reporte = {
            fecha: hoy,
            expulsados: [],
            descensos: [],
            ascensosOperativa: {
                "Auxiliar de Enfermería": [],
                "Enfermero": [],
                "Enfermero/a General": [],
                "Enfermero/a Especialista": []
            },
            ascensosMedica: {
                "Estudiante": [],
                "Estudiante (En Espera)": [],
                "Interno/a": [],
                "Residente": [],
                "Subespecialista": [],
                "Especialista": []
            },
            ascensosEspeciales: [],
            emsSemana: emsManual,
            bonos50k: [],
            bonos100k: []
        };

        const activosParaProcesar = [];

        for (const item of todos) {
            const h = parsearHorasServer(item.horas_semana);

            // 1. Si tiene DESPIDO, archivarlo en historial_despidos
            if (item.faltas === 'DESPIDO') {
                reporte.expulsados.push({
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    rango_anterior: item.rango_actual,
                    jefatura: item.jefatura
                });

                await db.execute({
                    sql: `INSERT INTO historial_despidos (discord_id, nombre, rango_anterior, jefatura, fecha_despido, motivo, registrado_por)
                          VALUES (?, ?, ?, ?, ?, ?, 'Cierre Semanal')`,
                    args: [
                        item.discord_id || 'N/A',
                        item.nombre,
                        item.rango_actual,
                        item.jefatura,
                        hoy,
                        item.descripcion && item.descripcion.trim() !== '' ? item.descripcion.trim() : 'Expulsión en Cierre Semanal'
                    ]
                });
                continue;
            }

            activosParaProcesar.push(item);

            // Solo recopilamos quién hizo 25+ y 50+ horas para el texto de Discord y el PDF (NO se insertan en Tesorería aquí)
            if (h >= 50) {
                reporte.bonos100k.push({ nombre: item.nombre, discord_id: item.discord_id, horas: item.horas_semana, rango: item.rango_actual, monto: 100000 });
            } else if (h >= 25) {
                reporte.bonos50k.push({ nombre: item.nombre, discord_id: item.discord_id, horas: item.horas_semana, rango: item.rango_actual, monto: 50000 });
            }
        }

        // Eliminar expulsados de las tablas médicas
        await db.execute("DELETE FROM registro_ascensos WHERE faltas = 'DESPIDO' AND jefatura IN ('enfermeria', 'cirugia', 'medicina')");

        let aplicados = 0;

        // 2. Procesar ascensos en Enfermería, Cirugía y Medicina
        for (const item of activosParaProcesar) {
            let postular = (item.rango_postular || item.rango_actual || '').trim();
            let nuevaJefatura = item.jefatura;
            let nuevoRangoActual = postular;
            let nuevoExamen = item.examen;

            // CASO A: Ascenso desde Medicina/Cirugía hacia JEFATURA -> Se borra de la tabla médica, se actualizan permisos en usuarios y va a Ascensos Especiales
            const esAscensoAJefatura = CARGOS_JEFATURA_LISTA.some(cargo => postular.toLowerCase() === cargo.toLowerCase());
            if (esAscensoAJefatura) {
                await sincronizarRangoYPermisosUsuario(item.nombre, item.discord_id, postular);
                await db.execute({ sql: "DELETE FROM registro_ascensos WHERE id = ?", args: [item.id] });

                reporte.ascensosEspeciales.push({
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    rango_anterior: item.rango_actual,
                    rango_nuevo: postular
                });
                aplicados++;
                continue;
            }

            // CASO B: Ascenso desde Medicina/Cirugía hacia SUPERVISOR o COORDINADOR -> Se borra de la tabla médica y se mueve a Coordinación
            if (postular === 'Supervisor' || postular === 'Coordinador' || postular.includes('Supervisor') || postular.includes('Coordinador')) {
                const rangoCoordFinal = postular.includes('Coordinador') ? 'Coordinador' : 'Supervisor';

                const existeEnCoord = await db.execute({
                    sql: "SELECT id FROM registro_coordinacion WHERE LOWER(TRIM(supervisor)) = LOWER(TRIM(?))",
                    args: [item.nombre]
                });

                if (existeEnCoord.rows && existeEnCoord.rows.length > 0) {
                    await db.execute({
                        sql: "UPDATE registro_coordinacion SET rango = ?, rango_postular = ?, discord_id = ?, horas_semana = '00:00 HRS' WHERE id = ?",
                        args: [rangoCoordFinal, rangoCoordFinal, item.discord_id || 'N/A', existeEnCoord.rows[0].id]
                    });
                } else {
                    await db.execute({
                        sql: `INSERT INTO registro_coordinacion (discord_id, supervisor, rango, rango_postular, horas_semana, estado, desempeno, actualizado_por)
                              VALUES (?, ?, ?, ?, '00:00 HRS', 'Activo', 'Excelente', 'Ascenso Cierre Semanal')`,
                        args: [item.discord_id || 'N/A', item.nombre, rangoCoordFinal, rangoCoordFinal]
                    });
                }

                await sincronizarRangoYPermisosUsuario(item.nombre, item.discord_id, rangoCoordFinal);
                await db.execute({ sql: "DELETE FROM registro_ascensos WHERE id = ?", args: [item.id] });

                reporte.ascensosEspeciales.push({
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    rango_anterior: item.rango_actual,
                    rango_nuevo: rangoCoordFinal
                });
                aplicados++;
                continue;
            }

            // CASO C: Ascensos médicos y operativos regulares
            const veniaDeEnfermeria = item.jefatura === 'enfermeria';

            if (postular.includes('(Cirugía)')) {
                nuevaJefatura = 'cirugia';
                nuevoRangoActual = postular.replace(' (Cirugía)', '').replace(' (Doble)', '').trim();
                nuevoExamen = 'NO APLICA';
            } else if (postular.includes('(Medicina)')) {
                nuevaJefatura = 'medicina';
                nuevoRangoActual = postular.replace(' (Medicina)', '').replace(' (Doble)', '').trim();
                nuevoExamen = 'NO APLICA';
            } else if (postular.includes('(Bajar)')) {
                nuevaJefatura = 'enfermeria';
                nuevoRangoActual = postular.replace(' (Bajar)', '').trim();
            } else if (postular.includes('(En Espera)')) {
                nuevaJefatura = 'enfermeria';
                nuevoRangoActual = postular.replace(' (En Espera)', '').trim();
                nuevoExamen = 'PENDIENTE';
            }

            const pesoAnt = JERARQUIA_SERVER[item.rango_actual] || 0;
            const pesoNuevo = JERARQUIA_SERVER[nuevoRangoActual] || 0;

            if (pesoNuevo < pesoAnt || postular.includes('(Bajar)')) {
                reporte.descensos.push({
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    rango_anterior: item.rango_actual,
                    rango_nuevo: nuevoRangoActual
                });
            } else if (pesoNuevo > pesoAnt || (veniaDeEnfermeria && nuevaJefatura !== 'enfermeria')) {
                const infoPersona = {
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    rango_anterior: item.rango_actual,
                    rango_nuevo: nuevoRangoActual,
                    jefatura_nueva: nuevaJefatura
                };

                // Separar en la plantilla quién subió a Estudiante en Espera vs Estudiante ya asignado a rama
                if (nuevoRangoActual === 'Estudiante' && nuevaJefatura === 'enfermeria') {
                    reporte.ascensosMedica["Estudiante (En Espera)"].push(infoPersona);
                } else if (reporte.ascensosOperativa[nuevoRangoActual] !== undefined) {
                    reporte.ascensosOperativa[nuevoRangoActual].push(infoPersona);
                } else if (reporte.ascensosMedica[nuevoRangoActual] !== undefined) {
                    reporte.ascensosMedica[nuevoRangoActual].push(infoPersona);
                } else {
                    reporte.ascensosEspeciales.push(infoPersona);
                }
            }

            await db.execute({
                sql: `UPDATE registro_ascensos SET 
                        rango_actual = ?, rango_postular = ?, rango_propuesto = ?, jefatura = ?, examen = ?, horas_semana = '00:00 HRS'
                      WHERE id = ?`,
                args: [nuevoRangoActual, nuevoRangoActual, nuevoRangoActual, nuevaJefatura, nuevoExamen, item.id]
            });
            aplicados++;
        }

        // 3. Procesar ascensos dentro de Coordinación (Supervisores -> Coordinador o Jefaturas) y limpiar PDFs/Horas
        for (const c of listaCoord) {
            const rActual = (c.rango || 'Supervisor').trim();
            const rPostular = (c.rango_postular || rActual).trim();

            if (rPostular !== rActual) {
                reporte.ascensosEspeciales.push({
                    nombre: c.supervisor,
                    discord_id: c.discord_id,
                    rango_anterior: rActual,
                    rango_nuevo: rPostular
                });

                await sincronizarRangoYPermisosUsuario(c.supervisor, c.discord_id, rPostular);

                // Si desde Coordinación asciende a una Jefatura de departamento, se retira de Coordinación porque ya pasa a ser Jefatura
                const subeAJefaturaDepto = CARGOS_JEFATURA_LISTA.some(cargo => rPostular.toLowerCase() === cargo.toLowerCase());
                if (subeAJefaturaDepto) {
                    await db.execute({ sql: "DELETE FROM registro_coordinacion WHERE id = ?", args: [c.id] });
                    continue;
                }
            }

            await db.execute({
                sql: `UPDATE registro_coordinacion SET 
                        rango = ?, rango_postular = ?, horas_semana = '00:00 HRS', 
                        pdf_feedback = '', nombre_pdf = '', feedback_semanal = ''
                      WHERE id = ?`,
                args: [rPostular, rPostular, c.id]
            });
        }

        // 4. Sumar instrucciones_hechas a instrucciones_totales en Formaciones y reiniciar semanales y total_pago a 0 (SIN mandar pagos duplicados a Tesorería)
        await db.execute(`
            UPDATE registro_formaciones 
            SET instrucciones_totales = COALESCE(instrucciones_totales, 0) + COALESCE(instrucciones_hechas, 0),
                instrucciones_hechas = 0,
                total_pago = 0
        `);

        // 5. Reiniciar horas semanales de las cuentas institucionales y desmarcar tablas listas
        await db.execute("UPDATE usuarios SET horas_semana = '00:00 HRS'");
        await db.execute("UPDATE control_tablas_listas SET esta_lista = 0, fecha_hora_mexico = '', marcado_por = '', ems_semana_nombre = '', ems_semana_discord = '', ems_semana_horas = ''");

        // 6. Guardar el reporte en la base de datos
        await db.execute({
            sql: `INSERT OR REPLACE INTO historial_reportes (id, reporte_json, fecha, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)`,
            args: [JSON.stringify(reporte), hoy]
        });

        notificar('ascensos_actualizados');
        notificar('coordinacion_actualizada');
        notificar('formaciones_actualizadas');
        notificar('tablas_listas_actualizadas');
        notificar('despidos_actualizados');

        res.json({ 
            message: `Cierre completado: ${aplicados} efectivos evaluados, instrucciones sumadas al histórico total, despidos archivados y PDFs de Coordinación limpiados (sin duplicar bonos en Tesorería).`,
            reporte
        });
    } catch (e) {
        console.error("Error en aplicar-todos-global:", e);
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ascensos/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM registro_ascensos WHERE id = ?", args: [req.params.id] });
        notificar('ascensos_actualizados');
        res.json({ message: "Registro eliminado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// CONTROL DE TABLAS LISTAS (Único lugar donde se envían automáticamente bonos de 25h/50h y pagos de Formadores a Tesorería)
app.get('/api/control-tablas', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM control_tablas_listas");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/control-tablas/toggle', async (req, res) => {
    const { jefatura, marcado_por } = req.body;
    if (!jefatura) return res.status(400).json({ error: "Jefatura requerida." });

    try {
        const current = await db.execute({
            sql: "SELECT * FROM control_tablas_listas WHERE jefatura = ?",
            args: [jefatura]
        });

        const filaActual = current.rows && current.rows.length > 0 ? current.rows[0] : null;
        const yaEstaLista = filaActual && filaActual.esta_lista === 1;
        const nuevoEstado = yaEstaLista ? 0 : 1;

        const ahoraMex = new Intl.DateTimeFormat('es-MX', {
            timeZone: 'America/Mexico_City',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).format(new Date());

        const fechaHoraFinal = nuevoEstado === 1 ? ahoraMex : '';
        const userFinal = nuevoEstado === 1 ? (marcado_por || 'Jefatura') : '';
        const hoy = new Date().toISOString().split('T')[0];

        await db.execute({
            sql: `INSERT OR REPLACE INTO control_tablas_listas 
                  (jefatura, esta_lista, fecha_hora_mexico, marcado_por, ems_semana_nombre, ems_semana_discord, ems_semana_horas) 
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
                jefatura,
                nuevoEstado,
                fechaHoraFinal,
                userFinal,
                filaActual ? (filaActual.ems_semana_nombre || '') : '',
                filaActual ? (filaActual.ems_semana_discord || '') : '',
                filaActual ? (filaActual.ems_semana_horas || '') : ''
            ]
        });

        let bonosEnviados = 0;

        // Cuando la Jefatura marca su tabla como LISTA (1), se envían los bonos a Tesorería
        if (nuevoEstado === 1) {
            if (['cirugia', 'medicina', 'enfermeria'].includes(jefatura)) {
                const personalRes = await db.execute({
                    sql: "SELECT * FROM registro_ascensos WHERE jefatura = ? AND faltas != 'DESPIDO'",
                    args: [jefatura]
                });
                for (const p of (personalRes.rows || [])) {
                    const h = parsearHorasServer(p.horas_semana);
                    if (h >= 50) {
                        await registrarPagoSinDuplicar(p.nombre, p.rango_actual, `Bono por Horas (${p.horas_semana})`, 100000, hoy, userFinal);
                        bonosEnviados++;
                    } else if (h >= 25) {
                        await registrarPagoSinDuplicar(p.nombre, p.rango_actual, `Bono por Horas (${p.horas_semana})`, 50000, hoy, userFinal);
                        bonosEnviados++;
                    }
                }
            } else if (jefatura === 'formaciones') {
                const formRes = await db.execute("SELECT * FROM registro_formaciones");
                for (const f of (formRes.rows || [])) {
                    const instSemanal = Number(f.instrucciones_hechas || 0);
                    const monto = Number(f.total_pago || (instSemanal * 50000));
                    if (instSemanal > 0 && monto > 0) {
                        await registrarPagoSinDuplicar(
                            f.instructor,
                            f.rango || 'Formador',
                            `Pago de Instrucciones Semanales (${instSemanal} inst.)`,
                            monto,
                            hoy,
                            userFinal
                        );
                        bonosEnviados++;
                    }
                }
                // Sumar instrucciones_hechas a instrucciones_totales y dejar semanales y total_pago en 0
                await db.execute(`
                    UPDATE registro_formaciones 
                    SET instrucciones_totales = COALESCE(instrucciones_totales, 0) + COALESCE(instrucciones_hechas, 0),
                        instrucciones_hechas = 0,
                        total_pago = 0
                `);
                notificar('formaciones_actualizadas');
            }
            if (bonosEnviados > 0) notificar('pagos_actualizados');
        }

        notificar('tablas_listas_actualizadas');
        res.json({ 
            esta_lista: nuevoEstado, 
            fecha_hora_mexico: fechaHoraFinal, 
            marcado_por: userFinal,
            bonos_enviados: bonosEnviados,
            message: nuevoEstado === 1 
                ? `Tabla marcada como LISTA. Se enviaron ${bonosEnviados} pagos/bonos automáticamente a Tesorería.` 
                : "Tabla marcada En Revisión."
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SELECCIÓN MANUAL DEL EMS DE LA SEMANA POR JEFATURA (Envía Bono de $200,000 a Tesorería)
app.post('/api/control-tablas/ems-semana', async (req, res) => {
    const { jefatura, nombre, discord_id, rango, horas_semana, registrado_por } = req.body;
    if (!jefatura || !nombre) {
        return res.status(400).json({ error: "Selecciona un miembro válido para EMS de la Semana." });
    }

    const hoy = new Date().toISOString().split('T')[0];
    const etiquetaDepto = jefatura === 'cirugia' ? 'Cirugía' : (jefatura === 'medicina' ? 'Medicina' : 'Enfermería');

    try {
        await db.execute({
            sql: `UPDATE control_tablas_listas SET 
                    ems_semana_nombre = ?, 
                    ems_semana_discord = ?, 
                    ems_semana_horas = ?
                  WHERE jefatura = ?`,
            args: [nombre.trim(), discord_id || 'N/A', horas_semana || 'Destacado', jefatura]
        });

        await registrarPagoSinDuplicar(
            nombre.trim(),
            rango || 'Personal EMS',
            `🌟 Bono EMS de la Semana (${etiquetaDepto})`,
            200000,
            hoy,
            registrado_por || 'Jefatura'
        );

        notificar('tablas_listas_actualizadas');
        notificar('pagos_actualizados');

        res.json({ message: `🌟 ${nombre} fue designado como EMS de la Semana en ${etiquetaDepto} y se envió su bono de $200,000 a Tesorería.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. FORMACIONES & LIMBO DE ASPIRANTES PENDIENTES DE INSTRUCCIÓN IC
app.get('/api/formaciones', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM registro_formaciones ORDER BY id DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/formaciones', async (req, res) => {
    const { instructor, rango, actualizado_por } = req.body;
    if (!instructor) return res.status(400).json({ error: "Ingresa el nombre del instructor." });

    try {
        await db.execute({
            sql: `INSERT INTO registro_formaciones (instructor, rango, instrucciones_hechas, instrucciones_totales, total_pago, notas, actualizado_por)
                  VALUES (?, ?, 0, 0, 0, '', ?)`,
            args: [instructor.trim(), rango || 'Formador', actualizado_por || 'Jefe de Formaciones']
        });
        notificar('formaciones_actualizadas');
        res.json({ message: "Instructor registrado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/formaciones/:id', async (req, res) => {
    const { instrucciones_hechas, instrucciones_totales, notas, rango } = req.body;

    try {
        let cantSemanal = null;
        let cantTotales = null;
        let totalPago = null;

        // Al editar instrucciones_hechas solo actualizamos las semanales y el total_pago; la suma al histórico total ocurre al cerrar/marcar lista la tabla
        if (instrucciones_hechas !== undefined) {
            cantSemanal = Math.max(0, parseFloat(instrucciones_hechas) || 0);
            totalPago = cantSemanal * 50000;
        }

        if (instrucciones_totales !== undefined) {
            cantTotales = Math.max(0, parseFloat(instrucciones_totales) || 0);
        }

        await db.execute({
            sql: `UPDATE registro_formaciones SET 
                    instrucciones_hechas = COALESCE(?, instrucciones_hechas),
                    instrucciones_totales = COALESCE(?, instrucciones_totales),
                    total_pago = COALESCE(?, total_pago),
                    notas = COALESCE(?, notas),
                    rango = COALESCE(?, rango)
                  WHERE id = ?`,
            args: [cantSemanal, cantTotales, totalPago, notas !== undefined ? notas.trim() : null, rango || null, req.params.id]
        });
        notificar('formaciones_actualizadas');
        res.json({ message: "Formación actualizada." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/formaciones/corte-semanal', async (req, res) => {
    const { registrado_por } = req.body || {};
    const hoy = new Date().toISOString().split('T')[0];
    try {
        const formRes = await db.execute("SELECT * FROM registro_formaciones");
        let enviados = 0;
        for (const f of (formRes.rows || [])) {
            const instSemanal = Number(f.instrucciones_hechas || 0);
            const monto = Number(f.total_pago || (instSemanal * 50000));
            if (instSemanal > 0 && monto > 0) {
                await registrarPagoSinDuplicar(
                    f.instructor,
                    f.rango || 'Formador',
                    `Pago de Instrucciones Semanales (${instSemanal} inst.)`,
                    monto,
                    hoy,
                    registrado_por || 'Jefe de Formaciones'
                );
                enviados++;
            }
        }
        // Sumar las instrucciones semanales a las instrucciones totales y dejar semanales y total_pago en 0
        await db.execute(`
            UPDATE registro_formaciones 
            SET instrucciones_totales = COALESCE(instrucciones_totales, 0) + COALESCE(instrucciones_hechas, 0),
                instrucciones_hechas = 0, 
                total_pago = 0
        `);
        notificar('formaciones_actualizadas');
        if (enviados > 0) notificar('pagos_actualizados');
        res.json({ message: `Corte semanal procesado: instrucciones sumadas al histórico total, ${enviados} pagos enviados a Tesorería y semanales en 0.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/formaciones/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM registro_formaciones WHERE id = ?", args: [req.params.id] });
        notificar('formaciones_actualizadas');
        res.json({ message: "Registro eliminado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// RUTAS DEL LIMBO DE ASPIRANTES EN FORMACIONES (PENDIENTES IC)
app.get('/api/formaciones/limbo', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM aspirantes_limbo ORDER BY id DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/formaciones/limbo', async (req, res) => {
    const { discord_id, nombre, fecha_ingreso, notas, registrado_por } = req.body;
    if (!nombre) return res.status(400).json({ error: "Ingresa el nombre del aspirante." });

    const discordLimpio = (discord_id || '').replace(/[^0-9]/g, '') || 'N/A';
    const fechaHoy = fecha_ingreso || new Date().toISOString().split('T')[0];

    try {
        await db.execute({
            sql: "INSERT INTO aspirantes_limbo (discord_id, nombre, fecha_ingreso, notas, registrado_por) VALUES (?, ?, ?, ?, ?)",
            args: [discordLimpio, nombre.trim(), fechaHoy, notas || 'Pendiente de Instrucción IC', registrado_por || 'Formaciones']
        });
        notificar('limbo_actualizado');
        res.json({ message: "Aspirante registrado en el Limbo de Formaciones (Pendiente IC)." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/formaciones/limbo/:id', async (req, res) => {
    const { discord_id, nombre, fecha_ingreso, notas } = req.body;
    let discordLimpio = discord_id !== undefined && discord_id !== null ? String(discord_id).replace(/[^0-9]/g, '') || 'N/A' : null;
    try {
        await db.execute({
            sql: `UPDATE aspirantes_limbo SET 
                    discord_id = COALESCE(?, discord_id),
                    nombre = COALESCE(?, nombre),
                    fecha_ingreso = COALESCE(?, fecha_ingreso),
                    notas = COALESCE(?, notas)
                  WHERE id = ?`,
            args: [discordLimpio, nombre ? nombre.trim() : null, fecha_ingreso || null, notas !== undefined ? notas.trim() : null, req.params.id]
        });
        notificar('limbo_actualizado');
        res.json({ message: "Aspirante en limbo actualizado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/formaciones/limbo/:id/aprobar', async (req, res) => {
    const { aprobado_por } = req.body;
    try {
        const check = await db.execute({ sql: "SELECT * FROM aspirantes_limbo WHERE id = ?", args: [req.params.id] });
        if (!check.rows || check.rows.length === 0) {
            return res.status(404).json({ error: "Aspirante no encontrado en el limbo." });
        }
        const asp = check.rows[0];
        const hoy = new Date().toISOString().split('T')[0];

        await db.execute({
            sql: `INSERT INTO registro_ascensos (
                    jefatura, discord_id, nombre_ems, nombre, rango_actual, rango_postular, rango_propuesto,
                    faltas, horas_semana, examen, estado, descripcion, fecha_ingreso, actualizado_por
                  ) VALUES ('enfermeria', ?, ?, ?, 'Celador/a', 'Celador/a', 'Celador/a', 'NINGUNA', '', 'NO APLICA', 'Activo', 'PRUEBA_ACTIVA', ?, ?)`,
            args: [asp.discord_id || 'N/A', asp.nombre, asp.nombre, asp.fecha_ingreso || hoy, aprobado_por || asp.registrado_por || 'Formaciones']
        });

        await sumarInstruccionFormador(aprobado_por || asp.registrado_por);

        await db.execute({ sql: "DELETE FROM aspirantes_limbo WHERE id = ?", args: [req.params.id] });

        notificar('limbo_actualizado');
        notificar('formaciones_actualizadas');
        notificar('ascensos_actualizados');

        res.json({ message: `${asp.nombre} completó su instrucción IC y fue enviado a Enfermería Básica.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/formaciones/limbo/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM aspirantes_limbo WHERE id = ?", args: [req.params.id] });
        notificar('limbo_actualizado');
        res.json({ message: "Aspirante retirado del limbo." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. COORDINACIÓN (Ordenado con Coordinador arriba + Rango a Postular + Desempeño + PDF ligero)
app.get('/api/coordinacion', async (req, res) => {
    try {
        const sql = `SELECT id, discord_id, supervisor, rango, COALESCE(rango_postular, rango) as rango_postular, 
                            horas_semana, estado, COALESCE(desempeno, 'Excelente') as desempeno, 
                            feedback_semanal, nombre_pdf, 
                            CASE WHEN pdf_feedback IS NOT NULL AND pdf_feedback != '' THEN 1 ELSE 0 END as tiene_pdf,
                            actualizado_por, updated_at 
                     FROM registro_coordinacion 
                     ORDER BY CASE WHEN rango = 'Coordinador' THEN 0 ELSE 1 END ASC, id ASC`;
        const result = await db.execute(sql);
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.get('/api/coordinacion/:id/pdf', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT pdf_feedback, nombre_pdf, supervisor FROM registro_coordinacion WHERE id = ?",
            args: [req.params.id]
        });
        if (!result.rows || result.rows.length === 0 || !result.rows[0].pdf_feedback) {
            return res.status(404).json({ error: "Este supervisor no tiene un reporte PDF adjunto." });
        }
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/coordinacion', async (req, res) => {
    const { discord_id, supervisor, rango, rango_postular, horas_semana, estado, desempeno, actualizado_por } = req.body;
    if (!supervisor) return res.status(400).json({ error: "Ingresa el nombre del supervisor." });

    const discordLimpio = (discord_id || '').replace(/[^0-9]/g, '') || 'N/A';
    const rangoBase = rango || 'Supervisor';

    try {
        await db.execute({
            sql: `INSERT INTO registro_coordinacion (discord_id, supervisor, rango, rango_postular, horas_semana, estado, desempeno, actualizado_por)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                discordLimpio, supervisor.trim(), rangoBase, rango_postular || rangoBase, horas_semana || '',
                estado || 'Activo', desempeno || 'Excelente', actualizado_por || 'Coordinación'
            ]
        });
        notificar('coordinacion_actualizada');
        res.json({ message: "Personal registrado en Coordinación." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/coordinacion/:id', async (req, res) => {
    const { estado, desempeno, feedback_semanal, rango, rango_actual, rango_postular, horas_semana, discord_id, supervisor, pdf_feedback, nombre_pdf } = req.body;
    const rangoFinal = rango || rango_actual || null;
    let discordLimpio = discord_id !== undefined && discord_id !== null ? String(discord_id).replace(/[^0-9]/g, '') : null;

    try {
        await db.execute({
            sql: `UPDATE registro_coordinacion SET 
                    estado = COALESCE(?, estado),
                    desempeno = COALESCE(?, desempeno),
                    feedback_semanal = COALESCE(?, feedback_semanal),
                    rango = COALESCE(?, rango),
                    rango_postular = COALESCE(?, rango_postular),
                    horas_semana = COALESCE(?, horas_semana),
                    discord_id = COALESCE(?, discord_id),
                    supervisor = COALESCE(?, supervisor),
                    pdf_feedback = COALESCE(?, pdf_feedback),
                    nombre_pdf = COALESCE(?, nombre_pdf)
                  WHERE id = ?`,
            args: [
                estado || null, desempeno || null, feedback_semanal !== undefined ? feedback_semanal.trim() : null, rangoFinal,
                rango_postular || null, horas_semana !== undefined ? horas_semana.trim() : null, discordLimpio, supervisor || null,
                pdf_feedback !== undefined ? pdf_feedback : null, nombre_pdf !== undefined ? nombre_pdf : null, req.params.id
            ]
        });

        if (rangoFinal) {
            const rowCheck = await db.execute({ sql: "SELECT supervisor, discord_id FROM registro_coordinacion WHERE id = ?", args: [req.params.id] });
            if (rowCheck.rows && rowCheck.rows.length > 0) {
                const sup = rowCheck.rows[0];
                await sincronizarRangoYPermisosUsuario(sup.supervisor, sup.discord_id, rangoFinal);
            }
        }

        notificar('coordinacion_actualizada');
        res.json({ message: "Coordinación actualizada." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/coordinacion/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM registro_coordinacion WHERE id = ?", args: [req.params.id] });
        notificar('coordinacion_actualizada');
        res.json({ message: "Registro retirado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. TESORERÍA / PAGOS
app.get('/api/pagos', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM registro_pagos ORDER BY id DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/pagos', async (req, res) => {
    const { personal, rango, concepto, cantidad, estado, pagado_por, fecha_pago, registrado_por } = req.body;
    if (!personal || !concepto) {
        return res.status(400).json({ error: "Ingresa el personal y concepto." });
    }

    const monto = Math.max(0, parseFloat(cantidad) || 0);
    const hoy = fecha_pago || new Date().toISOString().split('T')[0];

    try {
        await db.execute({
            sql: `INSERT INTO registro_pagos (personal, rango, concepto, cantidad, estado, pagado_por, fecha_pago, registrado_por)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                personal.trim(), rango || 'Personal EMS', concepto.trim(), monto, estado || 'Pendiente',
                pagado_por || (estado === 'Pagado' ? (registrado_por || 'Dirección') : 'Pendiente'), hoy, registrado_por || 'Dirección'
            ]
        });
        notificar('pagos_actualizados');
        res.json({ message: "Pago registrado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/pagos/:id', async (req, res) => {
    const { personal, rango, concepto, cantidad, estado, pagado_por, fecha_pago } = req.body;
    try {
        await db.execute({
            sql: `UPDATE registro_pagos SET 
                    personal = COALESCE(?, personal), rango = COALESCE(?, rango), concepto = COALESCE(?, concepto),
                    cantidad = COALESCE(?, cantidad), estado = COALESCE(?, estado), pagado_por = COALESCE(?, pagado_por),
                    fecha_pago = COALESCE(?, fecha_pago)
                  WHERE id = ?`,
            args: [
                personal ? personal.trim() : null, rango || null, concepto ? concepto.trim() : null,
                cantidad !== undefined ? Math.max(0, parseFloat(cantidad) || 0) : null, estado || null,
                pagado_por || null, fecha_pago || null, req.params.id
            ]
        });
        notificar('pagos_actualizados');
        res.json({ message: "Pago modificado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/pagos/corte-semanal', async (req, res) => {
    try {
        await db.execute("UPDATE registro_pagos SET estado = 'Pagado', pagado_por = 'Corte Semanal' WHERE estado = 'Pendiente'");
        notificar('pagos_actualizados');
        res.json({ message: "Corte semanal de tesorería completado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/pagos/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM registro_pagos WHERE id = ?", args: [req.params.id] });
        notificar('pagos_actualizados');
        res.json({ message: "Registro eliminado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. HISTORIAL DE DESPIDOS (REGISTRO Y CONSULTA DE BAJAS)
app.get('/api/despidos', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM historial_despidos ORDER BY id DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/despidos', async (req, res) => {
    const { discord_id, nombre, rango_anterior, jefatura, fecha_despido, motivo, registrado_por } = req.body;
    if (!nombre) return res.status(400).json({ error: "Ingresa el nombre de la persona despedida." });

    const discordLimpio = (discord_id || '').replace(/[^0-9]/g, '') || 'N/A';
    const hoy = fecha_despido || new Date().toISOString().split('T')[0];

    try {
        await db.execute({
            sql: `INSERT INTO historial_despidos (discord_id, nombre, rango_anterior, jefatura, fecha_despido, motivo, registrado_por)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [discordLimpio, nombre.trim(), rango_anterior || 'Personal EMS', jefatura || 'General', hoy, motivo || 'Baja administrativa', registrado_por || 'Dirección']
        });
        notificar('despidos_actualizados');
        res.json({ message: "Despido archivado en el historial." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/despidos/:id', async (req, res) => {
    const { discord_id, nombre, rango_anterior, jefatura, fecha_despido, motivo } = req.body;
    let discordLimpio = discord_id !== undefined && discord_id !== null ? String(discord_id).replace(/[^0-9]/g, '') || 'N/A' : null;
    try {
        await db.execute({
            sql: `UPDATE historial_despidos SET 
                    discord_id = COALESCE(?, discord_id),
                    nombre = COALESCE(?, nombre),
                    rango_anterior = COALESCE(?, rango_anterior),
                    jefatura = COALESCE(?, jefatura),
                    fecha_despido = COALESCE(?, fecha_despido),
                    motivo = COALESCE(?, motivo)
                  WHERE id = ?`,
            args: [discordLimpio, nombre ? nombre.trim() : null, rango_anterior || null, jefatura || null, fecha_despido || null, motivo !== undefined ? motivo.trim() : null, req.params.id]
        });
        notificar('despidos_actualizados');
        res.json({ message: "Registro de despido actualizado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/despidos/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM historial_despidos WHERE id = ?", args: [req.params.id] });
        notificar('despidos_actualizados');
        res.json({ message: "Registro eliminado del historial de despidos." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor EMS online en puerto ${PORT}`));