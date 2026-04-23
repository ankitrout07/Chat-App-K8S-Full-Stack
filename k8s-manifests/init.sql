-- Users Table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Groups Table (Channels)
CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Messages Table (Updated with group_id FK)
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  time TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT 'general',
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  delivered_at TIMESTAMP NULL,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id);

-- Reactions Table
CREATE TABLE IF NOT EXISTS reactions (
  id SERIAL PRIMARY KEY,
  message_id INT REFERENCES messages(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);

-- Seed default channels
INSERT INTO groups (name, created_by) VALUES
  ('general', 'system'),
  ('dev-ops', 'system'),
  ('k8s-logs', 'system')
ON CONFLICT (name) DO NOTHING;
