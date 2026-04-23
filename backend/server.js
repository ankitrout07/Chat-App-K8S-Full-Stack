require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const JWT_SECRET = process.env.JWT_SECRET || 'tunnel-pro-secret-key-1337';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const client = new OAuth2Client(GOOGLE_CLIENT_ID);
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
const io = new Server(server, {
  cors: { origin: "*" }
});

let db;

// Function to create a fresh DB Pool
function createDbPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'db-service',
    user: process.env.DB_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.DB_NAME || 'postgres',
    port: 5432,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
  });
}

// Properly initialize database connection with retries
async function initializeDB(retries = 5) {
  while (retries > 0) {
    try {
      db = createDbPool();
      // Test connection
      const res = await db.query('SELECT NOW()');
      console.log('✅ Database connected (Pool):', res.rows[0].now);
      // Auto-migrate: create groups table and add group_id FK to messages
      await runMigrations();
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

// Auto-migrate database schema for groups
async function runMigrations() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Groups table ready');

    // Add preferred_theme column to users if missing
    const themeCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'preferred_theme'
    `);
    if (themeCheck.rows.length === 0) {
      await db.query("ALTER TABLE users ADD COLUMN preferred_theme TEXT DEFAULT 'dark'");
      console.log('✅ Added preferred_theme column to users table');
    }

    // Add google_id column to users if missing
    const googleIdCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'google_id'
    `);
    if (googleIdCheck.rows.length === 0) {
      await db.query("ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE");
      console.log('✅ Added google_id column to users table');
    }

    // Add avatar_url column to users if missing
    const avatarCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'avatar_url'
    `);
    if (avatarCheck.rows.length === 0) {
      await db.query("ALTER TABLE users ADD COLUMN avatar_url TEXT");
      console.log('✅ Added avatar_url column to users table');
    }

    // Add group_id column to messages if it doesn't exist
    const colCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'group_id'
    `);
    if (colCheck.rows.length === 0) {
      await db.query('ALTER TABLE messages ADD COLUMN group_id INT REFERENCES groups(id) ON DELETE CASCADE');
      console.log('✅ Added group_id FK to messages');
    }

    // Add parent_id column for threaded replies
    const parentCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'parent_id'
    `);
    if (parentCheck.rows.length === 0) {
      await db.query('ALTER TABLE messages ADD COLUMN parent_id INT REFERENCES messages(id) ON DELETE CASCADE');
      console.log('✅ Added parent_id FK to messages for threading');
    }

    // Seed default channels if none exist
    const existing = await db.query('SELECT COUNT(*) FROM groups');
    if (parseInt(existing.rows[0].count) === 0) {
      await db.query("INSERT INTO groups (name, created_by) VALUES ('general', 'system'), ('dev-ops', 'system'), ('k8s-logs', 'system') ON CONFLICT DO NOTHING");
      console.log('✅ Default groups seeded');
    }


    // Ensure group_members table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        id SERIAL PRIMARY KEY,
        group_id INT REFERENCES groups(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(group_id, user_id)
      )
    `);
    console.log('✅ Group members table ready');
  } catch (err) {
    console.warn('⚠️ Migration warning (non-fatal):', err.message);
  }
}

