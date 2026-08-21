import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deflateRawSync, deflateSync } from "node:zlib";
import { inspectDocument } from "../app/lib/document-security";

const encoder = new TextEncoder();

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

type ZipEntry = Readonly<{
  name: string;
  body: string | Uint8Array;
  flags?: number;
  method?: number;
  declaredCompressedSize?: number;
  declaredExpandedSize?: number;
  declaredCrc32?: number;
  localOffset?: number;
}>;

function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = typeof entry.body === "string" ? encoder.encode(entry.body) : entry.body;
    const flags = entry.flags ?? 0x0800;
    const method = entry.method ?? 0;
    const payload = method === 8 ? Uint8Array.from(deflateRawSync(body)) : body;
    const compressedSize = entry.declaredCompressedSize ?? payload.byteLength;
    const expandedSize = entry.declaredExpandedSize ?? body.byteLength;
    const checksum = entry.declaredCrc32 ?? crc32(body);
    const local = join([
      u32(0x0403_4b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressedSize), u32(expandedSize), u16(name.byteLength), u16(0), name, payload,
    ]);
    localParts.push(local);
    centralParts.push(join([
      u32(0x0201_4b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressedSize), u32(expandedSize), u16(name.byteLength), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(entry.localOffset ?? localOffset), name,
    ]));
    localOffset += local.byteLength;
  }
  const central = join(centralParts);
  return join([
    ...localParts,
    central,
    u32(0x0605_4b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.byteLength), u32(localOffset), u16(0),
  ]);
}

const canonicalEntries = [
  {
    name: "[Content_Types].xml",
    body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
  },
  {
    name: "_rels/.rels",
    body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>",
  },
  {
    name: "word/document.xml",
    body: "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Agreement terms</w:t></w:r></w:p></w:body></w:document>",
  },
] as const;

function minimalPdf(trailing = ""): Uint8Array {
  const header = "%PDF-1.7\n";
  const catalog = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const pages = "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n";
  const catalogOffset = header.length;
  const pagesOffset = catalogOffset + catalog.length;
  const xrefOffset = pagesOffset + pages.length;
  return encoder.encode(`${header}${catalog}${pages}xref\n0 3\n0000000000 65535 f \n${String(catalogOffset).padStart(10, "0")} 00000 n \n${String(pagesOffset).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n${trailing}`);
}

function uintBigEndian(value: number, width: number): Uint8Array {
  const result = new Uint8Array(width);
  let remaining = BigInt(value);
  for (let index = width - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & BigInt(0xff));
    remaining >>= BigInt(8);
  }
  return result;
}

function xrefStreamRecord(type: number, field2: number, field3: number): Uint8Array {
  return join([uintBigEndian(type, 1), uintBigEndian(field2, 4), uintBigEndian(field3, 2)]);
}

function pngPredictedRows(records: Uint8Array, rowWidth: number, filters: readonly number[]): Uint8Array {
  assert.equal(records.byteLength, rowWidth * filters.length);
  const output = new Uint8Array(records.byteLength + filters.length);
  let cursor = 0;
  const paeth = (left: number, up: number, upperLeft: number): number => {
    const estimate = left + up - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
    return upDistance <= upperLeftDistance ? up : upperLeft;
  };
  for (let row = 0; row < filters.length; row += 1) {
    const filter = filters[row]!;
    output[cursor++] = filter;
    const rowStart = row * rowWidth;
    for (let column = 0; column < rowWidth; column += 1) {
      const current = records[rowStart + column]!;
      const left = column === 0 ? 0 : records[rowStart + column - 1]!;
      const up = row === 0 ? 0 : records[rowStart - rowWidth + column]!;
      const upperLeft = row === 0 || column === 0 ? 0 : records[rowStart - rowWidth + column - 1]!;
      const predicted = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paeth(left, up, upperLeft);
      output[cursor++] = (current - predicted) & 0xff;
    }
  }
  return output;
}

type XrefStreamOptions = Readonly<{
  catalogWithoutPages?: boolean;
  catalogOffsetDelta?: number;
  dictionaryPrefix?: string;
  dictionarySuffix?: string;
  filter?: "flate-png" | "flate-trailing" | "unsupported";
  indirectLength?: boolean;
  lengthDelta?: number;
  objectZeroGeneration?: number;
  objectZeroType?: number;
  omitObjectZero?: boolean;
  partialMap?: boolean;
  root?: string;
  selfType?: number;
  streamEol?: "space";
  widths?: readonly [number, number, number];
}>;

