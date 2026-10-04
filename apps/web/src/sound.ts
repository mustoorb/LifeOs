import { store } from './dom.js';

/**
 * Small synthesized chimes for XP, quests, badges and level-ups. Off by
 * default; the member turns them on in the header. No audio files: the Web
 * Audio API makes each sound, so the page loads nothing extra.
 */

const KEY = 'lifeos.sound';
let context: AudioContext | null = null;

export const soundOn = () => store.get(KEY) === 'on';

export function setSound(on: boolean): void {
  store.set(KEY, on ? 'on' : 'off');
  if (on) audio(); // created inside the click, so the browser allows it
}

function audio(): AudioContext | null {
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

type Note = readonly [frequency: number, start: number, length: number];

function notes(sequence: readonly Note[], type: OscillatorType = 'sine', volume = 0.07): void {
  if (!soundOn()) return;
  const ctx = audio();
  if (!ctx) return;
  for (const [frequency, start, length] of sequence) {
    const at = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }
}

export const play = {
  tick: () => notes([[1046, 0, 0.09]]),
  xp: () => notes([[880, 0, 0.12], [1318, 0.08, 0.2]]),
  quest: () => notes([[659, 0, 0.2], [880, 0.12, 0.2], [1175, 0.24, 0.4]]),
  badge: () => notes([[1568, 0, 0.12], [2093, 0.07, 0.14], [2637, 0.14, 0.35]], 'triangle', 0.05),
  level: () => notes([[523, 0, 0.22], [659, 0.15, 0.22], [784, 0.3, 0.22], [1047, 0.45, 0.7]], 'triangle'),
};
