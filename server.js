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

// Dividir texto largo para no exceder el límite de 2000 caracteres de Discord
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
    "Especialista": 10
};

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

        const hoy = new Date().toISOString().split('T')[0];

        const result = await db.execute({
            sql: "INSERT INTO usuarios (nombre, usuario, password, discord_id, rango, rol, fecha_ingreso) VALUES (?, ?, ?, ?, ?, ?, ?)",
            args: [nombre.trim(), userClean, String(password), discordLimpio || 'N/A', rangoAsignado, rolAsignado, hoy]
        });

        notificar('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre: nombre.trim(), usuario: userClean, rango: rangoAsignado, rol: rolAsignado });
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
        const sql = `SELECT id, nombre, usuario, discord_id, COALESCE(rango, 'Sin Rango (Pendiente)') as rango, COALESCE(rol, 'empleado') as rol FROM usuarios WHERE LOWER(TRIM(usuario)) = ? AND password = ?`;
        const result = await db.execute({ sql, args: [userClean, String(password)] });
        
        if (!result.rows || result.rows.length === 0) {
            return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        }

        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: "Error de autenticación." });
    }
});

// 2. PANEL ADMIN & WEBHOOK CONFIG
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, discord_id, nombre, usuario, COALESCE(rango, 'Sin Rango (Pendiente)') as rango, COALESCE(rol, 'empleado') as rol, fecha_ingreso, horas_semana FROM usuarios ORDER BY id ASC");
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { rango, rol, discord_id, horas_semana, fecha_ingreso, nombre, password } = req.body;
    let discordLimpio = discord_id !== undefined && discord_id !== null ? String(discord_id).replace(/[^0-9]/g, '') : null;

    try {
        await db.execute({
            sql: `UPDATE usuarios SET 
                    rango = COALESCE(?, rango), 
                    rol = COALESCE(?, rol),
                    discord_id = COALESCE(?, discord_id),
                    horas_semana = COALESCE(?, horas_semana),
                    fecha_ingreso = COALESCE(?, fecha_ingreso),
                    nombre = COALESCE(?, nombre),
                    password = COALESCE(?, password)
                  WHERE id = ?`,
            args: [rango || null, rol || null, discordLimpio, horas_semana || null, fecha_ingreso || null, nombre ? nombre.trim() : null, password ? String(password) : null, req.params.id]
        });
        notificar('usuario_modificado', { usuario_id: Number(req.params.id), rango, rol });
        res.json({ message: "Actualizado con éxito." });
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
            const formadorClean = actualizado_por.trim();
            const formadorCheck = await db.execute({
                sql: "SELECT id, instrucciones_hechas, instrucciones_totales FROM registro_formaciones WHERE LOWER(TRIM(instructor)) = LOWER(?)",
                args: [formadorClean]
            });

            if (formadorCheck.rows && formadorCheck.rows.length > 0) {
                const fId = formadorCheck.rows[0].id;
                const nuevas = Number(formadorCheck.rows[0].instrucciones_hechas || 0) + 1;
                const nuevasTotales = Number(formadorCheck.rows[0].instrucciones_totales || 0) + 1;
                await db.execute({
                    sql: "UPDATE registro_formaciones SET instrucciones_hechas = ?, instrucciones_totales = ?, total_pago = ? WHERE id = ?",
                    args: [nuevas, nuevasTotales, nuevas * 50000, fId]
                });
            } else {
                await db.execute({
                    sql: "INSERT INTO registro_formaciones (instructor, rango, instrucciones_hechas, instrucciones_totales, total_pago, notas, actualizado_por) VALUES (?, 'Formador', 1, 1, 50000, 'Ingreso de aspirante', ?)",
                    args: [formadorClean, formadorClean]
                });
            }
            notificar('formaciones_actualizadas');
        }

        notificar('ascensos_actualizados', { jefatura });
        res.json({ message: "Personal ingresado con éxito." });
    } catch (e) {
        console.error("Error Ascensos POST:", e);
        res.status(500).json({ error: e.message });
    }
});

// ACTUALIZACIÓN EN TIEMPO REAL (Con transferencia inmediata al aprobar examen)
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

