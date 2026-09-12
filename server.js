/**
 * RAFLY — Backend para sorteos en vivo con Instagram
 *
 * Flujo de autenticación (Instagram Business Login API):
 * 1. El usuario hace clic en "Conectar Instagram" → GET /auth/instagram
 * 2. Se redirige a Instagram OAuth para pedir permisos
 * 3. Instagram redirige a /auth/callback con un código
 * 4. El servidor intercambia el código por un access token + user_id
 * 5. Se obtiene el perfil de Instagram del usuario
 * 6. El frontend puede pedir posts y comentarios via /api/*
 */
 
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
const rateLimit = require('express-rate-limit');
const app = express();
app.set('trust proxy', 1); // trust Render's proxy for rate-limiting
 
// ── Configuración ──────────────────────────────────────────────
const {
  FB_APP_ID,
  FB_APP_SECRET,
  BASE_URL = 'http://localhost:3000',
  PORT = 3000
} = process.env;
 
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const GRAPH_VERSION = 'v20.0';
const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments'
].join(',');
 
// ── YouTube Data API ──────────────────────────────────────────
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || null;
 
// ── User-Agent pool for scraping fallbacks ────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
 
// Estado en memoria — legacy fallback (se usa platform_tokens para usuarios autenticados)
let session = {
  accessToken: null,
  igUserId: null,
  username: null,
  profilePic: null
};
 
// ── JWT Secret ────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'rafly-secret-change-in-production-' + Date.now();
const JWT_EXPIRES = '30d';
 
// ── PostgreSQL Database ──────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('.neon.tech')
    ? { rejectUnauthorized: false }
    : undefined
});
 
// Helper functions for cleaner DB access
const db = {
  async get(text, params = []) {
    const { rows } = await pool.query(text, params);
    return rows[0] || null;
  },
  async all(text, params = []) {
    const { rows } = await pool.query(text, params);
    return rows;
  },
  async run(text, params = []) {
    return await pool.query(text, params);
  }
};
 
// Initialize all tables
async function initDB() {
  // Migrate: add missing columns to existing tables
  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMP DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_grace_until TIMESTAMP DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS downgrade_warned INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_status TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS brand_settings TEXT DEFAULT NULL`,
  ];
  for (const mig of migrations) {
    try { await pool.query(mig); } catch (e) { /* column may already exist */ }
  }
 
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT DEFAULT '',
      plan TEXT DEFAULT 'free',
      brand_settings TEXT DEFAULT NULL,
      stripe_customer_id TEXT DEFAULT NULL,
      stripe_subscription_id TEXT DEFAULT NULL,
      stripe_subscription_status TEXT DEFAULT NULL,
      payment_failed_at TIMESTAMP DEFAULT NULL,
      payment_grace_until TIMESTAMP DEFAULT NULL,
      downgrade_warned INTEGER DEFAULT 0,
      email_verified INTEGER DEFAULT 0,
      verification_token TEXT DEFAULT NULL,
      reset_token TEXT DEFAULT NULL,
      reset_token_expires TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS sorteo_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      winner TEXT NOT NULL,
      suplentes TEXT DEFAULT '[]',
      participants_count INTEGER DEFAULT 0,
      platform TEXT DEFAULT 'manual',
      mode TEXT DEFAULT 'slot',
      post_url TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS daily_counts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      UNIQUE(user_id, date)
    );
 
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      endpoint TEXT UNIQUE NOT NULL,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      name TEXT DEFAULT 'default',
      created_at TIMESTAMP DEFAULT NOW(),
      last_used TIMESTAMP,
      requests_today INTEGER DEFAULT 0,
      requests_total INTEGER DEFAULT 0
    );
 
    CREATE TABLE IF NOT EXISTS scheduled_sorteos (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT DEFAULT 'Sorteo programado',
      participants TEXT NOT NULL,
      winner_count INTEGER DEFAULT 1,
      suplente_count INTEGER DEFAULT 0,
      remove_duplicates INTEGER DEFAULT 0,
      mode TEXT DEFAULT 'slot',
      scheduled_at TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'pending',
      winners TEXT DEFAULT NULL,
      executed_at TIMESTAMP DEFAULT NULL,
      share_url TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      user_id INTEGER,
      email TEXT NOT NULL,
      role TEXT DEFAULT 'viewer',
      status TEXT DEFAULT 'pending',
      invited_at TIMESTAMP DEFAULT NOW(),
      joined_at TIMESTAMP DEFAULT NULL,
      UNIQUE(team_id, email)
    );
 
    CREATE TABLE IF NOT EXISTS sorteo_shares (
      id SERIAL PRIMARY KEY,
      sorteo_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      shared_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '["sorteo.completed"]',
      secret TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW(),
      last_triggered TIMESTAMP DEFAULT NULL,
      fail_count INTEGER DEFAULT 0
    );
 
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id SERIAL PRIMARY KEY,
      webhook_id INTEGER NOT NULL REFERENCES webhooks(id),
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status_code INTEGER,
      response TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS widgets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      widget_key TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT 'Mi Widget',
      config TEXT DEFAULT '{}',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
 
    CREATE TABLE IF NOT EXISTS platform_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      platform TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT DEFAULT NULL,
      platform_user_id TEXT DEFAULT NULL,
      platform_username TEXT DEFAULT NULL,
      profile_pic TEXT DEFAULT NULL,
      token_expires_at TIMESTAMP DEFAULT NULL,
      scopes TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, platform)
    );
  `);
 
  console.log('  ✦ Database tables initialized');
}
 
// ── Auth Middleware ────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}
 
// Optional auth — sets req.userId if token present, doesn't block
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      req.userId = decoded.userId;
    } catch (err) { /* ignore */ }
  }
  next();
}
 
// ── Middleware ──────────────────────────────────────────────────
app.use(express.static('public'));
// Stripe webhook needs raw body — must come before express.json()
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
 
// ── Utilidades ─────────────────────────────────────────────────
async function graphGet(path, params = {}, accessToken = null) {
  params.access_token = accessToken || session.accessToken;
  const qs = new URLSearchParams(params).toString();
  const url = `${GRAPH_BASE}${path}?${qs}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message);
    err.status = res.status;
    err.fbError = data.error;
    throw err;
  }
  return data;
}
 
// Helper: get user's platform token from DB
async function getUserPlatformToken(userId, platform) {
  const row = await db.get(
    'SELECT * FROM platform_tokens WHERE user_id = $1 AND platform = $2',
    [userId, platform]
  );
  if (!row) return null;
  // Check expiry
  if (row.token_expires_at && new Date(row.token_expires_at) < new Date()) {
    return null; // Token expired
  }
  return row;
}
 
// Helper: save/update platform token
async function savePlatformToken(userId, platform, tokenData) {
  await db.run(`
    INSERT INTO platform_tokens (user_id, platform, access_token, refresh_token, platform_user_id, platform_username, profile_pic, token_expires_at, scopes, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (user_id, platform) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, platform_tokens.refresh_token),
      platform_user_id = COALESCE(EXCLUDED.platform_user_id, platform_tokens.platform_user_id),
      platform_username = COALESCE(EXCLUDED.platform_username, platform_tokens.platform_username),
      profile_pic = COALESCE(EXCLUDED.profile_pic, platform_tokens.profile_pic),
      token_expires_at = COALESCE(EXCLUDED.token_expires_at, platform_tokens.token_expires_at),
      scopes = COALESCE(EXCLUDED.scopes, platform_tokens.scopes),
      updated_at = NOW()
  `, [userId, platform, tokenData.accessToken, tokenData.refreshToken || null,
      tokenData.platformUserId || null, tokenData.platformUsername || null,
      tokenData.profilePic || null, tokenData.expiresAt || null,
      tokenData.scopes || null]);
}
 
// ── Auth: Iniciar flujo OAuth ──────────────────────────────────
app.get('/auth/instagram', (req, res) => {
  // Pass JWT token as state so we can link to authenticated user on callback
  const jwtToken = req.query.token || '';
  const state = jwtToken ? Buffer.from(JSON.stringify({ jwt: jwtToken })).toString('base64url') : '';
 
  const url = `https://api.instagram.com/oauth/authorize`
    + `?client_id=${FB_APP_ID}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&scope=${SCOPES}`
    + `&response_type=code`
    + `&enable_fb_login=0`
    + (state ? `&state=${state}` : '');
  res.redirect(url);
});
 
// ── Auth: Callback de Instagram ───────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, error, state } = req.query;
 
  if (error || !code) {
    return res.redirect('/?ig_error=auth_denied');
  }
 
  // Try to extract authenticated user from state
  let authUserId = null;
  if (state) {
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
      if (stateData.jwt) {
        const decoded = jwt.verify(stateData.jwt, JWT_SECRET);
        authUserId = decoded.userId;
      }
    } catch (e) { /* invalid state, proceed without auth */ }
  }
 
  try {
    // 1. Intercambiar código por token de corta duración + user_id
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error_message) throw new Error(tokenData.error_message);
    if (!tokenData.access_token) throw new Error('No se recibió access token');
 
    const igUserId = String(tokenData.user_id);
 
    // 2. Intercambiar por token de larga duración (~60 días)
    const longTokenUrl = `https://graph.instagram.com/access_token`
      + `?grant_type=ig_exchange_token`
      + `&client_secret=${FB_APP_SECRET}`
      + `&access_token=${tokenData.access_token}`;
 
    const longRes = await fetch(longTokenUrl);
    const longData = await longRes.json();
    const finalToken = longData.access_token || tokenData.access_token;
    const expiresIn = longData.expires_in || 5184000; // ~60 days
 
    // 3. Obtener perfil de Instagram
    const profile = await graphGet('/me', {
      fields: 'id,username,account_type,profile_picture_url'
    }, finalToken);
 
    // 4. Save to platform_tokens if user is authenticated
    if (authUserId) {
      await savePlatformToken(authUserId, 'instagram', {
        accessToken: finalToken,
        platformUserId: profile.id,
        platformUsername: profile.username,
        profilePic: profile.profile_picture_url,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        scopes: SCOPES
      });
    }
 
    // 5. Also update legacy session for backward compat
    session.accessToken = finalToken;
    session.igUserId = profile.id;
    session.username = profile.username;
    session.profilePic = profile.profile_picture_url;
 
    res.redirect('/?ig_connected=true');
 
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect(`/?ig_error=${encodeURIComponent(err.message)}`);
  }
});
 
// ── API: Estado de conexión ────────────────────────────────────
app.get('/api/status', optionalAuth, async (req, res) => {
  // Check per-user token first
  if (req.userId) {
    const igToken = await getUserPlatformToken(req.userId, 'instagram');
    if (igToken) {
      return res.json({
        connected: true,
        username: igToken.platform_username,
        profilePic: igToken.profile_pic,
        tokenSource: 'user'
      });
    }
  }
  // Legacy session fallback
  res.json({
    connected: !!session.accessToken && !!session.igUserId,
    username: session.username,
    profilePic: session.profilePic,
    tokenSource: session.accessToken ? 'session' : null
  });
});
 
