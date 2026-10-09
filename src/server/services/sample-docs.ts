// Fixed sample data used by the template preview in Admin and for checking the document design.
import type { ReportData, ReportLine } from './report-pdf.tsx';
import type { Brand, LetterheadBranch, SignerView } from '../../pdf/lab/kit.tsx';

export interface SampleBranch extends LetterheadBranch {
  footerText: string | null;
  timings: string | null;
  disclaimer: string | null;
  backgroundDataUri: string | null;
  letterhead: { enabled: boolean; topMm: number; bottomMm: number };
}

const line = (
  parameter: string,
  value: number | string,
  unit: string,
  low: number | null,
  high: number | null,
  flag: ReportLine['flag'],
  trend: number[] = [],
  comment: string | null = null,
): ReportLine => ({
  parameter,
  value: String(value),
  valueNum: typeof value === 'number' ? value : null,
  unit,
  reference: low != null && high != null ? `${low} - ${high}` : high != null ? `< ${high}` : low != null ? `> ${low}` : typeof value === 'string' ? 'Negative' : '',
  refLow: low,
  refHigh: high,
  flag,
  critical: flag === 'LL' || flag === 'HH',
  comment,
  trend,
  previous: trend.length ? { value: String(trend[trend.length - 1]), date: '02 Sep 2026' } : null,
});

export function sampleReport(branch: SampleBranch, brand: Brand, incharge: SignerView | null, variant: 'digital' | 'print' = 'digital'): ReportData {
  return {
    variant,
    reportNo: 'SAMPLE-RPT-0000001',
    version: 1,
    issuedAt: '09 Oct 2026, 14:20',
    verificationUrl: 'http://127.0.0.1:8080/#/verify/SAMPLECODE',
    verificationCode: 'SAMPLECODE',
    amended: false,
    amendmentReasons: [],
    brand,
    branch,
    patient: { name: 'Ayesha Khan', mrn: 'GRW-000123', gender: 'F', age: '38 years', practitioner: 'Dr. Imran Qureshi', allergies: null },
    order: {
      orderNo: 'GRW-O000456',
      priority: 'urgent',
      createdAt: '09 Oct 2026, 09:05',
      collectedAt: '09 Oct 2026, 09:12',
      receivedAt: '09 Oct 2026, 09:30',
      accessions: ['GRW-S0000901', 'GRW-S0000902'],
      specimenTypes: ['EDTA whole blood', 'Serum'],
    },
    sections: [
      {
        department: 'Hematology',
        tests: [
          {
            name: 'Complete Blood Count (CBC)',
            lines: [
              line('Hemoglobin', 6.5, 'g/dL', 12, 15.5, 'LL', [11.2, 9.8, 8.1], 'Critical value telephoned to Dr. Imran at 10:15.'),
              line('Total WBC count', 7.2, 'x10^9/L', 4, 11, 'N', [6.8, 7.5, 7.0]),
              line('RBC count', 3.6, 'x10^12/L', 4.1, 5.1, 'L', [4.0, 3.9, 3.7]),
              line('Hematocrit (PCV)', 24, '%', 36, 46, 'L'),
              line('MCV', 72, 'fL', 80, 100, 'L'),
              line('MCH', 21, 'pg', 27, 33, 'L'),
              line('MCHC', 29.5, 'g/dL', 32, 36, 'L'),
              line('Platelet count', 245, 'x10^9/L', 150, 400, 'N', [230, 260, 251]),
              line('Neutrophils', 62, '%', 40, 75, 'N'),
              line('Lymphocytes', 30, '%', 20, 45, 'N'),
            ],
          },
          { name: 'Erythrocyte Sedimentation Rate', lines: [line('ESR', 34, 'mm/1st hr', 0, 20, 'H', [18, 26])] },
        ],
      },
      {
        department: 'Clinical Chemistry',
        tests: [
          { name: 'Blood Glucose Fasting', lines: [line('Glucose (fasting)', 132, 'mg/dL', 70, 100, 'H', [118, 124, 129])] },
          {
            name: 'Lipid Profile',
            lines: [
              line('Total cholesterol', 214, 'mg/dL', null, 200, 'H', [205, 220]),
              line('Triglycerides', 140, 'mg/dL', null, 150, 'N'),
              line('HDL cholesterol', 38, 'mg/dL', 40, null, 'L'),
              line('LDL cholesterol', 148, 'mg/dL', null, 130, 'H'),
            ],
          },
          { name: 'Creatinine', lines: [line('Creatinine', 0.9, 'mg/dL', 0.6, 1.1, 'N', [0.8, 0.9, 0.85])] },
        ],
      },
      { department: 'Serology & Immunology', tests: [{ name: 'C-Reactive Protein', lines: [line('CRP', 'Negative', 'mg/L', null, null, 'N')] }] },
    ],
    incharge,
    signers: [
      {
        label: 'Consultant Pathologist',
        name: 'Dr. Muhammad Jamil',
        qualifications: 'MBBS, M.Phil Pathology (UHS)',
        signatureDataUri: null,
        note: 'Authorized 09 Oct 2026, 14:18',
      },
    ],
  };
}

export function sampleInvoice(branch: SampleBranch, brand: Brand, paymentDetails: string | null, status = 'partially_paid'): import('./invoice-pdf.tsx').InvoiceData {
  return {
    brand,
    branch,
    invoiceNo: 'INV-SAMPLE-000456',
    orderNo: 'GRW-O000456',
    issuedAt: '09 Oct 2026, 09:05',
    status,
    voidReason: status === 'void' ? 'Created in error' : null,
    patient: { name: 'Ayesha Khan', mrn: 'GRW-000123', phone: '0300 1234567', practitioner: 'Dr. Imran Qureshi' },
    lines: [
      { description: 'Complete Blood Count (CBC)', price: 700, tax: 0, total: 700 },
      { description: 'Erythrocyte Sedimentation Rate', price: 250, tax: 0, total: 250 },
      { description: 'Blood Glucose Fasting', price: 180, tax: 0, total: 180 },
      { description: 'Lipid Profile', price: 1500, tax: 0, total: 1500 },
      { description: 'Creatinine', price: 400, tax: 0, total: 400 },
      { description: 'C-Reactive Protein', price: 650, tax: 0, total: 650 },
    ],
    subtotal: 3680,
    discount: 368,
    discountReason: 'Senior citizen 10%',
    tax: 0,
    total: 3312,
    paid: status === 'paid' ? 3312 : status === 'issued' || status === 'void' ? 0 : 2000,
    refunded: 0,
    balance: status === 'paid' ? 0 : status === 'issued' || status === 'void' ? 3312 : 1312,
    payments:
      status === 'paid'
        ? [
            { when: '09 Oct 2026, 09:06', kind: 'payment', method: 'cash', reference: null, amount: 2000 },
            { when: '09 Oct 2026, 16:40', kind: 'payment', method: 'jazzcash', reference: 'JC-778812', amount: 1312 },
          ]
        : status === 'partially_paid'
          ? [{ when: '09 Oct 2026, 09:06', kind: 'payment', method: 'cash', reference: null, amount: 2000 }]
          : [],
    paymentDetails,
    verificationUrl: 'http://127.0.0.1:8080/#/verify-invoice/SAMPLE',
    verificationCode: 'SAMPLE',
  };
}
