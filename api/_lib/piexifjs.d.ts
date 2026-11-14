// No official @types package exists for piexifjs -- minimal ambient shim
// covering only what exifSpoof.ts actually calls.
declare module 'piexifjs' {
  type IFDDict = Record<number, unknown>;

  export const ImageIFD: Record<string, number>;
  export const ExifIFD: Record<string, number>;
  export const GPSIFD: Record<string, number>;
  export const GPSHelper: {
    degToDmsRational(degFloat: number): [[number, number], [number, number], [number, number]];
  };

  export function remove(jpegBinaryString: string): string;
  export function insert(exifBinaryString: string, jpegBinaryString: string): string;
  export function dump(exifObj: { '0th'?: IFDDict; Exif?: IFDDict; GPS?: IFDDict }): string;
  export function load(jpegBinaryString: string): unknown;
}
