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

// ── Iniciar servidor ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦ RAFLY corriendo en ${BASE_URL}\n`);
  if (!FB_APP_ID || !FB_APP_SECRET) {
    console.log('  ⚠ Falta FB_APP_ID o FB_APP_SECRET en .env');
    console.log('  → Creá una Facebook App en https://developers.facebook.com\n');
  }
});
