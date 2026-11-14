/**
 * Final step on a delivered admin-pipeline swap: writes fabricated-but-
 * plausible iPhone 16 Pro EXIF/GPS onto the composited result, so it looks
 * camera-native rather than carrying provenance pointing at the editing
 * pipeline. For consented client deliverables only (paid-for face-swap
 * stock/ad photos), not for impersonation.
 *
 * Ported from face_swap/server/exifSpoof.ts (itself ported from
 * ~/.bashrc's add_clean_iphone_metadata) -- ported to `piexifjs` instead of
 * `exiftool-vendored` since the latter shells out to a real `exiftool`
 * binary, which Vercel serverless functions can't reliably do. piexifjs
 * writes raw numeric EXIF tag values rather than exiftool's human-readable
 * convenience strings, so every enum-like field below is translated to its
 * raw EXIF code by hand. The `xattr -c` step from the local-tool version is
 * dropped entirely -- it's macOS-only and doesn't apply to a file served
 * from Supabase Storage to a browser.
 */

import piexif from 'piexifjs';

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// EXIF RATIONAL encoding: [numerator, denominator]. `precision` controls how
// many fractional digits survive -- 10 for one-decimal values (f-numbers,
// focal lengths, altitude/direction), 1_000_000 for the six-decimal APEX
// values this codebase has always computed at that precision.
function toRational(value: number, precision: number): [number, number] {
  return [Math.round(value * precision), precision];
}

function parseTimeToRationalTriplet(hhmmss: string): [[number, number], [number, number], [number, number]] {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return [
    [h!, 1],
    [m!, 1],
    [s!, 1],
  ];
}

export function randomDeliveredFilename(): string {
  return `IMG_${randomInt(1000, 9999)}.jpg`;
}

export async function applyCleanIphoneMetadata(jpegBytes: Buffer, width: number, height: number): Promise<Buffer> {
  // Current time minus 1-120 random minutes, matching the original's
  // `date -v -$((RANDOM % 120 + 1))M`.
  const minutesAgo = randomInt(1, 120);
  const dt = new Date(Date.now() - minutesAgo * 60_000);
  const datetime = `${dt.getFullYear()}:${pad2(dt.getMonth() + 1)}:${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
  const dateOnly = datetime.split(' ')[0]!;
  const timeOnly = `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}:${pad2(dt.getUTCSeconds())}`;

  const gpsLat = 47.6205;
  const gpsLon = -122.3493;

  const brightness = 0.5 + randomInt(0, 199) / 1000;
  const focalLength = 6.8;
  const iso = randomInt(100, 899);
  const shutterDenominator = randomInt(100, 499);
  let aperture = 1.8 + randomInt(0, 9) / 10;
  if (aperture > 2.8) aperture = 2.8;
  const shutterSpeedValue = Math.log(shutterDenominator) / Math.log(2);
  const gpsAltitude = 50 + randomInt(0, 49);
  const gpsImgDirection = 180 + randomInt(0, 179);

  const { ImageIFD, ExifIFD, GPSIFD, GPSHelper } = piexif;

  // OffsetTime/OffsetTimeOriginal/OffsetTimeDigitized are EXIF 2.31+ tags --
  // piexifjs predates that revision, and its dump() looks up each tag's
  // encoding type in its own internal TAGS table before serializing it, so
  // writing a tag number it doesn't recognize throws regardless of where the
  // number comes from. Dropped rather than written raw.

  const zeroth: Record<number, unknown> = {
    [ImageIFD.Make!]: 'Apple',
    [ImageIFD.Model!]: 'iPhone 16 Pro',
    [ImageIFD.Software!]: '18.5',
    [ImageIFD.HostComputer!]: 'iPhone 16 Pro',
    [ImageIFD.Orientation!]: 1,
    [ImageIFD.XResolution!]: [72, 1],
    [ImageIFD.YResolution!]: [72, 1],
    [ImageIFD.ResolutionUnit!]: 2, // inches
    [ImageIFD.DateTime!]: datetime, // ModifyDate
  };

  const exif: Record<number, unknown> = {
    [ExifIFD.ExposureTime!]: [1, shutterDenominator],
    [ExifIFD.FNumber!]: toRational(aperture, 10),
    [ExifIFD.ExposureProgram!]: 2, // Program AE
    [ExifIFD.ISOSpeedRatings!]: iso,
    [ExifIFD.DateTimeOriginal!]: datetime,
    [ExifIFD.DateTimeDigitized!]: datetime, // CreateDate
    [ExifIFD.ShutterSpeedValue!]: toRational(shutterSpeedValue, 1_000_000),
    [ExifIFD.ApertureValue!]: toRational(aperture, 1_000_000),
    [ExifIFD.BrightnessValue!]: toRational(brightness, 1_000_000),
    [ExifIFD.ExposureBiasValue!]: [0, 1], // ExposureCompensation
    [ExifIFD.MeteringMode!]: 5, // Multi-segment
    [ExifIFD.Flash!]: 0, // Off, did not fire
    [ExifIFD.FocalLength!]: toRational(focalLength, 10),
    [ExifIFD.SubjectArea!]: [2851, 2137, 3141, 1884],
    [ExifIFD.LensMake!]: 'Apple',
    [ExifIFD.LensModel!]: 'iPhone 16 Pro back triple camera 6.8mm f/1.8',
    [ExifIFD.LensSpecification!]: [toRational(focalLength, 10), toRational(focalLength, 10), [18, 10], [18, 10]],
    [ExifIFD.ColorSpace!]: 1, // sRGB
    [ExifIFD.PixelXDimension!]: width,
    [ExifIFD.PixelYDimension!]: height,
    [ExifIFD.SensingMethod!]: 2, // One-chip color area
    [ExifIFD.SceneType!]: '\x01', // Directly photographed (UNDEFINED, 1 byte)
    [ExifIFD.ExposureMode!]: 0, // Auto
    [ExifIFD.WhiteBalance!]: 0, // Auto
    [ExifIFD.FocalLengthIn35mmFilm!]: 26,
  };

  const gps: Record<number, unknown> = {
    [GPSIFD.GPSVersionID!]: [2, 3, 0, 0],
    [GPSIFD.GPSLatitudeRef!]: 'N',
    [GPSIFD.GPSLatitude!]: GPSHelper.degToDmsRational(gpsLat),
    [GPSIFD.GPSLongitudeRef!]: 'W',
    [GPSIFD.GPSLongitude!]: GPSHelper.degToDmsRational(Math.abs(gpsLon)),
    [GPSIFD.GPSAltitudeRef!]: 0, // above sea level
    [GPSIFD.GPSAltitude!]: toRational(gpsAltitude, 10),
    [GPSIFD.GPSTimeStamp!]: parseTimeToRationalTriplet(timeOnly),
    [GPSIFD.GPSImgDirectionRef!]: 'T', // True North
    [GPSIFD.GPSImgDirection!]: toRational(gpsImgDirection, 10),
    [GPSIFD.GPSDateStamp!]: dateOnly,
  };

  const binary = jpegBytes.toString('binary');
  const stripped = piexif.remove(binary);
  const exifBytes = piexif.dump({ '0th': zeroth, Exif: exif, GPS: gps });
  const withExif = piexif.insert(exifBytes, stripped);
  return Buffer.from(withExif, 'binary');
}
