import QRCode from 'qrcode';

// Specimen label: a QR code that encodes the accession number, plus the printed text.
// QR (2D) is used instead of 1D Code 128 because it scans reliably from any camera and needs no font.
export async function specimenLabelSvg(accession: string): Promise<string> {
  return QRCode.toString(accession, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 160 });
}