// ── API: Posts del usuario ─────────────────────────────────────
app.get('/api/media', optionalAuth, async (req, res) => {
  let token = null;
  let igUserId = null;
 
  // Try per-user token first
  if (req.userId) {
    const igToken = await getUserPlatformToken(req.userId, 'instagram');
    if (igToken) {
      token = igToken.access_token;
      igUserId = igToken.platform_user_id;
    }
  }
 
  // Fallback to legacy session
  if (!token) {
    token = session.accessToken;
    igUserId = session.igUserId;
  }
 
  if (!token || !igUserId) {
    return res.status(401).json({ error: 'No conectado a Instagram' });
  }
 
  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const data = await graphGet(`/${igUserId}/media`, {
      fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,permalink,comments_count',
      limit
    }, token);
 
    // Filtrar: solo posts que pueden tener comentarios (no stories)
    const posts = (data.data || []).filter(
      p => ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'].includes(p.media_type)
    );
 
    res.json({ posts, paging: data.paging });
 
  } catch (err) {
    console.error('Media error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});
 
// ── API: Comentarios de un post ────────────────────────────────
app.get('/api/media/:id/comments', optionalAuth, async (req, res) => {
  let token = null;
 
  // Try per-user token first
  if (req.userId) {
    const igToken = await getUserPlatformToken(req.userId, 'instagram');
    if (igToken) token = igToken.access_token;
  }
 
  // Fallback to legacy session
  if (!token) token = session.accessToken;
 
  if (!token) {
    return res.status(401).json({ error: 'No conectado a Instagram' });
  }
 
  try {
    const { id } = req.params;
    let allComments = [];
    let url = `${GRAPH_BASE}/${id}/comments`
      + `?fields=id,text,username,from,timestamp`
      + `&limit=100`
      + `&access_token=${token}`;
 
    // Paginar hasta obtener todos los comentarios
    let pages = 0;
    const maxPages = 50; // Límite de seguridad (5000 comentarios)
    while (url && pages < maxPages) {
      const commentsRes = await fetch(url);
      const commentsData = await commentsRes.json();
      if (commentsData.error) throw new Error(commentsData.error.message);
 
      allComments = allComments.concat(commentsData.data || []);
      url = commentsData.paging?.next || null;
      pages++;
    }
 
    // Normalizar: extraer username de 'from' si no viene directo
    const normalized = allComments.map(c => ({
      ...c,
      username: c.username || c.from?.username || 'usuario_' + (c.id || '').slice(-4)
    }));
 
    res.json({
      comments: normalized,
      total: normalized.length,
      truncated: pages >= maxPages
    });
 
  } catch (err) {
    console.error('Comments error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});
 
// ── API: Desconectar plataforma ────────────────────────────────
app.post('/api/disconnect', optionalAuth, async (req, res) => {
  const { platform } = req.body;
 
  // If authenticated user, remove from DB
  if (req.userId && platform) {
    await db.run('DELETE FROM platform_tokens WHERE user_id = $1 AND platform = $2', [req.userId, platform]);
  }
 
  // Also clear legacy session for Instagram
  if (!platform || platform === 'instagram') {
    session = { accessToken: null, igUserId: null, username: null, profilePic: null };
  }
 
  res.json({ ok: true });
});
 
// ── API: Connected platforms for user ─────────────────────────
app.get('/api/platforms', authMiddleware, async (req, res) => {
  try {
    const tokens = await db.all(
      'SELECT platform, platform_username, profile_pic, token_expires_at, updated_at FROM platform_tokens WHERE user_id = $1',
      [req.userId]
    );
    res.json({
      platforms: tokens.map(t => ({
        platform: t.platform,
        username: t.platform_username,
        profilePic: t.profile_pic,
        expiresAt: t.token_expires_at,
        connectedAt: t.updated_at
      })),
      youtubeApiConfigured: !!YOUTUBE_API_KEY
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ── API: Instagram Scraper (múltiples APIs de RapidAPI) ────────────
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
 
// Multiple RapidAPI scrapers — each has its own free quota (~100 req/month)
// Tries them in order; if one fails (quota, error), moves to the next
const IG_SCRAPERS = [
  {
    name: 'stable-api',
    host: 'instagram-scraper-stable-api.p.rapidapi.com',
    posts: { url: '/get_ig_user_posts.php', method: 'POST', form: true },
    comments: { url: '/get_post_comments.php', method: 'GET' },
    buildPostsBody: (user, amount, token) => {
      const p = new URLSearchParams();
      p.append('username_or_url', `https://www.instagram.com/${user}/`);
      p.append('pagination_token', token || '');
      p.append('amount', String(amount));
      return p.toString();
    },
    buildCommentsUrl: (host, code, sort) =>
      `https://${host}/get_post_comments.php?media_code=${encodeURIComponent(code)}&sort_order=${sort}`,
    parsePosts: (data) => {
      const rawItems = data.posts || data.collector || data.items || data.data || data.medias || [];
      return rawItems.map(raw => {
        const item = raw.node || raw;
        return {
          shortcode: item.shortcode || item.code || '',
          thumbnail: item.thumbnail_url || item.display_url || item.thumbnail_src || item.image_versions2?.candidates?.[0]?.url || '',
          caption: (typeof item.caption === 'object' ? item.caption?.text : item.caption) || item.description || item.edge_media_to_caption?.edges?.[0]?.node?.text || '',
          likes: item.like_count || item.likes?.count || item.edge_media_preview_like?.count || 0,
          comments_count: item.comment_count || item.comments?.count || item.edge_media_to_comment?.count || 0,
          timestamp: item.taken_at || item.taken_at_timestamp || item.timestamp || null,
          type: item.media_type === 2 ? 'video' : item.media_type === 8 ? 'carousel' : 'image'
        };
      });
    },
    paginationToken: (data) => data.pagination_token || data.next_max_id || null
  },
  {
    name: 'scraper-ai',
    host: 'instagram-scraper-ai1.p.rapidapi.com',
    posts: { url: '/user/feed_v2/', method: 'GET' },
    comments: { url: '/media/comments/', method: 'GET' },
    usesMediaId: true,
    buildPostsUrl: (host, user) =>
      `https://${host}/user/feed_v2/?username=${encodeURIComponent(user)}`,
    buildCommentsUrl: (host, codeOrMediaId) =>
      `https://${host}/media/comments/?media_id=${encodeURIComponent(codeOrMediaId)}`,
    parsePosts: (data) => {
      const rawItems = data.data?.items || data.items || data.data || [];
      return rawItems.map(raw => {
        const item = raw.node || raw; // unwrap node wrapper
        return {
          shortcode: item.code || item.shortcode || '',
          media_id: item.pk || item.id || '',
          thumbnail: item.image_versions2?.candidates?.[0]?.url || item.thumbnail_url || item.display_url || '',
          caption: (typeof item.caption === 'object' ? item.caption?.text : item.caption) || '',
          likes: item.like_count || item.likes_count || 0,
          comments_count: item.comment_count || item.comments_count || 0,
          timestamp: item.taken_at || null,
          type: item.media_type === 2 ? 'video' : item.media_type === 8 ? 'carousel' : 'image'
        };
      });
    },
    paginationToken: (data) => data.paging_info?.next_max_id || data.data?.next_cursor || data.next_cursor || null
  },
];
 
// Generic function to try all scrapers for posts
async function scrapeIgPosts(cleanUser, amount, pagination_token) {
  if (!RAPIDAPI_KEY) return null;
 
  for (const scraper of IG_SCRAPERS) {
    try {
      let response;
      if (scraper.posts.method === 'POST' && scraper.posts.form) {
        response = await fetch(`https://${scraper.host}${scraper.posts.url}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-rapidapi-host': scraper.host,
            'x-rapidapi-key': RAPIDAPI_KEY
          },
          body: scraper.buildPostsBody(cleanUser, amount, pagination_token)
        });
      } else {
        const url = scraper.buildPostsUrl(scraper.host, cleanUser);
        response = await fetch(url, {
          headers: {
            'x-rapidapi-host': scraper.host,
            'x-rapidapi-key': RAPIDAPI_KEY
          }
        });
      }
 
      const rawText = await response.text();
      if (response.status === 429 || response.status === 503) {
        console.log(`IG [${scraper.name}]: quota/unavailable (${response.status}), trying next...`);
        continue;
      }
 
      let data;
      try { data = JSON.parse(rawText); } catch { continue; }
 
      // Check for error messages (quota exceeded, etc)
      const errMsg = data.error || data.message || '';
      if (typeof errMsg === 'string' && (errMsg.includes('exceeded') || errMsg.includes('quota') || errMsg.includes('limit') || errMsg.includes('subscribe'))) {
        console.log(`IG [${scraper.name}]: ${errMsg.substring(0, 80)}, trying next...`);
        continue;
      }
      if (data.error || (data.message && !data.data)) continue;
 
      const posts = scraper.parsePosts(data);
      if (posts.length === 0) continue;
 
      console.log(`IG [${scraper.name}]: OK — ${posts.length} posts`);
      return {
        success: true,
        username: cleanUser,
        posts,
        pagination_token: scraper.paginationToken(data),
        total: posts.length,
        source: scraper.name
      };
    } catch (err) {
      console.log(`IG [${scraper.name}]: error — ${err.message}, trying next...`);
      continue;
    }
  }
  return null;
}
 
// Helper to parse comments from any API format
function parseCommentsFromData(data) {
  const comments = [];
  const items = data.data?.comments || data.comments || data.collector || data.data || [];
  for (const c of items) {
    const username = c.username || c.user?.username || c.owner?.username || 'unknown';
    const text = c.text || c.comment || '';
    if (!username || username === 'unknown') continue;
    comments.push({
      username, text,
      timestamp: c.created_at || c.timestamp || c.created_at_utc || null,
      likes: c.like_count || c.likes?.count || c.comment_like_count || 0
    });

    const replies = c.replies || c.child_comments || c.edge_threaded_comments?.edges || [];
    for (const r of replies) {
      const rn = r.node || r;
      const rUsername = rn.username || rn.user?.username || rn.owner?.username || 'unknown';
      if (!rUsername || rUsername === 'unknown') continue;
      comments.push({
        username: rUsername,
        text: rn.text || rn.comment || '',
        timestamp: rn.created_at || rn.timestamp || null,
        likes: rn.like_count || 0,
        is_reply: true
      });
    }
  }
  return comments;
}

// Generic function to try all scrapers for comments
async function scrapeIgComments(code, sort, mediaId) {
  if (!RAPIDAPI_KEY) return null;

  for (const scraper of IG_SCRAPERS) {
    // Skip scrapers that need media_id if we don't have one
    if (scraper.usesMediaId && !mediaId) {
      console.log(`IG comments [${scraper.name}]: skipped — needs media_id but none provided`);
      continue;
    }

    try {
      const identifier = scraper.usesMediaId ? mediaId : code;
      const baseUrl = scraper.buildCommentsUrl(scraper.host, identifier, sort || 'popular');

      // Pagination support
      const MAX_PAGES = 20;
      let allComments = [];
      let nextCursor = null;
      let page = 0;

      do {
        let url = baseUrl;
        if (nextCursor) {
          url += (url.includes('?') ? '&' : '?') + `end_cursor=${encodeURIComponent(nextCursor)}`;
        }

        const response = await fetch(url, {
          headers: {
            'x-rapidapi-host': scraper.host,
            'x-rapidapi-key': RAPIDAPI_KEY
          }
        });

        if (response.status === 429 || response.status === 503) {
          console.log(`IG comments [${scraper.name}]: quota/unavailable, trying next...`);
          break;
        }

        const data = await response.json();
        const errMsg = data.error || data.message || '';
        if (typeof errMsg === 'string' && (errMsg.includes('exceeded') || errMsg.includes('quota') || errMsg.includes('limit'))) {
          console.log(`IG comments [${scraper.name}]: quota exceeded, trying next...`);
          break;
        }
        if (data.error) break;

        const pageComments = parseCommentsFromData(data);
        allComments = allComments.concat(pageComments);
        page++;

        // Check for next page
        const pageInfo = data.page_info || data.data?.page_info || {};
        if (pageInfo.has_next_page && pageInfo.end_cursor) {
          nextCursor = pageInfo.end_cursor;
          console.log(`IG comments [${scraper.name}]: page ${page} — ${pageComments.length} comments, fetching next...`);
        } else {
          nextCursor = null;
        }
      } while (nextCursor && page < MAX_PAGES);

      if (allComments.length === 0) continue;
      console.log(`IG comments [${scraper.name}]: OK — ${allComments.length} total comments in ${page} page(s)`);
      return { comments: allComments, source: scraper.name };
    } catch (err) {
      console.log(`IG comments [${scraper.name}]: error — ${err.message}, trying next...`);
      continue;
    }
  }
  return null;
}
 
// Get user posts by username
app.post('/api/ig/posts', optionalAuth, async (req, res) => {
  const { username, amount = 12, pagination_token = '' } = req.body;
  if (!username) return res.status(400).json({ error: 'Username requerido' });
 
  let cleanUser = username.trim().replace(/^@/, '');
  if (cleanUser.includes('instagram.com/')) {
    const match = cleanUser.match(/instagram\.com\/([^/?]+)/);
    if (match) cleanUser = match[1];
  }
 
  try {
    console.log(`IG scrape: trying APIs for @${cleanUser}...`);
    const result = await scrapeIgPosts(cleanUser, amount, pagination_token);
    if (result && result.posts.length > 0) {
      return res.json(result);
    }
    console.log('IG scrape: all APIs failed');
    res.json({ success: true, username: cleanUser, posts: [], pagination_token: null, total: 0 });
  } catch (err) {
    console.error('IG posts error:', err.message);
    res.status(500).json({ error: 'Error al obtener posts: ' + err.message });
  }
});
 
// Image proxy for Instagram CDN (hotlink blocking workaround)
app.get('/api/ig/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL requerida');
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('cdninstagram.com') && !parsed.hostname.includes('fbcdn.net') && !parsed.hostname.includes('instagram.com')) {
      return res.status(403).send('Dominio no permitido');
    }
  } catch { return res.status(400).send('URL inválida'); }
  try {
    const imgRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://www.instagram.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
    if (!imgRes.ok) return res.status(imgRes.status).send('Error fetching image');
    res.set('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error('Image proxy error:', err.message);
    res.status(500).send('Error proxy imagen');
  }
});

// Get post comments by shortcode or media_id
app.get('/api/ig/comments', optionalAuth, async (req, res) => {
  const { code, sort = 'popular', media_id } = req.query;
  if (!code && !media_id) return res.status(400).json({ error: 'Media code requerido' });

  try {
    console.log(`IG comments: trying APIs for code=${code || 'N/A'}, media_id=${media_id || 'N/A'}...`);
    const result = await scrapeIgComments(code, sort, media_id);
    if (result && result.comments.length > 0) {
      return res.json({ success: true, shortcode: code, comments: result.comments, total: result.comments.length, source: result.source });
    }
    console.log('IG comments: all APIs failed');
    res.json({ success: true, shortcode: code, comments: [], total: 0 });
  } catch (err) {
    console.error('IG comments error:', err.message);
    res.status(500).json({ error: 'Error al obtener comentarios: ' + err.message });
  }
});
 
// ── API: Scrape comentarios por URL (multi-plataforma) ─────
function extractShortcode(url) {
  const patterns = [
    /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/,
    /instagr\.am\/p\/([A-Za-z0-9_-]+)/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
 
function extractYouTubeId(url) {
  const patterns = [
    /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
 
function extractTikTokId(url) {
  const m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  return m ? m[1] : null;
}
 
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/instagram\.com|instagr\.am/i.test(url)) return 'instagram';
  return null;
}
 
// ── YouTube: Data API v3 + scraping fallback ──
async function fetchYouTubeCommentsAPI(videoId) {
  if (!YOUTUBE_API_KEY) return null;
 
  const comments = [];
  let nextPageToken = null;
  const maxPages = 10; // Up to ~1000 comments
  let pages = 0;
 
  try {
    do {
      const params = new URLSearchParams({
        part: 'snippet',
        videoId,
        maxResults: '100',
        order: 'relevance',
        textFormat: 'plainText',
        key: YOUTUBE_API_KEY
      });
      if (nextPageToken) params.set('pageToken', nextPageToken);
 
      const apiRes = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?${params}`);
      if (!apiRes.ok) {
        const errData = await apiRes.json().catch(() => ({}));
        console.error('YouTube API error:', apiRes.status, errData?.error?.message);
        if (apiRes.status === 403) return null; // quota exceeded or comments disabled
        return null;
      }
 
      const data = await apiRes.json();
      for (const item of (data.items || [])) {
        const snippet = item.snippet?.topLevelComment?.snippet;
        if (snippet) {
          comments.push({
            username: snippet.authorDisplayName || 'unknown',
            text: snippet.textDisplay || '',
            timestamp: snippet.publishedAt || '',
            likeCount: snippet.likeCount || 0
          });
        }
      }
 
      nextPageToken = data.nextPageToken || null;
      pages++;
    } while (nextPageToken && pages < maxPages);
 
    return comments;
  } catch (e) {
    console.error('YouTube API fetch error:', e.message);
    return null;
  }
}
 
async function scrapeYouTubeCommentsFallback(videoId) {
  const comments = [];
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': randomUA(),
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const match = html.match(/var ytInitialData\s*=\s*({.*?});\s*<\/script>/s);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
          if (contents) {
            for (const section of contents) {
              const items = section?.itemSectionRenderer?.contents;
              if (items) {
                for (const item of items) {
                  const commentRenderer = item?.commentThreadRenderer?.comment?.commentRenderer;
                  if (commentRenderer) {
                    const username = commentRenderer.authorText?.simpleText || 'unknown';
                    const text = (commentRenderer.contentText?.runs || []).map(r => r.text).join('');
                    const timestamp = commentRenderer.publishedTimeText?.runs?.[0]?.text || '';
                    comments.push({ username, text, timestamp });
                  }
                }
              }
            }
          }
        } catch (pe) { /* parse error */ }
      }
    }
  } catch (e) { /* page fetch failed */ }
  return comments;
}
 
async function scrapeYouTubeComments(videoId) {
  let postInfo = null;
 
  // Always get post info from oEmbed (free, no quota)
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      postInfo = {
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        author: oembed.author_name,
        title: oembed.title
      };
    }
  } catch (e) { /* oEmbed failed */ }
 
  if (!postInfo) {
    postInfo = { thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, author: null, title: null };
  }
 
  // Try YouTube Data API v3 first
  let comments = await fetchYouTubeCommentsAPI(videoId);
  let method = 'youtube_api';
 
  // Fallback to scraping if API unavailable or returned nothing
  if (!comments || comments.length === 0) {
    comments = await scrapeYouTubeCommentsFallback(videoId);
    method = comments.length > 0 ? 'youtube_scrape' : 'none';
  }
 
  return { comments: comments || [], post: postInfo, method };
}
 
// ── TikTok comment scraping (multiple methods) ──
async function scrapeTikTokComments(url) {
  let postInfo = null;
  let comments = [];
  let method = 'none';
 
  // Extract video ID
  const videoId = extractTikTokId(url);
 
  // 1. oEmbed for post info (always works)
  try {
    const oembedRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      postInfo = {
        thumbnail: oembed.thumbnail_url,
        author: oembed.author_name,
        title: oembed.title
      };
    }
  } catch (e) { /* oEmbed failed */ }
 
  // 2. Try TikTok web API endpoint for comments
  if (videoId) {
    try {
      const apiUrl = `https://www.tiktok.com/api/comment/list/?aweme_id=${videoId}&count=50&cursor=0`;
      const apiRes = await fetch(apiUrl, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'application/json',
          'Referer': 'https://www.tiktok.com/',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data.comments && Array.isArray(data.comments)) {
          comments = data.comments.map(c => ({
            username: c.user?.unique_id || c.user?.nickname || 'unknown',
            text: c.text || '',
            timestamp: c.create_time ? new Date(c.create_time * 1000).toISOString() : '',
            likeCount: c.digg_count || 0
          }));
          if (comments.length > 0) method = 'tiktok_web_api';
        }
      }
    } catch (e) { /* web API failed */ }
  }
 
  // 3. Try page fetch with embedded data extraction
  if (comments.length === 0) {
    try {
      const pageRes = await fetch(url, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        // Try to extract SIGI_STATE or __UNIVERSAL_DATA_FOR_REHYDRATION__
        const sigiMatch = html.match(/<script id="SIGI_STATE"[^>]*>(.*?)<\/script>/s)
          || html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
        if (sigiMatch) {
          try {
            const sigiData = JSON.parse(sigiMatch[1]);
            // Navigate to comments in the data structure
            const commentList = sigiData?.ItemModule?.[videoId]?.comments
              || sigiData?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct?.comments;
            if (Array.isArray(commentList)) {
              comments = commentList.map(c => ({
                username: c.user?.uniqueId || c.user?.nickname || 'unknown',
                text: c.text || '',
                timestamp: c.createTime ? new Date(c.createTime * 1000).toISOString() : ''
              }));
              if (comments.length > 0) method = 'tiktok_html_parse';
            }
          } catch (pe) { /* parse error */ }
        }
 
        // Extract post info from page if oEmbed failed
        if (!postInfo) {
          const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
          if (titleMatch) {
            postInfo = { thumbnail: null, author: null, title: titleMatch[1] };
          }
        }
      }
    } catch (e) { /* page fetch failed */ }
  }
 
  return { comments, post: postInfo, method };
}
 
app.post('/api/scrape', optionalAuth, async (req, res) => {
  const { url, platform: clientPlatform } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
 
  const platform = clientPlatform || detectPlatform(url) || 'instagram';
 
  // ── YouTube ──
  if (platform === 'youtube') {
    const videoId = extractYouTubeId(url);
    if (!videoId) return res.status(400).json({ error: 'URL de YouTube no válida. Usá un link de video, short o live.' });
    try {
      const { comments, post, method } = await scrapeYouTubeComments(videoId);
      return res.json({
        success: true, shortcode: videoId, post, comments,
        total: comments.length, method,
        note: comments.length === 0 ? 'No se pudieron extraer comentarios de YouTube automáticamente. Podés configurar tu YouTube API Key en el dashboard, o pegar los comentarios manualmente.' : null,
        apiConfigured: !!YOUTUBE_API_KEY
      });
    } catch (err) {
      return res.status(500).json({ error: 'Error al procesar video de YouTube: ' + err.message });
    }
  }
 
  // ── TikTok ──
  if (platform === 'tiktok') {
    try {
      const { comments, post, method } = await scrapeTikTokComments(url);
      return res.json({
        success: true, shortcode: extractTikTokId(url) || 'tiktok', post, comments,
        total: comments.length, method,
        note: comments.length === 0 ? 'No se pudieron extraer comentarios de TikTok automáticamente. TikTok limita el acceso. Podés copiar y pegar los comentarios manualmente desde la app.' : null
      });
    } catch (err) {
      return res.status(500).json({ error: 'Error al procesar video de TikTok: ' + err.message });
    }
  }
 
  // ── Instagram (original flow) ──
 
  const shortcode = extractShortcode(url);
  if (!shortcode) return res.status(400).json({ error: 'URL de Instagram no válida. Usá un link de post, reel o carrusel.' });
 
  try {
    // 1. Obtener info del post via oEmbed
    let postInfo = null;
    try {
      const oembedUrl = `https://graph.facebook.com/v20.0/instagram_oembed`
        + `?url=${encodeURIComponent(url)}`
        + `&access_token=${FB_APP_ID}|${FB_APP_SECRET}`
        + `&fields=thumbnail_url,author_name,media_id`;
      const oRes = await fetch(oembedUrl);
      if (oRes.ok) {
        postInfo = await oRes.json();
      }
    } catch (e) { /* oEmbed failed, continue */ }
 
    // 2. Intentar obtener comentarios via la API pública de Instagram
    let comments = [];
    let method = 'none';
 
    // Método A: Instagram GraphQL endpoint
    try {
      const graphqlUrl = `https://www.instagram.com/graphql/query/`
        + `?query_hash=bc3296d1ce80a24b1b6e40b1e72903f5`
        + `&variables=${encodeURIComponent(JSON.stringify({ shortcode, first: 100 }))}`;
      const gRes = await fetch(graphqlUrl, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      if (gRes.ok) {
        const gData = await gRes.json();
        const edges = gData?.data?.shortcode_media?.edge_media_to_parent_comment?.edges || [];
        comments = edges.map(e => ({
          username: e.node?.owner?.username || 'unknown',
          text: e.node?.text || '',
          timestamp: e.node?.created_at ? new Date(e.node.created_at * 1000).toISOString() : null
        }));
        if (comments.length > 0) method = 'graphql';
 
        if (!postInfo) {
          const media = gData?.data?.shortcode_media;
          if (media) {
            postInfo = {
              thumbnail_url: media.display_url,
              author_name: media.owner?.username
            };
          }
        }
      }
    } catch (e) { /* GraphQL failed */ }
 
    // Método B: Fetch de la página del post y parsear JSON embebido
    if (comments.length === 0) {
      try {
        const pageRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
          headers: {
            'User-Agent': randomUA(),
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          const jsonMatch = html.match(/window\._sharedData\s*=\s*({.*?});\s*<\/script>/s)
            || html.match(/"edge_media_to_parent_comment":\s*(\{.*?\})\s*,\s*"edge_media_to_hoisted_comment"/s);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[1]);
              const media = parsed?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
              if (media) {
                const edges = media.edge_media_to_parent_comment?.edges || [];
                comments = edges.map(e => ({
                  username: e.node?.owner?.username || 'unknown',
                  text: e.node?.text || '',
                  timestamp: e.node?.created_at ? new Date(e.node.created_at * 1000).toISOString() : null
                }));
                if (comments.length > 0) method = 'html_parse';
                if (!postInfo) {
                  postInfo = {
                    thumbnail_url: media.display_url,
                    author_name: media.owner?.username
                  };
                }
              }
            } catch (pe) { /* parse error */ }
          }
        }
      } catch (e) { /* page fetch failed */ }
    }
 
    // Método C: Si tenemos sesión activa de Instagram, usar la API oficial
    if (comments.length === 0 && postInfo?.media_id) {
      let igToken = null;
      // Try per-user token first
      if (req.userId) {
        const userIg = await getUserPlatformToken(req.userId, 'instagram');
        if (userIg) igToken = userIg.access_token;
      }
      // Fallback to legacy session
      if (!igToken) igToken = session.accessToken;
 
      if (igToken) {
        try {
          const data = await graphGet(`/${postInfo.media_id}/comments`, {
            fields: 'id,text,username,timestamp',
            limit: 100
          }, igToken);
          comments = (data.data || []).map(c => ({
            username: c.username || 'unknown',
            text: c.text || '',
            timestamp: c.timestamp
          }));
          if (comments.length > 0) method = 'api_fallback';
        } catch (e) { /* API fallback failed */ }
      }
    }
 
    res.json({
      success: true,
      shortcode,
      post: postInfo ? {
        thumbnail: postInfo.thumbnail_url,
        author: postInfo.author_name
      } : null,
      comments,
      total: comments.length,
      method,
      note: comments.length === 0
        ? 'No se pudieron extraer comentarios automáticamente. Instagram bloquea el acceso público a comentarios. Podés conectar tu cuenta de Instagram o pegar los comentarios manualmente.'
        : null
    });
 
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: 'Error al procesar la URL: ' + err.message });
  }
});
 
// ── API: Manual comment input (paste from any platform) ──────
app.post('/api/comments/manual', (req, res) => {
  const { text, platform, postUrl } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Texto de comentarios requerido' });
  }
 
  // Parse comments from pasted text — one per line
  // Supports formats:
  //   @username comment text
  //   username: comment text
  //   username comment text
  //   just plain comment text (username = "participante_N")
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const comments = [];
  const seen = new Set();
 
  for (const line of lines) {
    let username = null;
    let commentText = line;
 
    // Try @username format
    const atMatch = line.match(/^@([A-Za-z0-9._]+)\s+(.*)/);
    if (atMatch) {
      username = atMatch[1];
      commentText = atMatch[2];
    } else {
      // Try "username: text" format
      const colonMatch = line.match(/^([A-Za-z0-9._]{2,30}):\s+(.*)/);
      if (colonMatch) {
        username = colonMatch[1];
        commentText = colonMatch[2];
      } else {
        // Try "username text" (first word as username if it looks like one)
        const spaceMatch = line.match(/^([A-Za-z0-9._]{2,30})\s+(.*)/);
        if (spaceMatch && /[a-z]/i.test(spaceMatch[1]) && !/\s/.test(spaceMatch[1])) {
          username = spaceMatch[1];
          commentText = spaceMatch[2];
        }
      }
    }
 
    if (!username) {
      username = `participante_${comments.length + 1}`;
      commentText = line;
    }
 
    // For giveaways, extract just usernames if text is just a username
    const entry = {
      username: username.replace(/^@/, ''),
      text: commentText || '',
      timestamp: new Date().toISOString()
    };
 
    // Dedup key
    const key = `${entry.username}::${entry.text}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      comments.push(entry);
    }
  }
 
  res.json({
    success: true,
    comments,
    total: comments.length,
    method: 'manual_paste',
    platform: platform || 'manual',
    postUrl: postUrl || null,
    note: null
  });
});
 
// ── API: Parse usernames list (for sorteos that only need usernames) ──
app.post('/api/comments/usernames', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Lista de usuarios requerida' });
  }
 
  // Parse usernames — one per line, or comma/space separated
  // Handles: @user1, @user2, user3
  const raw = text
    .replace(/,/g, '\n')
    .split('\n')
    .map(l => l.trim().replace(/^@/, ''))
    .filter(l => l.length > 0 && /^[A-Za-z0-9._]+$/.test(l));
 
  // Dedup
  const unique = [...new Set(raw.map(u => u.toLowerCase()))];
  const comments = unique.map(username => ({
    username,
    text: '',
    timestamp: new Date().toISOString()
  }));
 
  res.json({
    success: true,
    comments,
    total: comments.length,
    method: 'username_list',
    note: null
  });
});
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 6: AUTH API
// ══════════════════════════════════════════════════════════════
 
// ── Verification email HTML ──
function verificationEmailHTML(name, code) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#060614;color:#e0e0f8;padding:2rem;border-radius:12px">
      <h1 style="color:#00e5ff;font-size:1.5rem;margin-bottom:.5rem">Verificá tu email</h1>
      <p style="color:#8b8fa3;margin-bottom:1rem">Hola ${name || 'ahí'},</p>
      <p>Tu código de verificación es:</p>
      <div style="background:#0c0c24;border:2px solid rgba(0,229,255,.3);border-radius:10px;padding:1.2rem;text-align:center;margin:1.5rem 0">
        <p style="color:#00e5ff;font-size:2.2rem;font-weight:bold;letter-spacing:.3em;margin:0">${code}</p>
      </div>
      <p style="color:#6a6a8a;font-size:.8rem">Este código expira en 24 horas. Si no creaste esta cuenta, ignorá este email.</p>
      <hr style="border:none;border-top:1px solid rgba(0,229,255,.12);margin:1.5rem 0">
      <p style="color:#3a3a55;font-size:.7rem;text-align:center">RAFLY — Sorteos en vivo</p>
    </div>`;
}
 
// ── Password reset email HTML ──
function resetPasswordEmailHTML(name, code) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#060614;color:#e0e0f8;padding:2rem;border-radius:12px">
      <h1 style="color:#ffd700;font-size:1.5rem;margin-bottom:.5rem">Restablecer contraseña</h1>
      <p style="color:#8b8fa3;margin-bottom:1rem">Hola ${name || 'ahí'},</p>
      <p>Recibimos una solicitud para restablecer tu contraseña. Tu código es:</p>
      <div style="background:#0c0c24;border:2px solid rgba(255,215,0,.3);border-radius:10px;padding:1.2rem;text-align:center;margin:1.5rem 0">
        <p style="color:#ffd700;font-size:2.2rem;font-weight:bold;letter-spacing:.3em;margin:0">${code}</p>
      </div>
      <p style="color:#6a6a8a;font-size:.8rem">Este código expira en 1 hora. Si no solicitaste esto, ignorá este email — tu contraseña no cambiará.</p>
      <hr style="border:none;border-top:1px solid rgba(0,229,255,.12);margin:1.5rem 0">
      <p style="color:#3a3a55;font-size:.7rem;text-align:center">RAFLY — Sorteos en vivo</p>
    </div>`;
}
 
// ── Billing email templates ──
function upgradeEmailHTML(name, plan) {
  const planName = plan === 'enterprise' ? 'Enterprise' : 'Pro';
  const color = plan === 'enterprise' ? '#ffd700' : '#00e5ff';
  return `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#060614;color:#e0e0f8;padding:2rem;border-radius:12px">
      <h1 style="color:${color};font-size:1.5rem;margin-bottom:.5rem">🎉 ¡Bienvenido al plan ${planName}!</h1>
      <p style="color:#8b8fa3;margin-bottom:1rem">Hola ${name || 'ahí'},</p>
      <p>Tu suscripción al plan <strong style="color:${color}">${planName}</strong> ya está activa. Ahora tenés acceso a:</p>
      <ul style="color:#b0b0d0;padding-left:1.2rem;margin:1rem 0">
        ${plan === 'enterprise' ? `
          <li>Sorteos y participantes ilimitados</li>
          <li>Marca blanca completa</li>
          <li>OBS overlay dedicado</li>
          <li>API access + multi-usuario</li>
        ` : `
          <li>Sorteos ilimitados</li>
          <li>Hasta 5.000 participantes</li>
          <li>Modo presentación fullscreen</li>
          <li>Dashboard completo + PDF export</li>
        `}
      </ul>
      <div style="margin:1.5rem 0">
        <a href="https://rafly.onrender.com" style="display:inline-block;background:${color};color:#060614;padding:.6rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:bold">Ir a RAFLY →</a>
      </div>
      <p style="color:#6a6a8a;font-size:.8rem">Podés gestionar tu suscripción desde el Dashboard → Billing en cualquier momento.</p>
      <hr style="border:none;border-top:1px solid rgba(0,229,255,.12);margin:1.5rem 0">
      <p style="color:#3a3a55;font-size:.7rem;text-align:center">RAFLY — Sorteos en vivo</p>
    </div>`;
}
 
function paymentFailedEmailHTML(name, daysLeft) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#060614;color:#e0e0f8;padding:2rem;border-radius:12px">
      <h1 style="color:#ff4466;font-size:1.5rem;margin-bottom:.5rem">⚠️ Problema con tu pago</h1>
      <p style="color:#8b8fa3;margin-bottom:1rem">Hola ${name || 'ahí'},</p>
      <p>No pudimos procesar el pago de tu suscripción de RAFLY. Tu plan sigue activo por <strong style="color:#ff4466">${daysLeft} días más</strong> mientras resolvemos esto.</p>
      <div style="background:#0c0c24;border:2px solid rgba(255,68,102,.3);border-radius:10px;padding:1rem;margin:1.5rem 0">
        <p style="color:#ff8888;font-size:.85rem;margin:0">🔧 <strong>¿Qué podés hacer?</strong></p>
        <p style="color:#b0b0d0;font-size:.82rem;margin:.5rem 0 0">Actualizá tu método de pago desde tu Dashboard → Billing, o contactanos si necesitás ayuda.</p>
      </div>
      <div style="margin:1.5rem 0">
        <a href="https://rafly.onrender.com/?action=billing" style="display:inline-block;background:#ff4466;color:#fff;padding:.6rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:bold">Actualizar método de pago →</a>
      </div>
      <p style="color:#6a6a8a;font-size:.8rem">Si no actualizás tu pago, tu plan cambiará a Free automáticamente al finalizar el período de gracia.</p>
      <hr style="border:none;border-top:1px solid rgba(0,229,255,.12);margin:1.5rem 0">
      <p style="color:#3a3a55;font-size:.7rem;text-align:center">RAFLY — Sorteos en vivo</p>
    </div>`;
}
 
function downgradeEmailHTML(name) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#060614;color:#e0e0f8;padding:2rem;border-radius:12px">
      <h1 style="color:#ff8c00;font-size:1.5rem;margin-bottom:.5rem">Tu plan cambió a Free</h1>
      <p style="color:#8b8fa3;margin-bottom:1rem">Hola ${name || 'ahí'},</p>
      <p>Tu suscripción de RAFLY fue cancelada o expiró. Tu cuenta ahora está en el plan <strong style="color:#39ff14">Free</strong>.</p>
      <p style="margin-top:1rem">Todavía podés usar RAFLY con las funciones gratuitas (3 sorteos por día, hasta 100 participantes).</p>
      <div style="margin:1.5rem 0">
        <a href="https://rafly.onrender.com/pricing.html" style="display:inline-block;background:#00e5ff;color:#060614;padding:.6rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:bold">Reactivar mi plan →</a>
      </div>
      <p style="color:#6a6a8a;font-size:.8rem">Tus sorteos anteriores y datos no se pierden — siguen en tu cuenta.</p>
      <hr style="border:none;border-top:1px solid rgba(0,229,255,.12);margin:1.5rem 0">
      <p style="color:#3a3a55;font-size:.7rem;text-align:center">RAFLY — Sorteos en vivo</p>
    </div>`;
}
 
// ── Rate Limiters (must be before auth routes) ──
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intentá de nuevo en unos minutos.' }
});
app.use('/api/', globalLimiter);
 
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá 15 minutos.' }
});
 
// ── Register ──
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
 
  const normalizedEmail = email.trim().toLowerCase();
 
  try {
    const existing = await db.get('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
 
    const hashed = await bcrypt.hash(password, 10);
    const verificationCode = String(crypto.randomInt(100000, 999999));
    const result = await db.get(
      'INSERT INTO users (email, password, name, verification_token) VALUES ($1, $2, $3, $4) RETURNING id',
      [normalizedEmail, hashed, name || '', verificationCode]
    );
    const userId = result.id;
 
    // Send verification email
    sendEmail(normalizedEmail, 'Verificá tu email — RAFLY', verificationEmailHTML(name, verificationCode)).catch(() => {});
 
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [userId]
    );
 
    res.status(201).json({ token, user, needsVerification: true });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Error al crear cuenta' });
  }
});
 
// ── Verify email ──
app.post('/api/auth/verify-email', authMiddleware, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido' });
 
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.email_verified) return res.json({ ok: true, message: 'Email ya verificado' });
 
    if (user.verification_token !== String(code).trim()) {
      return res.status(400).json({ error: 'Código incorrecto' });
    }
 
    await db.run(
      'UPDATE users SET email_verified = 1, verification_token = NULL, updated_at = NOW() WHERE id = $1',
      [req.userId]
    );
 
    // Send welcome email
    sendEmail(user.email, '¡Bienvenido a RAFLY! 🎰', welcomeEmailHTML(user.name)).catch(() => {});
 
    res.json({ ok: true, message: 'Email verificado exitosamente' });
  } catch (err) {
    console.error('Verify email error:', err.message);
    res.status(500).json({ error: 'Error al verificar email' });
  }
});
 
// ── Resend verification code ──
app.post('/api/auth/resend-verification', authLimiter, authMiddleware, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.email_verified) return res.json({ ok: true, message: 'Email ya verificado' });
 
    const newCode = String(crypto.randomInt(100000, 999999));
    await db.run('UPDATE users SET verification_token = $1 WHERE id = $2', [newCode, req.userId]);
 
    await sendEmail(user.email, 'Tu nuevo código — RAFLY', verificationEmailHTML(user.name, newCode));
 
    res.json({ ok: true, message: 'Código reenviado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al reenviar código' });
  }
});
 
// ── Request password reset ──
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
 
  const normalizedEmail = email.trim().toLowerCase();
 
  try {
    const user = await db.get('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    // Always return success to prevent email enumeration
    if (!user) return res.json({ ok: true, message: 'Si el email existe, recibirás un código para restablecer tu contraseña.' });
 
    const resetCode = String(crypto.randomInt(100000, 999999));
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
 
    await db.run(
      'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
      [resetCode, expires.toISOString(), user.id]
    );
 
    await sendEmail(normalizedEmail, 'Restablecer contraseña — RAFLY', resetPasswordEmailHTML(user.name, resetCode));
 
    res.json({ ok: true, message: 'Si el email existe, recibirás un código para restablecer tu contraseña.' });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ error: 'Error al procesar solicitud' });
  }
});
 
// ── Reset password with code ──
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Email, código y nueva contraseña requeridos' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
 
  const normalizedEmail = email.trim().toLowerCase();
 
  try {
    const user = await db.get('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (!user || !user.reset_token) {
      return res.status(400).json({ error: 'Código inválido o expirado' });
    }
 
    // Check expiration
    if (user.reset_token_expires && new Date(user.reset_token_expires) < new Date()) {
      await db.run('UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE id = $1', [user.id]);
      return res.status(400).json({ error: 'Código expirado. Solicitá uno nuevo.' });
    }
 
    if (user.reset_token !== String(code).trim()) {
      return res.status(400).json({ error: 'Código incorrecto' });
    }
 
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.run(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL, updated_at = NOW() WHERE id = $2',
      [hashed, user.id]
    );
 
    res.json({ ok: true, message: 'Contraseña actualizada. Ya podés iniciar sesión.' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ error: 'Error al restablecer contraseña' });
  }
});
 
// ── Change password (authenticated) ──
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Contraseña actual y nueva requeridas' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
 
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
 
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: 'Contraseña actual incorrecta' });
 
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.run('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, req.userId]);
 
    res.json({ ok: true, message: 'Contraseña actualizada exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});
 
// ── Login ──
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
 
  const normalizedEmail = email.trim().toLowerCase();
 
  try {
    const user = await db.get('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
 
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });
 
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const safeUser = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [user.id]
    );
 
    // Auto-accept pending team invitations
    try { await autoAcceptInvitations(user.id, normalizedEmail); } catch(e) {}
 
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});
 
// ── Get current user ──
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, payment_failed_at, payment_grace_until, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
 
    const sorteoCount = await db.get(
      'SELECT COUNT(*) as total FROM sorteo_history WHERE user_id = $1',
      [req.userId]
    );
    const today = new Date().toISOString().split('T')[0];
    const dailyCount = await db.get(
      'SELECT count FROM daily_counts WHERE user_id = $1 AND date = $2',
      [req.userId, today]
    );
 
    res.json({
      user,
      stats: {
        totalSorteos: parseInt(sorteoCount.total),
        todaySorteos: dailyCount ? dailyCount.count : 0
      }
    });
  } catch (err) {
    console.error('Me error:', err.message);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});
 
// ── Update profile ──
app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    await db.run('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [name || '', req.userId]);
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar perfil' });
  }
});
 
// ── Update plan ──
app.put('/api/auth/plan', authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['free', 'pro', 'enterprise'].includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido' });
    }
    await db.run('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, req.userId]);
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar plan' });
  }
});
 
// ── Save brand settings ──
app.put('/api/auth/brand', authMiddleware, async (req, res) => {
  try {
    const brand = JSON.stringify(req.body.brand || {});
    await db.run('UPDATE users SET brand_settings = $1, updated_at = NOW() WHERE id = $2', [brand, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar marca' });
  }
});
 
// ── Save sorteo result ──
app.post('/api/sorteos', authMiddleware, async (req, res) => {
  try {
    const { winner, suplentes, participantsCount, platform, mode, postUrl } = req.body;
    if (!winner) return res.status(400).json({ error: 'Winner requerido' });
 
    await db.run(
      'INSERT INTO sorteo_history (user_id, winner, suplentes, participants_count, platform, mode, post_url) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [req.userId, winner, JSON.stringify(suplentes || []), participantsCount || 0, platform || 'manual', mode || 'slot', postUrl || null]
    );
 
    // Increment daily count
    const today = new Date().toISOString().split('T')[0];
    await db.run(
      'INSERT INTO daily_counts (user_id, date, count) VALUES ($1, $2, 1) ON CONFLICT(user_id, date) DO UPDATE SET count = daily_counts.count + 1',
      [req.userId, today]
    );
 
    // Fire webhooks
    fireWebhooks(req.userId, 'sorteo.completed', {
      winner, suplentes: suplentes || [],
      participants_count: participantsCount || 0,
      platform: platform || 'manual', mode: mode || 'slot', post_url: postUrl || null
    }).catch(() => {});
 
    res.json({ ok: true });
  } catch (err) {
    console.error('Save sorteo error:', err.message);
    res.status(500).json({ error: 'Error al guardar sorteo' });
  }
});
 
// ── Get sorteo history ──
app.get('/api/sorteos', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const sorteos = await db.all(
      'SELECT * FROM sorteo_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [req.userId, limit]
    );
    sorteos.forEach(s => {
      try { s.suplentes = JSON.parse(s.suplentes); } catch (e) { s.suplentes = []; }
    });
    res.json({ sorteos });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 6: ADMIN API
// ══════════════════════════════════════════════════════════════
 
// Admin middleware
async function adminMiddleware(req, res, next) {
  try {
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.id !== 1) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error de autenticación admin' });
  }
}
 
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await db.all(`
      SELECT u.id, u.email, u.name, u.plan, u.created_at,
             (SELECT COUNT(*) FROM sorteo_history WHERE user_id = u.id) as total_sorteos,
             (SELECT MAX(created_at) FROM sorteo_history WHERE user_id = u.id) as last_sorteo
      FROM users u ORDER BY u.created_at DESC
    `);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});
 
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await db.get('SELECT COUNT(*) as c FROM users');
    const totalSorteos = await db.get('SELECT COUNT(*) as c FROM sorteo_history');
    const todaySorteos = await db.get("SELECT COUNT(*) as c FROM sorteo_history WHERE DATE(created_at) = CURRENT_DATE");
    const planDist = await db.all('SELECT plan, COUNT(*) as c FROM users GROUP BY plan');
    const recentSorteos = await db.all(`
      SELECT sh.*, u.email, u.name as user_name
      FROM sorteo_history sh JOIN users u ON sh.user_id = u.id
      ORDER BY sh.created_at DESC LIMIT 20
    `);
 
    res.json({
      totalUsers: parseInt(totalUsers.c),
      totalSorteos: parseInt(totalSorteos.c),
      todaySorteos: parseInt(todaySorteos.c),
      planDist,
      recentSorteos
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});
 
app.put('/api/admin/users/:id/plan', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['free', 'pro', 'enterprise'].includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido' });
    }
    await db.run('UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2', [plan, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar plan' });
  }
});
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 6: STRIPE PAYMENTS
// ══════════════════════════════════════════════════════════════
 
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
let stripe = null;
if (STRIPE_SECRET_KEY) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}
 
// Stripe price IDs
const STRIPE_PRICES = {
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
  pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL || null,
  enterprise_monthly: process.env.STRIPE_PRICE_ENT_MONTHLY || null,
  enterprise_annual: process.env.STRIPE_PRICE_ENT_ANNUAL || null,
};
 
// ── Create Checkout Session ──
app.post('/api/stripe/checkout', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado. Contactá al administrador.' });
 
  const { plan, billing } = req.body;
  if (!['pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Plan inválido' });
  }
  if (!['monthly', 'annual'].includes(billing)) {
    return res.status(400).json({ error: 'Período de facturación inválido' });
  }
 
  const priceKey = `${plan}_${billing}`;
  const priceId = STRIPE_PRICES[priceKey];
  if (!priceId) {
    return res.status(400).json({ error: `Precio no configurado para ${plan} ${billing}. Contactá al administrador.` });
  }
 
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
 
    // Get or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { rafly_user_id: String(req.userId) }
      });
      customerId = customer.id;
      await db.run('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.userId]);
    }
 
    // If user already has an active subscription, redirect to portal
    if (user.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        if (['active', 'trialing'].includes(sub.status)) {
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${BASE_URL}/pricing.html?session=portal`,
          });
          return res.json({ url: portalSession.url, type: 'portal' });
        }
      } catch (e) { /* subscription not found or inactive */ }
    }
 
    // Create checkout session
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${BASE_URL}/pricing.html?session=success&plan=${plan}`,
      cancel_url: `${BASE_URL}/pricing.html?session=cancel`,
      metadata: { rafly_user_id: String(req.userId), plan },
      subscription_data: {
        metadata: { rafly_user_id: String(req.userId), plan }
      },
      allow_promotion_codes: true,
    });
 
    res.json({ url: checkoutSession.url, type: 'checkout' });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});
 
// ── Stripe Customer Portal ──
app.post('/api/stripe/portal', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado' });
 
  try {
    const user = await db.get('SELECT stripe_customer_id FROM users WHERE id = $1', [req.userId]);
    if (!user?.stripe_customer_id) {
      return res.status(400).json({ error: 'No tenés una suscripción activa' });
    }
 
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${BASE_URL}/pricing.html`,
    });
 
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: 'Error al abrir portal de facturación' });
  }
});
 