// APLICAR ASCENSOS GLOBAL + GUARDAR REPORTE SEMANAL + BONOS TESORERÍA
app.post('/api/ascensos/aplicar-todos-global', async (req, res) => {
    try {
        const todosRes = await db.execute("SELECT * FROM registro_ascensos WHERE jefatura IN ('enfermeria', 'cirugia', 'medicina')");
        const todos = todosRes.rows || [];

        const hoy = new Date().toISOString().split('T')[0];

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
                "Interno/a": [],
                "Residente": [],
                "Subespecialista": [],
                "Especialista": []
            },
            emsSemana: {
                enfermeria: null,
                medicina: null,
                cirugia: null
            },
            bonos50k: [],
            bonos100k: []
        };

        let maxHoras = { enfermeria: -1, medicina: -1, cirugia: -1 };
        const activosParaProcesar = [];

        for (const item of todos) {
            const h = parsearHorasServer(item.horas_semana);

            if (item.faltas === 'DESPIDO') {
                reporte.expulsados.push({
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    rango_anterior: item.rango_actual,
                    jefatura: item.jefatura
                });
                continue;
            }

            activosParaProcesar.push(item);

            if (h > 0 && h > maxHoras[item.jefatura]) {
                maxHoras[item.jefatura] = h;
                reporte.emsSemana[item.jefatura] = {
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    horas: item.horas_semana,
                    rango: item.rango_actual
                };
            }

            if (h >= 50) {
                reporte.bonos100k.push({ nombre: item.nombre, discord_id: item.discord_id, horas: item.horas_semana, rango: item.rango_actual, monto: 100000 });
            } else if (h >= 25) {
                reporte.bonos50k.push({ nombre: item.nombre, discord_id: item.discord_id, horas: item.horas_semana, rango: item.rango_actual, monto: 50000 });
            }
        }

        // Eliminar expulsados de las tablas médicas
        await db.execute("DELETE FROM registro_ascensos WHERE faltas = 'DESPIDO' AND jefatura IN ('enfermeria', 'cirugia', 'medicina')");

        let aplicados = 0;

        for (const item of activosParaProcesar) {
            let postular = item.rango_postular || item.rango_actual;
            let nuevaJefatura = item.jefatura;
            let nuevoRangoActual = postular;
            let nuevoExamen = item.examen;

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
            } else if (pesoNuevo > pesoAnt) {
                const infoPersona = {
                    nombre: item.nombre,
                    discord_id: item.discord_id,
                    rango_anterior: item.rango_actual,
                    rango_nuevo: nuevoRangoActual,
                    jefatura_nueva: nuevaJefatura
                };
                if (reporte.ascensosOperativa[nuevoRangoActual] !== undefined) {
                    reporte.ascensosOperativa[nuevoRangoActual].push(infoPersona);
                } else if (reporte.ascensosMedica[nuevoRangoActual] !== undefined) {
                    reporte.ascensosMedica[nuevoRangoActual].push(infoPersona);
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

        // Registrar bonos en Tesorería
        const todosLosBonos = [...reporte.bonos100k, ...reporte.bonos50k];
        for (const b of todosLosBonos) {
            await db.execute({
                sql: `INSERT INTO registro_pagos (personal, rango, concepto, cantidad, estado, pagado_por, fecha_pago, registrado_por)
                      VALUES (?, ?, ?, ?, 'Pendiente', 'Pendiente', ?, 'Sistema Automático')`,
                args: [
                    b.nombre,
                    b.rango,
                    `Bono por Horas (${b.horas})`,
                    b.monto,
                    hoy
                ]
            });
        }

        // Guardar el reporte en la base de datos para consultas futuras
        await db.execute({
            sql: `INSERT OR REPLACE INTO historial_reportes (id, reporte_json, fecha, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)`,
            args: [JSON.stringify(reporte), hoy]
        });

        notificar('ascensos_actualizados');
        if (todosLosBonos.length > 0) notificar('pagos_actualizados');

        res.json({ 
            message: `Se aplicaron los cambios en Enfermería, Cirugía y Medicina (${aplicados} efectivos procesados, ${reporte.expulsados.length} bajas y ${todosLosBonos.length} bonos generados).`,
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

// CONTROL DE TABLAS LISTAS
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
            sql: "SELECT esta_lista FROM control_tablas_listas WHERE jefatura = ?",
            args: [jefatura]
        });

        const yaEstaLista = current.rows && current.rows.length > 0 && current.rows[0].esta_lista === 1;
        const nuevoEstado = yaEstaLista ? 0 : 1;

        const ahoraMex = new Intl.DateTimeFormat('es-MX', {
            timeZone: 'America/Mexico_City',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).format(new Date());

        const fechaHoraFinal = nuevoEstado === 1 ? ahoraMex : '';
        const userFinal = nuevoEstado === 1 ? (marcado_por || 'Jefatura') : '';

        await db.execute({
            sql: "INSERT OR REPLACE INTO control_tablas_listas (jefatura, esta_lista, fecha_hora_mexico, marcado_por) VALUES (?, ?, ?, ?)",
            args: [jefatura, nuevoEstado, fechaHoraFinal, userFinal]
        });

        notificar('tablas_listas_actualizadas');
        res.json({ esta_lista: nuevoEstado, fecha_hora_mexico: fechaHoraFinal, marcado_por: userFinal });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. FORMACIONES
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
    const cantSemanal = instrucciones_hechas !== undefined ? Math.max(0, parseFloat(instrucciones_hechas) || 0) : null;
    const cantTotales = instrucciones_totales !== undefined ? Math.max(0, parseFloat(instrucciones_totales) || 0) : null;
    const totalPago = cantSemanal !== null ? cantSemanal * 50000 : null;

    try {
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
    try {
        await db.execute("UPDATE registro_formaciones SET instrucciones_hechas = 0, total_pago = 0");
        notificar('formaciones_actualizadas');
        res.json({ message: "Corte semanal procesado." });
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

// 5. COORDINACIÓN
app.get('/api/coordinacion', async (req, res) => {
    try {
        const sql = `SELECT id, discord_id, supervisor, rango, horas_semana, estado, feedback_semanal, actualizado_por, updated_at 
                     FROM registro_coordinacion ORDER BY id DESC`;
        const result = await db.execute(sql);
        res.json(result.rows || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/coordinacion', async (req, res) => {
    const { discord_id, supervisor, rango, horas_semana, estado, feedback_semanal, actualizado_por } = req.body;
    if (!supervisor) return res.status(400).json({ error: "Ingresa el nombre del supervisor." });

    const discordLimpio = (discord_id || '').replace(/[^0-9]/g, '') || 'N/A';

    try {
        await db.execute({
            sql: `INSERT INTO registro_coordinacion (discord_id, supervisor, rango, horas_semana, estado, feedback_semanal, actualizado_por)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
                discordLimpio, supervisor.trim(), rango || 'Supervisor', horas_semana || '',
                estado || 'Activo', feedback_semanal || '', actualizado_por || 'Coordinación'
            ]
        });
        notificar('coordinacion_actualizada');
        res.json({ message: "Supervisor registrado en Coordinación." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/coordinacion/:id', async (req, res) => {
    const { estado, feedback_semanal, rango, horas_semana, discord_id, supervisor } = req.body;
    let discordLimpio = discord_id !== undefined && discord_id !== null ? String(discord_id).replace(/[^0-9]/g, '') : null;

    try {
        await db.execute({
            sql: `UPDATE registro_coordinacion SET 
                    estado = COALESCE(?, estado),
                    feedback_semanal = COALESCE(?, feedback_semanal),
                    rango = COALESCE(?, rango),
                    horas_semana = COALESCE(?, horas_semana),
                    discord_id = COALESCE(?, discord_id),
                    supervisor = COALESCE(?, supervisor)
                  WHERE id = ?`,
            args: [
                estado || null, feedback_semanal !== undefined ? feedback_semanal.trim() : null, rango || null,
                horas_semana !== undefined ? horas_semana.trim() : null, discordLimpio, supervisor || null, req.params.id
            ]
        });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor EMS online en puerto ${PORT}`));