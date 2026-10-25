// The official YouTube IFrame player (developers.google.com/youtube/iframe_api_reference).
// The page can't read the player's sound; see tabcapture.js for that.

// the video id in any usual YouTube link (watch?v=, youtu.be/, shorts/, embed/, live/)
export function videoIdOf(url) {
  const s = String(url || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

let api = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  api ||= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { api = null; reject(new Error('YouTube player failed to load')); };
    document.head.appendChild(s);
  });
  return api;
}

// A Bilibili video's embed player (player.bilibili.com), or null for other
// links. It has no script control: the singer presses play.
export function bilibiliEmbedOf(url) {
  const s = String(url || '');
  if (!/bilibili\.com|b23\.tv|^BV/i.test(s)) return null;
  const bv = s.match(/BV[0-9A-Za-z]{10}/)?.[0], av = s.match(/\bav(\d+)/i)?.[1], p = s.match(/[?&]p=(\d+)/)?.[1] || 1;
  if (!bv && !av) return null;
  return `https://player.bilibili.com/player.html?${bv ? `bvid=${bv}` : `aid=${av}`}&page=${p}&high_quality=1&danmaku=0&autoplay=0`;
}

// a player in `el` (replaced by the iframe); resolves once it can play
export async function createPlayer(el, videoId) {
  const YT = await loadApi();
  return new Promise((resolve, reject) => {
    const p = new YT.Player(el, {
      videoId, width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0 },
      events: { onReady: () => resolve(p), onError: (e) => reject(new Error(`YouTube error ${e.data}`)) },
    });
  });
}
