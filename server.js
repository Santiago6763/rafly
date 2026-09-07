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

// ── Middleware ──────────────────────────────────────────────────
app.use(express.static('public'));
app.use(express.json());

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

// ── Iniciar servidor ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦ RAFLY corriendo en ${BASE_URL}\n`);
  if (!FB_APP_ID || !FB_APP_SECRET) {
    console.log('  ⚠ Falta FB_APP_ID o FB_APP_SECRET en .env');
    console.log('  → Creá una Facebook App en https://developers.facebook.com\n');
  }
});
