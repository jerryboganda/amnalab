import { Document, Fixed, Page, View, Watermark } from '@formepdf/react';
import { renderDocument } from '@formepdf/core';
import { PdfcnThemeProvider } from '../../pdf/components/theme-provider.tsx';
import { professionalTheme } from '../../pdf/components/theme-professional.ts';
import { PageHeader } from '../../pdf/components/page-header/page-header.tsx';
import { PageFooter } from '../../pdf/components/page-footer/page-footer.tsx';
import { PageNumber } from '../../pdf/components/page-number/page-number.tsx';
import { Heading } from '../../pdf/components/heading/heading.tsx';
import { Section } from '../../pdf/components/section/section.tsx';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '../../pdf/components/table/table.tsx';
import { PdfSignatureBlock } from '../../pdf/components/signature/signature.tsx';
import { PdfQRCode } from '../../pdf/components/qrcode/qrcode.tsx';
import { PdfImage } from '../../pdf/components/pdf-image/pdf-image.tsx';
import { Text } from '../../pdf/components/text/text.tsx';

export interface ReportLine {
  parameter: string;
  value: string;
  unit: string;
  reference: string;
  flag: string;
  critical: boolean;
  comment: string | null;
}

export interface ReportData {
  reportNo: string;
  version: number;
  issuedAt: string;
  verificationUrl: string;
  amended: boolean;
  amendmentReasons: string[];
  branch: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    motto: string | null;
    headerText: string | null;
    footerText: string | null;
    logoDataUri: string | null;
    backgroundDataUri: string | null;
  };
  patient: { name: string; mrn: string; gender: string; age: string; practitioner: string | null; allergies: string | null };
  order: { orderNo: string; priority: string; createdAt: string; accessions: string[] };
  sections: Array<{ department: string; tests: Array<{ name: string; lines: ReportLine[] }> }>;
  signers: Array<{ name: string; title: string | null }>;
}

// Column widths in points; A4 content width is 515pt with 40pt margins.
const W = { param: 165, result: 70, unit: 80, ref: 110, flag: 90 } as const;

const GENDER: Record<string, string> = { M: 'Male', F: 'Female', O: 'Other' };

