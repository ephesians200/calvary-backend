// Turns an admin-supplied video link into something that can be played INSIDE the app.
// The app opens https://<worker>/watch/<id> in a WebView; that page embeds the provider's player.

const DIRECT_RE = /\.(mp4|webm|ogv|m4v|mov)$/i;

/** Returns { provider, embed, direct } or null when the link is not a supported video link. */
export function parseVideoLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|web\.|mbasic\.)/, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const idOk = (s) => /^[A-Za-z0-9_-]{6,20}$/.test(s || '');

  if (host === 'youtu.be' && idOk(seg[0])) return yt(seg[0]);
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (u.pathname === '/watch' && idOk(v)) return yt(v);
    if (['shorts', 'live', 'embed', 'v'].includes(seg[0]) && idOk(seg[1])) return yt(seg[1]);
  }
  if (host === 'vimeo.com') {
    const id = seg.find((x) => /^\d{5,12}$/.test(x));
    if (id) return { provider: 'Vimeo', embed: `https://player.vimeo.com/video/${id}`, direct: false };
  }
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'fb.com') {
    const href = encodeURIComponent(u.toString());
    return { provider: 'Facebook', embed: `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false&t=0`, direct: false };
  }
  if (host === 'instagram.com' && ['p', 'reel', 'tv'].includes(seg[0]) && idOk(seg[1])) {
    return { provider: 'Instagram', embed: `https://www.instagram.com/${seg[0]}/${seg[1]}/embed/`, direct: false };
  }
  if (DIRECT_RE.test(u.pathname)) return { provider: 'Video', embed: u.toString(), direct: true };
  return null;
}

const yt = (id) => ({ provider: 'YouTube', embed: `https://www.youtube.com/embed/${id}?playsinline=1&rel=0`, direct: false });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function watchPage(title, link) {
  const parsed = parseVideoLink(link);
  const player = !parsed
    ? '<p class="msg">This video cannot be played here.</p>'
    : parsed.direct
      ? `<video controls playsinline preload="metadata" src="${esc(parsed.embed)}"></video>`
      : `<iframe src="${esc(parsed.embed)}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture; fullscreen; web-share" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
html,body{margin:0;height:100%;background:#000;color:#fff;font-family:system-ui,sans-serif}
iframe,video{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}
.msg{padding:32px;text-align:center}
</style></head><body>${player}</body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; media-src https:; " +
        'frame-src https://www.youtube.com https://player.vimeo.com https://www.facebook.com https://www.instagram.com',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}
