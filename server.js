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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
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

// 1. AUTENTICACIÓN
app.post('/api/register', async (req, res) => {
    const { nombre, usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    if (!nombre || !userClean || !password) {
        return res.status(400).json({ error: "Faltan campos por completar." });
    }

    try {
        const check = await db.execute({
            sql: "SELECT id FROM usuarios WHERE LOWER(usuario) = ?",
            args: [userClean]
        });

        if (check.rows && check.rows.length > 0) {
            return res.status(400).json({ error: "El usuario ya existe." });
        }

        const count = await db.execute("SELECT COUNT(*) as total FROM usuarios");
        const esPrimero = Number(count.rows[0].total) === 0;
        const rangoInicial = esPrimero ? 'Director (Admin)' : 'Supervisor';
        const rolInicial = esPrimero ? 'admin' : 'empleado';

        const result = await db.execute({
            sql: "INSERT INTO usuarios (nombre, usuario, password, rango, rol) VALUES (?, ?, ?, ?, ?)",
            args: [nombre.trim(), userClean, String(password), rangoInicial, rolInicial]
        });

        notificar('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre: nombre.trim(), usuario: userClean, rango: rangoInicial, rol: rolInicial });
    } catch (e) {
        res.status(500).json({ error: "Error registrando usuario." });
    }
});

app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    if (!userClean || !password) {
        return res.status(400).json({ error: "Ingresa usuario y contraseña." });
    }

    try {
        const sql = `SELECT id, nombre, usuario, COALESCE(rango, 'Supervisor') as rango, COALESCE(rol, 'empleado') as rol FROM usuarios WHERE LOWER(TRIM(usuario)) = ? AND password = ?`;
        const result = await db.execute({ sql, args: [userClean, String(password)] });
        
        if (!result.rows || result.rows.length === 0) {
            return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        }

        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: "Error al validar credenciales." });
    }
});

// 2. PANEL ADMIN
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, nombre, usuario, COALESCE(rango, 'Supervisor') as rango, COALESCE(rol, 'empleado') as rol FROM usuarios ORDER BY id ASC");
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { rango, rol } = req.body;
    try {
        await db.execute({
            sql: "UPDATE usuarios SET rango = ?, rol = ? WHERE id = ?",
            args: [rango, rol, req.params.id]
        });
        notificar('usuario_modificado', { usuario_id: Number(req.params.id), rango, rol });
        res.json({ message: "Rango actualizado." });
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

// 3. REGISTROS DE EVALUACIÓN
app.get('/api/ascensos', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM registro_ascensos ORDER BY id DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ascensos', async (req, res) => {
    const { jefatura, nombre, rango_actual, rango_postular, faltas, horas_semana, examen, descripcion, actualizado_por } = req.body;
    if (!jefatura || !nombre || !rango_actual || !rango_postular) {
        return res.status(400).json({ error: "Faltan campos por completar." });
    }

    try {
        await db.execute({
            sql: `INSERT INTO registro_ascensos (
                    jefatura, 
                    discord_id, 
                    nombre_ems, 
                    nombre, 
                    rango_actual, 
                    rango_propuesto, 
                    rango_postular, 
                    faltas, 
                    horas_semana, 
                    examen, 
                    descripcion, 
                    actualizado_por
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                jefatura,
                'N/A',
                nombre.trim(),
                nombre.trim(),
                rango_actual,
                rango_postular,
                rango_postular,
                faltas || 'NINGUNA',
                horas_semana || '00 HRS 00:00',
                examen || 'NO APLICA',
                descripcion || '',
                actualizado_por || 'Jefatura'
            ]
        });
        notificar('ascensos_actualizados', { jefatura });
        res.json({ message: "Registro guardado." });
    } catch (e) {
        console.error("[ERROR GUARDAR ASCENSO]:", e.message);
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

// 4. JEFATURA DE FORMACIONES ($20,000 POR INSTRUCCIÓN)
app.get('/api/formaciones', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM registro_formaciones ORDER BY id DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/formaciones', async (req, res) => {
    const { instructor, rango, instrucciones_hechas, notas, actualizado_por } = req.body;
    const cant = parseInt(instrucciones_hechas) || 0;
    if (!instructor || !rango) {
        return res.status(400).json({ error: "Ingresa el nombre del instructor y su rango." });
    }

    const totalPago = cant * 20000;

    try {
        await db.execute({
            sql: `INSERT INTO registro_formaciones (instructor, rango, instrucciones_hechas, total_pago, notas, actualizado_por)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [instructor.trim(), rango, cant, totalPago, notas || '', actualizado_por || 'Jefe de Formaciones']
        });
        notificar('formaciones_actualizadas');
        res.json({ message: "Instructor registrado." });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor EMS online en puerto ${PORT}`));