// ── Stripe Webhook ──
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
 
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
 
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const sess = event.data.object;
        const userId = sess.metadata?.rafly_user_id;
        const plan = sess.metadata?.plan;
        if (userId && plan) {
          await db.run(
            `UPDATE users SET plan = $1, stripe_subscription_id = COALESCE($2, stripe_subscription_id),
             stripe_subscription_status = 'active', payment_failed_at = NULL,
             payment_grace_until = NULL, downgrade_warned = 0, updated_at = NOW()
             WHERE id = $3`,
            [plan, sess.subscription || null, Number(userId)]
          );
          // Send upgrade confirmation email
          const user = await db.get('SELECT email, name FROM users WHERE id = $1', [Number(userId)]);
          if (user) {
            sendEmail(user.email, `¡Plan ${plan === 'enterprise' ? 'Enterprise' : 'Pro'} activado! — RAFLY`, upgradeEmailHTML(user.name, plan)).catch(() => {});
          }
          console.log(`✦ User ${userId} upgraded to ${plan}`);
        }
        break;
      }
 
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.rafly_user_id;
        if (userId) {
          const uid = Number(userId);
          await db.run('UPDATE users SET stripe_subscription_status = $1, updated_at = NOW() WHERE id = $2',
            [subscription.status, uid]);
 
          if (subscription.status === 'active') {
            const plan = subscription.metadata?.plan || 'pro';
            // Payment recovered — clear grace period
            await db.run(
              `UPDATE users SET plan = $1, payment_failed_at = NULL,
               payment_grace_until = NULL, downgrade_warned = 0, updated_at = NOW()
               WHERE id = $2`,
              [plan, uid]
            );
            console.log(`✦ User ${userId} subscription active → ${plan}`);
          } else if (subscription.status === 'past_due') {
            // Start grace period: 7 days to fix payment
            const user = await db.get('SELECT payment_failed_at, email, name, plan FROM users WHERE id = $1', [uid]);
            if (user && !user.payment_failed_at) {
              const graceEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
              await db.run(
                `UPDATE users SET payment_failed_at = NOW(), payment_grace_until = $1, updated_at = NOW() WHERE id = $2`,
                [graceEnd.toISOString(), uid]
              );
              sendEmail(user.email, '⚠️ Problema con tu pago — RAFLY', paymentFailedEmailHTML(user.name, 7)).catch(() => {});
            }
            console.log(`⚠ User ${userId} subscription past_due`);
          } else if (['canceled', 'unpaid'].includes(subscription.status)) {
            const user = await db.get('SELECT email, name FROM users WHERE id = $1', [uid]);
            await db.run(
              `UPDATE users SET plan = 'free', payment_failed_at = NULL,
               payment_grace_until = NULL, downgrade_warned = 0, updated_at = NOW()
               WHERE id = $1`,
              [uid]
            );
            if (user) {
              sendEmail(user.email, 'Tu plan cambió a Free — RAFLY', downgradeEmailHTML(user.name)).catch(() => {});
            }
            console.log(`✦ User ${userId} → free (${subscription.status})`);
          }
        }
        break;
      }
 
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.rafly_user_id;
        if (userId) {
          const uid = Number(userId);
          const user = await db.get('SELECT email, name FROM users WHERE id = $1', [uid]);
          await db.run(
            `UPDATE users SET plan = 'free', stripe_subscription_id = NULL,
             stripe_subscription_status = NULL, payment_failed_at = NULL,
             payment_grace_until = NULL, downgrade_warned = 0, updated_at = NOW()
             WHERE id = $1`,
            [uid]
          );
          if (user) {
            sendEmail(user.email, 'Tu plan cambió a Free — RAFLY', downgradeEmailHTML(user.name)).catch(() => {});
          }
          console.log(`✦ User ${userId} subscription deleted → free`);
        }
        break;
      }
 
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const user = await db.get('SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (user && user.plan !== 'free') {
          // Start or continue grace period
          if (!user.payment_failed_at) {
            const graceEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            await db.run(
              `UPDATE users SET payment_failed_at = NOW(), payment_grace_until = $1, updated_at = NOW() WHERE id = $2`,
              [graceEnd.toISOString(), user.id]
            );
            sendEmail(user.email, '⚠️ Problema con tu pago — RAFLY', paymentFailedEmailHTML(user.name, 7)).catch(() => {});
          }
          console.log(`⚠ Payment failed for user ${user.id} (${user.email})`);
        }
        break;
      }
 
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        // Clear any grace period on successful payment
        const user = await db.get('SELECT id, payment_failed_at FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (user && user.payment_failed_at) {
          await db.run(
            `UPDATE users SET payment_failed_at = NULL, payment_grace_until = NULL, downgrade_warned = 0, updated_at = NOW() WHERE id = $1`,
            [user.id]
          );
          console.log(`✦ User ${user.id} payment recovered`);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
 
  res.json({ received: true });
});
 
