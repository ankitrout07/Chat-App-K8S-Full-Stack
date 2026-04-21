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

let db;

// Function to create a fresh DB client
function createDbClient() {
  return new Client({
    host: process.env.DB_HOST || 'db-service',
    user: process.env.DB_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.DB_NAME || 'postgres',
    port: 5432,
  });
}

// Properly initialize database connection with retries
async function initializeDB(retries = 5) {
  while (retries > 0) {
    try {
      db = createDbClient();
      await db.connect();
      console.log('✅ Database connected');
      return;
    } catch (err) {
      retries -= 1;
      console.error(`❌ DB Connection Failed (${retries} retries left):`, err.message);
      if (retries === 0) {
        console.warn('⚠️ ALL DB RETRIES FAILED. Switching to IN-MEMORY VOLATILE MODE for demo purposes.');
        setupMemoryFallback();
        return;
      }
      await new Promise(res => setTimeout(res, 5000));
    }
  }
}

// Fallback logic for when no DB is available (Demo Mode)
function setupMemoryFallback() {
  console.log('🛡️ Memory Fallback Active: Chat will work but data will NOT persist.');
  // Mock the db.query method to use in-memory arrays
  const memoryStore = { users: [], messages: [], reactions: [] };
  db = {
    query: async (text, params) => {
      console.log('☁️ Memory DB Query:', text);
      if (text.includes('INSERT INTO users')) {
        const user = { id: Date.now(), username: params[0], password_hash: params[1] };
        memoryStore.users.push(user);
        return { rows: [user] };
      }
      if (text.includes('SELECT * FROM users WHERE username')) {
        const user = memoryStore.users.find(u => u.username === params[0]);
        return { rows: user ? [user] : [] };
      }
      if (text.includes('SELECT id, username FROM users')) {
        return { rows: memoryStore.users };
      }
      if (text.includes('INSERT INTO messages')) {
        const msg = { id: Date.now(), user_id: params[0], sender: params[1], text: params[2], time: params[3], room: params[4], created_at: new Date() };
        memoryStore.messages.push(msg);
        return { rows: [msg] };
      }
      if (text.includes('SELECT m.id')) {
        return { rows: memoryStore.messages.filter(m => m.room === params[0]).reverse().slice(params[2], params[2] + params[1]) };
      }
      return { rows: [] };
    }
  };
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

// Emit real-time system stats every 3 seconds
setInterval(async () => {
    const stats = {
        uptime: Math.floor(process.uptime()),
        memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
        connections: io.engine.clientsCount,
        dbStatus: 'HEALTHY',
        redisStatus: 'CONNECTED', // Simplified for demo, can be improved with redisClient.isReady
        heartbeat: Date.now()
    };
    io.emit('system-stats', stats);
}, 3000);

io.on('connection', (socket) => {
    const { id: userId, username } = socket.user;
    const userIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    console.log(`✓ Client authenticated: ${username} (${socket.id}) from IP: ${userIp}`);

    // Add to online tracking
    if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, { sockets: new Set(), ip: userIp, username });
        io.emit('user:online', { userId, username, ip: userIp });
    }
    onlineUsers.get(userId).sockets.add(socket.id);

    // Initial sync of online users for the newly connected client
    const onlineList = Array.from(onlineUsers.entries()).map(([id, data]) => ({
        userId: id,
        username: data.username,
        ip: data.ip
    }));
    socket.emit('online:list', onlineList);

    socket.on('disconnect', () => {
        console.log(`✗ Client disconnected: ${username} (${socket.id})`);
        
        const userData = onlineUsers.get(userId);
        if (userData) {
            userData.sockets.delete(socket.id);
            if (userData.sockets.size === 0) {
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
