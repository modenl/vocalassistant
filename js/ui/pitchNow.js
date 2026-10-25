// The note being sung right now: its name, how far above or below that note
// (cents, on a ±50 scale), and the frequency. Used by the lessons, the pitch
// trainer and the voice scope.

import { midiName, hzToMidi } from '../config.js';
import { L } from '../i18n.js';

// st: { voiced, f0 } (a pitch-tracker state or anything with a frequency)
export function pitchNowHtml(f0, a4 = 440) {
  if (!(f0 > 0)) return `<div class="pnow idle"><b>—</b><span class="pn-sub">${L('唱起来就显示音高', 'sing to see your pitch')}</span></div>`;
  const m = hzToMidi(f0, a4), n = Math.round(m), c = (m - n) * 100;
  const cls = Math.abs(c) <= 15 ? 'good' : Math.abs(c) <= 30 ? 'near' : 'off';
  return `<div class="pnow ${cls}" title="${L('音名、离这个音偏了多少音分、频率', 'note, cents off that note, frequency')}">
    <b>${midiName(n)}</b>
    <div class="pn-meter"><span class="pn-scale"></span><i style="left:${50 + Math.max(-50, Math.min(50, c))}%"></i></div>
    <span class="pn-sub">${c >= 0 ? '+' : ''}${Math.round(c)} ${L('音分', 'cents')} · ${Math.round(f0)} Hz</span>
  </div>`;
}