function xrefStreamPdf(options: XrefStreamOptions = {}): Uint8Array {
  const header = encoder.encode("%PDF-1.5\n%\u00ff\u00ff\u00ff\u00ff\n");
  const catalog = encoder.encode(
    "1 0 obj\n<< /Type /Catalog" + (options.catalogWithoutPages ? "" : " /Pages 2 0 R") + " >>\nendobj\n",
  );
  const pages = encoder.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  const page = encoder.encode("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n");
  const catalogOffset = header.byteLength;
  const pagesOffset = catalogOffset + catalog.byteLength;
  const pageOffset = pagesOffset + pages.byteLength;
  const xrefOffset = pageOffset + page.byteLength;
  const widths = options.widths ?? [1, 4, 2];
  const allRecords = [
    xrefStreamRecord(options.objectZeroType ?? 0, options.objectZeroType === 1 ? catalogOffset : 0, options.objectZeroGeneration ?? 65_535),
    xrefStreamRecord(1, catalogOffset + (options.catalogOffsetDelta ?? 0), 0),
    xrefStreamRecord(1, pagesOffset, 0),
    xrefStreamRecord(1, pageOffset, 0),
    xrefStreamRecord(options.selfType ?? 1, xrefOffset, 0),
  ] as const;
  const records = options.partialMap
    ? join([allRecords[0], allRecords[1], allRecords[4]])
    : options.omitObjectZero
      ? join(allRecords.slice(1))
      : join(allRecords);
  let payload = records;
  let filterDictionary = "";
  if (options.filter === "flate-png" || options.filter === "flate-trailing") {
    const filters = [0, 1, 2, 3, 4].slice(0, records.byteLength / 7);
    payload = Uint8Array.from(deflateSync(pngPredictedRows(records, 7, filters)));
    if (options.filter === "flate-trailing") payload = join([payload, encoder.encode("junk")]);
    filterDictionary = "/Filter [/FlateDecode] /DecodeParms [<< /Predictor 12 /Columns 7 >>] ";
  } else if (options.filter === "unsupported") {
    filterDictionary = "/Filter /ASCIIHexDecode ";
  }
  const dictionary = (options.dictionaryPrefix ?? "")
    + "/Type /XRef /Size 5 /Root " + (options.root ?? "1 0 R")
    + " /W [" + widths.join(" ") + "] /Index "
    + (options.partialMap ? "[0 2 4 1]" : options.omitObjectZero ? "[1 4]" : "[0 5]") + " "
    + filterDictionary
    + "/Length " + (options.indirectLength ? "6 0 R" : payload.byteLength + (options.lengthDelta ?? 0)) + " "
    + (options.dictionarySuffix ?? "");
  const xrefHeader = encoder.encode("4 0 obj\n<< " + dictionary + ">>\nstream" + (options.streamEol === "space" ? " " : "\n"));
  const trailer = encoder.encode("\nendstream\nendobj\nstartxref\n" + xrefOffset + "\n%%EOF\n");
  return join([header, catalog, pages, page, xrefHeader, payload, trailer]);
}

function incrementalXrefStreamPdf(tombstoneRoot = false, overrideObjectZero = false): Uint8Array {
  const base = minimalPdf();
  const baseText = new TextDecoder().decode(base);
  const previousXref = Number(/startxref\n(\d+)/.exec(baseText)?.[1]);
  assert.ok(Number.isSafeInteger(previousXref));
  const xrefOffset = base.byteLength;
  const records = tombstoneRoot
    ? join([xrefStreamRecord(0, 0, 1), xrefStreamRecord(1, xrefOffset, 0)])
    : overrideObjectZero
      ? join([xrefStreamRecord(0, 0, 0), xrefStreamRecord(1, xrefOffset, 0)])
      : xrefStreamRecord(1, xrefOffset, 0);
  const index = tombstoneRoot ? "[1 1 3 1]" : overrideObjectZero ? "[0 1 3 1]" : "[3 1]";
  const header = encoder.encode(
    "3 0 obj\n<< /Type /XRef /Size 4 /Root 1 0 R /Prev " + previousXref
      + " /W [1 4 2] /Index " + index + " /Length " + records.byteLength + " >>\nstream\n",
  );
  const trailer = encoder.encode("\nendstream\nendobj\nstartxref\n" + xrefOffset + "\n%%EOF\n");
  return join([base, header, records, trailer]);
}

function excessiveClassicPrevPdf(): Uint8Array {
  const base = minimalPdf();
  const baseText = new TextDecoder().decode(base);
  let previousXref = Number(/startxref\n(\d+)/.exec(baseText)?.[1]);
  assert.ok(Number.isSafeInteger(previousXref));
  const parts: Uint8Array[] = [base];
  const padding = new Uint8Array(Math.floor((19 * 1024 * 1024) / 7));
  padding.fill(0x20);
  let byteLength = base.byteLength;
  for (let revision = 0; revision < 7; revision += 1) {
    parts.push(padding);
    byteLength += padding.byteLength;
    const xrefOffset = byteLength;
    const section = encoder.encode(
      "xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 3 /Root 1 0 R /Prev "
        + previousXref + " >>\nstartxref\n" + xrefOffset + "\n%%EOF\n",
    );
    parts.push(section);
    byteLength += section.byteLength;
    previousXref = xrefOffset;
  }
  return join(parts);
}

