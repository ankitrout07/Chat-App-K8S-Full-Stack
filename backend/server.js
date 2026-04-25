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
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || 'vortex-chat-secret-key-1337';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
let client;
if (GOOGLE_CLIENT_ID) {
    client = new OAuth2Client(GOOGLE_CLIENT_ID);
} else {
    console.warn('⚠️ GOOGLE_CLIENT_ID missing from environment variables. Google Auth will not function.');
}
const app = express();
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "'unsafe-inline'", "https://cdn.socket.io", "https://cdn.jsdelivr.net", "https://accounts.google.com", "https://cdn.tailwindcss.com"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "https://accounts.google.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            "img-src": ["'self'", "data:", "https://source.boringavatars.com", "https://lh3.googleusercontent.com", "https://cdn-icons-png.flaticon.com", "https://upload.wikimedia.org"],
            "media-src": ["'self'", "https://assets.mixkit.co"],
            "script-src-attr": ["'unsafe-inline'"],
            "connect-src": ["'self'", "wss:", "https://accounts.google.com", "https://cdn.jsdelivr.net", "https://*.supabase.co"],
            "frame-src": ["'self'", "https://accounts.google.com"]
        },
    },
}));
const compression = require('compression');
app.use(compression());
app.use(express.json());
const staticPath = path.join(__dirname, 'app');

