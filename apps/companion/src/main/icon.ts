import { nativeImage, type NativeImage } from 'electron';

const POINTS = 18;
const SCALE = 2;

/**
 * Draws the menu-bar icon (an eclipse: a ring with a crescent) as a template
 * image, so macOS tints it for light and dark menu bars. Drawn in code so the
 * app ships no binary assets.
 */
export function createTrayIcon(): NativeImage {
  const size = POINTS * SCALE;
  const pixels = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const outer = 7 * SCALE;
  const ring = 1.4 * SCALE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = Math.hypot(px - center, py - center);
      const ringAlpha = clamp(ring / 2 + 0.5 - Math.abs(d - (outer - ring / 2)));
      // Crescent: inside the disc but outside a disc shifted up and right.
      const shifted = Math.hypot(px - center - 2.6 * SCALE, py - center + 1.2 * SCALE);
      const crescent = clamp(outer - ring - d + 0.5) * clamp(shifted - (outer - ring) + 0.5);
      pixels[(y * size + x) * 4 + 3] = Math.round(Math.max(ringAlpha, crescent) * 255); // BGRA: black + alpha
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: SCALE });
  image.setTemplateImage(true);
  return image;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