function ReportDocument({ d }: { d: ReportData }) {
  return (
    <Document title={`Laboratory report ${d.reportNo}`} author={d.branch.name} subject={`Report ${d.reportNo} version ${d.version}`}>
      <Page size="A4" margin={40}>
        {d.branch.backgroundDataUri ? (
          <View style={{ position: 'absolute', top: -40, left: -40, width: 595, height: 842 }}>
            <PdfImage src={d.branch.backgroundDataUri} width={595} height={842} fit="cover" />
          </View>
        ) : null}
        {d.amended ? <Watermark text="AMENDED" fontSize={70} color="rgba(0,0,0,0.06)" angle={-35} /> : null}

        <PageHeader
          title={d.branch.name}
          subtitle={d.branch.motto ?? undefined}
          rightText={`Report ${d.reportNo}`}
          rightSubText={`Version ${d.version}${d.amended ? ' (amended)' : ''}`}
          variant={d.branch.logoDataUri ? 'logo-left' : 'simple'}
          logo={d.branch.logoDataUri ? <PdfImage src={d.branch.logoDataUri} width={48} height={48} fit="contain" /> : undefined}
          fixed
        />

        {[d.branch.address, d.branch.phone, d.branch.email].some(Boolean) ? (
          <Text variant="sm">{[d.branch.address, d.branch.phone ? `Tel: ${d.branch.phone}` : null, d.branch.email].filter(Boolean).join('  |  ')}</Text>
        ) : null}
        {d.branch.headerText ? <Text variant="sm">{d.branch.headerText}</Text> : null}

        <Section variant="card" spacing="sm">
          <Heading level={4}>Patient</Heading>
          <Text>{`Name: ${d.patient.name}    MRN: ${d.patient.mrn}`}</Text>
          <Text>{`Age: ${d.patient.age}    Sex: ${GENDER[d.patient.gender] ?? d.patient.gender}`}</Text>
          <Text>{`Referring doctor: ${d.patient.practitioner ?? 'Self'}`}</Text>
          {d.patient.allergies ? <Text>{`Known allergies: ${d.patient.allergies}`}</Text> : null}
          <Text>{`Order: ${d.order.orderNo}    Priority: ${d.order.priority.toUpperCase()}`}</Text>
          <Text>{`Ordered: ${d.order.createdAt}    Accession: ${d.order.accessions.join(', ')}`}</Text>
        </Section>

        {d.amended && d.amendmentReasons.length > 0 ? (
          <Section variant="card" spacing="sm">
            <Heading level={5}>Amendment</Heading>
            {d.amendmentReasons.map((r, i) => (
              <Text key={i}>{`- ${r}`}</Text>
            ))}
          </Section>
        ) : null}

        {d.sections.map((dept) => (
          <View key={dept.department} style={{ marginTop: 10 }}>
            <Heading level={3}>{dept.department}</Heading>
            {dept.tests.map((test) => (
              <View key={test.name} style={{ marginTop: 6 }}>
                <Text weight="semibold">{test.name}</Text>
                <Table variant="line" zebraStripe>
                  <TableHeader>
                    <TableRow header>
                      <TableCell header width={W.param}>Parameter</TableCell>
                      <TableCell header width={W.result} align="right">Result</TableCell>
                      <TableCell header width={W.unit}>Unit</TableCell>
                      <TableCell header width={W.ref}>Reference range</TableCell>
                      <TableCell header width={W.flag}>Flag</TableCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {test.lines.map((l, i) => (
                      <TableRow key={`${l.parameter}-${i}`}>
                        <TableCell width={W.param}>{l.parameter}</TableCell>
                        <TableCell width={W.result} align="right" style={{ fontWeight: 700 }}>{l.value}</TableCell>
                        <TableCell width={W.unit}>{l.unit}</TableCell>
                        <TableCell width={W.ref}>{l.reference}</TableCell>
                        <TableCell width={W.flag} style={l.critical ? { color: '#b91c1c', fontWeight: 700 } : l.flag && l.flag !== 'Normal' ? { fontWeight: 700 } : {}}>{l.flag}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {test.lines
                  .filter((l) => l.comment)
                  .map((l, i) => (
                    <Text key={i} variant="sm">{`${l.parameter}: ${l.comment}`}</Text>
                  ))}
              </View>
            ))}
          </View>
        ))}

        <View style={{ marginTop: 18 }}>
          {d.signers.length > 2 ? (
            <View>
              <Text weight="semibold">Authorized by</Text>
              {d.signers.map((sg, i) => (
                <Text key={i}>{`${sg.name}${sg.title ? ` (${sg.title})` : ''}`}</Text>
              ))}
            </View>
          ) : d.signers.length === 2 ? (
            <PdfSignatureBlock
              variant="double"
              signers={[
                { label: 'Authorized by', name: d.signers[0]!.name, title: d.signers[0]!.title ?? undefined },
                { label: 'Authorized by', name: d.signers[1]!.name, title: d.signers[1]!.title ?? undefined },
              ]}
            />
          ) : (
            <PdfSignatureBlock
              variant="single"
              label="Authorized by"
              name={d.signers[0]?.name ?? ''}
              title={d.signers[0]?.title ?? undefined}
            />
          )}
        </View>

        <View style={{ marginTop: 14, flexDirection: 'row', alignItems: 'center' }}>
          <PdfQRCode value={d.verificationUrl} size={64} caption="Verify online" />
          <View style={{ marginLeft: 12 }}>
            <Text variant="sm">{`Issued ${d.issuedAt}. Results are valid only when the report is authorized and unaltered.`}</Text>
          </View>
        </View>

        <Fixed position="footer">
          <PageFooter leftText={d.branch.footerText ?? d.branch.name} rightText={d.reportNo} centerText={`Issued ${d.issuedAt}`} />
          <PageNumber format="Page {page} of {total}" align="right" />
        </Fixed>
      </Page>
    </Document>
  );
}

export async function renderReportPdf(data: ReportData): Promise<Uint8Array> {
  return renderDocument(
    <PdfcnThemeProvider theme={professionalTheme}>
      <ReportDocument d={data} />
    </PdfcnThemeProvider>,
  );
}
