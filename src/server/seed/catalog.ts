// Starter catalog for a laboratory in Pakistan. Prices are a sample price list in PKR.
// Reference ranges are typical adult values from published sources. They are loaded as
// "starter" ranges and must be reviewed and approved by the laboratory's pathologist before
// reports are released for patients. Clinical content, not software, is the responsibility of the lab.

export interface SeedRange {
  sex?: 'A' | 'M' | 'F';
  low?: number;
  high?: number;
  text?: string;
}

export interface SeedParam {
  code: string;
  name: string;
  unit?: string;
  decimals?: number;
  type?: 'numeric' | 'text' | 'qualitative' | 'calculated';
  formula?: string;
  options?: string[];
  crit?: [number | null, number | null];
  ranges?: SeedRange[];
}

export interface SeedTest {
  code: string;
  name: string;
  dept: string;
  specimen: string;
  price: number;
  tat: number;
  params?: SeedParam[];
  members?: string[]; // for panels
}

export const DEPARTMENTS: Array<{ code: string; name: string }> = [
  { code: 'HEM', name: 'Hematology' },
  { code: 'COAG', name: 'Coagulation' },
  { code: 'CHEM', name: 'Clinical Chemistry' },
  { code: 'ENDO', name: 'Endocrinology & Hormones' },
  { code: 'IMM', name: 'Serology & Immunology' },
  { code: 'MICRO', name: 'Microbiology' },
  { code: 'CLIN', name: 'Clinical Pathology' },
  { code: 'TUM', name: 'Tumor Markers' },
];

const ULTRAS = 'Serum';

