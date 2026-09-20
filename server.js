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

// 1. REGISTRO & LOGIN
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
            return res.status(400).json({ error: "El nombre de usuario ya existe. Intenta iniciar sesión." });
        }

        const count = await db.execute("SELECT COUNT(*) as total FROM usuarios");
        const esPrimero = Number(count.rows[0].total) === 0;
        const rangoInicial = esPrimero ? 'Director (Admin)' : 'Supervisor';
        const rolInicial = esPrimero ? 'admin' : 'empleado';
        const comision = esPrimero ? 0 : 30;

        const result = await db.execute({
            sql: "INSERT INTO usuarios (nombre, usuario, password, rango, rol, comision_porcentaje) VALUES (?, ?, ?, ?, ?, ?)",
            args: [nombre.trim(), userClean, String(password), rangoInicial, rolInicial, comision]
        });

        notificar('nuevo_usuario');
        res.json({
            id: Number(result.lastInsertRowid),
            nombre: nombre.trim(),
            usuario: userClean,
            rango: rangoInicial,
            rol: rolInicial
        });
    } catch (e) {
        console.error("[REGISTER ERROR]:", e.message);
        res.status(500).json({ error: "Error registrando usuario en la base de datos." });
    }
});

app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    const userClean = (usuario || '').trim().toLowerCase();

    if (!userClean || !password) {
        return res.status(400).json({ error: "Ingresa usuario y contraseña." });
    }

    try {
        const result = await db.execute({
            sql: "SELECT id, nombre, usuario, rango, rol, comision_porcentaje FROM usuarios WHERE LOWER(TRIM(usuario)) = ? AND password = ?",
            args: [userClean, String(password)]
        });

        const rows = result && result.rows ? result.rows : [];
        
        if (rows.length === 0) {
            return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
        }

        const user = rows[0];
        res.json({
            id: Number(user.id),
            nombre: user.nombre,
            usuario: user.usuario,
            rango: user.rango || 'Supervisor',
            rol: user.rol || 'empleado',
            comision_porcentaje: Number(user.comision_porcentaje) || 30
        });
    } catch (e) {
        console.error("[LOGIN ERROR]:", e.message);
        res.status(500).json({ error: "Error al validar credenciales en la base de datos." });
    }
});

// 2. GESTIÓN DE USUARIOS Y RANGOS (ADMIN)
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, nombre, usuario, rango, rol, comision_porcentaje, created_at FROM usuarios ORDER BY id ASC");
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { rango, rol, comision_porcentaje } = req.body;
    try {
        await db.execute({
            sql: "UPDATE usuarios SET rango = ?, rol = ?, comision_porcentaje = ? WHERE id = ?",
            args: [rango, rol, Number(comision_porcentaje) || 30, req.params.id]
        });
        notificar('usuario_modificado', { usuario_id: Number(req.params.id), rango, rol });
        res.json({ message: "Rango actualizado con éxito." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/usuarios/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM facturas WHERE usuario_id = ?", args: [req.params.id] });
        await db.execute({ sql: "DELETE FROM usuarios WHERE id = ?", args: [req.params.id] });
        notificar('usuario_eliminado', { usuario_id: Number(req.params.id) });
        res.json({ message: "Usuario eliminado correctamente." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. TABLAS DE JEFATURAS (ASCENSOS, HORAS Y DISCORD ID)
app.get('/api/ascensos/:jefatura', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM registro_ascensos WHERE jefatura = ? ORDER BY horas_hechas DESC",
            args: [req.params.jefatura]
        });
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ascensos', async (req, res) => {
    const { jefatura, discord_id, nombre_ems, rango_actual, rango_propuesto, horas_hechas, notas, actualizado_por } = req.body;
    if (!jefatura || !discord_id || !nombre_ems) {
        return res.status(400).json({ error: "Faltan campos obligatorios para el registro." });
    }

    try {
        await db.execute({
            sql: `INSERT INTO registro_ascensos (jefatura, discord_id, nombre_ems, rango_actual, rango_propuesto, horas_hechas, notas, actualizado_por)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [jefatura, discord_id, nombre_ems, rango_actual, rango_propuesto, parseFloat(horas_hechas) || 0, notas || '', actualizado_por || 'Jefatura']
        });
        notificar('ascensos_actualizados', { jefatura });
        res.json({ message: "Personal ingresado a la tabla de ascensos." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ascensos/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM registro_ascensos WHERE id = ?", args: [req.params.id] });
        notificar('ascensos_actualizados');
        res.json({ message: "Registro retirado de la tabla." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. FACTURACIÓN MÉDICA
app.post('/api/facturas', async (req, res) => {
    const { usuario_id, paciente, dni, items } = req.body;
    if (!usuario_id || !items || items.length === 0) {
        return res.status(400).json({ error: "Datos incompletos de la atención médica." });
    }

    try {
        const userRes = await db.execute({ sql: "SELECT nombre, comision_porcentaje FROM usuarios WHERE id = ?", args: [usuario_id] });
        if (!userRes.rows || userRes.rows.length === 0) {
            return res.status(404).json({ error: "Médico no encontrado." });
        }
        const user = userRes.rows[0];

        let totalCobrado = 0;
        let costeSuministros = 0;

        items.forEach(it => {
            totalCobrado += (it.precio * it.cantidad);
            costeSuministros += ((it.costo || 0) * it.cantidad);
        });

        const gananciaBruta = totalCobrado - costeSuministros;
        const comisionMedico = gananciaBruta > 0 ? gananciaBruta * (user.comision_porcentaje / 100) : 0;
        const fondoHospital = totalCobrado - comisionMedico;

        const result = await db.execute({
            sql: `INSERT INTO facturas (usuario_id, paciente, dni, total_cobrado, coste_suministros, fondo_hospital, comision_medico, items_json)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [usuario_id, paciente, dni || 'S/N', totalCobrado, costeSuministros, fondoHospital, comisionMedico, JSON.stringify(items)]
        });

        notificar('nueva_factura', { medico: user.nombre, paciente, total: totalCobrado });
        res.json({ id: Number(result.lastInsertRowid), total: totalCobrado, comision: comisionMedico, hospital: fondoHospital });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/mis-facturas/:id', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM facturas WHERE usuario_id = ? ORDER BY fecha DESC LIMIT 50",
            args: [req.params.id]
        });
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor EMS online en puerto ${PORT}`));