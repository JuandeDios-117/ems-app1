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
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
    if (!nombre || !usuario || !password) return res.status(400).json({ error: "Faltan campos por completar." });

    try {
        const count = await db.execute("SELECT COUNT(*) as total FROM usuarios");
        const esPrimero = count.rows[0].total === 0;
        const rangoInicial = esPrimero ? 'Director (Admin)' : 'Supervisor';
        const rolInicial = esPrimero ? 'admin' : 'empleado';
        const comision = esPrimero ? 0 : 30;

        const result = await db.execute({
            sql: "INSERT INTO usuarios (nombre, usuario, password, rango, rol, comision_porcentaje) VALUES (?, ?, ?, ?, ?, ?)",
            args: [nombre, usuario.trim().toLowerCase(), password, rangoInicial, rolInicial, comision]
        });

        notificar('nuevo_usuario');
        res.json({ id: Number(result.lastInsertRowid), nombre, usuario, rango: rangoInicial, rol: rolInicial });
    } catch (e) {
        res.status(400).json({ error: "El nombre de usuario ya existe o los datos son inválidos." });
    }
});

app.post('/api/login', async (req, res) => {
    const { usuario, password } = req.body;
    try {
        const result = await db.execute({
            sql: "SELECT id, nombre, usuario, rango, rol, comision_porcentaje FROM usuarios WHERE usuario = ? AND password = ?",
            args: [usuario.trim().toLowerCase(), password]
        });
        if (result.rows.length === 0) return res.status(401).json({ error: "Credenciales incorrectas." });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. GESTIÓN DE USUARIOS Y RANGOS (ADMIN)
app.get('/api/usuarios', async (req, res) => {
    try {
        const result = await db.execute("SELECT id, nombre, usuario, rango, rol, comision_porcentaje, created_at FROM usuarios ORDER BY id ASC");
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/usuarios/:id', async (req, res) => {
    const { rango, rol, comision_porcentaje } = req.body;
    try {
        await db.execute({
            sql: "UPDATE usuarios SET rango = ?, rol = ?, comision_porcentaje = ? WHERE id = ?",
            args: [rango, rol, comision_porcentaje, req.params.id]
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
        res.json({ message: "Usuario eliminado." });
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
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ascensos', async (req, res) => {
    const { jefatura, discord_id, nombre_ems, rango_actual, rango_propuesto, horas_hechas, notas, actualizado_por } = req.body;
    if (!jefatura || !discord_id || !nombre_ems) return res.status(400).json({ error: "Faltan datos obligatorios." });

    try {
        await db.execute({
            sql: `INSERT INTO registro_ascensos (jefatura, discord_id, nombre_ems, rango_actual, rango_propuesto, horas_hechas, notas, actualizado_por)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [jefatura, discord_id, nombre_ems, rango_actual, rango_propuesto, parseFloat(horas_hechas) || 0, notas || '', actualizado_por || 'Jefatura']
        });
        notificar('ascensos_actualizados', { jefatura });
        res.json({ message: "Registro de ascenso agregado exitosamente." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/ascensos/:id', async (req, res) => {
    const { rango_actual, rango_propuesto, horas_hechas, notas, actualizado_por } = req.body;
    try {
        await db.execute({
            sql: `UPDATE registro_ascensos 
                  SET rango_actual = ?, rango_propuesto = ?, horas_hechas = ?, notas = ?, actualizado_por = ?, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?`,
            args: [rango_actual, rango_propuesto, parseFloat(horas_hechas) || 0, notas || '', actualizado_por || 'Jefatura', req.params.id]
        });
        notificar('ascensos_actualizados');
        res.json({ message: "Datos de ascenso modificados." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/ascensos/:id', async (req, res) => {
    try {
        await db.execute({ sql: "DELETE FROM registro_ascensos WHERE id = ?", args: [req.params.id] });
        notificar('ascensos_actualizados');
        res.json({ message: "Registro retirado." });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. FACTURACIÓN MÉDICA
app.post('/api/facturas', async (req, res) => {
    const { usuario_id, paciente, dni, items } = req.body;
    if (!usuario_id || !items || items.length === 0) return res.status(400).json({ error: "Datos incompletos de la factura médica." });

    try {
        const userRes = await db.execute({ sql: "SELECT nombre, comision_porcentaje FROM usuarios WHERE id = ?", args: [usuario_id] });
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
        res.json({ id: result.lastInsertRowid, total: totalCobrado, comision: comisionMedico, hospital: fondoHospital });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/mis-facturas/:id', async (req, res) => {
    try {
        const result = await db.execute({ sql: "SELECT * FROM facturas WHERE usuario_id = ? ORDER BY fecha DESC LIMIT 50", args: [req.params.id] });
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor EMS online en puerto ${PORT}`));