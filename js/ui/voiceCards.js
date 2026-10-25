// Voice-scope pieces, small, for any page: a vowel chart with each voice's
// F1/F2 (where the tongue is), and per voice a mini vocal tract estimated from
// its F1/F2 and ring, with the parts in words. Fixed sizes: nothing moves as
// the numbers come and go.
//   const vc = new VoiceCards(el, [{ key: 'ref', label: '原唱', color, title? }, …], { sex });
//   vc.update({ ref: side, user: side })   // side: { formants: [F1, F2], ring, est }

import { TractView, tractWords } from '../viz/scope.js';
import { drawVowelChart } from '../viz/formants.js';
import { tractOf } from '../analysis/voiceState.js';
import { L } from '../i18n.js';

export class VoiceCards {
  constructor(el, voices, { sex = 'm', vowel = true } = {}) {
    this.el = el; this.voices = voices; this.sex = sex;
    el.innerHTML = `<div class="vc-row">
      ${vowel ? `<div class="vc-card vc-wide"><h5>${L('元音图（F1 / F2：舌头在哪）', 'Vowel chart (F1 / F2: where the tongue is)')}</h5><canvas class="viz vc-vowel"></canvas></div>` : ''}
      ${voices.map((v) => `<div class="vc-card" data-k="${v.key}"><h5><i style="background:${v.color}"></i>${v.title || v.label + L('的声道（推测）', ': vocal tract (estimated)')}</h5><div class="vc-tract"></div><p class="vc-words"></p></div>`).join('')}
    </div>`;
    this.tracts = Object.fromEntries(voices.map((v) => [v.key, new TractView(el.querySelector(`[data-k="${v.key}"] .vc-tract`), { mini: true })]));
    this.update({});
  }

  update(sides) {
    const k = this.sex === 'f' ? 1.17 : 1, pts = [];
    for (const v of this.voices) {
      const s = sides[v.key], F = s?.formants;
      const st = tractOf({ F1: F?.[0], F2: F?.[1], ring: s?.ring, k });
      this.tracts[v.key].update(st);
      const W = tractWords(st), est = s?.est ? '≈' : '';
      this.el.querySelector(`[data-k="${v.key}"] .vc-words`).innerHTML = s
        ? `<b>${L('舌', 'Tongue')}</b> ${W.tongue}${est}<br><b>${L('咽腔', 'Pharynx')}</b> ${W.pharynx}`
        : `<span class="muted">${L('这一刻没有声音', 'no voice at this moment')}</span>`;
      if (F?.[0] > 0 && F?.[1] > 0) pts.push({ F1: F[0], F2: F[1], label: v.label + est, color: v.color, hollow: !!s.est });
    }
    const cv = this.el.querySelector('.vc-vowel');
    if (cv) drawVowelChart(cv, { sex: this.sex, points: pts });
  }
}