// ── Stripe status ──
app.get('/api/stripe/status', (req, res) => {
  res.json({
    configured: !!stripe,
    prices: {
      pro_monthly: !!STRIPE_PRICES.pro_monthly,
      pro_annual: !!STRIPE_PRICES.pro_annual,
      enterprise_monthly: !!STRIPE_PRICES.enterprise_monthly,
      enterprise_annual: !!STRIPE_PRICES.enterprise_annual,
    }
  });
});
 
// ── Billing info endpoint ──
app.get('/api/billing/info', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      `SELECT plan, stripe_customer_id, stripe_subscription_id, stripe_subscription_status,
              payment_failed_at, payment_grace_until FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
 
    const billing = {
      plan: user.plan,
      subscriptionStatus: user.stripe_subscription_status,
      hasSubscription: !!user.stripe_subscription_id,
      paymentFailed: !!user.payment_failed_at,
      graceUntil: user.payment_grace_until,
      canManage: !!user.stripe_customer_id && !!stripe,
    };
 
    // Get subscription details from Stripe if available
    if (stripe && user.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        billing.currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
        billing.cancelAtPeriodEnd = sub.cancel_at_period_end;
        billing.interval = sub.items?.data?.[0]?.price?.recurring?.interval || null;
        billing.amount = sub.items?.data?.[0]?.price?.unit_amount ? (sub.items.data[0].price.unit_amount / 100) : null;
        billing.currency = sub.items?.data?.[0]?.price?.currency || 'usd';
      } catch (e) { /* subscription may not exist anymore */ }
    }
 
    res.json(billing);
  } catch (err) {
    console.error('Billing info error:', err.message);
    res.status(500).json({ error: 'Error al obtener info de billing' });
  }
});
 
// ── Grace period checker (runs every hour) ──
async function checkGracePeriods() {
  try {
    // Find users past their grace period who are still on paid plans
    const expiredUsers = await db.all(
      `SELECT id, email, name FROM users
       WHERE payment_grace_until IS NOT NULL
       AND payment_grace_until < NOW()
       AND plan != 'free'`
    );
 
    for (const user of expiredUsers) {
      await db.run(
        `UPDATE users SET plan = 'free', payment_failed_at = NULL,
         payment_grace_until = NULL, downgrade_warned = 0, updated_at = NOW()
         WHERE id = $1`,
        [user.id]
      );
      sendEmail(user.email, 'Tu plan cambió a Free — RAFLY', downgradeEmailHTML(user.name)).catch(() => {});
      console.log(`✦ User ${user.id} auto-downgraded to free (grace period expired)`);
    }
 
    // Warn users at 2 days remaining who haven't been warned
    const warnUsers = await db.all(
      `SELECT id, email, name, payment_grace_until FROM users
       WHERE payment_grace_until IS NOT NULL
       AND payment_grace_until > NOW()
       AND payment_grace_until < NOW() + INTERVAL '2 days'
       AND downgrade_warned = 0
       AND plan != 'free'`
    );
 
    for (const user of warnUsers) {
      const hoursLeft = Math.max(1, Math.round((new Date(user.payment_grace_until) - Date.now()) / (1000 * 60 * 60)));
      const daysLeft = Math.max(1, Math.ceil(hoursLeft / 24));
      await db.run('UPDATE users SET downgrade_warned = 1 WHERE id = $1', [user.id]);
      sendEmail(user.email, '⏰ Último aviso: tu plan cambiará a Free — RAFLY', paymentFailedEmailHTML(user.name, daysLeft)).catch(() => {});
      console.log(`⚠ User ${user.id} warned: ${daysLeft} days left in grace period`);
    }
  } catch (err) {
    console.error('Grace period check error:', err.message);
  }
}
 
// Run grace period check every hour
setInterval(checkGracePeriods, 60 * 60 * 1000);
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 7: EMAIL & PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════
 
const nodemailer = require('nodemailer');
const webpush = require('web-push');
 
// ── Email config ──
const EMAIL_FROM = process.env.EMAIL_FROM || 'RAFLY <noreply@rafly.app>';
let emailTransporter = null;
 
if (process.env.SMTP_HOST) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: (process.env.SMTP_PORT || '587') === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}
 
async function sendEmail(to, subject, html) {
  if (!emailTransporter) return { sent: false, reason: 'SMTP not configured' };
  try {
    await emailTransporter.sendMail({ from: EMAIL_FROM, to, subject, html });
    return { sent: true };
  } catch (err) {
    console.error('Email error:', err.message);
    return { sent: false, reason: err.message };
  }
}
 
function welcomeEmailHTML(name) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#060614;color:#e0e0f8;padding:2rem;border-radius:12px">
      <h1 style="color:#00e5ff;font-size:1.8rem;margin-bottom:.5rem">¡Bienvenido a RAFLY! 🎰</h1>
      <p style="color:#8b8fa3;margin-bottom:1.5rem">Hola ${name || 'ahí'},</p>
      <p>Tu cuenta está lista. Ahora podés hacer sorteos en vivo con animaciones profesionales para Instagram, YouTube y TikTok.</p>
      <div style="margin:1.5rem 0">
        <a href="https://rafly.onrender.com" style="display:inline-block;background:#00e5ff;color:#060614;padding:.6rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:bold">Ir a RAFLY →</a>
      </div>
      <p style="color:#6a6a8a;font-size:.8rem">Si no creaste esta cuenta, podés ignorar este email.</p>
      <hr style="border:none;border-top:1px solid rgba(0,229,255,.12);margin:1.5rem 0">
      <p style="color:#3a3a55;font-size:.7rem;text-align:center">RAFLY — Sorteos en vivo</p>
    </div>`;
}
 
