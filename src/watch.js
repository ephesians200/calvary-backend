// Turns an admin-supplied video link into something that can be played INSIDE the app.
// The app opens https://<worker>/watch/<id> in a WebView; that page embeds the provider's player.
// Supported: YouTube (watch, youtu.be, Shorts, Live), Facebook (videos, reels, fb.watch), Instagram (posts, reels),
// Vimeo (incl. unlisted), TikTok, Dailymotion, Google Drive videos, and direct .mp4/.webm/.mov/.m3u8 files.

const DIRECT_RE = /\.(mp4|webm|ogv|m4v|mov|m3u8)$/i;

/** Returns { provider, embed, direct } or null when the link is not a supported video link. */
export function parseVideoLink(raw, origin = '') {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|web\.|mbasic\.)/, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const idOk = (s) => /^[A-Za-z0-9_-]{6,20}$/.test(s || '');

  // ---- YouTube ----
  if (host === 'youtu.be' && idOk(seg[0])) return yt(seg[0], origin);
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (u.pathname === '/watch' && idOk(v)) return yt(v, origin);
    if (['shorts', 'live', 'embed', 'v'].includes(seg[0]) && idOk(seg[1])) return yt(seg[1], origin);
  }

  // ---- Vimeo (public, or unlisted with a privacy hash such as vimeo.com/123456789/abcdef1234) ----
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const idx = seg.findIndex((x) => /^\d{5,12}$/.test(x));
    if (idx >= 0) {
      const hash = /^[a-f0-9]{8,12}$/i.test(seg[idx + 1] || '') ? seg[idx + 1] : u.searchParams.get('h');
      const h = hash && /^[a-f0-9]{8,12}$/i.test(hash) ? `?h=${hash}` : '';
      return { provider: 'Vimeo', embed: `https://player.vimeo.com/video/${seg[idx]}${h}`, direct: false };
    }
  }

  // ---- Facebook (videos, reels, share links, fb.watch) ----
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'fb.com') {
    const href = encodeURIComponent(u.toString());
    return { provider: 'Facebook', embed: `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false&t=0`, direct: false };
  }

  // ---- Instagram ----
  if (host === 'instagram.com') {
    // Links like /username/reel/ID/ carry the username first.
    const i = seg.findIndex((x) => ['p', 'reel', 'reels', 'tv'].includes(x));
    if (i >= 0 && idOk(seg[i + 1])) {
      const kind = seg[i] === 'reels' ? 'reel' : seg[i];
      return { provider: 'Instagram', embed: `https://www.instagram.com/${kind}/${seg[i + 1]}/embed/`, direct: false };
    }
  }

  // ---- TikTok (full links only; vm.tiktok.com short links can't be resolved here) ----
  if (host === 'tiktok.com') {
    const i = seg.indexOf('video');
    if (i >= 0 && /^\d{8,25}$/.test(seg[i + 1] || '')) {
      return { provider: 'TikTok', embed: `https://www.tiktok.com/embed/v2/${seg[i + 1]}`, direct: false };
    }
  }

  // ---- Dailymotion ----
  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id = host === 'dai.ly' ? seg[0] : seg[seg.indexOf('video') + 1];
    if (/^[A-Za-z0-9]{5,12}$/.test(id || '')) return { provider: 'Dailymotion', embed: `https://www.dailymotion.com/embed/video/${id}`, direct: false };
  }

  // ---- Google Drive (the file must be shared as "anyone with the link") ----
  if (host === 'drive.google.com' && seg[0] === 'file' && seg[1] === 'd' && /^[A-Za-z0-9_-]{10,80}$/.test(seg[2] || '')) {
    return { provider: 'Google Drive', embed: `https://drive.google.com/file/d/${seg[2]}/preview`, direct: false };
  }

  if (DIRECT_RE.test(u.pathname)) return { provider: 'Video', embed: u.toString(), direct: true };
  return null;
}

// `origin` tells YouTube which site is embedding the player (it rejects embeds that don't identify themselves).
const yt = (id, origin) => ({
  provider: 'YouTube',
  embed: `https://www.youtube.com/embed/${id}?playsinline=1&rel=0&modestbranding=1${origin ? `&origin=${encodeURIComponent(origin)}` : ''}`,
  direct: false,
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function watchPage(title, link, origin = '') {
  const parsed = parseVideoLink(link, origin);
  const player = !parsed
    ? '<p class="msg">This video cannot be played here.</p>'
    : parsed.direct
      ? `<video controls playsinline preload="metadata" src="${esc(parsed.embed)}"></video>`
      : `<iframe src="${esc(parsed.embed)}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture; fullscreen; web-share; clipboard-write" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  // Safety net if a provider refuses to embed one particular video: the app opens this link in the phone's browser.
  const fallback = parsed ? `<a class="open" href="${esc(String(link).trim())}" target="_top">Not playing? Open in browser</a>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin"><title>${esc(title)}</title><style>
html,body{margin:0;height:100%;background:#000;color:#fff;font-family:system-ui,sans-serif}
body{display:flex;flex-direction:column}
.stage{position:relative;flex:1;min-height:0}
iframe,video{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}
.msg{padding:32px;text-align:center}
.open{display:block;padding:10px;text-align:center;font-size:13px;color:#cfd6ff;background:#111;text-decoration:none}
</style></head><body><div class="stage">${player}</div>${fallback}</body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; media-src https:; " +
        'frame-src https://*.youtube.com https://*.youtube-nocookie.com https://*.vimeo.com https://*.facebook.com ' +
        'https://*.instagram.com https://*.tiktok.com https://*.dailymotion.com https://drive.google.com https://*.google.com',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}
