require('dotenv').config();
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
const compression = require('compression');
app.use(compression());
app.use(express.json());
const oneDay = 86400000;
app.use(express.static(path.join(__dirname, 'app'), { maxAge: oneDay }));
app.use('/uploads', express.static(path.join(__dirname, 'app', 'uploads')));

const UPLOADS_DIR = path.join(__dirname, 'app', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'app', 'index.html'));
});

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

// --- USERS ---
app.get('/users', async (req, res) => {
    try {
        const result = await db.query('SELECT id, username FROM users');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- MONITORING ---

// return chat history with pagination
app.get('/messages', async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const room = req.query.room || 'global';
    try {
        const result = await db.query(
            `SELECT m.id, m.sender, m.text, m.time, m.delivered_at, m.read_at, m.created_at, m.user_id, m.room,
            (SELECT json_agg(re) FROM (SELECT r.emoji, r.user_id, u.username FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = m.id) re) as reactions
            FROM messages m WHERE m.room = $1 ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
            [room, limit, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SOCKET.IO MIDDLEWARE (JWT AUTH) ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error: Token missing'));

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error: Invalid token'));
        socket.user = decoded; // { id, username }
        next();
    });
});

// Presence tracking (userId -> set of socketIds)
const onlineUsers = new Map();

io.on('connection', (socket) => {
    const { id: userId, username } = socket.user;
    console.log(`✓ Client authenticated: ${username} (${socket.id})`);

    // Add to online tracking
    if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
        io.emit('user:online', { userId, username });
    }
    onlineUsers.get(userId).add(socket.id);

    // Initial sync of online users for the newly connected client
    socket.emit('online:list', Array.from(onlineUsers.keys()));

    socket.on('disconnect', () => {
        console.log(`✗ Client disconnected: ${username} (${socket.id})`);
        
        const sockets = onlineUsers.get(userId);
        if (sockets) {
            sockets.delete(socket.id);
            if (sockets.size === 0) {
                onlineUsers.delete(userId);
                io.emit('user:offline', { userId, username });
            }
        }
    });

    socket.on('join room', (room) => {
        // Leave previous rooms if any
        Array.from(socket.rooms).forEach(r => { if (r !== socket.id) socket.leave(r); });
        socket.join(room);
        console.log(`✓ ${username} joined room: ${room}`);
    });

    // broadcast typing notifications to everyone in the room except the originator
    socket.on('typing', (data) => {
        const room = data.room || 'global';
        socket.to(room).emit('typing', data);
    });

    // message deletion (also persist in DB)
    socket.on('delete message', async (msgId) => {
        try {
            await db.query('DELETE FROM messages WHERE id = $1', [msgId]);
            io.emit('delete message', msgId);
        } catch (err) { console.error(err); }
    });

    // new chat message - insert into db
    socket.on('chat message', async (data) => {
        const room = data.room || 'global';
        try {
            const res = await db.query(
                'INSERT INTO messages (user_id, sender, text, time, room) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
                [socket.user.id, socket.user.username, data.text, data.time, room]
            );
            const msgId = res.rows[0].id;
            const createdAt = res.rows[0].created_at;
            io.to(room).emit('chat message', {
                sender: socket.user.username,
                userId: socket.user.id,
                text: data.text,
                time: data.time,
                id: msgId,
                created_at: createdAt,
                room: room
            });
        } catch (err) { console.error('Save failed:', err.message); }
    });

    // Reactions
    socket.on('reaction', async (data) => {
        try {
            // data: { messageId, emoji }
            await db.query(
                'INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (message_id, user_id, emoji) DO NOTHING',
                [data.messageId, socket.user.id, data.emoji]
            );
            io.emit('reaction', { ...data, userId: socket.user.id, username: socket.user.username });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Tunnel v14 Control Live on port ${PORT}`));

// Health check for Azure/K8s
app.get('/health', (req, res) => res.status(200).send('OK'));

// Initialize all services on startup
(async () => {
  await initializeDB();
  await initializeRedis();
})().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