export const TESTS: SeedTest[] = [
  // ---- Hematology
  {
    code: 'CBC', name: 'Complete Blood Count', dept: 'HEM', specimen: 'EDTA whole blood', price: 700, tat: 4,
    params: [
      { code: 'HGB', name: 'Hemoglobin', unit: 'g/dL', decimals: 1, crit: [7, 20], ranges: [{ sex: 'M', low: 13, high: 17 }, { sex: 'F', low: 12, high: 15.5 }] },
      { code: 'WBC', name: 'Total WBC count', unit: 'x10^9/L', decimals: 1, crit: [2, 30], ranges: [{ low: 4, high: 11 }] },
      { code: 'RBC', name: 'RBC count', unit: 'x10^12/L', decimals: 2, ranges: [{ sex: 'M', low: 4.5, high: 5.9 }, { sex: 'F', low: 4.1, high: 5.1 }] },
      { code: 'HCT', name: 'Hematocrit (PCV)', unit: '%', decimals: 1, ranges: [{ sex: 'M', low: 40, high: 52 }, { sex: 'F', low: 36, high: 46 }] },
      { code: 'MCV', name: 'MCV', unit: 'fL', decimals: 1, ranges: [{ low: 80, high: 100 }] },
      { code: 'MCH', name: 'MCH', unit: 'pg', decimals: 1, ranges: [{ low: 27, high: 33 }] },
      { code: 'MCHC', name: 'MCHC', unit: 'g/dL', decimals: 1, ranges: [{ low: 32, high: 36 }] },
      { code: 'RDW', name: 'RDW-CV', unit: '%', decimals: 1, ranges: [{ low: 11.5, high: 14.5 }] },
      { code: 'PLT', name: 'Platelet count', unit: 'x10^9/L', decimals: 0, crit: [50, 1000], ranges: [{ low: 150, high: 400 }] },
      { code: 'NEUT', name: 'Neutrophils', unit: '%', decimals: 0, ranges: [{ low: 40, high: 75 }] },
      { code: 'LYMPH', name: 'Lymphocytes', unit: '%', decimals: 0, ranges: [{ low: 20, high: 45 }] },
      { code: 'MONO', name: 'Monocytes', unit: '%', decimals: 0, ranges: [{ low: 2, high: 10 }] },
      { code: 'EOS', name: 'Eosinophils', unit: '%', decimals: 0, ranges: [{ low: 1, high: 6 }] },
      { code: 'BASO', name: 'Basophils', unit: '%', decimals: 0, ranges: [{ low: 0, high: 1 }] },
    ],
  },
  { code: 'ESR', name: 'Erythrocyte Sedimentation Rate', dept: 'HEM', specimen: 'EDTA whole blood', price: 250, tat: 2,
    params: [{ code: 'ESR', name: 'ESR (1st hour)', unit: 'mm/hr', decimals: 0, ranges: [{ sex: 'M', low: 0, high: 15 }, { sex: 'F', low: 0, high: 20 }] }] },
  { code: 'RETIC', name: 'Reticulocyte Count', dept: 'HEM', specimen: 'EDTA whole blood', price: 500, tat: 24,
    params: [{ code: 'RETIC', name: 'Reticulocytes', unit: '%', decimals: 1, ranges: [{ low: 0.5, high: 2.5 }] }] },
  { code: 'ABO', name: 'Blood Group and Rh', dept: 'HEM', specimen: 'EDTA whole blood', price: 300, tat: 2,
    params: [
      { code: 'ABO', name: 'ABO group', type: 'qualitative', options: ['A', 'B', 'AB', 'O'] },
      { code: 'RH', name: 'Rh factor', type: 'qualitative', options: ['Positive', 'Negative'] },
    ] },
  { code: 'MP', name: 'Malaria Parasite (smear)', dept: 'HEM', specimen: 'EDTA whole blood', price: 400, tat: 4,
    params: [{ code: 'MP', name: 'Malaria parasite', type: 'qualitative', options: ['Negative', 'Positive'] }] },
  { code: 'SMEAR', name: 'Peripheral Blood Smear', dept: 'HEM', specimen: 'EDTA whole blood', price: 400, tat: 24,
    params: [{ code: 'SMEAR', name: 'Peripheral smear report', type: 'text' }] },

  // ---- Coagulation
  { code: 'PT', name: 'Prothrombin Time (PT/INR)', dept: 'COAG', specimen: 'Citrate plasma', price: 650, tat: 4,
    params: [
      { code: 'PT', name: 'PT', unit: 'sec', decimals: 1, ranges: [{ low: 11, high: 13.5 }] },
      { code: 'INR', name: 'INR', unit: 'ratio', decimals: 2, ranges: [{ low: 0.8, high: 1.2 }] },
    ] },
  { code: 'APTT', name: 'Activated Partial Thromboplastin Time', dept: 'COAG', specimen: 'Citrate plasma', price: 700, tat: 6,
    params: [{ code: 'APTT', name: 'aPTT', unit: 'sec', decimals: 1, ranges: [{ low: 25, high: 35 }] }] },
  { code: 'FIB', name: 'Fibrinogen', dept: 'COAG', specimen: 'Citrate plasma', price: 900, tat: 24,
    params: [{ code: 'FIB', name: 'Fibrinogen', unit: 'mg/dL', decimals: 0, ranges: [{ low: 200, high: 400 }] }] },

  // ---- Clinical chemistry
  { code: 'FBS', name: 'Blood Glucose Fasting', dept: 'CHEM', specimen: 'Fluoride plasma', price: 180, tat: 2,
    params: [{ code: 'FBS', name: 'Glucose (fasting)', unit: 'mg/dL', decimals: 0, crit: [40, 400], ranges: [{ low: 70, high: 100 }] }] },
  { code: 'RBS', name: 'Random Blood Glucose', dept: 'CHEM', specimen: 'Fluoride plasma', price: 180, tat: 2,
    params: [{ code: 'RBS', name: 'Glucose (random)', unit: 'mg/dL', decimals: 0, crit: [40, 400], ranges: [{ low: 70, high: 140 }] }] },
  { code: 'HBA1C', name: 'Glycated Hemoglobin (HbA1c)', dept: 'CHEM', specimen: 'EDTA whole blood', price: 900, tat: 24,
    params: [{ code: 'HBA1C', name: 'HbA1c', unit: '%', decimals: 1, ranges: [{ low: 4, high: 5.6 }] }] },
  { code: 'UREA', name: 'Blood Urea', dept: 'CHEM', specimen: ULTRAS, price: 250, tat: 3,
    params: [{ code: 'UREA', name: 'Urea', unit: 'mg/dL', decimals: 0, ranges: [{ low: 15, high: 40 }] }] },
  { code: 'CREA', name: 'Creatinine', dept: 'CHEM', specimen: ULTRAS, price: 250, tat: 3,
    params: [{ code: 'CREA', name: 'Creatinine', unit: 'mg/dL', decimals: 2, crit: [null, 10], ranges: [{ sex: 'M', low: 0.7, high: 1.3 }, { sex: 'F', low: 0.6, high: 1.1 }] }] },
  { code: 'UA', name: 'Uric Acid', dept: 'CHEM', specimen: ULTRAS, price: 250, tat: 3,
    params: [{ code: 'UA', name: 'Uric acid', unit: 'mg/dL', decimals: 1, ranges: [{ sex: 'M', low: 3.4, high: 7 }, { sex: 'F', low: 2.4, high: 6 }] }] },
  { code: 'ELEC', name: 'Serum Electrolytes', dept: 'CHEM', specimen: ULTRAS, price: 800, tat: 3,
    params: [
      { code: 'NA', name: 'Sodium', unit: 'mmol/L', decimals: 0, crit: [120, 160], ranges: [{ low: 135, high: 145 }] },
      { code: 'K', name: 'Potassium', unit: 'mmol/L', decimals: 1, crit: [2.5, 6.5], ranges: [{ low: 3.5, high: 5 }] },
      { code: 'CL', name: 'Chloride', unit: 'mmol/L', decimals: 0, ranges: [{ low: 98, high: 107 }] },
    ] },
  { code: 'CA', name: 'Calcium (Total)', dept: 'CHEM', specimen: ULTRAS, price: 300, tat: 3,
    params: [{ code: 'CA', name: 'Calcium', unit: 'mg/dL', decimals: 1, crit: [6.5, 13], ranges: [{ low: 8.5, high: 10.5 }] }] },
  { code: 'PHOS', name: 'Phosphorus', dept: 'CHEM', specimen: ULTRAS, price: 300, tat: 3,
    params: [{ code: 'PHOS', name: 'Phosphorus', unit: 'mg/dL', decimals: 1, ranges: [{ low: 2.5, high: 4.5 }] }] },
  { code: 'MG', name: 'Magnesium', dept: 'CHEM', specimen: ULTRAS, price: 350, tat: 4,
    params: [{ code: 'MG', name: 'Magnesium', unit: 'mg/dL', decimals: 1, ranges: [{ low: 1.7, high: 2.2 }] }] },
  { code: 'LIPID', name: 'Lipid Profile', dept: 'CHEM', specimen: ULTRAS, price: 1200, tat: 4,
    params: [
      { code: 'TC', name: 'Total cholesterol', unit: 'mg/dL', decimals: 0, ranges: [{ low: 0, high: 200 }] },
      { code: 'TG', name: 'Triglycerides', unit: 'mg/dL', decimals: 0, ranges: [{ low: 0, high: 150 }] },
      { code: 'HDL', name: 'HDL cholesterol', unit: 'mg/dL', decimals: 0, ranges: [{ sex: 'M', low: 40, high: 200 }, { sex: 'F', low: 50, high: 200 }] },
      { code: 'LDL', name: 'LDL cholesterol (calculated)', unit: 'mg/dL', decimals: 0, type: 'calculated', formula: 'TC - HDL - TG / 5', ranges: [{ low: 0, high: 100 }] },
      { code: 'VLDL', name: 'VLDL cholesterol (calculated)', unit: 'mg/dL', decimals: 0, type: 'calculated', formula: 'TG / 5', ranges: [{ low: 2, high: 30 }] },
    ] },
  { code: 'LFT', name: 'Liver Function Tests', dept: 'CHEM', specimen: ULTRAS, price: 1500, tat: 4,
    params: [
      { code: 'BILT', name: 'Bilirubin (total)', unit: 'mg/dL', decimals: 2, ranges: [{ low: 0.1, high: 1.2 }] },
      { code: 'BILD', name: 'Bilirubin (direct)', unit: 'mg/dL', decimals: 2, ranges: [{ low: 0, high: 0.3 }] },
      { code: 'BILI', name: 'Bilirubin (indirect, calculated)', unit: 'mg/dL', decimals: 2, type: 'calculated', formula: 'BILT - BILD', ranges: [{ low: 0.1, high: 0.9 }] },
      { code: 'ALT', name: 'ALT (SGPT)', unit: 'U/L', decimals: 0, ranges: [{ sex: 'M', low: 7, high: 55 }, { sex: 'F', low: 7, high: 45 }] },
      { code: 'AST', name: 'AST (SGOT)', unit: 'U/L', decimals: 0, ranges: [{ low: 5, high: 40 }] },
      { code: 'ALP', name: 'Alkaline phosphatase', unit: 'U/L', decimals: 0, ranges: [{ low: 44, high: 147 }] },
      { code: 'GGT', name: 'GGT', unit: 'U/L', decimals: 0, ranges: [{ sex: 'M', low: 9, high: 48 }, { sex: 'F', low: 5, high: 36 }] },
      { code: 'TP', name: 'Total protein', unit: 'g/dL', decimals: 1, ranges: [{ low: 6, high: 8.3 }] },
      { code: 'ALB', name: 'Albumin', unit: 'g/dL', decimals: 1, ranges: [{ low: 3.5, high: 5 }] },
      { code: 'GLOB', name: 'Globulin (calculated)', unit: 'g/dL', decimals: 1, type: 'calculated', formula: 'TP - ALB', ranges: [{ low: 2, high: 3.5 }] },
    ] },
  { code: 'AMY', name: 'Amylase', dept: 'CHEM', specimen: ULTRAS, price: 800, tat: 24,
    params: [{ code: 'AMY', name: 'Amylase', unit: 'U/L', decimals: 0, ranges: [{ low: 28, high: 100 }] }] },
  { code: 'LIPASE', name: 'Lipase', dept: 'CHEM', specimen: ULTRAS, price: 1000, tat: 24,
    params: [{ code: 'LIPASE', name: 'Lipase', unit: 'U/L', decimals: 0, ranges: [{ low: 13, high: 60 }] }] },
  { code: 'LDH', name: 'Lactate Dehydrogenase', dept: 'CHEM', specimen: ULTRAS, price: 600, tat: 24,
    params: [{ code: 'LDH', name: 'LDH', unit: 'U/L', decimals: 0, ranges: [{ low: 140, high: 280 }] }] },
  { code: 'CRP', name: 'C-Reactive Protein (quantitative)', dept: 'IMM', specimen: ULTRAS, price: 700, tat: 4,
    params: [{ code: 'CRP', name: 'CRP', unit: 'mg/L', decimals: 1, ranges: [{ low: 0, high: 5 }] }] },

  // ---- Iron and vitamins
  { code: 'FERR', name: 'Serum Ferritin', dept: 'CHEM', specimen: ULTRAS, price: 1000, tat: 24,
    params: [{ code: 'FERR', name: 'Ferritin', unit: 'ng/mL', decimals: 1, ranges: [{ sex: 'M', low: 30, high: 400 }, { sex: 'F', low: 15, high: 150 }] }] },
  { code: 'IRON', name: 'Iron Studies (Iron, TIBC)', dept: 'CHEM', specimen: ULTRAS, price: 900, tat: 24,
    params: [
      { code: 'IRON', name: 'Serum iron', unit: 'ug/dL', decimals: 0, ranges: [{ sex: 'M', low: 65, high: 175 }, { sex: 'F', low: 50, high: 170 }] },
      { code: 'TIBC', name: 'TIBC', unit: 'ug/dL', decimals: 0, ranges: [{ low: 250, high: 450 }] },
    ] },
  { code: 'VITD', name: 'Vitamin D, 25-Hydroxy', dept: 'CHEM', specimen: ULTRAS, price: 2500, tat: 48,
    params: [{ code: 'VITD', name: '25-OH Vitamin D', unit: 'ng/mL', decimals: 1, ranges: [{ low: 30, high: 100 }] }] },
  { code: 'VITB12', name: 'Vitamin B12', dept: 'CHEM', specimen: ULTRAS, price: 1800, tat: 48,
    params: [{ code: 'VITB12', name: 'Vitamin B12', unit: 'pg/mL', decimals: 0, ranges: [{ low: 200, high: 900 }] }] },

  // ---- Endocrinology
  { code: 'TFT', name: 'Thyroid Profile (TSH, Free T4, Total T3)', dept: 'ENDO', specimen: ULTRAS, price: 1800, tat: 24,
    params: [
      { code: 'TSH', name: 'TSH', unit: 'mIU/L', decimals: 2, ranges: [{ low: 0.4, high: 4 }] },
      { code: 'FT4', name: 'Free T4', unit: 'ng/dL', decimals: 2, ranges: [{ low: 0.8, high: 1.8 }] },
      { code: 'T3', name: 'Total T3', unit: 'ng/dL', decimals: 0, ranges: [{ low: 80, high: 200 }] },
    ] },
  { code: 'PRL', name: 'Prolactin', dept: 'ENDO', specimen: ULTRAS, price: 1500, tat: 48,
    params: [{ code: 'PRL', name: 'Prolactin', unit: 'ng/mL', decimals: 1, ranges: [{ sex: 'M', low: 2, high: 18 }, { sex: 'F', low: 2, high: 29 }] }] },
  { code: 'CORT', name: 'Cortisol (morning)', dept: 'ENDO', specimen: ULTRAS, price: 1800, tat: 48,
    params: [{ code: 'CORT', name: 'Cortisol', unit: 'ug/dL', decimals: 1, ranges: [{ low: 5, high: 25 }] }] },
  { code: 'INS', name: 'Insulin (fasting)', dept: 'ENDO', specimen: ULTRAS, price: 1800, tat: 48,
    params: [{ code: 'INS', name: 'Insulin', unit: 'uIU/mL', decimals: 1, ranges: [{ low: 2, high: 25 }] }] },
  { code: 'TESTO', name: 'Testosterone (total)', dept: 'ENDO', specimen: ULTRAS, price: 1800, tat: 48,
    params: [{ code: 'TESTO', name: 'Testosterone', unit: 'ng/dL', decimals: 0, ranges: [{ sex: 'M', low: 300, high: 1000 }, { sex: 'F', low: 15, high: 70 }] }] },
  { code: 'PSA', name: 'Prostate Specific Antigen (total)', dept: 'TUM', specimen: ULTRAS, price: 1500, tat: 48,
    params: [{ code: 'PSA', name: 'PSA (total)', unit: 'ng/mL', decimals: 2, ranges: [{ sex: 'M', low: 0, high: 4 }] }] },
  { code: 'BHCG', name: 'Beta-HCG (pregnancy test, qualitative)', dept: 'ENDO', specimen: ULTRAS, price: 500, tat: 4,
    params: [{ code: 'BHCG', name: 'Beta-HCG', type: 'qualitative', options: ['Negative', 'Positive'] }] },

  // ---- Tumor markers
  { code: 'CEA', name: 'Carcinoembryonic Antigen (CEA)', dept: 'TUM', specimen: ULTRAS, price: 1800, tat: 48,
    params: [{ code: 'CEA', name: 'CEA', unit: 'ng/mL', decimals: 1, ranges: [{ low: 0, high: 5 }] }] },
  { code: 'CA125', name: 'CA-125', dept: 'TUM', specimen: ULTRAS, price: 2200, tat: 48,
    params: [{ code: 'CA125', name: 'CA-125', unit: 'U/mL', decimals: 1, ranges: [{ low: 0, high: 35 }] }] },
  { code: 'AFP', name: 'Alpha-Fetoprotein (AFP)', dept: 'TUM', specimen: ULTRAS, price: 1800, tat: 48,
    params: [{ code: 'AFP', name: 'AFP', unit: 'ng/mL', decimals: 1, ranges: [{ low: 0, high: 10 }] }] },

  // ---- Serology and immunology
  { code: 'HBSAG', name: 'Hepatitis B Surface Antigen (HBsAg)', dept: 'IMM', specimen: ULTRAS, price: 900, tat: 6,
    params: [{ code: 'HBSAG', name: 'HBsAg', type: 'qualitative', options: ['Non-reactive', 'Reactive'] }] },
  { code: 'HCV', name: 'Hepatitis C Antibody (Anti-HCV)', dept: 'IMM', specimen: ULTRAS, price: 1200, tat: 6,
    params: [{ code: 'HCV', name: 'Anti-HCV', type: 'qualitative', options: ['Non-reactive', 'Reactive'] }] },
  { code: 'HIV', name: 'HIV I & II Antibody', dept: 'IMM', specimen: ULTRAS, price: 1200, tat: 6,
    params: [{ code: 'HIV', name: 'HIV I & II', type: 'qualitative', options: ['Non-reactive', 'Reactive'] }] },
  { code: 'DENGUE', name: 'Dengue Profile (NS1, IgG, IgM)', dept: 'IMM', specimen: ULTRAS, price: 3000, tat: 24,
    params: [
      { code: 'NS1', name: 'Dengue NS1 antigen', type: 'qualitative', options: ['Negative', 'Positive'] },
      { code: 'DIGG', name: 'Dengue IgG', type: 'qualitative', options: ['Negative', 'Positive'] },
      { code: 'DIGM', name: 'Dengue IgM', type: 'qualitative', options: ['Negative', 'Positive'] },
    ] },
  { code: 'TYPHOID', name: 'Typhoid IgM (Typhidot-type rapid test)', dept: 'IMM', specimen: ULTRAS, price: 1200, tat: 24,
    params: [{ code: 'TYPHIGM', name: 'Typhoid IgM', type: 'qualitative', options: ['Negative', 'Positive'] }] },
  { code: 'WIDAL', name: 'Widal Test (Typhoid agglutination)', dept: 'IMM', specimen: ULTRAS, price: 400, tat: 24,
    params: [
      { code: 'WO', name: 'S. Typhi O', type: 'text' },
      { code: 'WH', name: 'S. Typhi H', type: 'text' },
    ] },
  { code: 'RF', name: 'Rheumatoid Factor (quantitative)', dept: 'IMM', specimen: ULTRAS, price: 900, tat: 24,
    params: [{ code: 'RF', name: 'RF', unit: 'IU/mL', decimals: 1, ranges: [{ low: 0, high: 14 }] }] },
  { code: 'ANA', name: 'Antinuclear Antibody (ANA)', dept: 'IMM', specimen: ULTRAS, price: 3000, tat: 72,
    params: [{ code: 'ANA', name: 'ANA', type: 'qualitative', options: ['Negative', 'Positive'] }] },
  { code: 'VDRL', name: 'VDRL (syphilis screen)', dept: 'IMM', specimen: ULTRAS, price: 400, tat: 24,
    params: [{ code: 'VDRL', name: 'VDRL', type: 'qualitative', options: ['Non-reactive', 'Reactive'] }] },

  // ---- Microbiology
  { code: 'UCS', name: 'Urine Culture and Sensitivity', dept: 'MICRO', specimen: 'Urine (midstream)', price: 1500, tat: 72,
    params: [{ code: 'UCS', name: 'Culture result and sensitivity', type: 'text' }] },
  { code: 'BCS', name: 'Blood Culture', dept: 'MICRO', specimen: 'Blood culture bottle', price: 2000, tat: 120,
    params: [{ code: 'BCS', name: 'Blood culture result', type: 'text' }] },
  { code: 'SCS', name: 'Stool Culture', dept: 'MICRO', specimen: 'Stool', price: 1500, tat: 72,
    params: [{ code: 'SCS', name: 'Stool culture result', type: 'text' }] },

  // ---- Clinical pathology
  { code: 'URE', name: 'Urine Routine Examination', dept: 'CLIN', specimen: 'Urine (random)', price: 300, tat: 2,
    params: [
      { code: 'UCOL', name: 'Colour', type: 'text' },
      { code: 'UAPP', name: 'Appearance', type: 'text' },
      { code: 'UPH', name: 'pH', unit: '', decimals: 1, ranges: [{ low: 4.5, high: 8 }] },
      { code: 'USG', name: 'Specific gravity', unit: '', decimals: 3, ranges: [{ low: 1.005, high: 1.03 }] },
      { code: 'UPROT', name: 'Protein', type: 'qualitative', options: ['Negative', 'Trace', '1+', '2+', '3+'] },
      { code: 'UGLU', name: 'Glucose', type: 'qualitative', options: ['Negative', 'Trace', '1+', '2+', '3+'] },
      { code: 'UKET', name: 'Ketones', type: 'qualitative', options: ['Negative', 'Trace', '1+', '2+'] },
      { code: 'UBLD', name: 'Blood', type: 'qualitative', options: ['Negative', 'Trace', '1+', '2+'] },
      { code: 'UPUS', name: 'Pus cells (HPF)', type: 'text' },
      { code: 'URBC', name: 'RBC (HPF)', type: 'text' },
      { code: 'UEPI', name: 'Epithelial cells', type: 'text' },
      { code: 'UBACT', name: 'Bacteria', type: 'text' },
    ] },
  { code: 'STOOL', name: 'Stool Routine Examination', dept: 'CLIN', specimen: 'Stool', price: 300, tat: 2,
    params: [
      { code: 'SCOL', name: 'Colour and consistency', type: 'text' },
      { code: 'SMUC', name: 'Mucus / blood', type: 'text' },
      { code: 'SOCC', name: 'Occult blood', type: 'qualitative', options: ['Negative', 'Positive'] },
      { code: 'SPAR', name: 'Parasites / ova / cysts', type: 'text' },
    ] },
  { code: 'CSF', name: 'Synovial / Body Fluid Analysis', dept: 'CLIN', specimen: 'Body fluid', price: 800, tat: 24,
    params: [{ code: 'BFA', name: 'Fluid analysis result', type: 'text' }] },
];

export const PANELS: SeedTest[] = [
  { code: 'RENAL', name: 'Renal Function Panel', dept: 'CHEM', specimen: ULTRAS, price: 1800, tat: 4, members: ['UREA', 'CREA', 'UA', 'ELEC', 'CA', 'PHOS'] },
  { code: 'DIAB', name: 'Diabetes Panel', dept: 'CHEM', specimen: 'Fluoride plasma', price: 1000, tat: 24, members: ['FBS', 'HBA1C'] },
  { code: 'FBC', name: 'Full Blood Panel (CBC, ESR)', dept: 'HEM', specimen: 'EDTA whole blood', price: 900, tat: 4, members: ['CBC', 'ESR'] },
  { code: 'HEPA', name: 'Hepatitis Screen (HBsAg, Anti-HCV)', dept: 'IMM', specimen: ULTRAS, price: 1900, tat: 6, members: ['HBSAG', 'HCV'] },
  { code: 'PREOP', name: 'Pre-operative Panel', dept: 'COAG', specimen: 'Mixed', price: 2600, tat: 6, members: ['CBC', 'PT', 'APTT', 'FBS', 'UREA', 'CREA', 'ELEC', 'ABO', 'HIV', 'HBSAG', 'HCV'] },
];
