// The site's Worker: static files (dist/), plus /api/log — diagnostics a page
// sends while analysing a song on a phone (steps, sizes, errors; no audio, no
// file contents), printed for `wrangler tail`. Nothing is stored.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/log' && request.method === 'POST') {
      const body = (await request.text()).slice(0, 4000);
      console.log(`[vocallab] ${request.headers.get('cf-connecting-ip') ? '' : ''}${body}`);
      return new Response(null, { status: 204 });
    }
    return env.ASSETS.fetch(request);
  },
};