// --- TRANSPORT SECURITY (HTTPS REDIRECT) ---
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(`https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

// --- RATE LIMITING ---
const limiter = rateLimit({
    // windowMs: 2 * 60 * 1000 = 120,000ms (2 minutes)
    windowMs: 2 * 60 * 1000, 
    
    // Adjust this to the number of requests you want to allow in that 2-min window
    max: 50, 
    
    // The message the user sees when they are blocked
    message: {
        status: 429,
        error: 'Too many requests',
        message: 'Vortex is cooling down. Please try again in 2 minutes.'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false,  // Disable the `X-RateLimit-*` headers
});

// Apply to all routes
app.use(limiter);

const oneDay = 86400000;
app.use(express.static(staticPath, { maxAge: oneDay }));
app.use('/uploads', express.static(path.join(staticPath, 'uploads')));

const UPLOADS_DIR = path.join(staticPath, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : "*",
    methods: ["GET", "POST"]
  }
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
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        google_id TEXT UNIQUE,
        avatar_url TEXT,
        bio TEXT DEFAULT 'Neural interface active...',
        status_text TEXT DEFAULT 'Available',
        status_emoji TEXT DEFAULT '🟢',
        preferred_theme TEXT DEFAULT 'dark',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Users table ready');

    await db.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Groups table ready');

    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT NOT NULL,
        room TEXT DEFAULT 'general',
        group_id INT REFERENCES groups(id) ON DELETE CASCADE,
        parent_id INT REFERENCES messages(id) ON DELETE CASCADE,
        is_pinned BOOLEAN DEFAULT FALSE,
        delivered_at TIMESTAMP,
        read_at TIMESTAMP,
        updated_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Messages table ready');

    await db.query(`
      CREATE TABLE IF NOT EXISTS reactions (
        id SERIAL PRIMARY KEY,
        message_id INT REFERENCES messages(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(message_id, user_id, emoji)
      )
    `);
    console.log('✅ Reactions table ready');

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

    // Add bio column to users if missing
    const bioCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'bio'
    `);
    if (bioCheck.rows.length === 0) {
      await db.query("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT 'Neural interface active...'");
      console.log('✅ Added bio column to users table');
    }

    // Add status columns to users if missing
    const statusTextCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'status_text'
    `);
    if (statusTextCheck.rows.length === 0) {
      await db.query("ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT 'Available'");
      await db.query("ALTER TABLE users ADD COLUMN status_emoji TEXT DEFAULT '🟢'");
      console.log('✅ Added status columns to users table');
    }

    // Add presence tracking columns
    const presenceCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'presence_status'
    `);
    if (presenceCheck.rows.length === 0) {
      await db.query("ALTER TABLE users ADD COLUMN presence_status TEXT DEFAULT 'Offline'");
      await db.query("ALTER TABLE users ADD COLUMN last_seen TIMESTAMP DEFAULT NOW()");
      console.log('✅ Added presence tracking columns to users table');
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

    // Add is_pinned column to messages if missing
    const pinCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'is_pinned'
    `);
    if (pinCheck.rows.length === 0) {
      await db.query('ALTER TABLE messages ADD COLUMN is_pinned BOOLEAN DEFAULT FALSE');
      console.log('✅ Added is_pinned column to messages');
    }

    // Add updated_at column to messages if missing
    const updatedCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'updated_at'
    `);
    if (updatedCheck.rows.length === 0) {
      await db.query('ALTER TABLE messages ADD COLUMN updated_at TIMESTAMP');
      console.log('✅ Added updated_at column to messages');
    }

    // Add tsvector column for full-text search if missing
    const tsvCheck = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'tsv'
    `);
    if (tsvCheck.rows.length === 0) {
      await db.query('ALTER TABLE messages ADD COLUMN tsv tsvector');
      await db.query("UPDATE messages SET tsv = to_tsvector('english', COALESCE(text, ''))");
      await db.query('CREATE INDEX IF NOT EXISTS messages_tsv_idx ON messages USING GIN(tsv)');
      
      // Create trigger to keep tsv updated
      await db.query(`
        CREATE OR REPLACE FUNCTION messages_tsvector_trigger() RETURNS trigger AS $$
        begin
          new.tsv := to_tsvector('english', coalesce(new.text, ''));
          return new;
        end
        $$ LANGUAGE plpgsql;
      `);
      
      await db.query(`
        DROP TRIGGER IF EXISTS tsvectorupdate ON messages;
        CREATE TRIGGER tsvectorupdate BEFORE INSERT OR UPDATE
        ON messages FOR EACH ROW EXECUTE PROCEDURE messages_tsvector_trigger();
      `);
      
      console.log('✅ Full-Text Search (tsvector) indexing enabled on messages');
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
        const user = { 
            id: Date.now(), 
            username: params[0], 
            password_hash: params[1], 
            google_id: params[2] || null, 
            avatar_url: params[3] || null, 
            bio: 'Neural interface active...', 
            status_text: 'Available',
            status_emoji: '🟢',
            preferred_theme: 'dark' 
        };
        memoryStore.users.push(user);
        return { rows: [user] };
      }
      if (text.includes('SELECT * FROM users WHERE google_id')) {
        const user = memoryStore.users.find(u => u.google_id === params[0] || u.username === params[1]);
        return { rows: user ? [user] : [] };
      }
      if (text.includes('UPDATE users SET bio = $1')) {
        const user = memoryStore.users.find(u => u.id === params[1]);
        if (user) { user.bio = params[0]; }
        return { rows: [] };
      }
      if (text.includes('UPDATE users SET status_text = $1, status_emoji = $2')) {
        const user = memoryStore.users.find(u => u.id === params[2]);
        if (user) { user.status_text = params[0]; user.status_emoji = params[1]; }
        return { rows: [] };
      }
      if (text.includes('UPDATE users SET google_id')) {
        const user = memoryStore.users.find(u => u.id === params[2]);
        if (user) { user.google_id = params[0]; user.avatar_url = params[1]; }
        return { rows: [] };
      }
      if (text.includes('SELECT * FROM users WHERE username')) {
        const user = memoryStore.users.find(u => u.username === params[0]);
        return { rows: user ? [user] : [] };
      }
      if (text.includes('SELECT id, username FROM users')) {
        return { rows: memoryStore.users };
      }
      // Reactions
      if (text.includes('INSERT INTO reactions')) {
        const reaction = { message_id: params[0], user_id: params[1], emoji: params[2] };
        memoryStore.reactions.push(reaction);
        return { rows: [reaction] };
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
        const msg = { id: Date.now(), user_id: params[0], sender: params[1], text: params[2], time: params[3], room: params[4], group_id: params[5] || null, parent_id: params[6] || null, created_at: new Date() };
        memoryStore.messages.push(msg);
        return { rows: [msg] };
      }
      if (text.includes('UPDATE messages SET delivered_at')) {
        const msg = memoryStore.messages.find(m => m.id === params[0]);
        if (msg) msg.delivered_at = new Date();
        return { rows: [] };
      }
      if (text.includes('UPDATE messages SET read_at')) {
        const msg = memoryStore.messages.find(m => m.id === params[0]);
        if (msg) msg.read_at = new Date();
        return { rows: [] };
      }
      if (text.includes('SELECT m.id')) {
        const roomMsgs = memoryStore.messages.filter(m => m.room === params[0]);
        const results = roomMsgs.reverse().slice(params[2], params[2] + params[1]).map(m => ({
          ...m,
          reactions: memoryStore.reactions.filter(r => r.message_id === m.id).map(r => ({
            ...r,
            username: memoryStore.users.find(u => u.id === r.user_id)?.username || 'unknown'
          }))
        }));
        return { rows: results };
      }
      // Bot diagnostic queries for Demo Mode
      if (text.includes('SELECT COUNT(*) FROM messages')) return { rows: [{ count: memoryStore.messages.length }] };
      if (text.includes('SELECT COUNT(*) FROM users')) return { rows: [{ count: memoryStore.users.length }] };
      if (text.includes('SELECT COUNT(*) FROM groups')) return { rows: [{ count: memoryStore.groups.length }] };
      if (text.includes('SELECT NOW()')) return { rows: [{ time: new Date().toISOString(), name: 'MEMORY_STORE', size: '0 MB' }] };

      if (text.includes('UPDATE messages SET text = $1, updated_at = NOW()')) {
        const msg = memoryStore.messages.find(m => m.id === params[1] && m.user_id === params[2]);
        if (msg) { msg.text = params[0]; msg.updated_at = new Date(); return { rows: [msg] }; }
        return { rows: [] };
      }
      if (text.includes('UPDATE messages SET is_pinned = TRUE')) {
        const msg = memoryStore.messages.find(m => m.id === params[0]);
        if (msg) msg.is_pinned = true;
        return { rows: [] };
      }
      if (text.includes('UPDATE messages SET is_pinned = FALSE')) {
        const msg = memoryStore.messages.find(m => m.id === params[0]);
        if (msg) msg.is_pinned = false;
        return { rows: [] };
      }
      if (text.includes('SELECT * FROM messages WHERE id = $1')) {
        const msg = memoryStore.messages.find(m => m.id === params[0]);
        return { rows: msg ? [msg] : [] };
      }
      if (text.includes('SELECT * FROM messages WHERE room = $1 AND is_pinned = TRUE')) {
        const pins = memoryStore.messages.filter(m => m.room === params[0] && m.is_pinned).sort((a,b) => b.created_at - a.created_at);
        return { rows: pins };
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
    res.sendFile(path.join(staticPath, 'index.html'));
});

app.get('/chat', (req, res) => {
    res.sendFile(path.join(staticPath, 'chat.html'));
});

app.post('/api/login', async (req, res) => {
    const { username } = req.body;
    if (!username || !username.trim()) return res.status(400).json({ error: 'Username is required' });

    const cleanUsername = username.trim();
    try {
        // Upsert: insert the user only if they don't exist already (UNIQUE constraint on username)
        await db.query(
            'INSERT INTO users (username) VALUES ($1) ON CONFLICT (username) DO NOTHING',
            [cleanUsername]
        );
        // Always fetch the canonical row
        const result = await db.query('SELECT id, username, preferred_theme FROM users WHERE username = $1', [cleanUsername]);
        const user = result.rows[0];

        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, username: user.username, preferred_theme: user.preferred_theme } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- AUTH ROUTES ---

app.post('/auth/google', async (req, res) => {
    if (!client) {
        return res.status(501).json({ error: 'Google authentication is not configured on this server.' });
    }
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
            `SELECT m.id, m.sender, m.text, m.time, m.delivered_at, m.read_at, m.created_at, m.user_id, m.room, m.parent_id, u.avatar_url,
            (SELECT json_agg(re) FROM (SELECT r.emoji, r.user_id, u.username FROM reactions r JOIN users u ON r.user_id = u.id WHERE r.message_id = m.id) re) as reactions
            FROM messages m 
            LEFT JOIN users u ON m.user_id = u.id
            WHERE m.room = $1 
            ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
            [room, limit, offset]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Global Search Endpoint using Full-Text Search
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    
    try {
        const result = await db.query(
            `SELECT m.id, m.sender, m.text, m.time, m.room, m.created_at, u.avatar_url,
             ts_rank(m.tsv, plainto_tsquery('english', $1)) as rank
             FROM messages m
             LEFT JOIN users u ON m.user_id = u.id
             WHERE m.tsv @@ plainto_tsquery('english', $1)
             ORDER BY rank DESC, m.created_at DESC
             LIMIT 20`,
            [query]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Search error:', err);
        // Fallback to ILIKE if tsvector fails or in memory mode
        try {
            const fallback = await db.query(
                `SELECT m.id, m.sender, m.text, m.time, m.room, m.created_at, u.avatar_url 
                 FROM messages m
                 LEFT JOIN users u ON m.user_id = u.id
                 WHERE m.text ILIKE $1 
                 ORDER BY m.created_at DESC LIMIT 20`,
                [`%${query}%`]
            );
            res.json(fallback.rows);
        } catch (innerErr) {
            res.status(500).json({ error: err.message });
        }
    }
});

