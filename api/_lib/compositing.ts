/**
 * Ideogram's inpaint endpoints regenerate the whole frame, not just the
 * masked region, and snap the output down to a much lower resolution than
 * the input. Paste only the masked region back onto the untouched
 * full-resolution base and discard everything else Ideogram touched. A
 * small feather avoids a hard pixel edge without smearing detail across
 * two regions with different native grain/texture. Ported from
 * face_swap/server/compositing.ts -- same logic, inputs are downloaded
 * Buffers instead of disk paths since there's no local filesystem here.
 */

import sharp from 'sharp';

export async function compositeMaskedRegion(baseBuffer: Buffer, generatedBytes: Buffer, maskBuffer: Buffer, featherPx = 4): Promise<Buffer> {
  const base = sharp(baseBuffer);
  const { width, height } = await base.metadata();
  if (!width || !height) throw new Error('could not read base image dimensions');

  const baseRgb = await base.toColorspace('srgb').raw().ensureAlpha(1).toBuffer({ resolveWithObject: true });
  const generatedRgb = await sharp(generatedBytes)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toColorspace('srgb')
    .raw()
    .ensureAlpha(1)
    .toBuffer();
  const maskGray = await sharp(maskBuffer)
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .blur(Math.max(featherPx, 0.3))
    .raw()
    .toBuffer();

  const baseBuf = baseRgb.data;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const alpha = maskGray[i]! / 255;
    const bi = i * 4;
    const oi = i * 3;
    out[oi] = Math.round(generatedRgb[bi]! * alpha + baseBuf[bi]! * (1 - alpha));
    out[oi + 1] = Math.round(generatedRgb[bi + 1]! * alpha + baseBuf[bi + 1]! * (1 - alpha));
    out[oi + 2] = Math.round(generatedRgb[bi + 2]! * alpha + baseBuf[bi + 2]! * (1 - alpha));
  }

  return sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}