function linearizedPdf(): Readonly<{ bytes: Uint8Array; earlyXrefOffset: number }> {
  const padded = (value: number) => String(value).padStart(10, "0");
  const header = "%PDF-1.5\n";
  const linearization = "1 0 obj\n"
    + "<< /Linearized 1 /L LLLLLLLLLL /H [HHHHHHHHHH 0000000001] /O 4 "
    + "/E EEEEEEEEEE /N 1 /T TTTTTTTTTT >>\nendobj\n";
  const earlyXrefOffset = header.length + linearization.length;
  const earlyXref = "xref\n0 2\n"
    + "0000000000 65535 f \n"
    + padded(header.length) + " 00000 n \n"
    + "trailer\n<< /Size 5 /Root 2 0 R /Prev PPPPPPPPPP >>\n";
  const specialTrailer = "startxref\n0\n%%EOF\n";
  const hintOffset = earlyXrefOffset + earlyXref.length + specialTrailer.length;
  const hint = "H";
  const rootOffset = hintOffset + hint.length;
  const root = "2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n";
  const pagesOffset = rootOffset + root.length;
  const pages = "3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n";
  const pageOffset = pagesOffset + pages.length;
  const page = "4 0 obj\n<< /Type /Page /Parent 3 0 R >>\nendobj\n";
  const endFirstPageOffset = pageOffset + page.length;
  const mainXrefOffset = endFirstPageOffset;
  const mainXref = "xref\n0 5\n"
    + "0000000000 65535 f \n"
    + padded(header.length) + " 00000 n \n"
    + padded(rootOffset) + " 00000 n \n"
    + padded(pagesOffset) + " 00000 n \n"
    + padded(pageOffset) + " 00000 n \n"
    + "trailer\n<< /Size 5 /Root 2 0 R >>\n";
  const finalTrailer = "startxref\n" + earlyXrefOffset + "\n%%EOF\n";
  let source = header + linearization + earlyXref + specialTrailer + hint + root + pages + page + mainXref + finalTrailer;
  source = source
    .replace("LLLLLLLLLL", padded(source.length))
    .replace("HHHHHHHHHH", padded(hintOffset))
    .replace("EEEEEEEEEE", padded(endFirstPageOffset))
    .replace("TTTTTTTTTT", padded(mainXrefOffset))
    .replace("PPPPPPPPPP", padded(mainXrefOffset));
  return { bytes: encoder.encode(source), earlyXrefOffset };
}

function objectStreamPdf(
  mode: "raw" | "flate" | "empty" | "object-zero" | "too-many" | "wrong-index" | "wrong-object" = "raw",
): Uint8Array {
  const header = encoder.encode("%PDF-1.5\n");
  const catalog = encoder.encode("1 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n");
  const catalogOffset = header.byteLength;
  const objectStreamOffset = catalogOffset + catalog.byteLength;
  const tableObjectNumber = mode === "wrong-object" ? 1 : 3;
  const pagesBody = "<< /Type /Pages /Kids [] /Count 0 >>";
  const objectBody = mode === "empty" ? "   " : mode === "object-zero" ? "0" + pagesBody : pagesBody;
  const objectTable = mode === "object-zero" ? "0 0 3 1 " : tableObjectNumber + " 0 ";
  const first = objectTable.length;
  const decodedObjectStream = encoder.encode(objectTable + objectBody);
  const objectStreamPayload = mode === "flate"
    ? Uint8Array.from(deflateSync(decodedObjectStream))
    : decodedObjectStream;
  const objectStreamDictionary = "/Type /ObjStm /N " + (mode === "too-many" ? 4_097 : mode === "object-zero" ? 2 : 1)
    + " /First " + first
    + " /Length " + objectStreamPayload.byteLength
    + (mode === "flate" ? " /Filter /FlateDecode" : "");
  const objectStreamHeader = encoder.encode("2 0 obj\n<< " + objectStreamDictionary + " >>\nstream\n");
  const objectStreamTrailer = encoder.encode("\nendstream\nendobj\n");
  const xrefOffset = objectStreamOffset
    + objectStreamHeader.byteLength
    + objectStreamPayload.byteLength
    + objectStreamTrailer.byteLength;
  const records = join([
    xrefStreamRecord(0, 0, 65_535),
    xrefStreamRecord(1, catalogOffset, 0),
    xrefStreamRecord(1, objectStreamOffset, 0),
    xrefStreamRecord(2, 2, mode === "wrong-index" || mode === "object-zero" ? 1 : 0),
    xrefStreamRecord(1, xrefOffset, 0),
  ]);
  const xrefHeader = encoder.encode(
    "4 0 obj\n<< /Type /XRef /Size 5 /Root 1 0 R /W [1 4 2] /Index [0 5] /Length "
      + records.byteLength + " >>\nstream\n",
  );
  const trailer = encoder.encode("\nendstream\nendobj\nstartxref\n" + xrefOffset + "\n%%EOF\n");
  return join([
    header,
    catalog,
    objectStreamHeader,
    objectStreamPayload,
    objectStreamTrailer,
    xrefHeader,
    records,
    trailer,
  ]);
}