// Peer Search Endpoint — search users by username prefix
app.get('/search/users', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    try {
        const result = await db.query(
            `SELECT id, username, bio, status_text, status_emoji, avatar_url
             FROM users
             WHERE username ILIKE $1
             ORDER BY username ASC
             LIMIT 10`,
            [`%${query}%`]
        );
        res.json(result.rows);
    } catch (err) {
        // Memory fallback
        const lower = query.toLowerCase();
        const matched = (global._memUsers || []).filter(u => u.username.toLowerCase().includes(lower));
        res.json(matched.slice(0, 10));
    }

app.get('/stats', (req, res) => {
    // Cleanup message history
    const now = Date.now();
    while (messageHistory.length > 0 && messageHistory[0] < now - 60000) {
        messageHistory.shift();
    }

    const stats = {
        uptime: Math.floor(process.uptime()),
        memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
        cpu: getCpuPercentage(),
        msgFreq: messageHistory.length, // Messages per minute
        connections: io.engine.clientsCount,
        dbStatus: 'HEALTHY',
        redisStatus: 'CONNECTED', 
        heartbeat: Date.now()
    };
    res.json(stats);
});

// --- SOCKET.IO MIDDLEWARE (JWT AUTH) ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error: Token missing'));

    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err) return next(new Error('Authentication error: Invalid token'));
        
        try {
            // Local token payload is { id, username }
            // No Supabase mapping needed.
            
            // Supabase user id is a UUID, which might fail the pg query if id is INT.
            // Using a try-catch will gracefully fallback.
            const result = await db.query('SELECT avatar_url FROM users WHERE id = $1', [decoded.id]);
            decoded.avatar_url = result.rows[0]?.avatar_url || null;
            socket.user = decoded; // { id, username, avatar_url }
            next();
        } catch (dbErr) {
            socket.user = decoded;
            next();
        }
    });
});

