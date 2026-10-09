// Branch letterhead, colours and signers shared by the lab report, the invoice and the template preview.
import type { DatabaseSync } from 'node:sqlite';
import { readIfExists } from './files.ts';
import { safeColor, type Brand, type SignerView } from '../../pdf/lab/kit.tsx';
import type { SampleBranch } from './sample-docs.ts';

export function dataUri(path: string | null | undefined, fallbackMime = 'image/jpeg'): string | null {
  const buf = readIfExists(path ?? null);
  if (!buf) return null;
  const mime = path!.endsWith('.png') ? 'image/png' : fallbackMime;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export interface BranchDesign {
  brand: Brand;
  branch: SampleBranch;
  incharge: SignerView | null;
  paymentDetails: string | null;
}

export function branchDesign(db: DatabaseSync, branchId: number): BranchDesign {
  const b = db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId) as Record<string, any>;
  return {
    brand: { primary: safeColor(b.brand_primary, '#1F5FAE'), secondary: safeColor(b.brand_secondary, '#C8102E') },
    branch: {
      name: String(b.name),
      motto: b.motto ?? null,
      address: b.address ?? null,
      phone: b.phone ?? null,
      email: b.email ?? null,
      headerText: b.header_text ?? null,
      logoDataUri: dataUri(b.logo_path),
      footerText: b.footer_text ?? null,
      timings: b.timings ?? null,
      disclaimer: b.disclaimer ?? null,
      backgroundDataUri: dataUri(b.background_path),
      letterhead: { enabled: b.letterhead_mode === 1, topMm: Number(b.letterhead_top_mm ?? 45), bottomMm: Number(b.letterhead_bottom_mm ?? 30) },
    },
    incharge: b.incharge_name
      ? { label: 'Lab Incharge', name: String(b.incharge_name), qualifications: b.incharge_title ?? null, signatureDataUri: dataUri(b.incharge_signature_path, 'image/png'), note: null }
      : null,
    paymentDetails: b.payment_details ?? null,
  };
}
