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
const Database = require('better-sqlite3');
const path = require('path');
const app = express();

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

// Estado en memoria (un solo usuario — para producción usar DB + sesiones)
let session = {
  accessToken: null,
  igUserId: null,
  username: null,
  profilePic: null
};

// ── JWT Secret ────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'rafly-secret-change-in-production-' + Date.now();
const JWT_EXPIRES = '30d';

// ── SQLite Database ───────────────────────────────────────────
const dbPath = path.join(__dirname, 'data', 'rafly.db');
const fs = require('fs');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT DEFAULT '',
    plan TEXT DEFAULT 'free',
    brand_settings TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sorteo_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    winner TEXT NOT NULL,
    suplentes TEXT DEFAULT '[]',
    participants_count INTEGER DEFAULT 0,
    platform TEXT DEFAULT 'manual',
    mode TEXT DEFAULT 'slot',
    post_url TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS daily_counts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    UNIQUE(user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Prepared statements
const stmts = {
  findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  findUserById: db.prepare('SELECT id, email, name, plan, brand_settings, created_at FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)'),
  updateUser: db.prepare('UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  updatePlan: db.prepare('UPDATE users SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  updateBrand: db.prepare('UPDATE users SET brand_settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
  addSorteo: db.prepare('INSERT INTO sorteo_history (user_id, winner, suplentes, participants_count, platform, mode, post_url) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getSorteos: db.prepare('SELECT * FROM sorteo_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
  getSorteoCount: db.prepare('SELECT COUNT(*) as total FROM sorteo_history WHERE user_id = ?'),
  getDailyCount: db.prepare('SELECT count FROM daily_counts WHERE user_id = ? AND date = ?'),
  upsertDailyCount: db.prepare(`INSERT INTO daily_counts (user_id, date, count) VALUES (?, ?, 1)
    ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1`),
};

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
async function graphGet(path, params = {}) {
  params.access_token = session.accessToken;
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

// ── Auth: Iniciar flujo OAuth ──────────────────────────────────
app.get('/auth/instagram', (req, res) => {
  const url = `https://api.instagram.com/oauth/authorize`
    + `?client_id=${FB_APP_ID}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&scope=${SCOPES}`
    + `&response_type=code`
    + `&enable_fb_login=0`;
  res.redirect(url);
});

// ── Auth: Callback de Instagram ───────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect('/?ig_error=auth_denied');
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

    session.igUserId = String(tokenData.user_id);

    // 2. Intercambiar por token de larga duración (~60 días)
    const longTokenUrl = `https://graph.instagram.com/access_token`
      + `?grant_type=ig_exchange_token`
      + `&client_secret=${FB_APP_SECRET}`
      + `&access_token=${tokenData.access_token}`;

    const longRes = await fetch(longTokenUrl);
    const longData = await longRes.json();
    session.accessToken = longData.access_token || tokenData.access_token;

    // 3. Obtener perfil de Instagram (usar /me en vez del ID numérico
    //    para evitar problemas de precisión con IDs grandes en JavaScript)
    const profile = await graphGet('/me', {
      fields: 'id,username,account_type,profile_picture_url'
    });
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
app.get('/api/status', (req, res) => {
  res.json({
    connected: !!session.accessToken && !!session.igUserId,
    username: session.username,
    profilePic: session.profilePic
  });
});

// ── API: Posts del usuario ─────────────────────────────────────
app.get('/api/media', async (req, res) => {
  if (!session.accessToken || !session.igUserId) {
    return res.status(401).json({ error: 'No conectado a Instagram' });
  }

  try {
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const data = await graphGet(`/${session.igUserId}/media`, {
      fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,permalink,comments_count',
      limit
    });

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
app.get('/api/media/:id/comments', async (req, res) => {
  if (!session.accessToken) {
    return res.status(401).json({ error: 'No conectado a Instagram' });
  }

  try {
    const { id } = req.params;
    let allComments = [];
    let url = `${GRAPH_BASE}/${id}/comments`
      + `?fields=id,text,username,from,timestamp`
      + `&limit=100`
      + `&access_token=${session.accessToken}`;

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

// ── API: Desconectar ───────────────────────────────────────────
app.post('/api/disconnect', (req, res) => {
  session = { accessToken: null, igUserId: null, username: null, profilePic: null };
  res.json({ ok: true });
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

// ── YouTube comment scraping ──
async function scrapeYouTubeComments(videoId) {
  // Use YouTube's internal API (no key needed, limited results)
  const comments = [];
  let postInfo = null;

  try {
    // Get video info via oEmbed
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      postInfo = {
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        author: oembed.author_name
      };
    }
  } catch (e) { /* oEmbed failed */ }

  if (!postInfo) {
    postInfo = {
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      author: null
    };
  }

  // Try to get comments via YouTube page scraping
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      // Extract initial data JSON
      const match = html.match(/var ytInitialData\s*=\s*({.*?});\s*<\/script>/s);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          // Navigate to comment section in the data structure
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

  return { comments, post: postInfo };
}

// ── TikTok comment scraping ──
async function scrapeTikTokComments(url) {
  let postInfo = null;
  const comments = [];

  // Try oEmbed for video info
  try {
    const oembedRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      postInfo = {
        thumbnail: oembed.thumbnail_url,
        author: oembed.author_name
      };
    }
  } catch (e) { /* oEmbed failed */ }

  // TikTok comments are very hard to scrape without API access
  // We return post info and note that manual paste is needed for comments
  return { comments, post: postInfo };
}

app.post('/api/scrape', async (req, res) => {
  const { url, platform: clientPlatform } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });

  const platform = clientPlatform || detectPlatform(url) || 'instagram';

  // ── YouTube ──
  if (platform === 'youtube') {
    const videoId = extractYouTubeId(url);
    if (!videoId) return res.status(400).json({ error: 'URL de YouTube no válida. Usá un link de video, short o live.' });
    try {
      const { comments, post } = await scrapeYouTubeComments(videoId);
      return res.json({
        success: true, shortcode: videoId, post, comments,
        total: comments.length, method: comments.length > 0 ? 'youtube_scrape' : 'none',
        note: comments.length === 0 ? 'No se pudieron extraer comentarios de YouTube automáticamente. YouTube limita el acceso público. Podés pegar los comentarios manualmente.' : null
      });
    } catch (err) {
      return res.status(500).json({ error: 'Error al procesar video de YouTube: ' + err.message });
    }
  }

  // ── TikTok ──
  if (platform === 'tiktok') {
    try {
      const { comments, post } = await scrapeTikTokComments(url);
      return res.json({
        success: true, shortcode: extractTikTokId(url) || 'tiktok', post, comments,
        total: comments.length, method: comments.length > 0 ? 'tiktok_scrape' : 'none',
        note: comments.length === 0 ? 'TikTok no permite acceso público a comentarios. Podés copiar y pegar los comentarios manualmente desde la app.' : null
      });
    } catch (err) {
      return res.status(500).json({ error: 'Error al procesar video de TikTok: ' + err.message });
    }
  }

  // ── Instagram (original flow) ──

  const shortcode = extractShortcode(url);
  if (!shortcode) return res.status(400).json({ error: 'URL de Instagram no válida. Usá un link de post, reel o carrusel.' });

  try {
    // 1. Obtener info del post via oEmbed (confiable, usa app credentials)
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

    // Método A: Instagram GraphQL endpoint (público, sin auth)
    try {
      const graphqlUrl = `https://www.instagram.com/graphql/query/`
        + `?query_hash=bc3296d1ce80a24b1b6e40b1e72903f5`
        + `&variables=${encodeURIComponent(JSON.stringify({ shortcode, first: 100 }))}`;
      const gRes = await fetch(graphqlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

        // Obtener thumbnail del post si oEmbed falló
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
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          // Buscar JSON embebido en el HTML
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
    if (comments.length === 0 && session.accessToken && postInfo?.media_id) {
      try {
        const data = await graphGet(`/${postInfo.media_id}/comments`, {
          fields: 'id,text,username,timestamp',
          limit: 100
        });
        comments = (data.data || []).map(c => ({
          username: c.username || 'unknown',
          text: c.text || '',
          timestamp: c.timestamp
        }));
        if (comments.length > 0) method = 'api_fallback';
      } catch (e) { /* API fallback failed */ }
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

// ══════════════════════════════════════════════════════════════
//   LEVEL 6: AUTH API
// ══════════════════════════════════════════════════════════════

// ── Register ──
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  // Normalize email
  const normalizedEmail = email.trim().toLowerCase();

  // Check existing
  const existing = stmts.findUserByEmail.get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });

  try {
    const hashed = await bcrypt.hash(password, 10);
    const result = stmts.createUser.run(normalizedEmail, hashed, name || '');
    const userId = result.lastInsertRowid;

    const token = jwt.sign({ userId: Number(userId) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const user = stmts.findUserById.get(userId);

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Error al crear cuenta' });
  }
});

// ── Login ──
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const normalizedEmail = email.trim().toLowerCase();
  const user = stmts.findUserByEmail.get(normalizedEmail);
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

  try {
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const safeUser = stmts.findUserById.get(user.id);

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// ── Get current user ──
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = stmts.findUserById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const sorteoCount = stmts.getSorteoCount.get(req.userId);
  const today = new Date().toISOString().split('T')[0];
  const dailyCount = stmts.getDailyCount.get(req.userId, today);

  res.json({
    user,
    stats: {
      totalSorteos: sorteoCount.total,
      todaySorteos: dailyCount ? dailyCount.count : 0
    }
  });
});

// ── Update profile ──
app.put('/api/auth/profile', authMiddleware, (req, res) => {
  const { name } = req.body;
  stmts.updateUser.run(name || '', req.userId);
  const user = stmts.findUserById.get(req.userId);
  res.json({ user });
});

// ── Update plan ──
app.put('/api/auth/plan', authMiddleware, (req, res) => {
  const { plan } = req.body;
  if (!['free', 'pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Plan inválido' });
  }
  stmts.updatePlan.run(plan, req.userId);
  const user = stmts.findUserById.get(req.userId);
  res.json({ user });
});

// ── Save brand settings ──
app.put('/api/auth/brand', authMiddleware, (req, res) => {
  const brand = JSON.stringify(req.body.brand || {});
  stmts.updateBrand.run(brand, req.userId);
  res.json({ ok: true });
});

// ── Save sorteo result ──
app.post('/api/sorteos', authMiddleware, (req, res) => {
  const { winner, suplentes, participantsCount, platform, mode, postUrl } = req.body;
  if (!winner) return res.status(400).json({ error: 'Winner requerido' });

  stmts.addSorteo.run(
    req.userId, winner,
    JSON.stringify(suplentes || []),
    participantsCount || 0,
    platform || 'manual',
    mode || 'slot',
    postUrl || null
  );

  // Increment daily count
  const today = new Date().toISOString().split('T')[0];
  stmts.upsertDailyCount.run(req.userId, today);

  res.json({ ok: true });
});

// ── Get sorteo history ──
app.get('/api/sorteos', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const sorteos = stmts.getSorteos.all(req.userId, limit);
  sorteos.forEach(s => {
    try { s.suplentes = JSON.parse(s.suplentes); } catch (e) { s.suplentes = []; }
  });
  res.json({ sorteos });
});

// ══════════════════════════════════════════════════════════════
//   LEVEL 6: ADMIN API
// ══════════════════════════════════════════════════════════════

// Admin middleware — check if user has admin flag or is first user
function adminMiddleware(req, res, next) {
  const user = stmts.findUserById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  // First registered user is admin, or check admin column
  if (user.id !== 1) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
}

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.plan, u.created_at,
           (SELECT COUNT(*) FROM sorteo_history WHERE user_id = u.id) as total_sorteos,
           (SELECT MAX(created_at) FROM sorteo_history WHERE user_id = u.id) as last_sorteo
    FROM users u ORDER BY u.created_at DESC
  `).all();
  res.json({ users });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalSorteos = db.prepare('SELECT COUNT(*) as c FROM sorteo_history').get().c;
  const todaySorteos = db.prepare("SELECT COUNT(*) as c FROM sorteo_history WHERE date(created_at) = date('now')").get().c;
  const planDist = db.prepare('SELECT plan, COUNT(*) as c FROM users GROUP BY plan').all();
  const recentSorteos = db.prepare(`
    SELECT sh.*, u.email, u.name as user_name
    FROM sorteo_history sh JOIN users u ON sh.user_id = u.id
    ORDER BY sh.created_at DESC LIMIT 20
  `).all();

  res.json({ totalUsers, totalSorteos, todaySorteos, planDist, recentSorteos });
});

app.put('/api/admin/users/:id/plan', authMiddleware, adminMiddleware, (req, res) => {
  const { plan } = req.body;
  if (!['free', 'pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Plan inválido' });
  }
  stmts.updatePlan.run(plan, req.params.id);
  res.json({ ok: true });
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

// Stripe price IDs — set these in .env or Stripe dashboard
const STRIPE_PRICES = {
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
  pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL || null,
  enterprise_monthly: process.env.STRIPE_PRICE_ENT_MONTHLY || null,
  enterprise_annual: process.env.STRIPE_PRICE_ENT_ANNUAL || null,
};

// Add stripe_customer_id column if not exists
try {
  db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT DEFAULT NULL`);
} catch (e) { /* column already exists */ }
try {
  db.exec(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT DEFAULT NULL`);
} catch (e) { /* column already exists */ }

const stmtUpdateStripeCustomer = db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?');
const stmtUpdateStripeSubscription = db.prepare('UPDATE users SET stripe_subscription_id = ? WHERE id = ?');
const stmtFindByStripeCustomer = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?');

// ── Create Checkout Session ──
app.post('/api/stripe/checkout', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado. Contactá al administrador.' });

  const { plan, billing } = req.body; // plan: 'pro'|'enterprise', billing: 'monthly'|'annual'
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
    const user = stmts.findUserByEmail.get(
      db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId)?.email
    );
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Get or create Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { rafly_user_id: String(req.userId) }
      });
      customerId = customer.id;
      stmtUpdateStripeCustomer.run(customerId, req.userId);
    }

    // If user already has an active subscription, redirect to portal instead
    if (user.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        if (['active', 'trialing'].includes(sub.status)) {
          // Create billing portal session for plan change
          const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${BASE_URL}/pricing.html?session=portal`,
          });
          return res.json({ url: portalSession.url, type: 'portal' });
        }
      } catch (e) { /* subscription not found or inactive, continue to checkout */ }
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
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

    res.json({ url: session.url, type: 'checkout' });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});

// ── Stripe Customer Portal ──
app.post('/api/stripe/portal', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado' });

  try {
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.userId);
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
// IMPORTANT: This must be BEFORE express.json() for the raw body,
// but since we already have express.json(), we handle it with a special parser
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
        const session = event.data.object;
        const userId = session.metadata?.rafly_user_id;
        const plan = session.metadata?.plan;
        if (userId && plan) {
          stmts.updatePlan.run(plan, Number(userId));
          if (session.subscription) {
            stmtUpdateStripeSubscription.run(session.subscription, Number(userId));
          }
          console.log(`✦ User ${userId} upgraded to ${plan}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.rafly_user_id;
        if (userId) {
          if (subscription.status === 'active') {
            const plan = subscription.metadata?.plan || 'pro';
            stmts.updatePlan.run(plan, Number(userId));
          } else if (['canceled', 'unpaid', 'past_due'].includes(subscription.status)) {
            stmts.updatePlan.run('free', Number(userId));
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.rafly_user_id;
        if (userId) {
          stmts.updatePlan.run('free', Number(userId));
          stmtUpdateStripeSubscription.run(null, Number(userId));
          console.log(`✦ User ${userId} subscription canceled → free`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const user = stmtFindByStripeCustomer.get(customerId);
        if (user) {
          console.log(`⚠ Payment failed for user ${user.id} (${user.email})`);
          // Don't downgrade immediately — Stripe retries
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }

  res.json({ received: true });
});

// ── Stripe status (check if configured) ──
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

// Hook: send welcome email on register
const originalRegisterHandler = app._router.stack;
// We'll add email sending to the existing register route via a post-register hook

// ── Send welcome email endpoint (called by frontend after register) ──
app.post('/api/email/welcome', authMiddleware, async (req, res) => {
  const user = stmts.findUserById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const result = await sendEmail(
    user.email,
    '¡Bienvenido a RAFLY! 🎰',
    welcomeEmailHTML(user.name)
  );
  res.json(result);
});

// ── Send sorteo result email ──
app.post('/api/email/sorteo-result', authMiddleware, async (req, res) => {
  const user = stmts.findUserById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { winner, participantsCount, mode } = req.body;
  const result = await sendEmail(
    user.email,
    `🎉 Ganador: ${winner} — RAFLY`,
    sorteoEmailHTML(winner, participantsCount || 0, mode || 'slot')
  );
  res.json(result);
});

// ── Web Push Notifications ──
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || null;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@rafly.app';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

// Create push_subscriptions table
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT UNIQUE NOT NULL,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const stmtSavePushSub = db.prepare('INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?, ?)');
const stmtGetPushSubs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
const stmtDeletePushSub = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');

// Subscribe to push
app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });

  const { subscription } = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  stmtSavePushSub.run(req.userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
  res.json({ ok: true });
});

// Unsubscribe
app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) stmtDeletePushSub.run(endpoint);
  res.json({ ok: true });
});

// Get VAPID public key
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC || null });
});

// Send push notification to a user
async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC) return;
  const subs = stmtGetPushSubs.all(userId);
  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
      }, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — remove it
        stmtDeletePushSub.run(sub.endpoint);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
//   LEVEL 7: ANALYTICS CONFIG
// ══════════════════════════════════════════════════════════════

const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || null;

// Endpoint to get analytics config (avoids hardcoding GA ID in frontend)
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

// API keys table
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT DEFAULT 'default',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    requests_today INTEGER DEFAULT 0,
    requests_total INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const stmtCreateApiKey = db.prepare('INSERT INTO api_keys (user_id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?)');
const stmtGetApiKeyByHash = db.prepare('SELECT ak.*, u.email, u.plan FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.key_hash = ?');
const stmtGetApiKeysByUser = db.prepare('SELECT id, key_prefix, name, created_at, last_used, requests_today, requests_total FROM api_keys WHERE user_id = ?');
const stmtDeleteApiKey = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
const stmtUpdateApiKeyUsage = db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP, requests_today = requests_today + 1, requests_total = requests_total + 1 WHERE id = ?');
const stmtResetDailyApiUsage = db.prepare('UPDATE api_keys SET requests_today = 0');

// Reset daily API usage at midnight (simple approach)
let lastResetDate = new Date().toDateString();
function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    stmtResetDailyApiUsage.run();
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
function apiKeyAuth(req, res, next) {
  checkDailyReset();

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Pass it via X-API-Key header or api_key query param.' });
  }

  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const keyRow = stmtGetApiKeyByHash.get(hash);
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
  stmtUpdateApiKeyUsage.run(keyRow.id);

  req.apiUser = { id: keyRow.user_id, email: keyRow.email, plan };
  req.apiLimits = limits;
  next();
}

// ── API Key Management (requires JWT auth) ──

// Create API key
app.post('/api/keys', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  const existing = stmtGetApiKeysByUser.all(req.userId);
  if (existing.length >= 5) {
    return res.status(400).json({ error: 'Max 5 API keys per account' });
  }

  const rawKey = `rfly_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const prefix = rawKey.substring(0, 12) + '...';

  stmtCreateApiKey.run(req.userId, hash, prefix, name || 'default');
  res.json({ key: rawKey, prefix, name: name || 'default', message: 'Save this key — it won\'t be shown again.' });
});

// List API keys
app.get('/api/keys', authMiddleware, (req, res) => {
  const keys = stmtGetApiKeysByUser.all(req.userId);
  res.json({ keys });
});

// Delete API key
app.delete('/api/keys/:id', authMiddleware, (req, res) => {
  const result = stmtDeleteApiKey.run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});

// ── Public API Endpoints (require API key) ──

// GET /api/v1/sorteo/random — pick random winner(s) from a list
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
  const pool = [...list];

  for (let i = 0; i < winnerCount; i++) {
    const idx = crypto.randomInt(pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }

  res.json({
    winners,
    total_participants: list.length,
    draw_time: new Date().toISOString(),
    method: 'crypto.randomInt'
  });
});

// GET /api/v1/sorteos — list user's sorteo history
app.get('/api/v1/sorteos', apiKeyAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const sorteos = db.prepare('SELECT * FROM sorteos WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(req.apiUser.id, limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM sorteos WHERE user_id = ?').get(req.apiUser.id);

  res.json({ sorteos, total: total.count, limit, offset });
});

// GET /api/v1/account — account info + usage
app.get('/api/v1/account', apiKeyAuth, (req, res) => {
  res.json({
    email: req.apiUser.email,
    plan: req.apiUser.plan,
    api_limits: req.apiLimits
  });
});

// API docs endpoint (returns OpenAPI-style spec)
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

// ── Iniciar servidor ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦ RAFLY corriendo en ${BASE_URL}\n`);
  if (!FB_APP_ID || !FB_APP_SECRET) {
    console.log('  ⚠ Falta FB_APP_ID o FB_APP_SECRET en .env');
    console.log('  → Creá una Facebook App en https://developers.facebook.com\n');
  }
});
