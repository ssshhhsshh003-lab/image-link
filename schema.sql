-- Simple Image Links - Pure SQL Schema for PostgreSQL / Vercel Postgres / Supabase / Neon

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2. Image Links Table
CREATE TABLE IF NOT EXISTS image_links (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug VARCHAR(32) UNIQUE NOT NULL,
  image_url TEXT NOT NULL,
  title VARCHAR(200),
  description VARCHAR(500),
  destination_url TEXT NOT NULL,
  total_clicks BIGINT DEFAULT 0 NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 3. Country Statistics Table
CREATE TABLE IF NOT EXISTS country_stats (
  id VARCHAR(64) PRIMARY KEY,
  image_link_id VARCHAR(64) NOT NULL REFERENCES image_links(id) ON DELETE CASCADE,
  country_code VARCHAR(10) NOT NULL,
  country_name VARCHAR(100) NOT NULL,
  clicks BIGINT DEFAULT 0 NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT unique_link_country UNIQUE (image_link_id, country_code)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_image_links_user_id ON image_links(user_id);
CREATE INDEX IF NOT EXISTS idx_image_links_slug ON image_links(slug);
CREATE INDEX IF NOT EXISTS idx_country_stats_link_id ON country_stats(image_link_id);
CREATE INDEX IF NOT EXISTS idx_country_stats_link_country ON country_stats(image_link_id, country_code);
