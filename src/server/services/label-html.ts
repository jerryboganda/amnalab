// Specimen tube label, 50 x 25 mm for thermal label printers (black only).
// Left: QR of the accession number. Right: accession, patient, specimen, priority and test codes.
export interface LabelData {
  accession: string;
  patientName: string;
  mrn: string;
  sexAge: string;
  specimenType: string;
  priority: string;
  collectedAt: string | null;
  testCodes: string[];
  branchCode: string;
  qrSvg: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function specimenLabelHtml(d: LabelData, autoPrint = true): string {
  const urgent = d.priority !== 'routine';
  const tests = d.testCodes.length > 5 ? `${d.testCodes.slice(0, 4).join(' · ')} +${d.testCodes.length - 4}` : d.testCodes.join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.accession)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter','Segoe UI',Roboto,Arial,sans-serif;color:#000}
  .label{width:50mm;height:25mm;padding:1.4mm 1.6mm;display:flex;gap:1.6mm;overflow:hidden}
  .qr{width:17mm;flex:none;display:flex;flex-direction:column;align-items:center}
  .qr svg{width:17mm;height:17mm;display:block}
  .br{font-size:5.5pt;font-weight:700;letter-spacing:.4px;margin-top:.6mm}
  .info{flex:1;min-width:0;display:flex;flex-direction:column}
  .acc{font-size:9pt;font-weight:800;letter-spacing:.2px;line-height:1.05;font-variant-numeric:tabular-nums}
  .name{font-size:7.2pt;font-weight:700;line-height:1.15;margin-top:.5mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meta{font-size:5.8pt;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bar{margin-top:auto;display:flex;align-items:center;gap:1mm}
  .type{flex:1;min-width:0;background:#000;color:#fff;font-size:5.8pt;font-weight:700;padding:.3mm 1mm;border-radius:.6mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .pri{flex:none;border:1.2px solid #000;font-size:5.4pt;font-weight:800;padding:0 .7mm;border-radius:.6mm;letter-spacing:.4px}
  .foot{display:flex;align-items:center;gap:1mm;margin-top:.5mm}
  .tests{flex:1;min-width:0;font-size:5.6pt;font-weight:600;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  @media screen{html{background:#eef1f5}body{padding:24px}.label{background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.15);border-radius:2mm;transform:scale(2.2);transform-origin:top left}}
  @media print{@page{size:50mm 25mm;margin:0}}
</style></head><body>
<div class="label">
  <div class="qr">${d.qrSvg}<div class="br">${esc(d.branchCode)}</div></div>
  <div class="info">
    <div class="acc">${esc(d.accession)}</div>
    <div class="name">${esc(d.patientName)}</div>
    <div class="meta">${esc(d.mrn)} · ${esc(d.sexAge)}</div>
    ${d.collectedAt ? `<div class="meta">Coll. ${esc(d.collectedAt)}</div>` : ''}
    <div class="bar"><div class="type">${esc(d.specimenType)}</div></div>
    <div class="foot"><div class="tests">${esc(tests)}</div>${urgent ? `<div class="pri">${esc(d.priority.toUpperCase())}</div>` : ''}</div>
  </div>
</div>
${autoPrint ? '<script>window.onload=()=>window.print()</script>' : ''}
</body></html>`;
}
