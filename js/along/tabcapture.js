// The sound of this browser tab — the YouTube player in it — shared by the
// singer through the browser's own screen-share dialog ("share tab audio").
// Chrome and Edge on a computer only. Analysed in memory, never stored.

export const canCaptureTab = () => !!navigator.mediaDevices?.getDisplayMedia;

// → { stream }. The tab keeps playing its own sound (suppressLocalAudioPlayback
// false): suppressing it silences the WHOLE tab — this page's own audio output
// included — since the shared tab is this one (tried: no sound at all).
// currentTab: the player is in this page (YouTube, Bilibili embedded); else the
// singer picks the tab where the music plays (any site)
export async function captureTabAudio({ currentTab = true } = {}) {
  const s = await navigator.mediaDevices.getDisplayMedia({
    // a video track is required by the API; it's dropped right away
    video: { displaySurface: 'browser' },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    preferCurrentTab: currentTab, selfBrowserSurface: currentTab ? 'include' : 'exclude', surfaceSwitching: 'exclude', systemAudio: 'exclude',
  });
  const audio = s.getAudioTracks()[0];
  s.getVideoTracks().forEach((t) => t.stop());
  if (!audio) { s.getTracks().forEach((t) => t.stop()); throw new Error('no-audio'); }
  return { stream: new MediaStream([audio]) };
}
