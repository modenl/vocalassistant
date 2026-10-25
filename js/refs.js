// Where the rules come from. One numbered list for the whole app; pages show
// the ones they rely on, and inline markers [n] open the paper.

import { L } from './i18n.js';

export const REFS = [
  { id: 'sundberg1974', cite: 'Sundberg J (1974). Articulatory interpretation of the “singing formant”. J Acoust Soc Am 55(4):838–844.', url: 'https://doi.org/10.1121/1.1914609',
    note: L('歌手共振峰：2.5–3.5 kHz 的强峰，来自喉上方收窄的一段短管（喉咽管）；咽腔的横截面积要比它大 6 倍以上。', 'The singer’s formant: a strong peak at 2.5–3.5 kHz produced by the narrow tube just above the larynx; the pharynx’s cross-section must be over six times its area.') },
  { id: 'yanagisawa1989', cite: 'Yanagisawa E, Estill J, Kmucha ST, Leder SB (1989). The contribution of aryepiglottic constriction to “ringing” voice quality — a videolaryngoscopic study with acoustic analysis. J Voice 3(4):342–350.', url: 'https://doi.org/10.1016/S0892-1997(89)80057-8',
    note: L('喉镜直接观察：twang、belting、美声里杓会厌襞都收窄，频谱上对应歌手共振峰。所以 belting 和美声也可以带这种收窄，它们和咽音并不互斥。', 'Seen with a laryngoscope: the aryepiglottic folds narrow in twang, belting and opera, matching the singer’s formant in the spectrum — so belting and opera can include this narrowing too; they aren’t opposites of twang.') },
  { id: 'sundbergThalen2010', cite: 'Sundberg J, Thalén M (2010). What is “twang”? J Voice 24(6):654–660.', url: 'https://doi.org/10.1016/j.jvoice.2009.03.003',
    note: L('一位女歌手的测量：twang 与普通唱法相比，F1、F2 升高，F3、F5 降低，声压级更高；声道形状和声源（声门闭合）都有变化。只有一个人，不能推广成所有人的规律。', 'One female singer measured: twang vs neutral had F1 and F2 higher, F3 and F5 lower and a higher sound level, with both the tract shape and the voice source (closure) changing. One singer — not a rule for everyone.') },
  { id: 'titze2003', cite: 'Titze IR, Bergan CC, Hunter EJ, Story B (2003). Source and filter adjustments affecting the perception of the vocal qualities twang and yawn. Logoped Phoniatr Vocol 28(4):147–155.', url: 'https://doi.org/10.1080/14015430310018874',
    note: L('twang 的感知来自：喉上管（epilarynx）变窄、咽腔变窄、声道变短、声门闭合增强。', 'Twang is heard when the epilarynx and pharynx narrow, the tract shortens and glottal adduction increases.') },
  { id: 'omori1996', cite: 'Omori K, Kacker A, Carroll LM, Riley WD, Blaugrund SM (1996). Singing power ratio: quantitative evaluation of singing voice quality. J Voice 10(3):228–235.', url: 'https://doi.org/10.1016/S0892-1997(96)80003-8',
    note: L('歌唱功率比（SPR）：2–4 kHz 与 0–2 kHz 最强谐波的差；歌手明显好于非歌手，并与听起来“亮、传得远”（ring）的评分相关。', 'Singing power ratio (SPR): strongest harmonic in 2–4 kHz vs 0–2 kHz; clearly better in singers and related to perceived “ring”.') },
  { id: 'kondo2025', cite: 'Kondo H, Kondoh S, Fujii S (2025). Perceived vibrato and the singing power ratio explain overall evaluations in opera singing. Front Psychol 16:1568982.', url: 'https://doi.org/10.3389/fpsyg.2025.1568982',
    note: L('10 位职业女高音的 SPR 在 −30 到 −11 dB 之间（本应用写作“2–4 kHz 比低频弱 11–30 dB”），SPR 越高整体评价越好。', 'SPR of 10 professional female opera singers: −30 to −11 dB (shown here as “2–4 kHz 11–30 dB below the lows”); higher SPR, better overall ratings.') },
  { id: 'sundbergNordenberg2006', cite: 'Sundberg J, Nordenberg M (2006). Effects of vocal loudness variation on spectrum balance as reflected by the alpha measure of long-term-average spectra of speech. J Acoust Soc Am 120(1):453–457.', url: 'https://doi.org/10.1121/1.2208451',
    note: L('（研究的是朗读的说话声）声音变响时，高频相对低频也会变强。唱歌时大概也是这样，但这篇没有测；所以本应用要求穿透力提高的量至少是音量增加量的 0.8 倍——0.8 是本应用的设定，不是从这篇论文得出的。', '(Measured on read speech) louder voices get relatively stronger highs. Singing probably behaves alike but wasn’t measured here; so the app asks twang to gain at least 0.8 dB of ring per dB of loudness — 0.8 is the app’s setting, not derived from this paper.') },
  { id: 'chen1997', cite: 'Chen MY (1997). Acoustic correlates of English and French nasalized vowels. J Acoust Soc Am 102(4):2360–2370.', url: 'https://pubmed.ncbi.nlm.nih.gov/9348695/',
    note: L('鼻音指标 A1−P0：软腭下垂时低频出现鼻腔峰 P0、第一共振峰 A1 变弱，A1−P0 下降（口元音与鼻化元音差 6–8 dB）。', 'Nasality A1−P0: with the soft palate lowered a nasal peak P0 appears low and the first formant A1 weakens, so A1−P0 falls (6–8 dB between oral and nasalized vowels).') },
  { id: 'hanson1997', cite: 'Hanson HM (1997). Glottal characteristics of female speakers: acoustic correlates. J Acoust Soc Am 101(1):466–481.', url: 'https://pubmed.ncbi.nlm.nih.gov/9000737/',
    note: L('H1−H2（第一、第二谐波的强度差）与声门开放比相关：开放比大（气声）H1 强，闭得紧（挤）H1 弱。', 'H1−H2 (first vs second harmonic) tracks the open quotient: breathy (open) voices have a strong H1, pressed ones a weak H1.') },
  { id: 'petersonBarney1952', cite: 'Peterson GE, Barney HL (1952). Control methods used in a study of the vowels. J Acoust Soc Am 24(2):175–184.', url: 'https://doi.org/10.1121/1.1906875',
    note: L('元音的共振峰：F1 随舌位降低（张口）而升高，F2 随舌位前移而升高；女声的共振峰比男声高约 15–20%。', 'Vowel formants: F1 rises as the tongue lowers (mouth opens), F2 rises as it moves forward; women’s formants are ≈ 15–20 % higher.') },
  { id: 'teixeira2013', cite: 'Teixeira JP, Oliveira C, Lopes C (2013). Vocal acoustic analysis – jitter, shimmer and HNR parameters. Procedia Technol 9:1112–1122.', url: 'https://doi.org/10.1016/j.protcy.2013.12.124',
    note: L('周期抖动（jitter）：正常嗓音约 1% 以下（MDVP 常用阈值 1.04%）。唱歌的颤音、滑音会让逐帧估计偏高，所以本应用只在平滑后明显更高（> 3%）时提示。', 'Jitter: normal voices stay under ≈ 1 % (MDVP’s usual threshold 1.04 %). Vibrato and glides inflate frame estimates in singing, so the app only flags a clearly higher smoothed value (> 3 %).') },
];

const NUM = Object.fromEntries(REFS.map((r, i) => [r.id, i + 1]));
// inline marker(s): [n] opening the paper
export const ref = (...ids) => ids.map((id) => { const r = REFS[NUM[id] - 1]; return `<a class="ref" href="${r.url}" target="_blank" rel="noopener" title="${r.cite.replace(/"/g, '&quot;')}">[${NUM[id]}]</a>`; }).join('');
// the reference list for a page
export const refList = (ids) => `<ol class="refs">${ids.map((id) => { const r = REFS[NUM[id] - 1]; return `<li value="${NUM[id]}"><a href="${r.url}" target="_blank" rel="noopener">${r.cite}</a><br><span class="t2">${r.note}</span></li>`; }).join('')}</ol>`;
export const refsSection = (ids) => `<details class="panel refs-box"><summary>${L('依据与参考文献', 'Where this comes from (references)')}</summary>${refList(ids)}</details>`;
