// The site's Worker: static files (dist/), plus /api/log — diagnostics a page
// sends while analysing a song on a phone (steps, sizes, errors; no audio, no
// file contents), printed for `wrangler tail`. Nothing is stored.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/log' && request.method === 'POST') {
      // one line or a batch of them
      let lines;
      try { const j = JSON.parse((await request.text()).slice(0, 64000)); lines = Array.isArray(j) ? j : [j]; } catch { lines = []; }
      for (const l of lines.slice(0, 200)) console.log(`[vocallab] ${JSON.stringify(l).slice(0, 2000)}`);
      return new Response(null, { status: 204 });
    }
    return env.ASSETS.fetch(request);
  },
};
