const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('pg');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const JWT_SECRET = process.env.JWT_SECRET || 'tunnel-pro-secret-key-1337';
const app = express();
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });
const server = http.createServer(app);
const io = new Server(server);

const db = new Client({
  host: process.env.DB_HOST || 'db-service',
  user: process.env.DB_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
  port: 5432,
});

// Properly initialize database connection
async function initializeDB() {
  try {
    await db.connect();
    console.log('✅ Database connected');
  } catch (err) {
    console.error('❌ DB Connection Failed:', err.message);
    process.exit(1);
  }
}

// Setup Redis adapter for Socket.IO clustering
const redisClient = createClient({
  host: process.env.REDIS_HOST || 'redis-service',
  port: process.env.REDIS_PORT || 6379,
});

async function initializeRedis() {
  try {
    await redisClient.connect();
    const pubClient = redisClient.duplicate();
    await pubClient.connect();
    io.adapter(createAdapter(pubClient, redisClient));
    console.log('✅ Redis adapter connected for Socket.IO clustering');
  } catch (err) {
    console.warn('⚠️ Redis not available, running without clustering:', err.message);
  }
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// --- AUTH ROUTES ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await db.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
            [username, hashedPassword]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: 'Username already exists or invalid data' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- FILE UPLOAD ---
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

// --- MONITORING ---
app.get('/stats', (req, res) => {
    res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        connections: io.engine.clientsCount,
        platform: process.platform
    });
});

// return chat history with pagination
app.get('/messages', async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    try {
        const result = await db.query(
            `SELECT m.id, m.sender, m.text, m.time, m.delivered_at, m.read_at, m.created_at, m.user_id,
            (SELECT json_agg(re) FROM (SELECT r.emoji, r.user_id, u.username FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = m.id) re) as reactions
            FROM messages m ORDER BY m.created_at DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

io.on('connection', (socket) => {
    console.log(`✓ Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`✗ Client disconnected: ${socket.id}`);
    });

    // broadcast typing notifications to everyone except the originator
    socket.on('typing', (data) => socket.broadcast.emit('typing', data));

    // message deletion (also persist in DB)
    socket.on('delete message', async (msgId) => {
        try {
            await db.query('DELETE FROM messages WHERE id = $1', [msgId]);
            io.emit('delete message', msgId);
        } catch (err) { console.error(err); }
    });

    // new chat message - insert into db
    socket.on('chat message', async (data) => {
        try {
            const res = await db.query(
                'INSERT INTO messages (user_id, sender, text, time) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
                [data.userId || null, data.user, data.text, data.time]
            );
            const msgId = res.rows[0].id;
            const createdAt = res.rows[0].created_at;
            io.emit('chat message', {
                sender: data.user,
                userId: data.userId,
                text: data.text,
                time: data.time,
                id: msgId,
                created_at: createdAt
            });
        } catch (err) { console.error('Save failed:', err.message); }
    });

    // Reactions
    socket.on('reaction', async (data) => {
        try {
            // data: { messageId, userId, emoji }
            await db.query(
                'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (message_id, user_id, emoji) DO NOTHING',
                [data.messageId, data.userId, data.emoji]
            );
            io.emit('reaction', data);
        } catch (err) { console.error('Reaction failed:', err.message); }
    });

    // delivery/read receipts
    socket.on('message delivered', async (msgId) => {
        try {
            await db.query('UPDATE messages SET delivered_at = NOW() WHERE id = $1', [msgId]);
            io.emit('message delivered', msgId);
        } catch (err) { console.error(err); }
    });

    socket.on('message read', async (msgId) => {
        try {
            await db.query('UPDATE messages SET read_at = NOW() WHERE id = $1', [msgId]);
            io.emit('message read', msgId);
        } catch (err) { console.error(err); }
    });

    // clear all messages (admin action)
    socket.on('clear chat', async () => {
        try {
            await db.query('DELETE FROM messages');
            io.emit('clear chat');
        } catch (err) { console.error('Failed to clear chat:', err.message); }
    });
});

server.listen(3000, '0.0.0.0', () => console.log('🚀 Tunnel v14 Control Live'));

// Initialize all services on startup
(async () => {
  await initializeDB();
  await initializeRedis();
})().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