function sorteoEmailHTML(winner, participantsCount, mode) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#060614;color:#e0e0f8;padding:2rem;border-radius:12px">
      <h1 style="color:#00ff88;font-size:1.5rem;margin-bottom:1rem">🎉 Resultado del sorteo</h1>
      <div style="background:#0c0c24;border:1px solid rgba(0,255,136,.2);border-radius:10px;padding:1.2rem;text-align:center;margin-bottom:1rem">
        <p style="color:#6a6a8a;font-size:.75rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:.3rem">Ganador</p>
        <p style="color:#00ff88;font-size:1.8rem;font-weight:bold;margin:0">${winner}</p>
      </div>
      <p style="color:#8b8fa3;font-size:.85rem">Participantes: ${participantsCount} · Modo: ${mode}</p>
      <div style="margin:1.5rem 0">
        <a href="https://rafly.onrender.com/dashboard.html" style="display:inline-block;background:#00e5ff;color:#060614;padding:.5rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:bold;font-size:.85rem">Ver en Dashboard →</a>
      </div>
      <hr style="border:none;border-top:1px solid rgba(0,229,255,.12);margin:1.5rem 0">
      <p style="color:#3a3a55;font-size:.7rem;text-align:center">RAFLY — Sorteos en vivo</p>
    </div>`;
}
 
// ── Send welcome email endpoint ──
app.post('/api/email/welcome', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
 
    const result = await sendEmail(
      user.email,
      '¡Bienvenido a RAFLY! 🎰',
      welcomeEmailHTML(user.name)
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Error al enviar email' });
  }
});
 
// ── Send sorteo result email ──
app.post('/api/email/sorteo-result', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
 
    const { winner, participantsCount, mode } = req.body;
    const result = await sendEmail(
      user.email,
      `🎉 Ganador: ${winner} — RAFLY`,
      sorteoEmailHTML(winner, participantsCount || 0, mode || 'slot')
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Error al enviar email' });
  }
});
 
// ── Web Push Notifications ──
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || null;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@rafly.app';
 
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}
 
// Subscribe to push
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });
 
  const { subscription } = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
 
  try {
    await db.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = $1, keys_p256dh = $3, keys_auth = $4`,
      [req.userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar suscripción' });
  }
});
 