function type1ObjectInsideEncodedStreamPdf(): Uint8Array {
  const header = encoder.encode("%PDF-1.5\n");
  const catalog = encoder.encode("1 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n");
  const catalogOffset = header.byteLength;
  const objectStreamOffset = catalogOffset + catalog.byteLength;
  const objectTable = "3 0 ";
  const embeddedHeader = "4 0 obj";
  const pagesBody = "<< /Type /Pages /Kids [] /Count 0 /Note (" + embeddedHeader + ") >>";
  const objectStreamPayload = encoder.encode(objectTable + pagesBody);
  const objectStreamHeader = encoder.encode(
    "2 0 obj\n<< /Type /ObjStm /N 1 /First " + objectTable.length
      + " /Length " + objectStreamPayload.byteLength + " >>\nstream\n",
  );
  const objectStreamDataOffset = objectStreamOffset + objectStreamHeader.byteLength;
  const embeddedObjectOffset = objectStreamDataOffset + objectTable.length + pagesBody.indexOf(embeddedHeader);
  const objectStreamTrailer = encoder.encode("\nendstream\nendobj\n");
  const xrefOffset = objectStreamDataOffset + objectStreamPayload.byteLength + objectStreamTrailer.byteLength;
  const records = join([
    xrefStreamRecord(0, 0, 65_535),
    xrefStreamRecord(1, catalogOffset, 0),
    xrefStreamRecord(1, objectStreamOffset, 0),
    xrefStreamRecord(2, 2, 0),
    xrefStreamRecord(1, embeddedObjectOffset, 0),
    xrefStreamRecord(1, xrefOffset, 0),
  ]);
  const xrefHeader = encoder.encode(
    "5 0 obj\n<< /Type /XRef /Size 6 /Root 1 0 R /W [1 4 2] /Index [0 6] /Length "
      + records.byteLength + " >>\nstream\n",
  );
  const trailer = encoder.encode("\nendstream\nendobj\nstartxref\n" + xrefOffset + "\n%%EOF\n");
  return join([
    header,
    catalog,
    objectStreamHeader,
    objectStreamPayload,
    objectStreamTrailer,
    xrefHeader,
    records,
    trailer,
  ]);
}

function streamSpanProductPdf(size: number, objectStreams: number): Uint8Array {
  assert.ok(size >= 8 && objectStreams >= 1 && 3 + objectStreams * 2 < size - 1);
  const streamStart = 3;
  const compressedStart = streamStart + objectStreams;
  const compressedEnd = compressedStart + objectStreams;
  const xrefObject = size - 1;
  const offsets = new Uint32Array(size);
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.5\n")];
  let byteLength = parts[0]!.byteLength;
  const append = (value: string): void => {
    const encoded = encoder.encode(value);
    parts.push(encoded);
    byteLength += encoded.byteLength;
  };

  for (let objectNumber = 1; objectNumber < xrefObject; objectNumber += 1) {
    if (objectNumber >= compressedStart && objectNumber < compressedEnd) continue;
    offsets[objectNumber] = byteLength;
    if (objectNumber === 1) {
      append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    } else if (objectNumber === 2) {
      append("2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n");
    } else if (objectNumber >= streamStart && objectNumber < compressedStart) {
      const compressedObject = compressedStart + objectNumber - streamStart;
      const table = compressedObject + " 0 ";
      const payload = table + "null";
      append(
        objectNumber + " 0 obj\n<< /Type /ObjStm /N 1 /First " + table.length
          + " /Length " + payload.length + " >>\nstream\n" + payload + "\nendstream\nendobj\n",
      );
    } else {
      append(objectNumber + " 0 obj\n");
    }
  }

  const xrefOffset = byteLength;
  offsets[xrefObject] = xrefOffset;
  const records: Uint8Array[] = [xrefStreamRecord(0, 0, 65_535)];
  for (let objectNumber = 1; objectNumber < size; objectNumber += 1) {
    if (objectNumber >= compressedStart && objectNumber < compressedEnd) {
      records.push(xrefStreamRecord(2, streamStart + objectNumber - compressedStart, 0));
    } else {
      records.push(xrefStreamRecord(1, offsets[objectNumber]!, 0));
    }
  }
  const payload = join(records);
  append(
    xrefObject + " 0 obj\n<< /Type /XRef /Size " + size
      + " /Root 1 0 R /W [1 4 2] /Index [0 " + size + "] /Length " + payload.byteLength
      + " >>\nstream\n",
  );
  parts.push(payload);
  append("\nendstream\nendobj\nstartxref\n" + xrefOffset + "\n%%EOF\n");
  return join(parts);
}

function utf16LeXml(value: string): Uint8Array {
  const result = new Uint8Array(2 + value.length * 2);
  result[0] = 0xff;
  result[1] = 0xfe;
  const view = new DataView(result.buffer);
  for (let index = 0; index < value.length; index += 1) view.setUint16(2 + index * 2, value.charCodeAt(index), true);
  return result;
}

function wordDocumentWithRootAttributes(count: number): string {
  const chunks = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"",
  ];
  let attributes = "";
  for (let index = 0; index < count; index += 1) {
    attributes += " a" + index.toString(36) + "=\"\"";
    if (attributes.length >= 1_000_000) {
      chunks.push(attributes);
      attributes = "";
    }
  }
  chunks.push(attributes, "><w:body/></w:document>");
  return chunks.join("");
}

function docxWithWordDocument(body: string | Uint8Array): Uint8Array {
  return storedZip(canonicalEntries.map((entry, index) => index === 2 ? { ...entry, body } : entry));
}

