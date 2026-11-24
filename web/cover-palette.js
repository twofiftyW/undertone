// Group coloured pixels by hue so black borders and white lettering don't
// drown out an album's colours. Two shades also work for monochrome covers.
export function sampleCover(image) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 24;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, 24, 24);
  const { data } = context.getImageData(0, 0, 24, 24);
  return coverColors(data);
}

export function coverColors(data) {
  const bins = new Map();
  let light = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max - min;
    light += (max + min) / 510;
    count++;
    if (chroma < 16 || max < 25) continue;
    const hue = max === r ? (g - b) / chroma : max === g ? 2 + (b - r) / chroma : 4 + (r - g) / chroma;
    const bin = Math.round((hue + 6) * 2) % 12;
    bins.set(bin, (bins.get(bin) || 0) + chroma);
  }
  if (!count) return null;
  const ranked = [...bins].sort((a, b) => b[1] - a[1]);
  const lightness = Math.round(24 + 10 * light / count);
  if (!ranked.length || ranked[0][1] < count) return [0, 0, lightness, 0];
  const [dominant, weight] = ranked[0];
  const second = ranked.find(([bin, score]) =>
    Math.min(Math.abs(bin - dominant), 12 - Math.abs(bin - dominant)) >= 2 && score > weight * 0.12);
  const saturation = Math.min(71, Math.round(27 + 1.7 * weight / count));
  return [dominant * 30, saturation, lightness, (second?.[0] ?? dominant) * 30];
}

const storageKey = 'undertone.lyricsCoverColors.v1';
let palettes;

export function savedCoverColors(artwork) {
  if (!palettes) {
    try { palettes = new Map(JSON.parse(localStorage.getItem(storageKey) || '[]')); }
    catch { palettes = new Map(); }
  }
  const colors = palettes.get(artwork);
  return Array.isArray(colors) && colors.length === 4 && colors.every(Number.isFinite) ? colors : null;
}

export function rememberCoverColors(artwork, colors) {
  if (!/^https?:\/\//i.test(artwork) || artwork.length > 2048) return;
  palettes.set(artwork, colors);
  if (palettes.size > 64) palettes.delete(palettes.keys().next().value);
  try { localStorage.setItem(storageKey, JSON.stringify([...palettes])); } catch { /* Use the palette for this session. */ }
}
