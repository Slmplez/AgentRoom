import { useEffect, type RefObject } from 'react';

// Damped spring response, sampled for the Web Animations API. No animation runtime.
// Preset values reference OpenClaudeUI/ClaudeMotionPresets; see THIRD_PARTY_NOTICES.md.
type Entrance = 'popover' | 'dialog' | 'panel';
const presets = { popover: [320, 28, 1], dialog: [400, 32, 1], panel: [1200, 80, .1] } as const;
function response(t: number, k: number, c: number, m: number) {
  const w = Math.sqrt(k / m), z = c / (2 * Math.sqrt(k * m));
  if (Math.abs(z - 1) < .0001) return 1 - Math.exp(-w * t) * (1 + w * t);
  if (z < 1) { const d = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * t) * (Math.cos(d * t) + z * w / d * Math.sin(d * t)); }
  const a = -w * (z - Math.sqrt(z * z - 1)), b = -w * (z + Math.sqrt(z * z - 1));
  return 1 - (b * Math.exp(a * t) - a * Math.exp(b * t)) / (b - a);
}
export function useEntrance<T extends HTMLElement>(ref: RefObject<T | null>, active: boolean, kind: Entrance) {
  useEffect(() => {
    const element = ref.current, preference = matchMedia('(prefers-reduced-motion: reduce)');
    if (!active || !element || preference.matches || !element.animate) return;
    const [k, c, m] = presets[kind], duration = kind === 'panel' ? 320 : kind === 'dialog' ? 280 : 200;
    const frames = Array.from({ length: 34 }, (_, i) => {
      const progress = i === 33 ? 1 : response(i / 33 * duration / 1000, k, c, m);
      return { opacity: Math.min(1, Math.max(0, progress)), transform: kind === 'panel' ? `translateX(${(1 - progress) * 16}px)` : `translateY(${(1 - progress) * 6}px) scale(${.98 + progress * .02})`, offset: i / 33 };
    });
    const animation = element.animate(frames, { duration, easing: 'linear' });
    const stop = () => { if (preference.matches) animation.cancel(); };
    preference.addEventListener('change', stop);
    return () => { animation.cancel(); preference.removeEventListener('change', stop); };
  }, [active, kind, ref]);
}