// Presence tracking (username -> data)
const onlineUsers = new Map();

// Helper to get socket by username
function getSocketsByUserId(username) {
    const data = onlineUsers.get(username);
    if (!data) return [];
    return Array.from(data.sockets).map(sid => io.sockets.sockets.get(sid)).filter(s => !!s);
}

// ─────────────────────────────────────────────────
// 🤖 CHATOPS BOT ENGINE
// ─────────────────────────────────────────────────
const BOT_NAME = 'VortexBot';
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
                .map(([uname, data]) => `• **${data.username}** — IP: \`${data.ip}\` (${data.sockets.size} session${data.sockets.size > 1 ? 's' : ''})`)
                .join('\n');
            return `👥 **Online Users (${onlineUsers.size})**\n${lines}`;
        }
    },
    '/vortex': {
        description: 'Vortex-Ops Bot Interface (/vortex weather, news, system)',
        handler: async (socket, args) => {
            const subCmd = args[0]?.toLowerCase();
            if (subCmd === 'weather') {
                const location = args.slice(1).join(' ') || 'London';
                try {
                    const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=3`);
                    const weather = await response.text();
                    return `🌦️ **Weather report:**\n${weather}`;
                } catch (e) {
                    return `⚠️ Could not fetch weather.`;
                }
            } else if (subCmd === 'news') {
                try {
                    const response = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
                    const ids = await response.json();
                    const top3 = await Promise.all(ids.slice(0, 3).map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json())));
                    const news = top3.map((item, i) => `${i + 1}. [${item.title}](${item.url || '#'})`).join('\n');
                    return `📰 **Latest Tech Headlines:**\n${news}`;
                } catch (e) {
                    return `⚠️ Could not fetch news.`;
                }
            } else if (subCmd === 'system') {
                const secs = Math.floor(process.uptime());
                const h = Math.floor(secs / 3600);
                const m = Math.floor((secs % 3600) / 60);
                return `⚙️ **Vortex System Status**\n• Uptime: ${h}h ${m}m ${secs % 60}s\n• Version: Vortex v2.0 (Quantum Edition)\n• Node: ${process.version}`;
            } else {
                return '❓ Unknown Vortex-Ops command. Try: `weather [location]`, `news`, or `system`.';
            }
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
            const userData = onlineUsers.get(socket.user.username);
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

// Track message frequency
let messageCountInWindow = 0;
const messageHistory = [];
const WINDOW_SIZE_MS = 60000; // 1 minute window

// Add message to tracking
function trackMessage() {
    messageCountInWindow++;
    const now = Date.now();
    messageHistory.push(now);
    // Cleanup old messages
    while (messageHistory.length > 0 && messageHistory[0] < now - WINDOW_SIZE_MS) {
        messageHistory.shift();
    }
}

// Get CPU Usage
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

function getCpuPercentage() {
    const currCpuUsage = process.cpuUsage(lastCpuUsage);
    const currCpuTime = Date.now();
    const elapsedMs = currCpuTime - lastCpuTime;
    
    lastCpuUsage = process.cpuUsage();
    lastCpuTime = currCpuTime;

    const totalUsageMs = (currCpuUsage.user + currCpuUsage.system) / 1000;
    return Math.min(100, (totalUsageMs / elapsedMs) * 100).toFixed(1);
}

// Emit real-time system stats every 5 seconds (as requested)
setInterval(async () => {
    // Cleanup message history
    const now = Date.now();
    while (messageHistory.length > 0 && messageHistory[0] < now - WINDOW_SIZE_MS) {
        messageHistory.shift();
    }

    const stats = {
        uptime: Math.floor(process.uptime()),
        memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
        cpu: getCpuPercentage(),
        msgFreq: messageHistory.length, // Messages per minute
        connections: io.engine.clientsCount,
        dbStatus: 'HEALTHY',
        redisStatus: 'CONNECTED', 
        heartbeat: Date.now()
    };
    io.emit('system-stats', stats);
}, 5000);

io.on('connection', (socket) => {
    const { id: userId, username } = socket.user;
    const userIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    console.log(`✓ Client authenticated: ${username} (${socket.id}) from IP: ${userIp}`);

    // Auto-upsert Supabase user into public.users
    db.query(`
        INSERT INTO users (username, password, presence_status) 
        VALUES ($1, 'supabase_auth', 'Active') 
        ON CONFLICT (username) DO UPDATE 
        SET presence_status = 'Active'
    `, [username]).catch(err => console.error('Failed to auto-register user:', err));

    // Add to online tracking
    if (!onlineUsers.has(username)) {
        onlineUsers.set(username, { sockets: new Set(), ip: userIp, username, avatar_url: socket.user.avatar_url });
        io.emit('user:online', { username, ip: userIp, avatar_url: socket.user.avatar_url });
    }
    onlineUsers.get(username).sockets.add(socket.id);

    // Initial sync of online users for the newly connected client
    const onlineList = Array.from(onlineUsers.entries()).map(([uname, data]) => ({
        username: uname,
        avatar_url: data.avatar_url,
        ip: data.ip
    }));
    socket.emit('online:list', onlineList);

    socket.on('disconnect', () => {
        console.log(`✗ Client disconnected: ${username} (${socket.id})`);
        
        const userData = onlineUsers.get(username);
        if (userData) {
            userData.sockets.delete(socket.id);
            if (userData.sockets.size === 0) {
                onlineUsers.delete(username);
                io.emit('user:offline', { username });
                
                // Update presence in PostgreSQL
                db.query("UPDATE users SET presence_status = 'Offline', last_seen = NOW() WHERE username = $1", [username])
                  .catch(err => console.error('Failed to update offline presence:', err));
            }
        }
    });

    // Typing indicators
    socket.on('typing', (room) => {
        socket.to(room).emit('user:typing', { username });
    });

    socket.on('stop_typing', (room) => {
        socket.to(room).emit('user:stop_typing', { username });
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

    // Handle bio update
    socket.on('updateBio', async ({ bio }) => {
        try {
            await db.query('UPDATE users SET bio = $1 WHERE id = $2', [bio, socket.user.id]);
            socket.user.bio = bio;
            console.log(`👤 Bio updated for ${socket.user.username}`);
        } catch (err) {
            console.error('Bio Update Error:', err);
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

    // Handle status update
    socket.on('updateStatus', async ({ text, emoji }) => {
        try {
            await db.query('UPDATE users SET status_text = $1, status_emoji = $2 WHERE id = $3', [text, emoji, socket.user.id]);
            socket.user.status_text = text;
            socket.user.status_emoji = emoji;
            io.emit('user:statusUpdate', { userId: socket.user.id, text, emoji });
            console.log(`📡 Status updated for ${socket.user.username}: ${emoji} ${text}`);
        } catch (err) {
            console.error('Status Update Error:', err);
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

    // message editing
    socket.on('editRequest', async ({ msgId, newText }) => {
        try {
            const result = await db.query(
                'UPDATE messages SET text = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING id, updated_at',
                [newText, msgId, socket.user.id]
            );
            if (result.rows.length > 0) {
                io.emit('messageEdited', { msgId, newText, updated_at: result.rows[0].updated_at });
                console.log(`📝 Message ${msgId} edited by ${socket.user.username}`);
            }
        } catch (err) { console.error('Edit Error:', err); }
    });

    // pinning logic
    socket.on('pinRequest', async (msgId) => {
        try {
            await db.query('UPDATE messages SET is_pinned = TRUE WHERE id = $1', [msgId]);
            const res = await db.query('SELECT * FROM messages WHERE id = $1', [msgId]);
            io.emit('messagePinned', res.rows[0]);
            console.log(`📌 Message ${msgId} pinned by ${socket.user.username}`);
        } catch (err) { console.error('Pin Error:', err); }
    });

    socket.on('unpinRequest', async (msgId) => {
        try {
            await db.query('UPDATE messages SET is_pinned = FALSE WHERE id = $1', [msgId]);
            io.emit('messageUnpinned', msgId);
            console.log(`📍 Message ${msgId} unpinned by ${socket.user.username}`);
        } catch (err) { console.error('Unpin Error:', err); }
    });

    socket.on('fetchPinnedMessages', async (room) => {
        try {
            const result = await db.query(
                'SELECT * FROM messages WHERE room = $1 AND is_pinned = TRUE ORDER BY created_at DESC',
                [room]
            );
            socket.emit('pinnedMessages', result.rows);
        } catch (err) { console.error('Fetch Pins Error:', err); }
    });

    // new chat message - insert into db (with ChatOps bot interception)
    socket.on('chat message', async (data) => {
        const room = data.room || 'general';
        const text = (data.text || '').trim();
        
        trackMessage(); // Track for monitoring dashboard

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
            avatar_url: socket.user.avatar_url,
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
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Vortex v14 Control Live on port ${PORT}`));

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