test("document inspection accepts complete bounded PDF, DOCX, RTF, and UTF-8 text fixtures", () => {
  assert.equal(inspectDocument(minimalPdf(), "agreement.pdf").contentType, "application/pdf");
  assert.equal(inspectDocument(storedZip(canonicalEntries), "agreement.docx").extension, "docx");
  assert.equal(inspectDocument(storedZip(canonicalEntries.map((entry) => ({ ...entry, method: 8 }))), "compressed.docx").extension, "docx");
  assert.equal(inspectDocument(encoder.encode("{\\rtf1\\ansi Agreement {\\b terms}\\par}"), "agreement.rtf").extension, "rtf");
  assert.equal(inspectDocument(encoder.encode("Agreement terms\nLine two: café"), "agreement.txt").extension, "txt");
});

test("PDF and RTF inspection requires complete bounded structure", () => {
  assert.throws(() => inspectDocument(encoder.encode("%PDF-1.7\nbody only"), "agreement.pdf"), /final trailer/i);
  assert.throws(() => inspectDocument(minimalPdf("appended payload"), "agreement.pdf"), /final trailer/i);
  assert.throws(() => inspectDocument(encoder.encode("%PDF-1.7\nstartxref\n999999\n%%EOF\n"), "agreement.pdf"), /offset/i);
  const fakePdfPrefix = "%PDF-1.7\n";
  assert.throws(
    () => inspectDocument(encoder.encode(`${fakePdfPrefix}startxref\n${fakePdfPrefix.length + 5}\n%%EOF\n`), "agreement.pdf"),
    /offset|cross-reference/i,
  );
  assert.throws(() => inspectDocument(encoder.encode("{\\rtf1\\ansi unclosed"), "agreement.rtf"), /incomplete|nesting/i);
  assert.throws(() => inspectDocument(encoder.encode("{\\rtf1\\ansi ok}payload"), "agreement.rtf"), /trailing/i);
  assert.throws(() => inspectDocument(encoder.encode("{\\rtf1\\ansi {\\object unsafe}}"), "agreement.rtf"), /object/i);
  assert.throws(() => inspectDocument(encoder.encode("{\\rtf1\\ansi {\\object1\\objdata1 41424344}}"), "agreement.rtf"), /object/i);
});