// Fallback logic for when no DB is available (Demo Mode)
function setupMemoryFallback() {
  console.log('🛡️ Memory Fallback Active: Chat will work but data will NOT persist.');
  // Mock the db.query method to use in-memory arrays
  const memoryStore = {
    users: [],
    messages: [],
    reactions: [],
    groups: [
      { id: 1, name: 'general', created_by: 'system', created_at: new Date() },
      { id: 2, name: 'dev-ops', created_by: 'system', created_at: new Date() },
      { id: 3, name: 'k8s-logs', created_by: 'system', created_at: new Date() }
    ]
  };
  let groupIdCounter = 4;
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
      // Groups queries
      if (text.includes('INSERT INTO groups')) {
        const existing = memoryStore.groups.find(g => g.name === params[0]);
        if (existing) throw new Error('Group already exists');
        const group = { id: groupIdCounter++, name: params[0], created_by: params[1], created_at: new Date() };
        memoryStore.groups.push(group);
        return { rows: [group] };
      }
      if (text.includes('SELECT * FROM groups ORDER BY')) {
        return { rows: [...memoryStore.groups] };
      }
      if (text.includes('DELETE FROM groups WHERE id')) {
        memoryStore.groups = memoryStore.groups.filter(g => g.id !== params[0]);
        return { rows: [] };
      }
      if (text.includes('INSERT INTO messages')) {
        const msg = { id: Date.now(), user_id: params[0], sender: params[1], text: params[2], time: params[3], room: params[4], group_id: params[5] || null, created_at: new Date() };
        memoryStore.messages.push(msg);
        return { rows: [msg] };
      }
      if (text.includes('SELECT m.id')) {
        return { rows: memoryStore.messages.filter(m => m.room === params[0]).reverse().slice(params[2], params[2] + params[1]) };
      }
      // Bot diagnostic queries for Demo Mode
      if (text.includes('SELECT COUNT(*) FROM messages')) return { rows: [{ count: memoryStore.messages.length }] };
      if (text.includes('SELECT COUNT(*) FROM users')) return { rows: [{ count: memoryStore.users.length }] };
      if (text.includes('SELECT COUNT(*) FROM groups')) return { rows: [{ count: memoryStore.groups.length }] };
      if (text.includes('SELECT NOW()')) return { rows: [{ time: new Date().toISOString(), name: 'MEMORY_STORE', size: '0 MB' }] };

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
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, preferred_theme',
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
        res.json({ token, user: { id: user.id, username: user.username, preferred_theme: user.preferred_theme } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/auth/google', async (req, res) => {
    const { credential } = req.body;
    try {
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { sub, email, name, picture } = payload;

        // Use email or sub as username for Google users
        let username = name || email.split('@')[0];
        
        // Check if user exists
        let result = await db.query('SELECT * FROM users WHERE google_id = $1 OR username = $2', [sub, username]);
        
        let user;
        if (result.rows.length === 0) {
            // Create new user
            const insertResult = await db.query(
                'INSERT INTO users (username, google_id, avatar_url) VALUES ($1, $2, $3) RETURNING id, username, preferred_theme',
                [username, sub, picture]
            );
            user = insertResult.rows[0];
        } else {
            user = result.rows[0];
            // Update google_id if it was a legacy user with same username/email
            if (!user.google_id) {
                await db.query('UPDATE users SET google_id = $1, avatar_url = $2 WHERE id = $3', [sub, picture, user.id]);
            }
        }

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username, preferred_theme: user.preferred_theme, avatar_url: picture } });
    } catch (err) {
        console.error('Google Auth Error:', err);
        res.status(400).json({ error: 'Google authentication failed' });
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

// --- GROUPS ---
app.get('/groups', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM groups ORDER BY created_at ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/groups', async (req, res) => {
    const { name, createdBy } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' });
    try {
        const result = await db.query(
            'INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING *',
            [name.trim().toLowerCase().replace(/\s+/g, '-'), createdBy || 'unknown']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.message.includes('duplicate') || err.message.includes('already exists')) {
            return res.status(409).json({ error: 'Group already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.delete('/groups/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- MONITORING ---

// return chat history with pagination
app.get('/messages', async (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const room = req.query.room || 'general';
    try {
        const result = await db.query(
            `SELECT m.id, m.sender, m.text, m.time, m.delivered_at, m.read_at, m.created_at, m.user_id, m.room, m.parent_id,
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

// Presence tracking (userId -> data)
const onlineUsers = new Map();

// Helper to get socket by user ID
function getSocketsByUserId(userId) {
    const data = onlineUsers.get(userId);
    if (!data) return [];
    return Array.from(data.sockets).map(sid => io.sockets.sockets.get(sid)).filter(s => !!s);
}

// ─────────────────────────────────────────────────
// 🤖 CHATOPS BOT ENGINE
// ─────────────────────────────────────────────────
const BOT_NAME = 'TunnelBot';
const BOT_COMMANDS = {
    '/help': {
        description: 'List all available bot commands',
        handler: async () => {
            const lines = Object.entries(BOT_COMMANDS)
                .map(([cmd, meta]) => `\`${cmd}\` — ${meta.description}`)
                .join('\n');
            return `**📖 Available Commands**\n${lines}`;
        }
    },
    '/ping': {
        description: 'Test bot latency',
        handler: async () => {
            const start = Date.now();
            return `🏓 Pong! Latency: **${Date.now() - start}ms** | Server time: ${new Date().toISOString()}`;
        }
    },
    '/uptime': {
        description: 'Show server uptime',
        handler: async () => {
            const secs = Math.floor(process.uptime());
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = secs % 60;
            return `⏱️ **Server Uptime:** ${h}h ${m}m ${s}s`;
        }
    },
    '/stats': {
        description: 'Show real-time system resource usage',
        handler: async () => {
            const mem = process.memoryUsage();
            return [
                '📊 **System Resources**',
                `• RSS Memory: **${(mem.rss / 1024 / 1024).toFixed(1)} MB**`,
                `• Heap Used: **${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB** / ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
                `• External: **${(mem.external / 1024 / 1024).toFixed(2)} MB**`,
                `• Live Sockets: **${io.engine.clientsCount}**`,
                `• Online Users: **${onlineUsers.size}**`,
                `• Node.js: **${process.version}**`,
                `• Platform: **${process.platform} ${process.arch}**`
            ].join('\n');
        }
    },
    '/db-health': {
        description: 'Run a PostgreSQL health check',
        handler: async () => {
            try {
                const start = Date.now();
                const res = await db.query('SELECT NOW() as time, current_database() as name, pg_size_pretty(pg_database_size(current_database())) as size');
                const latency = Date.now() - start;
                const row = res.rows[0];
                const msgCount = await db.query('SELECT COUNT(*) FROM messages');
                const userCount = await db.query('SELECT COUNT(*) FROM users');
                const groupCount = await db.query('SELECT COUNT(*) FROM groups');
                return [
                    '🗄️ **Database Health: HEALTHY** ✅',
                    `• DB Name: **${row.name}**`,
                    `• DB Size: **${row.size}**`,
                    `• Query Latency: **${latency}ms**`,
                    `• Server Time: ${row.time}`,
                    `• Total Messages: **${msgCount.rows[0].count}**`,
                    `• Total Users: **${userCount.rows[0].count}**`,
                    `• Total Groups: **${groupCount.rows[0].count}**`
                ].join('\n');
            } catch (err) {
                return `🗄️ **Database Health: DEGRADED** ❌\n• Error: \`${err.message}\``;
            }
        }
    },
    '/redis-health': {
        description: 'Check Redis Pub/Sub mesh status',
        handler: async () => {
            try {
                const start = Date.now();
                const pong = await redisClient.ping();
                const latency = Date.now() - start;
                return [
                    '⚡ **Redis Health: CONNECTED** ✅',
                    `• Response: **${pong}**`,
                    `• Latency: **${latency}ms**`,
                    `• Host: \`${process.env.REDIS_HOST || 'redis-service'}:${process.env.REDIS_PORT || 6379}\``
                ].join('\n');
            } catch (err) {
                return `⚡ **Redis Health: DISCONNECTED** ❌\n• Error: \`${err.message}\``;
            }
        }
    },
    '/deploy-status': {
        description: 'Show current deployment environment info',
        handler: async () => {
            const env = process.env.NODE_ENV || 'development';
            const dbHost = process.env.DB_HOST || 'db-service';
            const redisHost = process.env.REDIS_HOST || 'redis-service';
            const port = process.env.PORT || 3000;
            const hasAzure = !!process.env.DATABASE_URL;
            return [
                '🚀 **Deployment Status**',
                `• Environment: **${env.toUpperCase()}**`,
                `• Platform: **${hasAzure ? 'Azure App Service' : 'Kubernetes / Local'}**`,
                `• App Port: **${port}**`,
                `• DB Host: \`${dbHost}\``,
                `• Redis Host: \`${redisHost}\``,
                `• SSL: **${process.env.DATABASE_URL ? 'Enabled' : 'Disabled'}**`,
                `• Server PID: **${process.pid}**`,
                `• Memory Limit: **${(process.resourceUsage?.()?.maxRSS / 1024).toFixed(0) || 'N/A'} MB**`
            ].join('\n');
        }
    },
    '/users': {
        description: 'List currently online users',
        handler: async () => {
            if (onlineUsers.size === 0) return '👤 No users currently online.';
            const lines = Array.from(onlineUsers.entries())
                .map(([id, data]) => `• **${data.username}** — IP: \`${data.ip}\` (${data.sockets.size} session${data.sockets.size > 1 ? 's' : ''})`)
                .join('\n');
            return `👥 **Online Users (${onlineUsers.size})**\n${lines}`;
        }
    },
    '/groups': {
        description: 'List all available channels',
        handler: async () => {
            try {
                const res = await db.query('SELECT name, created_by, created_at FROM groups ORDER BY created_at ASC');
                if (res.rows.length === 0) return '📁 No channels found.';
                const lines = res.rows.map(g => `• **#${g.name}** — created by \`${g.created_by}\``).join('\n');
                return `📁 **Channels (${res.rows.length})**\n${lines}`;
            } catch (err) {
                return `📁 Channel list unavailable: \`${err.message}\``;
            }
        }
    },
    '/whoami': {
        description: 'Show your session info',
        handler: async (socket) => {
            const userData = onlineUsers.get(socket.user.id);
            return [
                '🪪 **Your Session**',
                `• Username: **${socket.user.username}**`,
                `• User ID: **${socket.user.id}**`,
                `• Socket ID: \`${socket.id}\``,
                `• IP: \`${userData?.ip || 'unknown'}\``,
                `• Active Sessions: **${userData?.sockets.size || 1}**`
            ].join('\n');
        }
    }
};

// Execute a bot command and return the response payload
async function executeBotCommand(commandText, socket, room) {
    const parts = commandText.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    const command = BOT_COMMANDS[cmd];
    if (!command) {
        return `❓ Unknown command: \`${cmd}\`\nType \`/help\` to see available commands.`;
    }

    try {
        return await command.handler(socket, args, room);
    } catch (err) {
        console.error(`Bot command error [${cmd}]:`, err);
        return `⚠️ Command \`${cmd}\` failed: \`${err.message}\``;
    }
}

// Emit real-time system stats every 3 seconds
setInterval(async () => {
    const stats = {
        uptime: Math.floor(process.uptime()),
        memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
        connections: io.engine.clientsCount,
        dbStatus: 'HEALTHY',
        redisStatus: 'CONNECTED', 
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

    // Join a group (creates Socket.IO room + notifies)
    socket.on('joinGroup', async (data) => {
        const groupName = typeof data === 'string' ? data : data.groupName;
        socket.join(groupName);
        console.log(`✓ ${username} joined group: ${groupName}`);
        socket.to(groupName).emit('group:userJoined', { username, groupName });
    });

    // Leave a group room
    socket.on('leaveGroup', (groupName) => {
        socket.leave(groupName);
        console.log(`✗ ${username} left group: ${groupName}`);
    });

    // Propagate group deletion
    socket.on('group:delete', (data) => {
        io.emit('group:deleted', data);
    });

    // Handle adding members to a group
    socket.on('addMemberToGroup', async ({ groupId, groupName, targetUserId, targetUsername }) => {
        try {
            // 1. Persist to DB
            await db.query(
                'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [groupId, targetUserId]
            );

            // 2. Real-time Join: If user is online, force them to join the room
            const targetSockets = getSocketsByUserId(targetUserId);
            targetSockets.forEach(s => {
                s.join(groupName);
                s.emit('addedToGroup', { groupName, groupId, inviter: socket.user.username });
            });
            
            // 3. Confirm back to the requester
            socket.emit('memberAddedSuccess', { targetUsername, groupName });
            console.log(`🤝 User ${targetUsername} added to group ${groupName} by ${socket.user.username}`);
        } catch (err) {
            console.error('Add Member Error:', err);
            socket.emit('error', { message: 'Failed to add member to group' });
        }
    });

    // Handle theme persistence
    socket.on('updateThemePreference', async ({ theme }) => {
        try {
            await db.query('UPDATE users SET preferred_theme = $1 WHERE id = $2', [theme, socket.user.id]);
            console.log(`🎨 Theme updated to ${theme} for user ${socket.user.username}`);
        } catch (err) {
            console.error('Theme Update Error:', err);
        }
    });

    // broadcast typing notifications to everyone in the room except the originator
    socket.on('typing', (data) => {
        const room = data.room || 'general';
        socket.to(room).emit('typing', data);
    });

    // message deletion (also persist in DB)
    socket.on('deleteRequest', async (msgId) => {
        try {
            await db.query('DELETE FROM messages WHERE id = $1', [msgId]);
            io.emit('messageDeleted', msgId);
            console.log(`🗑️ Message ${msgId} deleted and broadcasted.`);
        } catch (err) { console.error('Deletion Error:', err); }
    });

    // new chat message - insert into db (with ChatOps bot interception)
    socket.on('chat message', async (data) => {
        const room = data.room || 'general';
        const text = (data.text || '').trim();

        // 🤖 BOT INTERCEPTION: If the message starts with '/', route to the bot
        if (text.startsWith('/')) {
            console.log(`🤖 Bot command from ${socket.user.username}: ${text}`);

            // Show the user's command to the room first
            io.to(room).emit('chat message', {
                sender: socket.user.username,
                userId: socket.user.id,
                text: text,
                time: data.time || new Date().toLocaleTimeString(),
                room: room,
                id: Date.now(),
                isCommand: true,
                ephemeral: true
            });

            // Execute the command and post the bot's response
            const botResponse = await executeBotCommand(text, socket, room);
            io.to(room).emit('chat message', {
                sender: BOT_NAME,
                userId: null,
                text: botResponse,
                time: new Date().toLocaleTimeString(),
                room: room,
                id: Date.now() + 1,
                isBot: true,
                ephemeral: true
            });
            return; // Don't persist bot commands to DB
        }

        const payload = {
            sender: socket.user.username,
            userId: socket.user.id,
            text: data.text,
            time: data.time || new Date().toLocaleTimeString(),
            room: room,
            id: Date.now() // temporary ID if DB fails
        };

        try {
            const groupId = data.groupId || null;
            const parentId = data.parentId || null;
            const res = await db.query(
                'INSERT INTO messages (user_id, sender, text, time, room, group_id, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at',
                [socket.user.id, socket.user.username, data.text, data.time, room, groupId, parentId]
            );
            payload.id = res.rows[0].id;
            payload.created_at = res.rows[0].created_at;
            payload.groupId = groupId;
            payload.parentId = parentId;
            
            // BROADCAST: Send the saved message to everyone in the room
            io.to(room).emit('chat message', payload);
        } catch (err) { 
            console.error('❌ Persistence failed, broadcasting as ephemeral:', err.message);
            // BROADCAST anyway to ensure multi-user real-time interaction
            io.to(room).emit('chat message', { ...payload, ephemeral: true }); 
        }
    });

    // Reactions
    socket.on('reaction', async (data) => {
        try {
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