// Unsubscribe
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) await db.run('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Get VAPID public key
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null });
});
 
// Send push notification to a user
async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC) return;
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
      }, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.run('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
      }
    }
  }
}
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 7: ANALYTICS CONFIG
// ══════════════════════════════════════════════════════════════
 
const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || null;
 
app.get('/api/config', (req, res) => {
  res.json({
    ga: GA_MEASUREMENT_ID,
    stripeConfigured: !!stripe,
  });
});
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 7: PUBLIC API
// ══════════════════════════════════════════════════════════════
 
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
 
// ══════════════════════════════════════════════════════════════
//   PHASE 2: RATE LIMITING & SECURITY HEADERS
// ══════════════════════════════════════════════════════════════
 
const helmet = require('helmet');
 
// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for the app
  crossOriginEmbedderPolicy: false,
}));
 
// (Rate limiters moved above auth routes)
 
// Reset daily API usage at midnight
let lastResetDate = new Date().toDateString();
async function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    await db.run('UPDATE api_keys SET requests_today = 0');
    lastResetDate = today;
  }
}
 
// Rate limits per plan for API
const API_RATE_LIMITS = {
  free: { daily: 50, perMinute: 10 },
  pro: { daily: 1000, perMinute: 60 },
  enterprise: { daily: 10000, perMinute: 200 }
};
 
// In-memory rate limiter (per-minute)
const apiMinuteCounters = new Map();
setInterval(() => apiMinuteCounters.clear(), 60000);
 
// API key auth middleware
async function apiKeyAuth(req, res, next) {
  try {
    await checkDailyReset();
 
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key. Pass it via X-API-Key header or api_key query param.' });
    }
 
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const keyRow = await db.get(
      'SELECT ak.*, u.email, u.plan FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.key_hash = $1',
      [hash]
    );
    if (!keyRow) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
 
    const plan = keyRow.plan || 'free';
    const limits = API_RATE_LIMITS[plan] || API_RATE_LIMITS.free;
 
    // Check daily limit
    if (keyRow.requests_today >= limits.daily) {
      return res.status(429).json({ error: 'Daily API limit reached', limit: limits.daily, plan });
    }
 
    // Check per-minute limit
    const minuteKey = `api:${keyRow.id}`;
    const minuteCount = (apiMinuteCounters.get(minuteKey) || 0) + 1;
    apiMinuteCounters.set(minuteKey, minuteCount);
    if (minuteCount > limits.perMinute) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.', limit: limits.perMinute });
    }
 
    // Update usage
    await db.run(
      'UPDATE api_keys SET last_used = NOW(), requests_today = requests_today + 1, requests_total = requests_total + 1 WHERE id = $1',
      [keyRow.id]
    );
 
    req.apiUser = { id: keyRow.user_id, email: keyRow.email, plan };
    req.apiLimits = limits;
    next();
  } catch (err) {
    console.error('API key auth error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
}
 
// ── API Key Management ──
 
// Create API key
app.post('/api/keys', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    const existing = await db.all(
      'SELECT id, key_prefix, name, created_at, last_used, requests_today, requests_total FROM api_keys WHERE user_id = $1',
      [req.userId]
    );
    if (existing.length >= 5) {
      return res.status(400).json({ error: 'Max 5 API keys per account' });
    }
 
    const rawKey = `rfly_${crypto.randomBytes(24).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const prefix = rawKey.substring(0, 12) + '...';
 
    await db.run(
      'INSERT INTO api_keys (user_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4)',
      [req.userId, hash, prefix, name || 'default']
    );
    res.json({ key: rawKey, prefix, name: name || 'default', message: 'Save this key — it won\'t be shown again.' });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear API key' });
  }
});
 
// List API keys
app.get('/api/keys', authMiddleware, async (req, res) => {
  try {
    const keys = await db.all(
      'SELECT id, key_prefix, name, created_at, last_used, requests_today, requests_total FROM api_keys WHERE user_id = $1',
      [req.userId]
    );
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener API keys' });
  }
});
 
// Delete API key
app.delete('/api/keys/:id', authMiddleware, async (req, res) => {
  try {
    const result = await db.run('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Key not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar API key' });
  }
});
 
// ── Public API Endpoints ──
 
// POST /api/v1/sorteo/random — pick random winner(s) from a list
app.post('/api/v1/sorteo/random', apiKeyAuth, (req, res) => {
  const { participants, count, removeDuplicates } = req.body || {};
 
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: 'participants must be a non-empty array of strings' });
  }
  if (participants.length > 10000) {
    return res.status(400).json({ error: 'Max 10,000 participants per request' });
  }
 
  let list = participants.map(p => String(p).trim()).filter(Boolean);
  if (removeDuplicates) list = [...new Set(list)];
 
  const winnerCount = Math.min(Math.max(1, parseInt(count) || 1), list.length);
  const winners = [];
  const pool2 = [...list];
 
  for (let i = 0; i < winnerCount; i++) {
    const idx = crypto.randomInt(pool2.length);
    winners.push(pool2.splice(idx, 1)[0]);
  }
 
  res.json({
    winners,
    total_participants: list.length,
    draw_time: new Date().toISOString(),
    method: 'crypto.randomInt'
  });
});
 
// GET /api/v1/sorteos — list user's sorteo history
app.get('/api/v1/sorteos', apiKeyAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
 
    const sorteos = await db.all(
      'SELECT * FROM sorteo_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.apiUser.id, limit, offset]
    );
    const total = await db.get('SELECT COUNT(*) as count FROM sorteo_history WHERE user_id = $1', [req.apiUser.id]);
 
    res.json({ sorteos, total: parseInt(total.count), limit, offset });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener sorteos' });
  }
});
 
// GET /api/v1/account — account info + usage
app.get('/api/v1/account', apiKeyAuth, (req, res) => {
  res.json({
    email: req.apiUser.email,
    plan: req.apiUser.plan,
    api_limits: req.apiLimits
  });
});
 
// API docs endpoint
app.get('/api/v1/spec', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: { title: 'RAFLY API', version: '1.0.0', description: 'API pública para sorteos y giveaways' },
    servers: [{ url: `${BASE_URL}/api/v1` }],
    paths: {
      '/sorteo/random': {
        post: {
          summary: 'Sortear ganador(es) de una lista',
          security: [{ apiKey: [] }],
          requestBody: {
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['participants'],
              properties: {
                participants: { type: 'array', items: { type: 'string' }, description: 'Lista de participantes' },
                count: { type: 'integer', default: 1, description: 'Cantidad de ganadores' },
                removeDuplicates: { type: 'boolean', default: false }
              }
            }}}
          }
        }
      },
      '/sorteos': { get: { summary: 'Historial de sorteos', security: [{ apiKey: [] }] } },
      '/account': { get: { summary: 'Info de cuenta y uso', security: [{ apiKey: [] }] } }
    },
    components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } }
  });
});
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 8: SCHEDULED DRAWS
// ══════════════════════════════════════════════════════════════
 
// Create scheduled sorteo
app.post('/api/scheduled-sorteos', authMiddleware, async (req, res) => {
  try {
    const { title, participants, winnerCount, suplenteCount, removeDuplicates, mode, scheduledAt } = req.body;
 
    if (!Array.isArray(participants) || participants.length < 2) {
      return res.status(400).json({ error: 'Se necesitan al menos 2 participantes' });
    }
    const schedDate = new Date(scheduledAt);
    if (isNaN(schedDate.getTime()) || schedDate <= new Date()) {
      return res.status(400).json({ error: 'La fecha debe ser futura' });
    }
 
    const result = await db.get(
      'INSERT INTO scheduled_sorteos (user_id, title, participants, winner_count, suplente_count, remove_duplicates, mode, scheduled_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [
        req.userId,
        title || 'Sorteo programado',
        JSON.stringify(participants),
        Math.max(1, parseInt(winnerCount) || 1),
        Math.max(0, parseInt(suplenteCount) || 0),
        removeDuplicates ? 1 : 0,
        mode || 'slot',
        schedDate.toISOString()
      ]
    );
 
    res.json({ id: result.id, scheduledAt: schedDate.toISOString() });
  } catch (err) {
    console.error('Create scheduled error:', err.message);
    res.status(500).json({ error: 'Error al crear sorteo programado' });
  }
});
 
// List scheduled sorteos
app.get('/api/scheduled-sorteos', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const sorteos = await db.all(
      'SELECT * FROM scheduled_sorteos WHERE user_id = $1 ORDER BY scheduled_at DESC LIMIT $2 OFFSET $3',
      [req.userId, limit, offset]
    );
    const total = await db.get('SELECT COUNT(*) as total FROM scheduled_sorteos WHERE user_id = $1', [req.userId]);
    res.json({
      sorteos: sorteos.map(s => ({
        ...s,
        participants: JSON.parse(s.participants),
        winners: s.winners ? JSON.parse(s.winners) : null
      })),
      total: parseInt(total.total)
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener sorteos programados' });
  }
});
 
// Get single scheduled sorteo
app.get('/api/scheduled-sorteos/:id', authMiddleware, async (req, res) => {
  try {
    const s = await db.get('SELECT * FROM scheduled_sorteos WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!s) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ...s, participants: JSON.parse(s.participants), winners: s.winners ? JSON.parse(s.winners) : null });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Delete scheduled sorteo (only if pending)
app.delete('/api/scheduled-sorteos/:id', authMiddleware, async (req, res) => {
  try {
    const result = await db.run(
      "DELETE FROM scheduled_sorteos WHERE id = $1 AND user_id = $2 AND status = 'pending'",
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'No encontrado o ya ejecutado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Public view for scheduled sorteo countdown
app.get('/api/scheduled-sorteos/:id/public', async (req, res) => {
  try {
    const s = await db.get(
      'SELECT id, title, scheduled_at, status, winners, mode, executed_at FROM scheduled_sorteos WHERE id = $1',
      [req.params.id]
    );
    if (!s) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ...s, winners: s.winners ? JSON.parse(s.winners) : null });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Scheduled sorteo executor — runs every 10 seconds
async function executeScheduledSorteos() {
  try {
    const pending = await db.all("SELECT * FROM scheduled_sorteos WHERE status = 'pending' AND scheduled_at <= NOW()");
    for (const sorteo of pending) {
      try {
        let sorteoPool = JSON.parse(sorteo.participants).map(p => String(p).trim()).filter(Boolean);
        if (sorteo.remove_duplicates) sorteoPool = [...new Set(sorteoPool)];
 
        const totalWinners = Math.min(sorteo.winner_count + sorteo.suplente_count, sorteoPool.length);
        const selected = [];
        const available = [...sorteoPool];
 
        for (let i = 0; i < totalWinners; i++) {
          const idx = crypto.randomInt(available.length);
          selected.push(available.splice(idx, 1)[0]);
        }
 
        const winners = selected.slice(0, sorteo.winner_count);
        const suplentes = selected.slice(sorteo.winner_count);
 
        await db.run(
          "UPDATE scheduled_sorteos SET status = 'completed', winners = $1, executed_at = NOW() WHERE id = $2",
          [JSON.stringify({ winners, suplentes }), sorteo.id]
        );
 
        // Send push notification
        sendPushToUser(sorteo.user_id, {
          title: '🎉 ¡Sorteo completado!',
          body: `Ganador: ${winners[0]}${winners.length > 1 ? ` (+${winners.length - 1} más)` : ''}`,
          url: `/dashboard.html`
        }).catch(() => {});
 
        // Fire webhooks
        fireWebhooks(sorteo.user_id, 'sorteo.completed', {
          sorteo_id: sorteo.id,
          title: sorteo.title,
          winners,
          suplentes,
          participants_count: sorteoPool.length,
          mode: sorteo.mode,
          executed_at: new Date().toISOString()
        });
 
        console.log(`  ✦ Scheduled sorteo #${sorteo.id} executed — Winner: ${winners[0]}`);
      } catch (err) {
        console.error(`  ✗ Error executing scheduled sorteo #${sorteo.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Scheduled executor error:', err.message);
  }
}
setInterval(() => executeScheduledSorteos().catch(console.error), 10000);
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 8: TEAMS / COLLABORATION
// ══════════════════════════════════════════════════════════════
 
// Create team
app.post('/api/teams', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
 
    const teamCount = await db.get('SELECT COUNT(*) as c FROM teams WHERE owner_id = $1', [req.userId]);
    if (parseInt(teamCount.c) >= 5) return res.status(400).json({ error: 'Máximo 5 equipos' });
 
    const result = await db.get('INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id', [name.trim(), req.userId]);
    const teamId = result.id;
 
    // Add owner as admin member
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    await db.run(
      "INSERT INTO team_members (team_id, user_id, email, role, status, joined_at) VALUES ($1, $2, $3, 'admin', 'active', NOW())",
      [teamId, req.userId, user.email]
    );
 
    res.json({ id: teamId, name: name.trim() });
  } catch (err) {
    console.error('Create team error:', err.message);
    res.status(500).json({ error: 'Error al crear equipo' });
  }
});
 
// List user's teams
app.get('/api/teams', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    const teams = await db.all(`
      SELECT t.*, tm.role FROM teams t
      JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.email = $1 AND tm.status = 'active'
      ORDER BY t.created_at DESC
    `, [user.email]);
 
    const result = [];
    for (const t of teams) {
      const members = await db.all(
        'SELECT id, email, role, status, joined_at FROM team_members WHERE team_id = $1',
        [t.id]
      );
      result.push({ ...t, members });
    }
 
    res.json({ teams: result });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener equipos' });
  }
});
 
// Invite member to team
app.post('/api/teams/:teamId/invite', authMiddleware, async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });
 
    const team = await db.get('SELECT * FROM teams WHERE id = $1', [req.params.teamId]);
    if (!team) return res.status(404).json({ error: 'Equipo no encontrado' });
 
    // Check permission
    const member = await db.get(
      "SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2 AND role IN ('admin') AND status = 'active'",
      [req.params.teamId, req.userId]
    );
    if (team.owner_id !== req.userId && !member) {
      return res.status(403).json({ error: 'Sin permisos' });
    }
 
    const memberCount = await db.get('SELECT COUNT(*) as c FROM team_members WHERE team_id = $1', [req.params.teamId]);
    if (parseInt(memberCount.c) >= 20) return res.status(400).json({ error: 'Máximo 20 miembros por equipo' });
 
    const validRole = ['admin', 'moderator', 'viewer'].includes(role) ? role : 'viewer';
 
    await db.run(
      "INSERT INTO team_members (team_id, email, role, status) VALUES ($1, $2, $3, 'pending')",
      [req.params.teamId, email, validRole]
    );
 
    // Send invite email if configured
    if (emailTransporter) {
      sendEmail(email, `Te invitaron al equipo "${team.name}" en RAFLY`,
        `<div style="font-family:sans-serif;padding:20px"><h2>🎉 Invitación a equipo</h2><p>Te invitaron al equipo <strong>${team.name}</strong> en RAFLY como <strong>${validRole}</strong>.</p><p><a href="${BASE_URL}" style="background:#00e5ff;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Ir a RAFLY</a></p></div>`
      ).catch(() => {});
    }
 
    res.json({ ok: true, email, role: validRole });
  } catch (err) {
    if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
      return res.status(400).json({ error: 'Ya invitado' });
    }
    console.error('Invite error:', err.message);
    res.status(500).json({ error: 'Error al invitar' });
  }
});
 