test("PDF XRef streams decode bounded records, predictors, and incremental root linkage", () => {
  assert.equal(inspectDocument(xrefStreamPdf(), "raw-xref.pdf").extension, "pdf");
  assert.equal(inspectDocument(xrefStreamPdf({
    filter: "flate-png",
    dictionarySuffix: "/Note (stream >> endstream) /Nested << /Value (endobj) >> ",
  }), "flate-xref.pdf").extension, "pdf");
  assert.equal(inspectDocument(incrementalXrefStreamPdf(), "incremental-xref.pdf").extension, "pdf");
  assert.equal(inspectDocument(incrementalXrefStreamPdf(false, true), "mixed-object-zero.pdf").extension, "pdf");
  const linearized = linearizedPdf();
  assert.equal(inspectDocument(linearized.bytes, "linearized.pdf").extension, "pdf");
  assert.equal(inspectDocument(objectStreamPdf(), "raw-object-stream.pdf").extension, "pdf");
  assert.equal(inspectDocument(objectStreamPdf("flate"), "flate-object-stream.pdf").extension, "pdf");
  assert.equal(inspectDocument(xrefStreamPdf({ omitObjectZero: true }), "sparse-stream-xref.pdf").extension, "pdf");

  const fakePrefix = "%PDF-1.5\n";
  const fake = encoder.encode(
    fakePrefix
      + "1 0 obj\n<< /Type /XRef /Size 2 /Root 99 0 R /W [1 4 2] /Index [0 2] /Length 0 >>\n"
      + "stream\n\nendstream\nendobj\nstartxref\n" + fakePrefix.length + "\n%%EOF\n",
  );
  assert.throws(() => inspectDocument(fake, "empty-xref.pdf"), /root|record|Length/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ root: "99 0 R" }), "missing-root.pdf"), /root/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ root: "3 0 R" }), "non-catalog-root.pdf"), /catalog/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ catalogWithoutPages: true }), "missing-pages.pdf"), /Pages/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ catalogOffsetDelta: 1 }), "wrong-offset.pdf"), /object header/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ selfType: 0 }), "missing-self.pdf"), /self-entry|free/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ widths: [0, 0, 0] }), "zero-width.pdf"), /field widths/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ lengthDelta: 1 }), "wrong-length.pdf"), /Length|record size/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ filter: "unsupported" }), "unsupported-filter.pdf"), /filter/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ filter: "flate-trailing" }), "trailing-flate.pdf"), /trailing compressed/i);
  assert.throws(
    () => inspectDocument(xrefStreamPdf({ dictionaryPrefix: "/Si#7ae 5 " }), "duplicate-key.pdf"),
    /duplicate key/i,
  );
  assert.throws(
    () => inspectDocument(xrefStreamPdf({ dictionarySuffix: "/F (remote.xref) " }), "external-xref.pdf"),
    /external/i,
  );

  assert.throws(() => inspectDocument(xrefStreamPdf({ indirectLength: true }), "indirect-length.pdf"), /Length/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ streamEol: "space" }), "stream-eol.pdf"), /end-of-line/i);
  const badClassicRoot = new TextDecoder("latin1").decode(minimalPdf()).replace("/Root 1 0 R", "/Root 99 0 R");
  assert.throws(() => inspectDocument(encoder.encode(badClassicRoot), "classic-root.pdf"), /root/i);
  const badClassicObjectZero = new TextDecoder("latin1").decode(minimalPdf()).replace("0000000000 65535 f", "0000000000 00000 f");
  assert.throws(() => inspectDocument(encoder.encode(badClassicObjectZero), "classic-object-zero.pdf"), /object-zero/i);
  assert.throws(() => inspectDocument(incrementalXrefStreamPdf(true), "root-tombstone.pdf"), /root/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ partialMap: true }), "partial-xref-map.pdf"), /Pages|page tree|cross-reference/i);
  assert.equal(inspectDocument(xrefStreamPdf({ objectZeroGeneration: 0 }), "stream-object-zero.pdf").extension, "pdf");
  assert.throws(() => inspectDocument(xrefStreamPdf({ objectZeroGeneration: 1 }), "object-zero-generation.pdf"), /object-zero/i);
  assert.throws(() => inspectDocument(xrefStreamPdf({ objectZeroType: 1 }), "object-zero-type.pdf"), /object header|object-zero/i);
  const appendedLinearized = join([
    linearized.bytes,
    encoder.encode("JUNK\nstartxref\n" + linearized.earlyXrefOffset + "\n%%EOF\n"),
  ]);
  assert.throws(() => inspectDocument(appendedLinearized, "linearized-append.pdf"), /unexpected data|linearized/i);
  assert.throws(() => inspectDocument(objectStreamPdf("empty"), "empty-object-stream.pdf"), /compressed object|truncated/i);
  assert.throws(() => inspectDocument(objectStreamPdf("object-zero"), "object-stream-object-zero.pdf"), /object table/i);
  assert.throws(() => inspectDocument(objectStreamPdf("too-many"), "oversized-object-stream.pdf"), /bounded header/i);
  assert.throws(() => inspectDocument(objectStreamPdf("wrong-index"), "object-stream-index.pdf"), /object-stream table/i);
  assert.throws(() => inspectDocument(objectStreamPdf("wrong-object"), "object-stream-mapping.pdf"), /object-stream table/i);
  const excessivePrev = excessiveClassicPrevPdf();
  assert.ok(excessivePrev.byteLength < 20 * 1024 * 1024);
  assert.throws(() => inspectDocument(excessivePrev, "excessive-prev.pdf"), /aggregate parse size/i);
});

test("PDF encoded stream spans use one sorted index and logarithmic offset lookups", () => {
  const source = readFileSync(new URL("../app/lib/document-security.ts", import.meta.url), "utf8");
  const indexStart = source.indexOf("function buildPdfEncodedStreamSpanIndex");
  const lookupStart = source.indexOf("function pdfOffsetInsideEncodedStream", indexStart);
  const lookupEnd = source.indexOf("function inspectPdfObjectHeader", lookupStart);
  const inspectionStart = source.indexOf("function inspectEffectivePdfObjects");
  const inspectionEnd = source.indexOf("function inspectBoundedPdfXrefChain", inspectionStart);
  assert.ok(indexStart >= 0 && lookupStart > indexStart && lookupEnd > lookupStart);
  assert.ok(inspectionStart >= 0 && inspectionEnd > inspectionStart);

  const indexImplementation = source.slice(indexStart, lookupStart);
  const lookupImplementation = source.slice(lookupStart, lookupEnd);
  const inspectionImplementation = source.slice(inspectionStart, inspectionEnd);
  assert.match(indexImplementation, /\.sort\(/);
  assert.match(indexImplementation, /span\.start < previous\.end/);
  assert.match(indexImplementation, /span\.start === previous\.end/);
  assert.doesNotMatch(indexImplementation, /\.some\(/);
  assert.match(lookupImplementation, /while \(lower < upper\)/);
  assert.match(lookupImplementation, /lower = middle \+ 1/);
  assert.match(lookupImplementation, /upper = middle/);
  assert.match(inspectionImplementation, /buildPdfEncodedStreamSpanIndex\(context\.encodedStreamSpans\)/);
  assert.match(inspectionImplementation, /pdfOffsetInsideEncodedStream\(encodedStreamSpanIndex, offset\)/);
  assert.doesNotMatch(inspectionImplementation, /encodedStreamSpans\.some/);

  const size = 512;
  const objectStreams = 32;
  const type1Objects = size - objectStreams - 1;
  const maximumStepsPerLookup = Math.ceil(Math.log2(objectStreams + 2));
  const originalFloor = Math.floor;
  let lookupSteps = 0;
  Math.floor = (value: number): number => {
    lookupSteps += 1;
    return originalFloor(value);
  };
  try {
    assert.equal(inspectDocument(streamSpanProductPdf(size, objectStreams), "span-product.pdf").extension, "pdf");
  } finally {
    Math.floor = originalFloor;
  }
  assert.ok(lookupSteps > 0);
  assert.ok(lookupSteps <= type1Objects * maximumStepsPerLookup);
  assert.throws(
    () => inspectDocument(type1ObjectInsideEncodedStreamPdf(), "embedded-object.pdf"),
    /embedded inside encoded stream data/i,
  );
});

test("text inspection validates the entire body as UTF-8 and rejects controls beyond the former prefix sample", () => {
  const lateNull = join([encoder.encode("a".repeat(9_000)), new Uint8Array([0]), encoder.encode("tail")]);
  const lateInvalidUtf8 = join([encoder.encode("a".repeat(9_000)), new Uint8Array([0xc3, 0x28])]);
  assert.throws(() => inspectDocument(lateNull, "agreement.txt"), /control/i);
  assert.throws(() => inspectDocument(lateInvalidUtf8, "agreement.txt"), /UTF-8/i);
  assert.throws(() => inspectDocument(encoder.encode("left\u202eright"), "agreement.txt"), /control/i);
});

test("DOCX inspection rejects generic ZIPs, unsafe aliases, encryption, ZIP64, and overlapping entries", () => {
  assert.throws(() => inspectDocument(storedZip([{ name: "file.txt", body: "not OOXML" }]), "agreement.docx"), /canonical/i);
  assert.throws(() => inspectDocument(storedZip([
    { name: "[Content_Types].xml", body: "this is not XML or OOXML", method: 8 },
    { name: "_rels/.rels", body: "this is not XML or OOXML", method: 8 },
    { name: "word/document.xml", body: "this is not XML or OOXML", method: 8 },
  ]), "agreement.docx"), /XML|root|markup/i);
  assert.throws(() => inspectDocument(storedZip([...canonicalEntries, { name: "../escape.xml", body: "x" }]), "agreement.docx"), /unsafe/i);
  assert.throws(() => inspectDocument(storedZip([...canonicalEntries, { name: "WORD/DOCUMENT.XML", body: "x" }]), "agreement.docx"), /duplicate|aliased/i);
  assert.throws(() => inspectDocument(storedZip(canonicalEntries.map((entry, index) => ({ ...entry, flags: index === 0 ? 0x0801 : 0x0800 }))), "agreement.docx"), /encrypted/i);
  assert.throws(() => inspectDocument(storedZip(canonicalEntries.map((entry, index) => ({ ...entry, localOffset: index === 1 ? 0 : undefined }))), "agreement.docx"), /duplicate|overlapping/i);
  assert.throws(() => inspectDocument(storedZip(canonicalEntries.map((entry, index) => ({ ...entry, method: index === 0 ? 12 : 0 }))), "agreement.docx"), /compression method/i);
  assert.throws(() => inspectDocument(storedZip(canonicalEntries.map((entry, index) => ({ ...entry, body: index === 0 ? "" : entry.body }))), "agreement.docx"), /canonical/i);

  const zip64 = storedZip(canonicalEntries);
  const eocd = zip64.byteLength - 22;
  new DataView(zip64.buffer).setUint32(eocd + 16, 0xffff_ffff, true);
  assert.throws(() => inspectDocument(zip64, "agreement.docx"), /ZIP64/i);

  const malformedExtra = storedZip(canonicalEntries);
  const centralOffset = new DataView(malformedExtra.buffer).getUint32(malformedExtra.byteLength - 6, true);
  new DataView(malformedExtra.buffer).setUint16(centralOffset + 30, 4, true);
  assert.throws(() => inspectDocument(malformedExtra, "agreement.docx"), /extra field|directory/i);

  const symlink = storedZip(canonicalEntries);
  const symlinkCentralOffset = new DataView(symlink.buffer).getUint32(symlink.byteLength - 6, true);
  new DataView(symlink.buffer).setUint16(symlinkCentralOffset + 4, (3 << 8) | 20, true);
  new DataView(symlink.buffer).setUint32(symlinkCentralOffset + 38, 0xa000_0000, true);
  assert.throws(() => inspectDocument(symlink, "agreement.docx"), /special entry/i);
});

test("DOCX inspection enforces entry-count, expanded-size, and compression-ratio budgets", () => {
  const tooMany = storedZip(canonicalEntries);
  const eocd = tooMany.byteLength - 22;
  new DataView(tooMany.buffer).setUint16(eocd + 8, 2_049, true);
  new DataView(tooMany.buffer).setUint16(eocd + 10, 2_049, true);
  assert.throws(() => inspectDocument(tooMany, "agreement.docx"), /too many/i);

  assert.throws(() => inspectDocument(storedZip(canonicalEntries.map((entry, index) => ({
    ...entry,
    method: index === 0 ? 8 : 0,
    declaredExpandedSize: index === 0 ? 33 * 1024 * 1024 : undefined,
  }))), "agreement.docx"), /expands beyond/i);

  assert.throws(() => inspectDocument(storedZip(canonicalEntries.map((entry, index) => ({
    ...entry,
    method: index === 0 ? 8 : 0,
    declaredCompressedSize: index === 0 ? 1 : undefined,
    declaredExpandedSize: index === 0 ? 101 : undefined,
  }))), "agreement.docx"), /compression ratio/i);

  assert.throws(() => inspectDocument(storedZip(canonicalEntries.map((entry, index) => ({
    ...entry,
    declaredCompressedSize: index === 0 ? entry.body.length - 1 : undefined,
  }))), "agreement.docx"), /inconsistent sizes/i);
});

test("DOCX XML inspection bounds attribute cardinality and material before retained allocation", () => {
  const namespaceAttributes = Array.from(
    { length: 200 },
    (_, index) => " xmlns:n" + index + "=\"urn:notice:test:" + index + "\"",
  ).join("");
  const namespaceRich = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\""
    + namespaceAttributes + "><w:body/></w:document>";
  assert.equal(inspectDocument(docxWithWordDocument(namespaceRich), "namespace-rich.docx").extension, "docx");

  assert.throws(
    () => inspectDocument(docxWithWordDocument(wordDocumentWithRootAttributes(257)), "per-tag-attributes.docx"),
    /too many attributes/i,
  );
  const utf16Attributes = wordDocumentWithRootAttributes(257).replace("encoding=\"UTF-8\"", "encoding=\"UTF-16\"");
  assert.throws(
    () => inspectDocument(docxWithWordDocument(utf16LeXml(utf16Attributes)), "utf16-attributes.docx"),
    /too many attributes/i,
  );

  const oneMillionAttributePoc = docxWithWordDocument(wordDocumentWithRootAttributes(1_000_000));
  assert.ok(oneMillionAttributePoc.byteLength < 20 * 1024 * 1024);
  assert.throws(
    () => inspectDocument(oneMillionAttributePoc, "million-attributes.docx"),
    /overlong start tag|too many attributes/i,
  );

  const prefix = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    + "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>";
  const suffix = "</w:body></w:document>";
  assert.throws(
    () => inspectDocument(docxWithWordDocument(
      prefix + "<w:p " + "a".repeat(257) + "=\"\"/>" + suffix,
    ), "attribute-name.docx"),
    /overlong name/i,
  );
  assert.throws(
    () => inspectDocument(docxWithWordDocument(
      prefix + "<w:p a=\"" + "x".repeat(65_537) + "\"/>" + suffix,
    ), "attribute-value.docx"),
    /overlong attribute value/i,
  );
  assert.throws(
    () => inspectDocument(docxWithWordDocument(
      prefix + "<w:p a=\"\"/>".repeat(100_000) + suffix,
    ), "document-attributes.docx"),
    /too many attributes/i,
  );
  const maximumValue = "x".repeat(65_536);
  assert.throws(
    () => inspectDocument(docxWithWordDocument(
      prefix + ("<w:p a=\"" + maximumValue + "\"/>").repeat(128) + suffix,
    ), "attribute-material.docx"),
    /too much attribute material/i,
  );
  assert.throws(
    () => inspectDocument(docxWithWordDocument(
      prefix + "<w:p " + "a".repeat(262_145),
    ), "unterminated-start-tag.docx"),
    /overlong start tag/i,
  );
});

test("DOCX inspection authenticates compressed payload CRC, expansion, and XML structure", () => {
  const corrupt = storedZip(canonicalEntries.map((entry) => ({ ...entry, method: 8 })));
  const documentName = encoder.encode("word/document.xml");
  let nameOffset = -1;
  outer: for (let index = 0; index <= corrupt.byteLength - documentName.byteLength; index += 1) {
    for (let nameIndex = 0; nameIndex < documentName.byteLength; nameIndex += 1) {
      if (corrupt[index + nameIndex] !== documentName[nameIndex]) continue outer;
    }
    nameOffset = index;
    break;
  }
  assert.ok(nameOffset >= 30);
  const localOffset = nameOffset - 30;
  const localExtraLength = new DataView(corrupt.buffer).getUint16(localOffset + 28, true);
  corrupt[nameOffset + documentName.byteLength + localExtraLength] ^= 0xff;
  assert.throws(() => inspectDocument(corrupt, "corrupt.docx"), /decompress|CRC|expanded/i);

  const wrongCrc = storedZip(canonicalEntries.map((entry, index) => ({
    ...entry,
    method: 8,
    declaredCrc32: index === 2 ? 0 : undefined,
  })));
  assert.throws(() => inspectDocument(wrongCrc, "wrong-crc.docx"), /CRC/i);

  const oversizedDocumentXml = new Uint8Array(33 * 1024 * 1024);
  oversizedDocumentXml.fill(0x41);
  const forgedExpansion = storedZip(canonicalEntries.map((entry, index) => index === 2 ? {
    ...entry,
    body: oversizedDocumentXml,
    method: 8,
    declaredExpandedSize: 1,
  } : { ...entry, method: 8 }));
  assert.ok(forgedExpansion.byteLength < 20 * 1024 * 1024);
  assert.throws(() => inspectDocument(forgedExpansion, "forged-expansion.docx"), /decompress|expanded|limit/i);
});