// Accept team invitation
app.post('/api/teams/:teamId/accept', authMiddleware, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    const result = await db.run(
      "UPDATE team_members SET status = 'active', user_id = $1, joined_at = NOW() WHERE team_id = $2 AND email = $3 AND status = 'pending'",
      [req.userId, req.params.teamId, user.email]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Invitación no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Remove member from team
app.delete('/api/teams/:teamId/members/:memberId', authMiddleware, async (req, res) => {
  try {
    const team = await db.get('SELECT * FROM teams WHERE id = $1', [req.params.teamId]);
    if (!team || team.owner_id !== req.userId) return res.status(403).json({ error: 'Solo el owner puede remover miembros' });
 
    const member = await db.get('SELECT * FROM team_members WHERE id = $1 AND team_id = $2', [req.params.memberId, req.params.teamId]);
    if (!member) return res.status(404).json({ error: 'Miembro no encontrado' });
    if (member.user_id === req.userId) return res.status(400).json({ error: 'No podés removerte a vos mismo' });
 
    await db.run('DELETE FROM team_members WHERE id = $1', [req.params.memberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Delete team
app.delete('/api/teams/:teamId', authMiddleware, async (req, res) => {
  try {
    const team = await db.get('SELECT * FROM teams WHERE id = $1', [req.params.teamId]);
    if (!team || team.owner_id !== req.userId) return res.status(403).json({ error: 'Solo el owner puede eliminar el equipo' });
 
    await db.run('DELETE FROM team_members WHERE team_id = $1', [req.params.teamId]);
    await db.run('DELETE FROM sorteo_shares WHERE team_id = $1', [req.params.teamId]);
    await db.run('DELETE FROM teams WHERE id = $1', [req.params.teamId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Auto-accept pending invitations on login
async function autoAcceptInvitations(userId, email) {
  await db.run(
    "UPDATE team_members SET status = 'active', user_id = $1, joined_at = NOW() WHERE email = $2 AND status = 'pending'",
    [userId, email]
  );
}
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 8: WEBHOOKS
// ══════════════════════════════════════════════════════════════
 
// Register webhook
app.post('/api/webhooks', authMiddleware, async (req, res) => {
  try {
    const { url, events } = req.body;
    if (!url || !url.startsWith('https://')) return res.status(400).json({ error: 'URL debe ser HTTPS' });
 
    const webhookCount = await db.get('SELECT COUNT(*) as c FROM webhooks WHERE user_id = $1', [req.userId]);
    if (parseInt(webhookCount.c) >= 10) return res.status(400).json({ error: 'Máximo 10 webhooks' });
 
    const validEvents = ['sorteo.completed', 'sorteo.scheduled', 'participant.added', 'team.member_joined'];
    const selectedEvents = Array.isArray(events) ? events.filter(e => validEvents.includes(e)) : ['sorteo.completed'];
    if (selectedEvents.length === 0) selectedEvents.push('sorteo.completed');
 
    const secret = crypto.randomBytes(32).toString('hex');
 
    const result = await db.get(
      'INSERT INTO webhooks (user_id, url, events, secret) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.userId, url, JSON.stringify(selectedEvents), secret]
    );
 
    res.json({
      id: result.id,
      url,
      events: selectedEvents,
      secret,
      message: 'Guardá el secret — se usa para verificar la firma de los payloads.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear webhook' });
  }
});
 
// List webhooks
app.get('/api/webhooks', authMiddleware, async (req, res) => {
  try {
    const webhooks = await db.all(
      'SELECT id, url, events, active, created_at, last_triggered, fail_count FROM webhooks WHERE user_id = $1',
      [req.userId]
    );
    res.json({ webhooks: webhooks.map(w => ({ ...w, events: JSON.parse(w.events) })) });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Delete webhook
app.delete('/api/webhooks/:id', authMiddleware, async (req, res) => {
  try {
    const result = await db.run('DELETE FROM webhooks WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Toggle webhook active/inactive
app.patch('/api/webhooks/:id', authMiddleware, async (req, res) => {
  try {
    const wh = await db.get('SELECT * FROM webhooks WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!wh) return res.status(404).json({ error: 'No encontrado' });
 
    await db.run('UPDATE webhooks SET active = $1 WHERE id = $2', [wh.active ? 0 : 1, wh.id]);
    res.json({ ok: true, active: !wh.active });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Webhook logs
app.get('/api/webhooks/:id/logs', authMiddleware, async (req, res) => {
  try {
    const wh = await db.get('SELECT * FROM webhooks WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!wh) return res.status(404).json({ error: 'No encontrado' });
 
    const logs = await db.all(
      'SELECT * FROM webhook_logs WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 20',
      [wh.id]
    );
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Fire webhooks for an event
async function fireWebhooks(userId, event, data) {
  try {
    const webhooks = await db.all("SELECT * FROM webhooks WHERE user_id = $1 AND active = 1", [userId]);
 
    for (const wh of webhooks) {
      const events = JSON.parse(wh.events);
      if (!events.includes(event)) continue;
 
      const payload = JSON.stringify({
        event,
        data,
        timestamp: new Date().toISOString(),
        webhook_id: wh.id
      });
 
      // Create HMAC signature
      const signature = crypto.createHmac('sha256', wh.secret).update(payload).digest('hex');
 
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
 
        const response = await fetch(wh.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Rafly-Signature': signature,
            'X-Rafly-Event': event,
            'User-Agent': 'RAFLY-Webhooks/1.0'
          },
          body: payload,
          signal: controller.signal
        });
        clearTimeout(timeout);
 
        await db.run(
          'INSERT INTO webhook_logs (webhook_id, event, payload, status_code, response) VALUES ($1, $2, $3, $4, $5)',
          [wh.id, event, payload, response.status, (await response.text()).substring(0, 500)]
        );
        await db.run('UPDATE webhooks SET last_triggered = NOW(), fail_count = 0 WHERE id = $1', [wh.id]);
      } catch (err) {
        await db.run(
          'INSERT INTO webhook_logs (webhook_id, event, payload, status_code, response) VALUES ($1, $2, $3, $4, $5)',
          [wh.id, event, payload, 0, err.message]
        );
        const newFails = wh.fail_count + 1;
        if (newFails >= 10) {
          await db.run('UPDATE webhooks SET active = 0, fail_count = $1 WHERE id = $2', [newFails, wh.id]);
        } else {
          await db.run('UPDATE webhooks SET fail_count = $1 WHERE id = $2', [newFails, wh.id]);
        }
      }
    }
  } catch (err) {
    console.error('fireWebhooks error:', err.message);
  }
}
 
// ══════════════════════════════════════════════════════════════
//   LEVEL 8: WHITE-LABEL EMBEDDABLE WIDGET
// ══════════════════════════════════════════════════════════════
 
// Create widget
app.post('/api/widgets', authMiddleware, async (req, res) => {
  try {
    const { name, config } = req.body;
 
    const user = await db.get(
      'SELECT id, email, name, plan, brand_settings, email_verified, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (user.plan === 'free') return res.status(403).json({ error: 'Widget embebible disponible en plan Pro o Enterprise' });
 
    const widgetCount = await db.get('SELECT COUNT(*) as c FROM widgets WHERE user_id = $1', [req.userId]);
    if (parseInt(widgetCount.c) >= 10) return res.status(400).json({ error: 'Máximo 10 widgets' });
 
    const widgetKey = 'w_' + crypto.randomBytes(12).toString('hex');
    const widgetConfig = {
      primaryColor: config?.primaryColor || '#00e5ff',
      accentColor: config?.accentColor || '#ffd700',
      bgColor: config?.bgColor || '#0a0a0f',
      textColor: config?.textColor || '#e8e8f0',
      borderRadius: config?.borderRadius || '12',
      showBranding: config?.showBranding !== false,
      title: config?.title || 'Sorteo',
      buttonText: config?.buttonText || 'SORTEAR',
      ...config
    };
 
    await db.run(
      'INSERT INTO widgets (user_id, widget_key, name, config) VALUES ($1, $2, $3, $4)',
      [req.userId, widgetKey, name || 'Mi Widget', JSON.stringify(widgetConfig)]
    );
 
    res.json({
      key: widgetKey,
      embedCode: `<iframe src="${BASE_URL}/widget.html?key=${widgetKey}" width="400" height="500" frameborder="0" style="border-radius:12px;overflow:hidden"></iframe>`,
      scriptEmbed: `<div id="rafly-widget" data-key="${widgetKey}"></div>\n<script src="${BASE_URL}/widget-sdk.js"></script>`
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al crear widget' });
  }
});
 
// List widgets
app.get('/api/widgets', authMiddleware, async (req, res) => {
  try {
    const widgets = await db.all('SELECT * FROM widgets WHERE user_id = $1', [req.userId]);
    res.json({ widgets: widgets.map(w => ({ ...w, config: JSON.parse(w.config) })) });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Update widget config
app.put('/api/widgets/:key', authMiddleware, async (req, res) => {
  try {
    const widget = await db.get('SELECT * FROM widgets WHERE widget_key = $1 AND user_id = $2', [req.params.key, req.userId]);
    if (!widget) return res.status(404).json({ error: 'Widget no encontrado' });
 
    const { name, config } = req.body;
    if (name) await db.run('UPDATE widgets SET name = $1 WHERE id = $2', [name, widget.id]);
    if (config) await db.run('UPDATE widgets SET config = $1 WHERE id = $2', [JSON.stringify(config), widget.id]);
 
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Delete widget
app.delete('/api/widgets/:key', authMiddleware, async (req, res) => {
  try {
    const result = await db.run('DELETE FROM widgets WHERE widget_key = $1 AND user_id = $2', [req.params.key, req.userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Public widget config endpoint
app.get('/api/widgets/:key/config', async (req, res) => {
  try {
    const widget = await db.get('SELECT config, active FROM widgets WHERE widget_key = $1 AND active = 1', [req.params.key]);
    if (!widget) return res.status(404).json({ error: 'Widget no encontrado o inactivo' });
    res.json(JSON.parse(widget.config));
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// Widget sorteo endpoint (public, rate limited by widget key)
const widgetRateLimits = new Map();
setInterval(() => widgetRateLimits.clear(), 60000);
 
app.post('/api/widgets/:key/sorteo', async (req, res) => {
  try {
    const widget = await db.get('SELECT * FROM widgets WHERE widget_key = $1 AND active = 1', [req.params.key]);
    if (!widget) return res.status(404).json({ error: 'Widget no encontrado' });
 
    // Rate limit: 30 per minute per widget
    const count = (widgetRateLimits.get(req.params.key) || 0) + 1;
    widgetRateLimits.set(req.params.key, count);
    if (count > 30) return res.status(429).json({ error: 'Rate limit' });
 
    const { participants, count: winnerCount } = req.body;
    if (!Array.isArray(participants) || participants.length < 2) {
      return res.status(400).json({ error: 'Se necesitan al menos 2 participantes' });
    }
 
    const widgetPool = participants.map(p => String(p).trim()).filter(Boolean);
    const total = Math.min(Math.max(1, parseInt(winnerCount) || 1), widgetPool.length);
    const winners = [];
    const available = [...widgetPool];
 
    for (let i = 0; i < total; i++) {
      const idx = crypto.randomInt(available.length);
      winners.push(available.splice(idx, 1)[0]);
    }
 
    res.json({ winners, total_participants: widgetPool.length });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// ── User Analytics ─────────────────────────────────────────────
app.get('/api/analytics', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
 
    // Total sorteos
    const total = await db.get('SELECT COUNT(*) as c FROM sorteo_history WHERE user_id = $1', [uid]);
 
    // Sorteos by platform
    const byPlatform = await db.all(
      'SELECT platform, COUNT(*) as c FROM sorteo_history WHERE user_id = $1 GROUP BY platform ORDER BY c DESC',
      [uid]
    );
 
    // Sorteos by mode
    const byMode = await db.all(
      'SELECT mode, COUNT(*) as c FROM sorteo_history WHERE user_id = $1 GROUP BY mode ORDER BY c DESC',
      [uid]
    );
 
    // Last 30 days activity
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dailyActivity = await db.all(
      'SELECT date, count FROM daily_counts WHERE user_id = $1 AND date >= $2 ORDER BY date ASC',
      [uid, thirtyDaysAgo]
    );
 
    // Total participants drawn
    const totalParticipants = await db.get(
      'SELECT COALESCE(SUM(participants_count), 0) as c FROM sorteo_history WHERE user_id = $1',
      [uid]
    );
 
    // Top winners (most frequent)
    const topWinners = await db.all(
      'SELECT winner, COUNT(*) as c FROM sorteo_history WHERE user_id = $1 GROUP BY winner ORDER BY c DESC LIMIT 5',
      [uid]
    );
 
    // Average participants per sorteo
    const avgParticipants = await db.get(
      'SELECT COALESCE(AVG(participants_count), 0) as avg FROM sorteo_history WHERE user_id = $1',
      [uid]
    );
 
    // Recent sorteos
    const recent = await db.all(
      'SELECT winner, platform, mode, participants_count, created_at FROM sorteo_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [uid]
    );
 
    res.json({
      totalSorteos: parseInt(total.c),
      totalParticipants: parseInt(totalParticipants.c),
      avgParticipants: Math.round(parseFloat(avgParticipants.avg)),
      byPlatform: byPlatform.map(r => ({ platform: r.platform, count: parseInt(r.c) })),
      byMode: byMode.map(r => ({ mode: r.mode, count: parseInt(r.c) })),
      dailyActivity: dailyActivity.map(r => ({ date: r.date, count: r.count })),
      topWinners: topWinners.map(r => ({ winner: r.winner, count: parseInt(r.c) })),
      recent
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Error al obtener analytics' });
  }
});
 
// ── PDF Certificate Generator ──────────────────────────────────
app.post('/api/certificate/pdf', optionalAuth, (req, res) => {
  try {
    const { winners, suplentes, participants, title, date, ref } = req.body;
    if (!winners || !Array.isArray(winners) || winners.length === 0) {
      return res.status(400).json({ error: 'Se necesita al menos un ganador' });
    }
 
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
 
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificado-rafly-${Date.now()}.pdf"`);
    doc.pipe(res);
 
    const w = doc.page.width;
    const h = doc.page.height;
 
    // Background
    doc.rect(0, 0, w, h).fill('#060614');
 
    // Gold border
    doc.lineWidth(3).strokeColor('#ffd700');
    doc.roundedRect(25, 25, w - 50, h - 50, 8).stroke();
    doc.lineWidth(1).strokeColor('#ffd70033');
    doc.roundedRect(40, 40, w - 80, h - 80, 5).stroke();
 
    // Corner flourishes
    const corners = [[48,48,1,1],[w-48,48,-1,1],[48,h-48,1,-1],[w-48,h-48,-1,-1]];
    doc.lineWidth(2).strokeColor('#ffd700');
    for (const [cx, cy, dx, dy] of corners) {
      doc.moveTo(cx, cy + 18*dy).lineTo(cx, cy).lineTo(cx + 18*dx, cy).stroke();
    }
 
    // Title
    doc.fontSize(28).fillColor('#ffd700').font('Helvetica-Bold');
    doc.text(title || 'CERTIFICADO DE SORTEO', 0, 80, { align: 'center', width: w });
 
    // Gold line
    doc.strokeColor('#ffd70055').lineWidth(1);
    doc.moveTo(w/2 - 120, 118).lineTo(w/2 + 120, 118).stroke();
 
    let yPos = 150;
 
    if (winners.length === 1) {
      doc.fontSize(16).fillColor('#a0a0c0').font('Helvetica');
      doc.text('Se certifica que el participante:', 0, yPos, { align: 'center', width: w });
      yPos += 60;
 
      doc.fontSize(36).fillColor('#00e5ff').font('Helvetica-Bold');
      doc.text(winners[0], 0, yPos, { align: 'center', width: w });
      yPos += 60;
 
      doc.fontSize(16).fillColor('#a0a0c0').font('Helvetica');
      doc.text('ha resultado ganador/a del sorteo realizado', 0, yPos, { align: 'center', width: w });
      yPos += 45;
    } else {
      doc.fontSize(16).fillColor('#a0a0c0').font('Helvetica');
      doc.text(`Se certifican los ${winners.length} ganadores del sorteo:`, 0, yPos, { align: 'center', width: w });
      yPos += 35;
 
      for (let i = 0; i < winners.length; i++) {
        doc.fontSize(10).fillColor('#ffd700').font('Helvetica-Bold');
        doc.text(`#${i + 1}`, w/2 - 160, yPos, { width: 40 });
        doc.fontSize(20).fillColor('#00e5ff').font('Helvetica-Bold');
        doc.text(winners[i], w/2 - 110, yPos - 3, { width: 300 });
        yPos += 32;
      }
    }
 
    // Suplentes
    if (suplentes && Array.isArray(suplentes) && suplentes.length > 0) {
      yPos += 10;
      doc.fontSize(12).fillColor('#6a6a8a').font('Helvetica-Bold');
      doc.text('SUPLENTES', 0, yPos, { align: 'center', width: w });
      yPos += 25;
 
      for (let i = 0; i < suplentes.length; i++) {
        doc.fontSize(8).fillColor('#7b2eff').font('Helvetica-Bold');
        doc.text(`S${i + 1}`, w/2 - 140, yPos, { width: 30 });
        doc.fontSize(16).fillColor('#b388ff').font('Helvetica-Bold');
        doc.text(suplentes[i], w/2 - 100, yPos - 2, { width: 280 });
        yPos += 28;
      }
    }
 
    // Date
    yPos += 20;
    const dateStr = date || new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    doc.fontSize(14).fillColor('#a0a0c0').font('Helvetica');
    doc.text(`el ${dateStr} a las ${timeStr}`, 0, yPos, { align: 'center', width: w });
 
    yPos += 35;
    doc.fontSize(12).fillColor('#6a6a8a').font('Helvetica');
    doc.text(`Total de participantes: ${participants || 0}`, 0, yPos, { align: 'center', width: w });
    yPos += 22;
    doc.text(`Ref: ${ref || 'RAFLY-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-6)}`, 0, yPos, { align: 'center', width: w });
 
    // RAFLY watermark
    doc.fontSize(60).fillColor('#00e5ff08').font('Helvetica-Bold');
    doc.text('RAFLY', 0, h - 100, { align: 'center', width: w });
    doc.fontSize(10).fillColor('#4a4a6a').font('Helvetica');
    doc.text('Generado por RAFLY — Sorteos en vivo', 0, h - 55, { align: 'center', width: w });
 
    doc.end();
  } catch (err) {
    console.error('PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error generando PDF' });
  }
});
 
// ── OBS Overlay State ──────────────────────────────────────────
const overlayStates = new Map(); // userId → { winner, participants, animation, timestamp, config }
 
app.post('/api/overlay/trigger', authMiddleware, async (req, res) => {
  try {
    const { winner, participants, animation, config } = req.body;
    if (!winner) return res.status(400).json({ error: 'Falta el ganador' });
 
    const state = {
      winner: typeof winner === 'string' ? winner : String(winner),
      participants: Array.isArray(participants) ? participants.length : (parseInt(participants) || 0),
      animation: animation || 'slot',
      timestamp: Date.now(),
      config: config || {}
    };
    overlayStates.set(req.user.id, state);
    res.json({ ok: true, state });
  } catch (err) {
    res.status(500).json({ error: 'Error al disparar overlay' });
  }
});
 
app.get('/api/overlay/state/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const since = parseInt(req.query.since) || 0;
  const state = overlayStates.get(userId);
 
  if (!state || state.timestamp <= since) {
    return res.json({ pending: false });
  }
  res.json({ pending: true, ...state });
});
 
app.post('/api/overlay/clear', authMiddleware, (req, res) => {
  overlayStates.delete(req.user.id);
  res.json({ ok: true });
});
 
app.get('/api/overlay/config', authMiddleware, async (req, res) => {
  try {
    const user = await db.get('SELECT id, name, brand_settings FROM users WHERE id = $1', [req.user.id]);
    let brand = {};
    try { brand = JSON.parse(user.brand_settings || '{}'); } catch(e) {}
    res.json({ userId: user.id, name: user.name, brand });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});
 
// ── Iniciar servidor ───────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  ✦ RAFLY corriendo en ${BASE_URL}\n`);
    if (!FB_APP_ID || !FB_APP_SECRET) {
      console.log('  ⚠ Falta FB_APP_ID o FB_APP_SECRET en .env');
      console.log('  → Creá una Facebook App en https://developers.facebook.com\n');
    }
    if (!process.env.DATABASE_URL) {
      console.log('  ⚠ Falta DATABASE_URL en .env');
      console.log('  → Creá una base PostgreSQL en https://neon.tech\n');
    }
  });
}).catch(err => {
  console.error('  ✗ Error al inicializar base de datos:', err.message);
  process.exit(1);
});
