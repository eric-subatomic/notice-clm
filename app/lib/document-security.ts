import {
  cancelResponseBody,
  fetchWithHeaderDeadline,
  readBoundedResponseBody,
  ResponseBoundaryError,
} from "./response-boundary";
import { inflateRawSync, inflateSync } from "node:zlib";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const SCANNER_RESPONSE_MAX_BYTES = 8 * 1_024;
export const CUSTOMER_HOSTED_OCR_PROTOCOL_VERSION = "2.0" as const;
export const CUSTOMER_HOSTED_OCR_MAX_CHARACTERS = 400_000;
export const CUSTOMER_HOSTED_OCR_MAX_TEXT_BYTES = 2_000_000;
export const CUSTOMER_HOSTED_OCR_RESPONSE_MAX_BYTES = CUSTOMER_HOSTED_OCR_MAX_TEXT_BYTES + 16_384;

const customerHostedOcrIdentifierPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?)?$/;

export type SupportedDocument = {
  extension: "pdf" | "docx" | "rtf" | "txt";
  contentType: string;
};

export type ScanVerdict = {
  status: "clean" | "malicious" | "unavailable";
  provider: string;
  detail: string;
  scannedAt: string | null;
};

export type ScannerConfiguration = {
  endpoint: string | null;
  secret: string | null;
  timeoutMs?: number;
  ocr?: CustomerHostedOcrProfile | null;
};

export type CustomerHostedOcrProfile = Readonly<{
  modelId: string;
  profileId: string;
}>;

export type CustomerHostedOcrResult = Readonly<{
  text: string;
  requestId: string;
  provider: string;
  detail: string;
  modelId: string;
  profileId: string;
  sourceSha256: string;
}>;

export type CustomerHostedOcrVerdictEvidence = Readonly<{
  requestId: string;
  provider: string;
  detail: string;
  scannedAt: string;
}>;

export function isValidCustomerHostedOcrIdentifier(value: string): boolean {
  return value.length <= 128
    && customerHostedOcrIdentifierPattern.test(value)
    && !value.includes("..")
    && !/^(?:change-?me|replace(?:-|$)|todo|tbd|unset|your(?:-|$))/i.test(value);
}

export function supportsCustomerHostedOcr(document: SupportedDocument): boolean {
  return document.extension === "pdf" || document.extension === "docx";
}

const extensionTypes: Record<SupportedDocument["extension"], string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rtf: "application/rtf",
  txt: "text/plain",
};

const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const DOCX_REQUIRED_ENTRIES = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
const DOCX_MAX_ENTRIES = 2_048;
const DOCX_MAX_ENTRY_EXPANDED_BYTES = 32 * 1024 * 1024;
const DOCX_MAX_TOTAL_EXPANDED_BYTES = 64 * 1024 * 1024;
const DOCX_MAX_COMPRESSION_RATIO = 100;
const DOCX_MAX_ENTRY_NAME_BYTES = 1_024;
const DOCX_MAX_XML_DEPTH = 512;
const DOCX_MAX_XML_ELEMENTS = 500_000;
const DOCX_MAX_XML_ATTRIBUTES_PER_ELEMENT = 256;
const DOCX_MAX_XML_ATTRIBUTES_PER_DOCUMENT = 100_000;
const DOCX_MAX_XML_NAME_CHARACTERS = 256;
const DOCX_MAX_XML_ATTRIBUTE_VALUE_CHARACTERS = 64 * 1024;
const DOCX_MAX_XML_ATTRIBUTE_CHARACTERS_PER_DOCUMENT = 8 * 1024 * 1024;
const DOCX_MAX_XML_START_TAG_CHARACTERS = 256 * 1024;
const PDF_TRAILER_SEARCH_BYTES = 4_096;
const PDF_MAX_XREF_ENTRIES = 500_000;
const PDF_MAX_XREF_DICTIONARY_BYTES = 64 * 1024;
const PDF_MAX_XREF_FIELD_BYTES = 8;
const PDF_MAX_VALUE_DEPTH = 32;
const PDF_MAX_VALUE_TOKENS = 16_384;
const PDF_MAX_TOTAL_DECODED_STREAM_BYTES = 64 * 1024 * 1024;
const PDF_MAX_TOTAL_PARSED_XREF_BYTES = 64 * 1024 * 1024;
const PDF_MAX_OBJECT_STREAMS = 2_048;
const PDF_MAX_OBJECTS_PER_STREAM = 4_096;
const RTF_MAX_NESTING_DEPTH = 256;
const OPC_CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const OPC_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const WORDPROCESSING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const WORDPROCESSING_MAIN_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1));
    table[index] = value >>> 0;
  }
  return table;
})();

function contentMismatch(message = "The document contents do not match its filename"): never {
  throw new DocumentSecurityError("content_mismatch", message, 415);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) contentMismatch("The DOCX archive is truncated");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) contentMismatch("The DOCX archive is truncated");
  return (
    bytes[offset]!
    + bytes[offset + 1]! * 0x100
    + bytes[offset + 2]! * 0x1_0000
    + bytes[offset + 3]! * 0x100_0000
  );
}

function byteSlicesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function validateZipExtraFields(bytes: Uint8Array, offset: number, length: number): void {
  const end = offset + length;
  if (offset < 0 || end > bytes.byteLength) contentMismatch("The DOCX archive contains a truncated extra field");
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) contentMismatch("The DOCX archive contains a malformed extra field");
    const fieldId = readUint16(bytes, cursor);
    const fieldLength = readUint16(bytes, cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end) contentMismatch("The DOCX archive contains a malformed extra field");
    if (fieldId === 0x0001) contentMismatch("The DOCX archive uses an unsupported ZIP64 structure");
    cursor += fieldLength;
  }
}

function zipEntryName(nameBytes: Uint8Array, utf8: boolean): string {
  if (nameBytes.byteLength === 0) contentMismatch("The DOCX archive contains an unnamed entry");
  let name: string;
  try {
    name = new TextDecoder(utf8 ? "utf-8" : "latin1", { fatal: utf8 }).decode(nameBytes);
  } catch {
    contentMismatch("The DOCX archive contains an invalid entry name");
  }
  if (
    name.includes("\u0000")
    || name.includes("\\")
    || name.startsWith("/")
    || /^[A-Za-z]:/.test(name)
    || /[\u0000-\u001f\u007f-\u009f]/.test(name)
  ) contentMismatch("The DOCX archive contains an unsafe entry path");
  const pathSegments = name.split("/");
  const directory = pathSegments.at(-1) === "";
  if (directory) pathSegments.pop();
  if (pathSegments.length === 0 || pathSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    contentMismatch("The DOCX archive contains an unsafe entry path");
  }
  return directory ? `${pathSegments.join("/")}/` : pathSegments.join("/");
}

type DocxCentralEntry = Readonly<{
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  expandedSize: number;
  localOffset: number;
  directory: boolean;
}>;

type DocxXmlKind = "content-types" | "package-relationships" | "word-document";

function crc32Bytes(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffff_ffff) >>> 0;
}

function isXmlCharacter(codePoint: number): boolean {
  return codePoint === 0x09
    || codePoint === 0x0a
    || codePoint === 0x0d
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x1_0000 && codePoint <= 0x10_ffff);
}

function validateXmlCharacters(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (!isXmlCharacter(codePoint)) contentMismatch("A required DOCX XML part contains invalid characters");
    if (codePoint > 0xffff) index += 1;
  }
}

function decodedXmlEntity(entity: string): string {
  const predefined: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: "\"" };
  if (entity in predefined) return predefined[entity]!;
  const hexadecimal = /^#x([0-9a-f]+)$/i.exec(entity);
  const decimal = /^#([0-9]+)$/.exec(entity);
  const codePoint = hexadecimal ? Number.parseInt(hexadecimal[1]!, 16) : decimal ? Number.parseInt(decimal[1]!, 10) : Number.NaN;
  if (!Number.isSafeInteger(codePoint) || !isXmlCharacter(codePoint)) {
    contentMismatch("A required DOCX XML part contains an unsupported entity");
  }
  return String.fromCodePoint(codePoint);
}

function decodeXmlEntities(value: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const entityStart = value.indexOf("&", cursor);
    if (entityStart < 0) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, entityStart);
    const entityEnd = value.indexOf(";", entityStart + 1);
    if (entityEnd < 0 || entityEnd - entityStart > 34) {
      contentMismatch("A required DOCX XML part contains a malformed entity");
    }
    output += decodedXmlEntity(value.slice(entityStart + 1, entityEnd));
    cursor = entityEnd + 1;
  }
  return output;
}

function decodeDocxXml(bytes: Uint8Array): string {
  let encoding: "utf-8" | "utf-16le" | "utf-16be" = "utf-8";
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  } else if (bytes[0] === 0x3c && bytes[1] === 0x00) encoding = "utf-16le";
  else if (bytes[0] === 0x00 && bytes[1] === 0x3c) encoding = "utf-16be";

  let xml: string;
  try {
    xml = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    contentMismatch("A required DOCX XML part has an invalid text encoding");
  }
  validateXmlCharacters(xml);
  const declaration = /^\s*<\?xml\s+[\s\S]*?\?>/i.exec(xml)?.[0] ?? "";
  const declaredEncoding = /\bencoding\s*=\s*["']([^"']+)["']/i.exec(declaration)?.[1]?.toLowerCase().replace(/[_\s]/g, "-");
  if (declaredEncoding) {
    const compatible = encoding === "utf-8"
      ? declaredEncoding === "utf-8"
      : declaredEncoding === "utf-16" || declaredEncoding === encoding;
    if (!compatible) contentMismatch("A required DOCX XML part declares a mismatched encoding");
  }
  return xml;
}

function isXmlNameStart(value: string): boolean {
  return /[A-Za-z_]/.test(value);
}

function isXmlNameCharacter(value: string): boolean {
  return /[A-Za-z0-9_.:-]/.test(value);
}

function readXmlName(value: string, start: number): { name: string; end: number } {
  if (start >= value.length || !isXmlNameStart(value[start]!)) contentMismatch("A required DOCX XML part contains an invalid name");
  let end = start + 1;
  while (end < value.length && isXmlNameCharacter(value[end]!)) end += 1;
  if (end - start > DOCX_MAX_XML_NAME_CHARACTERS) {
    contentMismatch("A required DOCX XML part contains an overlong name");
  }
  const name = value.slice(start, end);
  if ((name.match(/:/g) ?? []).length > 1 || name.endsWith(":")) {
    contentMismatch("A required DOCX XML part contains an invalid qualified name");
  }
  return { name, end };
}

function findXmlTagEnd(xml: string, start: number): number {
  let quote: "'" | "\"" | null = null;
  for (let index = start; index < xml.length; index += 1) {
    if (index - start > DOCX_MAX_XML_START_TAG_CHARACTERS) {
      contentMismatch("A required DOCX XML part contains an overlong start tag");
    }
    const value = xml[index]!;
    if (quote) {
      if (value === quote) quote = null;
      continue;
    }
    if (value === "'" || value === "\"") quote = value;
    else if (value === "<") contentMismatch("A required DOCX XML part contains malformed markup");
    else if (value === ">") return index;
  }
  contentMismatch("A required DOCX XML part is truncated");
}

type XmlStartTag = Readonly<{
  name: string;
  attributes: Map<string, string>;
  selfClosing: boolean;
}>;

type XmlAttributeBudget = {
  count: number;
  decodedCharacters: number;
};

function parseXmlStartTag(raw: string, documentBudget: XmlAttributeBudget): XmlStartTag {
  let cursor = 0;
  while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
  const parsedName = readXmlName(raw, cursor);
  const name = parsedName.name;
  cursor = parsedName.end;
  const attributes = new Map<string, string>();
  let attributeCount = 0;
  let selfClosing = false;
  while (cursor < raw.length) {
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (cursor >= raw.length) break;
    if (raw[cursor] === "/") {
      if (raw.slice(cursor + 1).trim() !== "") contentMismatch("A required DOCX XML part has malformed empty-element syntax");
      selfClosing = true;
      break;
    }
    attributeCount += 1;
    if (
      attributeCount > DOCX_MAX_XML_ATTRIBUTES_PER_ELEMENT
      || documentBudget.count + 1 > DOCX_MAX_XML_ATTRIBUTES_PER_DOCUMENT
    ) contentMismatch("A required DOCX XML part contains too many attributes");
    const attributeName = readXmlName(raw, cursor);
    cursor = attributeName.end;
    if (attributes.has(attributeName.name)) contentMismatch("A required DOCX XML part contains a duplicate attribute");
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] !== "=") contentMismatch("A required DOCX XML attribute is malformed");
    cursor += 1;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    const quote = raw[cursor];
    if (quote !== "'" && quote !== "\"") contentMismatch("A required DOCX XML attribute is not quoted");
    cursor += 1;
    const valueStart = cursor;
    while (cursor < raw.length && raw[cursor] !== quote) {
      if (raw[cursor] === "<") contentMismatch("A required DOCX XML attribute contains markup");
      cursor += 1;
    }
    if (cursor >= raw.length) contentMismatch("A required DOCX XML attribute is truncated");
    const rawValueLength = cursor - valueStart;
    if (rawValueLength > DOCX_MAX_XML_ATTRIBUTE_VALUE_CHARACTERS) {
      contentMismatch("A required DOCX XML part contains an overlong attribute value");
    }
    const decodedValue = decodeXmlEntities(raw.slice(valueStart, cursor));
    const decodedCharacters = attributeName.name.length + decodedValue.length;
    if (
      decodedValue.length > DOCX_MAX_XML_ATTRIBUTE_VALUE_CHARACTERS
      || documentBudget.decodedCharacters + decodedCharacters > DOCX_MAX_XML_ATTRIBUTE_CHARACTERS_PER_DOCUMENT
    ) contentMismatch("A required DOCX XML part contains too much attribute material");
    documentBudget.count += 1;
    documentBudget.decodedCharacters += decodedCharacters;
    attributes.set(attributeName.name, decodedValue);
    cursor += 1;
  }
  return { name, attributes, selfClosing };
}

function qNameParts(name: string): { prefix: string; localName: string } {
  const separator = name.indexOf(":");
  return separator < 0
    ? { prefix: "", localName: name }
    : { prefix: name.slice(0, separator), localName: name.slice(separator + 1) };
}

function inspectDocxXml(bytes: Uint8Array, kind: DocxXmlKind): void {
  const xml = decodeDocxXml(bytes);
  const namespaceBindings = new Map<string, string>();
  const stack: Array<{
    name: string;
    namespaceChanges: Array<{ prefix: string; previous: string | undefined }>;
  }> = [];
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;
  let declarationSeen = false;
  let elementCount = 0;
  const attributeBudget: XmlAttributeBudget = { count: 0, decodedCharacters: 0 };
  let hasMainOverride = false;
  let hasOfficeDocumentRelationship = false;
  let hasWordBody = false;

  const rollbackNamespaces = (changes: Array<{ prefix: string; previous: string | undefined }>) => {
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index]!;
      if (change.previous === undefined) namespaceBindings.delete(change.prefix);
      else namespaceBindings.set(change.prefix, change.previous);
    }
  };

  while (cursor < xml.length) {
    const markup = xml.indexOf("<", cursor);
    const text = markup < 0 ? xml.slice(cursor) : xml.slice(cursor, markup);
    if (stack.length === 0 && text.trim() !== "") contentMismatch("A required DOCX XML part contains content outside its root element");
    if (stack.length > 0) decodeXmlEntities(text);
    if (markup < 0) break;

    if (xml.startsWith("<!--", markup)) {
      const end = xml.indexOf("-->", markup + 4);
      if (end < 0 || xml.slice(markup + 4, end).includes("--")) contentMismatch("A required DOCX XML comment is malformed");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", markup)) {
      if (stack.length === 0) contentMismatch("A required DOCX XML CDATA section is outside the root element");
      const end = xml.indexOf("]]>", markup + 9);
      if (end < 0) contentMismatch("A required DOCX XML CDATA section is truncated");
      validateXmlCharacters(xml.slice(markup + 9, end));
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", markup)) {
      const end = xml.indexOf("?>", markup + 2);
      if (end < 0) contentMismatch("A required DOCX XML processing instruction is truncated");
      const instruction = xml.slice(markup + 2, end).trim();
      if (rootSeen || declarationSeen || !/^xml(?:\s|$)/i.test(instruction)) {
        contentMismatch("A required DOCX XML part contains an unsupported processing instruction");
      }
      declarationSeen = true;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", markup)) {
      contentMismatch("DTD, entity, and other declarations are not supported in DOCX XML parts");
    }

    const tagEnd = findXmlTagEnd(xml, markup + 1);
    if (tagEnd - markup - 1 > DOCX_MAX_XML_START_TAG_CHARACTERS) {
      contentMismatch("A required DOCX XML part contains an overlong start tag");
    }
    const rawTag = xml.slice(markup + 1, tagEnd);
    if (rawTag.startsWith("/")) {
      const closing = rawTag.slice(1).trim();
      const parsedClosing = readXmlName(closing, 0);
      if (parsedClosing.end !== closing.length || stack.length === 0 || stack.at(-1)!.name !== parsedClosing.name) {
        contentMismatch("A required DOCX XML part has mismatched element nesting");
      }
      const frame = stack.pop()!;
      rollbackNamespaces(frame.namespaceChanges);
      if (stack.length === 0) rootClosed = true;
      cursor = tagEnd + 1;
      continue;
    }

    if (rootClosed) contentMismatch("A required DOCX XML part contains more than one root element");
    const tag = parseXmlStartTag(rawTag, attributeBudget);
    elementCount += 1;
    if (elementCount > DOCX_MAX_XML_ELEMENTS) contentMismatch("A required DOCX XML part contains too many elements");
    const namespaceChanges: Array<{ prefix: string; previous: string | undefined }> = [];
    for (const [attributeName, value] of tag.attributes) {
      const namespacePrefix = attributeName === "xmlns" ? "" : attributeName.startsWith("xmlns:") ? attributeName.slice(6) : null;
      if (namespacePrefix === null) continue;
      const previous = namespaceBindings.get(namespacePrefix);
      namespaceChanges.push({ prefix: namespacePrefix, previous });
      namespaceBindings.set(namespacePrefix, value);
    }
    const { prefix, localName } = qNameParts(tag.name);
    const namespace = namespaceBindings.get(prefix) ?? null;
    if (!rootSeen) {
      rootSeen = true;
      const rootMatches = kind === "content-types"
        ? localName === "Types" && namespace === OPC_CONTENT_TYPES_NAMESPACE
        : kind === "package-relationships"
          ? localName === "Relationships" && namespace === OPC_RELATIONSHIPS_NAMESPACE
          : localName === "document" && namespace !== null && WORDPROCESSING_NAMESPACES.has(namespace);
      if (!rootMatches) contentMismatch("A required DOCX XML part has the wrong root element or namespace");
    }
    if (
      kind === "content-types"
      && localName === "Override"
      && namespace === OPC_CONTENT_TYPES_NAMESPACE
      && tag.attributes.get("PartName") === "/word/document.xml"
      && tag.attributes.get("ContentType") === WORDPROCESSING_MAIN_CONTENT_TYPE
    ) hasMainOverride = true;
    if (kind === "package-relationships" && localName === "Relationship" && namespace === OPC_RELATIONSHIPS_NAMESPACE) {
      const target = tag.attributes.get("Target")?.replace(/^\.\//, "").replace(/^\//, "");
      if (
        target === "word/document.xml"
        && OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(tag.attributes.get("Type") ?? "")
        && (tag.attributes.get("TargetMode") ?? "Internal") === "Internal"
      ) hasOfficeDocumentRelationship = true;
    }
    if (kind === "word-document" && localName === "body" && namespace !== null && WORDPROCESSING_NAMESPACES.has(namespace)) {
      hasWordBody = true;
    }

    if (tag.selfClosing) {
      rollbackNamespaces(namespaceChanges);
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push({ name: tag.name, namespaceChanges });
      if (stack.length > DOCX_MAX_XML_DEPTH) contentMismatch("A required DOCX XML part is nested too deeply");
    }
    cursor = tagEnd + 1;
  }

  if (!rootSeen || !rootClosed || stack.length !== 0) contentMismatch("A required DOCX XML part is incomplete");
  if (kind === "content-types" && !hasMainOverride) contentMismatch("The DOCX content-types part does not declare the main Word document");
  if (kind === "package-relationships" && !hasOfficeDocumentRelationship) contentMismatch("The DOCX package relationship does not target the main Word document");
  if (kind === "word-document" && !hasWordBody) contentMismatch("The DOCX main document is missing its WordprocessingML body");
}

function inspectRequiredDocxXml(name: string, bytes: Uint8Array): void {
  if (name === "[Content_Types].xml") inspectDocxXml(bytes, "content-types");
  else if (name === "_rels/.rels") inspectDocxXml(bytes, "package-relationships");
  else if (name === "word/document.xml") inspectDocxXml(bytes, "word-document");
}

function expandedDocxEntry(
  bytes: Uint8Array,
  entry: DocxCentralEntry,
  dataStart: number,
  maximumExpandedBytes: number,
): Uint8Array {
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  let expanded: Uint8Array;
  if (entry.method === 0) {
    expanded = compressed;
  } else {
    try {
      expanded = inflateRawSync(compressed, { maxOutputLength: Math.max(1, maximumExpandedBytes) });
    } catch {
      contentMismatch("A DOCX entry could not be decompressed within the supported limit");
    }
  }
  if (expanded.byteLength !== entry.expandedSize) contentMismatch("A DOCX entry has a forged expanded size");
  if (crc32Bytes(expanded) !== entry.crc32) contentMismatch("A DOCX entry failed its CRC-32 integrity check");
  return expanded;
}

function inspectDocxArchive(bytes: Uint8Array): void {
  // EOCD may be followed only by its bounded ZIP comment. Searching backward
  // prevents an earlier signature inside entry data from being authoritative.
  const minimumEocdOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (readUint32(bytes, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = readUint16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) contentMismatch("The DOCX archive is missing its final directory");

  const diskNumber = readUint16(bytes, eocdOffset + 4);
  const centralDisk = readUint16(bytes, eocdOffset + 6);
  const entriesOnDisk = readUint16(bytes, eocdOffset + 8);
  const entryCount = readUint16(bytes, eocdOffset + 10);
  const centralSize = readUint32(bytes, eocdOffset + 12);
  const centralOffset = readUint32(bytes, eocdOffset + 16);
  if (
    diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0
    || entryCount === 0xffff
    || centralSize === 0xffff_ffff
    || centralOffset === 0xffff_ffff
  ) contentMismatch("The DOCX archive uses an unsupported split or ZIP64 structure");
  if (entryCount > DOCX_MAX_ENTRIES) contentMismatch("The DOCX archive contains too many entries");
  if (centralOffset + centralSize !== eocdOffset || centralOffset < 30) {
    contentMismatch("The DOCX archive directory is inconsistent");
  }

  const entries: DocxCentralEntry[] = [];
  const exactNames = new Set<string>();
  const foldedNames = new Set<string>();
  const localOffsets = new Set<number>();
  let expandedTotal = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || readUint32(bytes, cursor) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      contentMismatch("The DOCX archive directory is malformed");
    }
    const versionMadeBy = readUint16(bytes, cursor + 4);
    const flags = readUint16(bytes, cursor + 8);
    const method = readUint16(bytes, cursor + 10);
    const crc32 = readUint32(bytes, cursor + 16);
    const compressedSize = readUint32(bytes, cursor + 20);
    const expandedSize = readUint32(bytes, cursor + 24);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const startingDisk = readUint16(bytes, cursor + 34);
    const externalAttributes = readUint32(bytes, cursor + 38);
    const localOffset = readUint32(bytes, cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > eocdOffset) contentMismatch("The DOCX archive directory is truncated");
    if (nameLength > DOCX_MAX_ENTRY_NAME_BYTES) contentMismatch("The DOCX archive contains an overlong entry name");
    validateZipExtraFields(bytes, cursor + 46 + nameLength, extraLength);
    if (
      startingDisk !== 0
      || compressedSize === 0xffff_ffff
      || expandedSize === 0xffff_ffff
      || localOffset === 0xffff_ffff
    ) contentMismatch("The DOCX archive uses an unsupported ZIP64 structure");
    if ((flags & (0x0001 | 0x0020 | 0x0040 | 0x2000)) !== 0) {
      contentMismatch("Encrypted or patched DOCX entries are not supported");
    }
    const creatorSystem = versionMadeBy >>> 8;
    const unixFileType = (externalAttributes >>> 16) & 0xf000;
    if (creatorSystem === 3 && unixFileType !== 0 && unixFileType !== 0x4000 && unixFileType !== 0x8000) {
      contentMismatch("The DOCX archive contains an unsupported special entry");
    }
    if (method !== 0 && method !== 8) contentMismatch("The DOCX archive uses an unsupported compression method");
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    const name = zipEntryName(nameBytes, (flags & 0x0800) !== 0);
    const foldedName = name.toLowerCase();
    if (exactNames.has(name) || foldedNames.has(foldedName) || localOffsets.has(localOffset)) {
      contentMismatch("The DOCX archive contains duplicate or aliased entries");
    }
    exactNames.add(name);
    foldedNames.add(foldedName);
    localOffsets.add(localOffset);
    const directory = name.endsWith("/");
    if (directory && (compressedSize !== 0 || expandedSize !== 0)) {
      contentMismatch("The DOCX archive contains a malformed directory entry");
    }
    if (!directory) {
      if (method === 0 && compressedSize !== expandedSize) contentMismatch("A stored DOCX entry has inconsistent sizes");
      if (expandedSize > DOCX_MAX_ENTRY_EXPANDED_BYTES) contentMismatch("A DOCX entry expands beyond the supported limit");
      expandedTotal += expandedSize;
      if (expandedTotal > DOCX_MAX_TOTAL_EXPANDED_BYTES) contentMismatch("The DOCX archive expands beyond the supported limit");
      if (expandedSize > 0 && (compressedSize === 0 || expandedSize / compressedSize > DOCX_MAX_COMPRESSION_RATIO)) {
        contentMismatch("A DOCX entry has an unsafe compression ratio");
      }
    }
    entries.push({ name, nameBytes, flags, method, crc32, compressedSize, expandedSize, localOffset, directory });
    cursor = entryEnd;
  }
  if (
    cursor !== eocdOffset
    || [...DOCX_REQUIRED_ENTRIES].some((name) => {
      const entry = entries.find((candidate) => candidate.name === name);
      return !entry || entry.directory || entry.expandedSize === 0;
    })
  ) {
    contentMismatch("The DOCX archive is missing canonical WordprocessingML entries");
  }

  const regions: Array<{ start: number; end: number; dataStart: number; entry: DocxCentralEntry }> = [];
  for (const entry of entries) {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || readUint32(bytes, offset) !== ZIP_LOCAL_FILE_SIGNATURE) {
      contentMismatch("The DOCX archive contains an invalid local entry");
    }
    const localFlags = readUint16(bytes, offset + 6);
    const localMethod = readUint16(bytes, offset + 8);
    const localCrc32 = readUint32(bytes, offset + 14);
    const localCompressedSize = readUint32(bytes, offset + 18);
    const localExpandedSize = readUint32(bytes, offset + 22);
    const localNameLength = readUint16(bytes, offset + 26);
    const localExtraLength = readUint16(bytes, offset + 28);
    const localName = bytes.slice(offset + 30, offset + 30 + localNameLength);
    validateZipExtraFields(bytes, offset + 30 + localNameLength, localExtraLength);
    const usesDescriptor = (entry.flags & 0x0008) !== 0;
    if (
      localFlags !== entry.flags
      || localMethod !== entry.method
      || !byteSlicesEqual(localName, entry.nameBytes)
      || (!usesDescriptor && (
        localCrc32 !== entry.crc32
        || localCompressedSize !== entry.compressedSize
        || localExpandedSize !== entry.expandedSize
      ))
      || localCompressedSize === 0xffff_ffff
      || localExpandedSize === 0xffff_ffff
    ) contentMismatch("The DOCX archive local and central entries disagree");
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    let dataEnd = dataStart + entry.compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset) contentMismatch("The DOCX archive entry overlaps its directory");
    if (usesDescriptor) {
      // Unsigned descriptors are ambiguous to validate without decompressing.
      // Require the canonical signature and exact 32-bit sizes; ZIP64 is
      // intentionally unsupported by the product boundary.
      if (dataEnd + 16 > centralOffset || readUint32(bytes, dataEnd) !== ZIP_DATA_DESCRIPTOR_SIGNATURE) {
        contentMismatch("The DOCX archive uses an unsupported data descriptor");
      }
      if (
        readUint32(bytes, dataEnd + 4) !== entry.crc32
        || readUint32(bytes, dataEnd + 8) !== entry.compressedSize
        || readUint32(bytes, dataEnd + 12) !== entry.expandedSize
      ) contentMismatch("The DOCX archive data descriptor is inconsistent");
      dataEnd += 16;
    }
    regions.push({ start: offset, end: dataEnd, dataStart, entry });
  }
  regions.sort((left, right) => left.start - right.start);
  let expectedOffset = 0;
  for (const region of regions) {
    if (region.start !== expectedOffset || region.end < region.start) {
      contentMismatch("The DOCX archive contains overlapping or hidden local data");
    }
    expectedOffset = region.end;
  }
  if (expectedOffset !== centralOffset) contentMismatch("The DOCX archive contains unindexed local data");

  let actualExpandedTotal = 0;
  for (const region of regions) {
    if (region.entry.directory) {
      if (region.entry.crc32 !== 0) contentMismatch("The DOCX archive contains a malformed directory checksum");
      continue;
    }
    const remainingExpandedBytes = DOCX_MAX_TOTAL_EXPANDED_BYTES - actualExpandedTotal;
    const expanded = expandedDocxEntry(
      bytes,
      region.entry,
      region.dataStart,
      Math.min(DOCX_MAX_ENTRY_EXPANDED_BYTES, remainingExpandedBytes),
    );
    actualExpandedTotal += expanded.byteLength;
    if (actualExpandedTotal > DOCX_MAX_TOTAL_EXPANDED_BYTES) contentMismatch("The DOCX archive expands beyond the supported limit");
    if (DOCX_REQUIRED_ENTRIES.has(region.entry.name)) inspectRequiredDocxXml(region.entry.name, expanded);
  }
}

function skipPdfWhitespaceAndComments(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length) {
    if (/[\u0000\t\n\f\r ]/.test(value[cursor]!)) {
      cursor += 1;
      continue;
    }
    if (value[cursor] !== "%") break;
    cursor += 1;
    while (cursor < value.length && value[cursor] !== "\r" && value[cursor] !== "\n") cursor += 1;
  }
  return cursor;
}

type PdfValue =
  | Readonly<{ kind: "array"; values: readonly PdfValue[] }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "dictionary"; entries: ReadonlyMap<string, PdfValue> }>
  | Readonly<{ kind: "name"; value: string }>
  | Readonly<{ kind: "null" }>
  | Readonly<{ kind: "number"; value: number }>
  | Readonly<{ kind: "reference"; objectNumber: number; generation: number }>
  | Readonly<{ kind: "string" }>;

type PdfValueParser = {
  source: string;
  cursor: number;
  limit: number;
  tokens: number;
};

type PdfEncodedStreamSpan = Readonly<{ start: number; end: number }>;

type PdfXrefContext = {
  size: number;
  entryKinds: Uint8Array;
  field2: Float64Array;
  field3: Uint32Array;
  requiresCompleteClassicMap: boolean;
  root: Readonly<{ objectNumber: number; generation: number }> | null;
  totalEntries: number;
  decodedStreamBytes: number;
  encodedStreamSpans: PdfEncodedStreamSpan[];
  sections: number;
  visitedOffsets: Set<number>;
};

type PdfXrefSection = Readonly<{
  context: PdfXrefContext;
  endOffset: number;
  prevOffset: number | null;
}>;

type PdfLinearizedTopology = Readonly<{
  earlyXrefOffset: number;
  endFirstPageOffset: number;
  firstPageObject: number;
  length: number;
  mainXrefCandidates: readonly [number, number];
}>;

type PdfXrefTraversalBudget = {
  classicSourceBytes: number;
};

type PdfObjectStreamInspection = Readonly<{
  objectNumbers: Uint32Array;
  capturedValue: PdfValue | null;
}>;

function isPdfDelimiter(value: string): boolean {
  return /[()<>\[\]{}/%]/.test(value);
}

function isPdfTokenBoundary(value: string | undefined): boolean {
  return value === undefined || /[\u0000\t\n\f\r ]/.test(value) || isPdfDelimiter(value);
}

function pdfParserSkip(parser: PdfValueParser): void {
  parser.cursor = skipPdfWhitespaceAndComments(parser.source, parser.cursor);
  if (parser.cursor > parser.limit) contentMismatch("The PDF contains an overlong cross-reference dictionary");
}

function pdfParserToken(parser: PdfValueParser): void {
  parser.tokens += 1;
  if (parser.tokens > PDF_MAX_VALUE_TOKENS) contentMismatch("The PDF cross-reference dictionary is too complex");
}

function parsePdfName(parser: PdfValueParser): string {
  if (parser.source[parser.cursor] !== "/") contentMismatch("The PDF dictionary contains an invalid name");
  parser.cursor += 1;
  let decoded = "";
  while (parser.cursor < parser.limit) {
    const value = parser.source[parser.cursor]!;
    if (isPdfTokenBoundary(value)) break;
    if (value === "#") {
      const escaped = parser.source.slice(parser.cursor + 1, parser.cursor + 3);
      if (!/^[0-9a-f]{2}$/i.test(escaped)) contentMismatch("The PDF dictionary contains a malformed escaped name");
      decoded += String.fromCharCode(Number.parseInt(escaped, 16));
      parser.cursor += 3;
    } else {
      decoded += value;
      parser.cursor += 1;
    }
    if (decoded.length > 256) contentMismatch("The PDF dictionary contains an overlong name");
  }
  if (!decoded) contentMismatch("The PDF dictionary contains an empty name");
  return decoded;
}

function parsePdfNumberToken(parser: PdfValueParser): { value: number; integer: boolean; end: number } | null {
  const token = /[+-]?(?:\d+\.\d*|\.\d+|\d+)/y;
  token.lastIndex = parser.cursor;
  const match = token.exec(parser.source);
  if (!match || token.lastIndex > parser.limit || !isPdfTokenBoundary(parser.source[token.lastIndex])) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) contentMismatch("The PDF dictionary contains an invalid number");
  return { value, integer: /^[+-]?\d+$/.test(match[0]), end: token.lastIndex };
}

function skipPdfLiteralString(parser: PdfValueParser): void {
  parser.cursor += 1;
  let depth = 1;
  while (parser.cursor < parser.limit) {
    const value = parser.source[parser.cursor]!;
    parser.cursor += 1;
    if (value === "\\") {
      if (parser.cursor >= parser.limit) break;
      const escaped = parser.source[parser.cursor]!;
      parser.cursor += 1;
      if (escaped === "\r" && parser.source[parser.cursor] === "\n") parser.cursor += 1;
      else if (/[0-7]/.test(escaped)) {
        for (let count = 1; count < 3 && /[0-7]/.test(parser.source[parser.cursor] ?? ""); count += 1) parser.cursor += 1;
      }
      continue;
    }
    if (value === "(") depth += 1;
    else if (value === ")") {
      depth -= 1;
      if (depth === 0) return;
    }
    if (depth > PDF_MAX_VALUE_DEPTH) contentMismatch("The PDF dictionary contains an over-nested string");
  }
  contentMismatch("The PDF dictionary contains a truncated string");
}

function skipPdfHexString(parser: PdfValueParser): void {
  parser.cursor += 1;
  while (parser.cursor < parser.limit) {
    const value = parser.source[parser.cursor]!;
    parser.cursor += 1;
    if (value === ">") return;
    if (/[\u0000\t\n\f\r ]/.test(value)) continue;
    if (!/[0-9a-f]/i.test(value)) contentMismatch("The PDF dictionary contains a malformed hexadecimal string");
  }
  contentMismatch("The PDF dictionary contains a truncated hexadecimal string");
}

function parsePdfValue(parser: PdfValueParser, depth = 0): PdfValue {
  if (depth > PDF_MAX_VALUE_DEPTH) contentMismatch("The PDF cross-reference dictionary is nested too deeply");
  pdfParserSkip(parser);
  if (parser.cursor >= parser.limit) contentMismatch("The PDF cross-reference dictionary is truncated");
  pdfParserToken(parser);
  const value = parser.source[parser.cursor]!;
  if (value === "/") return { kind: "name", value: parsePdfName(parser) };
  if (value === "(") {
    skipPdfLiteralString(parser);
    return { kind: "string" };
  }
  if (value === "<" && parser.source[parser.cursor + 1] !== "<") {
    skipPdfHexString(parser);
    return { kind: "string" };
  }
  if (value === "[") {
    parser.cursor += 1;
    const values: PdfValue[] = [];
    while (true) {
      pdfParserSkip(parser);
      if (parser.source[parser.cursor] === "]") {
        parser.cursor += 1;
        return { kind: "array", values };
      }
      values.push(parsePdfValue(parser, depth + 1));
    }
  }
  if (value === "<" && parser.source[parser.cursor + 1] === "<") {
    parser.cursor += 2;
    const entries = new Map<string, PdfValue>();
    while (true) {
      pdfParserSkip(parser);
      if (parser.source.startsWith(">>", parser.cursor)) {
        parser.cursor += 2;
        return { kind: "dictionary", entries };
      }
      pdfParserToken(parser);
      const key = parsePdfName(parser);
      if (entries.has(key)) contentMismatch("The PDF dictionary contains a duplicate key");
      entries.set(key, parsePdfValue(parser, depth + 1));
    }
  }

  const number = parsePdfNumberToken(parser);
  if (number) {
    parser.cursor = number.end;
    if (number.integer && Number.isSafeInteger(number.value) && number.value >= 0) {
      const afterFirst = parser.cursor;
      pdfParserSkip(parser);
      const second = parsePdfNumberToken(parser);
      if (second?.integer && Number.isSafeInteger(second.value) && second.value >= 0) {
        parser.cursor = second.end;
        pdfParserSkip(parser);
        if (parser.source[parser.cursor] === "R" && isPdfTokenBoundary(parser.source[parser.cursor + 1])) {
          parser.cursor += 1;
          return { kind: "reference", objectNumber: number.value, generation: second.value };
        }
      }
      parser.cursor = afterFirst;
    }
    return { kind: "number", value: number.value };
  }

  for (const keyword of ["true", "false", "null"] as const) {
    if (parser.source.startsWith(keyword, parser.cursor) && isPdfTokenBoundary(parser.source[parser.cursor + keyword.length])) {
      parser.cursor += keyword.length;
      return keyword === "null" ? { kind: "null" } : { kind: "boolean", value: keyword === "true" };
    }
  }
  contentMismatch("The PDF dictionary contains an unsupported value");
}

function parsePdfDictionary(
  source: string,
  start: number,
  limit: number,
): { value: Extract<PdfValue, { kind: "dictionary" }>; end: number } {
  const parser: PdfValueParser = { source, cursor: start, limit: Math.min(source.length, limit), tokens: 0 };
  const value = parsePdfValue(parser);
  if (value.kind !== "dictionary") contentMismatch("The PDF cross-reference dictionary is missing");
  if (parser.cursor - start > PDF_MAX_XREF_DICTIONARY_BYTES) {
    contentMismatch("The PDF contains an overlong cross-reference dictionary");
  }
  return { value, end: parser.cursor };
}

function pdfDictionaryInteger(
  dictionary: Extract<PdfValue, { kind: "dictionary" }>,
  key: string,
  required = true,
): number | null {
  const value = dictionary.entries.get(key);
  if (!value) {
    if (required) contentMismatch("The PDF cross-reference dictionary is missing /" + key);
    return null;
  }
  if (value.kind !== "number" || !Number.isSafeInteger(value.value) || value.value < 0) {
    contentMismatch("The PDF cross-reference dictionary has an invalid /" + key);
  }
  return value.value;
}

function pdfDictionaryReference(
  dictionary: Extract<PdfValue, { kind: "dictionary" }>,
  key: string,
): Readonly<{ objectNumber: number; generation: number }> | null {
  const value = dictionary.entries.get(key);
  if (!value) return null;
  if (
    value.kind !== "reference"
    || !Number.isSafeInteger(value.objectNumber)
    || !Number.isSafeInteger(value.generation)
    || value.generation > 65_535
  ) contentMismatch("The PDF cross-reference dictionary has an invalid /" + key);
  return { objectNumber: value.objectNumber, generation: value.generation };
}

function pdfDictionaryName(dictionary: Extract<PdfValue, { kind: "dictionary" }>, key: string): string | null {
  const value = dictionary.entries.get(key);
  if (!value) return null;
  if (value.kind !== "name") contentMismatch("The PDF cross-reference dictionary has an invalid /" + key);
  return value.value;
}

function pdfIntegerArray(value: PdfValue | undefined, label: string): number[] {
  if (!value || value.kind !== "array") contentMismatch("The PDF cross-reference dictionary has an invalid /" + label);
  return value.values.map((entry) => {
    if (entry.kind !== "number" || !Number.isSafeInteger(entry.value) || entry.value < 0) {
      contentMismatch("The PDF cross-reference dictionary has an invalid /" + label);
    }
    return entry.value;
  });
}

function createPdfXrefContext(size: number): PdfXrefContext {
  if (!Number.isSafeInteger(size) || size < 1 || size > PDF_MAX_XREF_ENTRIES) {
    contentMismatch("The PDF cross-reference size exceeds the supported limit");
  }
  return {
    size,
    entryKinds: new Uint8Array(size),
    field2: new Float64Array(size),
    field3: new Uint32Array(size),
    requiresCompleteClassicMap: false,
    root: null,
    totalEntries: 0,
    decodedStreamBytes: 0,
    encodedStreamSpans: [],
    sections: 0,
    visitedOffsets: new Set<number>(),
  };
}

function preparePdfXrefContext(
  context: PdfXrefContext | null,
  size: number,
  root: Readonly<{ objectNumber: number; generation: number }> | null,
): PdfXrefContext {
  const resolved = context ?? createPdfXrefContext(size);
  if (size < 1 || size > resolved.size) contentMismatch("The PDF cross-reference revisions have inconsistent sizes");
  if (root && root.objectNumber >= resolved.size) contentMismatch("The PDF document root is outside the cross-reference size");
  if (!resolved.root && root) resolved.root = root;
  return resolved;
}

function chargePdfDecodedStream(context: PdfXrefContext, byteLength: number): void {
  context.decodedStreamBytes += byteLength;
  if (
    !Number.isSafeInteger(context.decodedStreamBytes)
    || context.decodedStreamBytes > PDF_MAX_TOTAL_DECODED_STREAM_BYTES
  ) contentMismatch("The PDF streams exceed the supported aggregate decoded size");
}

function recordPdfEncodedStreamSpan(context: PdfXrefContext, start: number, end: number): void {
  if (
    start < 0
    || end <= start
    || end > MAX_DOCUMENT_BYTES
  ) contentMismatch("The PDF contains overlapping or invalid encoded stream spans");
  context.encodedStreamSpans.push({ start, end });
}

function buildPdfEncodedStreamSpanIndex(spans: readonly PdfEncodedStreamSpan[]): PdfEncodedStreamSpan[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const index: PdfEncodedStreamSpan[] = [];
  for (const span of sorted) {
    const previous = index[index.length - 1];
    if (previous && span.start < previous.end) {
      contentMismatch("The PDF contains overlapping or invalid encoded stream spans");
    }
    if (previous && span.start === previous.end) {
      index[index.length - 1] = { start: previous.start, end: span.end };
    } else {
      index.push(span);
    }
  }
  return index;
}

function pdfOffsetInsideEncodedStream(spans: readonly PdfEncodedStreamSpan[], offset: number): boolean {
  let lower = 0;
  let upper = spans.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (spans[middle]!.start <= offset) lower = middle + 1;
    else upper = middle;
  }
  const candidate = spans[lower - 1];
  return Boolean(candidate && offset < candidate.end);
}

function inspectPdfObjectHeader(
  bytes: Uint8Array,
  objectOffset: number,
  upperBound: number,
  objectNumber: number,
  generation: number,
): void {
  if (!Number.isSafeInteger(objectOffset) || objectOffset < 9 || objectOffset >= upperBound) {
    contentMismatch("The PDF cross-reference entry points outside the object body");
  }
  const objectHeader = new TextDecoder("latin1").decode(bytes.subarray(objectOffset, Math.min(bytes.byteLength, objectOffset + 96)));
  const parsed = /^(\d+)[\t\n\f\r ]+(\d+)[\t\n\f\r ]+obj\b/.exec(objectHeader);
  if (!parsed || Number(parsed[1]) !== objectNumber || Number(parsed[2]) !== generation) {
    contentMismatch("The PDF cross-reference entry does not match its object header");
  }
}

function mergePdfXrefEntry(
  context: PdfXrefContext,
  bytes: Uint8Array,
  sectionSize: number,
  upperBound: number,
  objectNumber: number,
  type: number,
  field2: number,
  field3: number,
): void {
  context.totalEntries += 1;
  if (
    context.totalEntries > PDF_MAX_XREF_ENTRIES
    || objectNumber < 0
    || objectNumber >= sectionSize
    || objectNumber >= context.size
    || !Number.isSafeInteger(field2)
    || !Number.isSafeInteger(field3)
  ) contentMismatch("The PDF cross-reference records exceed the supported limit");
  if (type === 0) {
    if (field2 >= sectionSize || field3 > 65_535) contentMismatch("The PDF contains an invalid free cross-reference record");
  } else if (type === 1) {
    if (field3 > 65_535) contentMismatch("The PDF contains an invalid in-use cross-reference record");
    inspectPdfObjectHeader(bytes, field2, upperBound, objectNumber, field3);
  } else if (type === 2) {
    if (field2 >= sectionSize || field3 >= PDF_MAX_XREF_ENTRIES) {
      contentMismatch("The PDF contains an invalid compressed-object cross-reference record");
    }
  } else {
    contentMismatch("The PDF cross-reference stream contains an unsupported record type");
  }
  if (context.entryKinds[objectNumber] === 0) {
    context.entryKinds[objectNumber] = type + 1;
    context.field2[objectNumber] = field2;
    context.field3[objectNumber] = field3;
  }
}

function readPdfXrefField(bytes: Uint8Array, offset: number, width: number, defaultValue: number): number {
  if (width === 0) return defaultValue;
  let value = BigInt(0);
  for (let index = 0; index < width; index += 1) value = (value << BigInt(8)) | BigInt(bytes[offset + index]!);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) contentMismatch("The PDF cross-reference stream contains an oversized field");
  return Number(value);
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function reversePdfPngPredictor(encoded: Uint8Array, rows: number, columns: number): Uint8Array {
  const expected = rows * (columns + 1);
  if (!Number.isSafeInteger(expected) || encoded.byteLength !== expected) {
    contentMismatch("The PDF cross-reference predictor output has the wrong size");
  }
  const decoded = new Uint8Array(rows * columns);
  let source = 0;
  for (let row = 0; row < rows; row += 1) {
    const filter = encoded[source++]!;
    if (filter > 4) contentMismatch("The PDF cross-reference stream uses an invalid PNG predictor row");
    const rowStart = row * columns;
    for (let column = 0; column < columns; column += 1) {
      const left = column === 0 ? 0 : decoded[rowStart + column - 1]!;
      const up = row === 0 ? 0 : decoded[rowStart - columns + column]!;
      const upperLeft = row === 0 || column === 0 ? 0 : decoded[rowStart - columns + column - 1]!;
      const predicted = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paethPredictor(left, up, upperLeft);
      decoded[rowStart + column] = (encoded[source++]! + predicted) & 0xff;
    }
  }
  return decoded;
}

function decodePdfXrefStream(
  streamBytes: Uint8Array,
  dictionary: Extract<PdfValue, { kind: "dictionary" }>,
  recordCount: number,
  recordWidth: number,
): Uint8Array {
  if (dictionary.entries.has("F")) contentMismatch("External PDF cross-reference streams are not supported");
  const filterValue = dictionary.entries.get("Filter");
  const filters: string[] = [];
  if (filterValue?.kind === "name") {
    filters.push(filterValue.value);
  } else if (filterValue?.kind === "array") {
    for (const entry of filterValue.values) {
      if (entry.kind !== "name") contentMismatch("The PDF cross-reference stream uses an unsupported filter");
      filters.push(entry.value);
    }
  } else if (filterValue) {
    contentMismatch("The PDF cross-reference stream uses an unsupported filter");
  }
  if (filters.length > 1 || (filters.length === 1 && filters[0] !== "FlateDecode")) {
    contentMismatch("The PDF cross-reference stream uses an unsupported filter");
  }

  let decodeParameters: Extract<PdfValue, { kind: "dictionary" }> | null = null;
  const parameterValue = dictionary.entries.get("DecodeParms");
  if (parameterValue) {
    const resolved = parameterValue.kind === "array" && parameterValue.values.length === 1
      ? parameterValue.values[0]
      : parameterValue;
    if (resolved?.kind === "dictionary") decodeParameters = resolved;
    else if (resolved?.kind !== "null") contentMismatch("The PDF cross-reference stream has invalid decode parameters");
  }
  if (filters.length === 0 && decodeParameters) {
    contentMismatch("The PDF cross-reference stream has decode parameters without a filter");
  }

  const predictor = decodeParameters ? pdfDictionaryInteger(decodeParameters, "Predictor", false) ?? 1 : 1;
  const columns = decodeParameters ? pdfDictionaryInteger(decodeParameters, "Columns", false) ?? 1 : recordWidth;
  const colors = decodeParameters ? pdfDictionaryInteger(decodeParameters, "Colors", false) ?? 1 : 1;
  const bits = decodeParameters ? pdfDictionaryInteger(decodeParameters, "BitsPerComponent", false) ?? 8 : 8;
  if (
    columns !== recordWidth
    || colors !== 1
    || bits !== 8
    || (predictor !== 1 && predictor !== 2 && (predictor < 10 || predictor > 15))
  ) contentMismatch("The PDF cross-reference stream uses unsupported predictor parameters");

  const predictedLength = predictor >= 10 ? recordCount * (recordWidth + 1) : recordCount * recordWidth;
  if (!Number.isSafeInteger(predictedLength) || predictedLength < 1 || predictedLength > MAX_DOCUMENT_BYTES) {
    contentMismatch("The PDF cross-reference stream exceeds the supported decoded size");
  }
  let predicted: Uint8Array;
  if (filters.length === 0) {
    predicted = streamBytes;
  } else {
    try {
      const result = inflateSync(
        streamBytes,
        { info: true, maxOutputLength: predictedLength + 1 },
      ) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
      if (result.engine.bytesWritten !== streamBytes.byteLength) {
        contentMismatch("The PDF cross-reference stream contains trailing compressed data");
      }
      predicted = Uint8Array.from(result.buffer);
    } catch (error) {
      if (error instanceof DocumentSecurityError) throw error;
      contentMismatch("The PDF cross-reference stream could not be decoded within the supported limit");
    }
  }
  if (predictor === 1) {
    if (predicted.byteLength !== recordCount * recordWidth) {
      contentMismatch("The PDF cross-reference stream record size is inconsistent");
    }
    return predicted;
  }
  if (predictor === 2) {
    if (predicted.byteLength !== recordCount * recordWidth) {
      contentMismatch("The PDF cross-reference predictor output has the wrong size");
    }
    const decoded = Uint8Array.from(predicted);
    for (let row = 0; row < recordCount; row += 1) {
      const start = row * recordWidth;
      for (let column = 1; column < recordWidth; column += 1) {
        decoded[start + column] = (decoded[start + column]! + decoded[start + column - 1]!) & 0xff;
      }
    }
    return decoded;
  }
  return reversePdfPngPredictor(predicted, recordCount, recordWidth);
}

function parsePdfXrefRanges(
  dictionary: Extract<PdfValue, { kind: "dictionary" }>,
  size: number,
): Array<Readonly<{ first: number; count: number }>> {
  const indexValue = dictionary.entries.get("Index");
  const index = indexValue ? pdfIntegerArray(indexValue, "Index") : [0, size];
  if (index.length === 0 || index.length % 2 !== 0) {
    contentMismatch("The PDF cross-reference stream has an invalid /Index");
  }
  const ranges: Array<Readonly<{ first: number; count: number }>> = [];
  let total = 0;
  let previousEnd = 0;
  for (let cursor = 0; cursor < index.length; cursor += 2) {
    const first = index[cursor]!;
    const count = index[cursor + 1]!;
    if (count < 1 || first < previousEnd || first + count > size || total + count > PDF_MAX_XREF_ENTRIES) {
      contentMismatch("The PDF cross-reference stream has invalid or overlapping index ranges");
    }
    ranges.push({ first, count });
    previousEnd = first + count;
    total += count;
  }
  return ranges;
}

function parseBoundedPdfXrefStream(
  bytes: Uint8Array,
  xrefOffset: number,
  upperBound: number,
  existingContext: PdfXrefContext | null,
): PdfXrefSection {
  const prefixEnd = Math.min(upperBound, xrefOffset + PDF_MAX_XREF_DICTIONARY_BYTES + 256);
  const source = new TextDecoder("latin1").decode(bytes.subarray(xrefOffset, prefixEnd));
  const object = /^(\d+)[\t\n\f\r ]+(\d+)[\t\n\f\r ]+obj\b/.exec(source);
  if (!object) contentMismatch("The PDF trailer does not reference a cross-reference stream object");
  const objectNumber = Number(object[1]);
  const generation = Number(object[2]);
  if (!Number.isSafeInteger(objectNumber) || !Number.isSafeInteger(generation) || generation > 65_535) {
    contentMismatch("The PDF cross-reference stream object header is invalid");
  }
  const dictionaryStart = skipPdfWhitespaceAndComments(source, object[0].length);
  if (!source.startsWith("<<", dictionaryStart)) contentMismatch("The PDF cross-reference stream dictionary is missing");
  const parsed = parsePdfDictionary(source, dictionaryStart, dictionaryStart + PDF_MAX_XREF_DICTIONARY_BYTES);
  const dictionary = parsed.value;
  if (pdfDictionaryName(dictionary, "Type") !== "XRef") contentMismatch("The PDF object is not a cross-reference stream");
  if (dictionary.entries.has("XRefStm")) contentMismatch("Hybrid PDF cross-reference structures are not supported");
  const size = pdfDictionaryInteger(dictionary, "Size")!;
  const root = pdfDictionaryReference(dictionary, "Root");
  const prevOffset = pdfDictionaryInteger(dictionary, "Prev", false);
  const context = preparePdfXrefContext(existingContext, size, root);
  if (objectNumber >= size) contentMismatch("The PDF cross-reference stream object is outside /Size");

  const widths = pdfIntegerArray(dictionary.entries.get("W"), "W");
  if (
    widths.length !== 3
    || widths.some((width) => width > PDF_MAX_XREF_FIELD_BYTES)
    || widths.reduce((total, width) => total + width, 0) < 1
  ) contentMismatch("The PDF cross-reference stream has invalid field widths");
  const recordWidth = widths[0]! + widths[1]! + widths[2]!;
  const ranges = parsePdfXrefRanges(dictionary, size);
  const recordCount = ranges.reduce((total, range) => total + range.count, 0);
  const streamLength = pdfDictionaryInteger(dictionary, "Length")!;

  let cursor = skipPdfWhitespaceAndComments(source, parsed.end);
  if (!source.startsWith("stream", cursor) || !isPdfTokenBoundary(source[cursor + 6])) {
    contentMismatch("The PDF cross-reference stream marker is missing");
  }
  cursor += 6;
  let streamDataStart: number;
  if (source.startsWith("\r\n", cursor)) streamDataStart = cursor + 2;
  else if (source[cursor] === "\n" || source[cursor] === "\r") streamDataStart = cursor + 1;
  else contentMismatch("The PDF cross-reference stream marker is not followed by an end-of-line");
  const absoluteDataStart = xrefOffset + streamDataStart;
  const absoluteDataEnd = absoluteDataStart + streamLength;
  if (!Number.isSafeInteger(absoluteDataEnd) || streamLength < 1 || absoluteDataEnd > upperBound) {
    contentMismatch("The PDF cross-reference stream /Length is invalid");
  }
  recordPdfEncodedStreamSpan(context, absoluteDataStart, absoluteDataEnd);
  const decoded = decodePdfXrefStream(
    bytes.subarray(absoluteDataStart, absoluteDataEnd),
    dictionary,
    recordCount,
    recordWidth,
  );
  chargePdfDecodedStream(context, decoded.byteLength);

  let endCursor = absoluteDataEnd;
  if (bytes[endCursor] === 0x0d && bytes[endCursor + 1] === 0x0a) endCursor += 2;
  else if (bytes[endCursor] === 0x0a || bytes[endCursor] === 0x0d) endCursor += 1;
  else contentMismatch("The PDF cross-reference stream data is not followed by an end-of-line");
  const ending = new TextDecoder("latin1").decode(bytes.subarray(endCursor, Math.min(upperBound, endCursor + 256)));
  if (!ending.startsWith("endstream") || !isPdfTokenBoundary(ending[9])) {
    contentMismatch("The PDF cross-reference stream has a mismatched /Length");
  }
  const endingCursor = skipPdfWhitespaceAndComments(ending, 9);
  if (!ending.startsWith("endobj", endingCursor) || !isPdfTokenBoundary(ending[endingCursor + 6])) {
    contentMismatch("The PDF cross-reference stream object is incomplete");
  }
  const endOffset = endCursor + endingCursor + 6;

  let decodedCursor = 0;
  let selfEntry = false;
  for (const range of ranges) {
    for (let index = 0; index < range.count; index += 1) {
      const type = readPdfXrefField(decoded, decodedCursor, widths[0]!, 1);
      decodedCursor += widths[0]!;
      const field2 = readPdfXrefField(decoded, decodedCursor, widths[1]!, 0);
      decodedCursor += widths[1]!;
      const field3 = readPdfXrefField(decoded, decodedCursor, widths[2]!, 0);
      decodedCursor += widths[2]!;
      const currentObject = range.first + index;
      if (
        currentObject === 0
        && (type !== 0 || (field3 !== 0 && field3 !== 65_535))
      ) contentMismatch("The PDF cross-reference stream has an invalid object-zero entry");
      if (currentObject === objectNumber && type === 1 && field2 === xrefOffset && field3 === generation) selfEntry = true;
      mergePdfXrefEntry(context, bytes, size, upperBound, currentObject, type, field2, field3);
    }
  }
  if (decodedCursor !== decoded.byteLength || !selfEntry) {
    contentMismatch("The PDF cross-reference stream is missing its exact self-entry");
  }
  return { context, endOffset, prevOffset };
}

function scanBoundedClassicPdfXref(
  source: string,
  onEntry?: (objectNumber: number, type: number, field2: number, field3: number) => void,
): {
  dictionaryStart: number;
  firstObject: number | null;
  lastObjectEnd: number;
  objectZero: Readonly<{ type: number; field2: number; field3: number }> | null;
  totalEntries: number;
} {
  let cursor = skipPdfWhitespaceAndComments(source, 0);
  if (!source.startsWith("xref", cursor) || !isPdfTokenBoundary(source[cursor + 4])) {
    contentMismatch("The PDF trailer does not reference a cross-reference table");
  }
  cursor += 4;
  let totalEntries = 0;
  let previousEnd = 0;
  let firstObjectNumber: number | null = null;
  let objectZero: Readonly<{ type: number; field2: number; field3: number }> | null = null;
  const subsectionPattern = /(\d+)[\t ]+(\d+)[\t ]*(?:\r\n|\r|\n)/y;
  const entryPattern = /(\d{10})[\t ](\d{5})[\t ]([fn])[\t ]*(?:\r\n|\r|\n)/y;
  while (cursor < source.length) {
    cursor = skipPdfWhitespaceAndComments(source, cursor);
    if (source.startsWith("trailer", cursor) && isPdfTokenBoundary(source[cursor + 7])) {
      return {
        dictionaryStart: skipPdfWhitespaceAndComments(source, cursor + 7),
        firstObject: firstObjectNumber,
        lastObjectEnd: previousEnd,
        objectZero,
        totalEntries,
      };
    }
    subsectionPattern.lastIndex = cursor;
    const subsection = subsectionPattern.exec(source);
    if (!subsection) contentMismatch("The PDF cross-reference table is malformed");
    const firstObject = Number(subsection[1]);
    const count = Number(subsection[2]);
    if (
      !Number.isSafeInteger(firstObject)
      || !Number.isSafeInteger(count)
      || count < 1
      || firstObject < previousEnd
      || firstObject + count > Number.MAX_SAFE_INTEGER
      || totalEntries + count > PDF_MAX_XREF_ENTRIES
    ) contentMismatch("The PDF cross-reference table exceeds the supported limit");
    if (firstObjectNumber === null) firstObjectNumber = firstObject;
    previousEnd = firstObject + count;
    totalEntries += count;
    cursor = subsectionPattern.lastIndex;
    for (let index = 0; index < count; index += 1) {
      entryPattern.lastIndex = cursor;
      const entry = entryPattern.exec(source);
      if (!entry) contentMismatch("The PDF cross-reference table contains a malformed entry");
      cursor = entryPattern.lastIndex;
      const objectNumber = firstObject + index;
      const type = entry[3] === "n" ? 1 : 0;
      const field2 = Number(entry[1]);
      const field3 = Number(entry[2]);
      if (objectNumber === 0) objectZero = { type, field2, field3 };
      onEntry?.(
        objectNumber,
        type,
        field2,
        field3,
      );
    }
  }
  contentMismatch("The PDF cross-reference table has no trailer dictionary");
}

function parseBoundedClassicPdfXref(
  bytes: Uint8Array,
  xrefOffset: number,
  upperBound: number,
  existingContext: PdfXrefContext | null,
  allowSplitLinearizedBase: boolean,
): PdfXrefSection {
  const source = new TextDecoder("latin1").decode(bytes.subarray(xrefOffset, upperBound));
  const firstPass = scanBoundedClassicPdfXref(source);
  const parsed = parsePdfDictionary(
    source,
    firstPass.dictionaryStart,
    firstPass.dictionaryStart + PDF_MAX_XREF_DICTIONARY_BYTES,
  );
  const dictionary = parsed.value;
  if (dictionary.entries.has("XRefStm")) contentMismatch("Hybrid PDF cross-reference structures are not supported");
  const size = pdfDictionaryInteger(dictionary, "Size")!;
  const root = pdfDictionaryReference(dictionary, "Root");
  const prevOffset = pdfDictionaryInteger(dictionary, "Prev", false);
  const context = preparePdfXrefContext(existingContext, size, root);
  if (prevOffset === null) {
    context.requiresCompleteClassicMap = true;
    if (
      (!firstPass.objectZero && !allowSplitLinearizedBase)
      || (firstPass.objectZero
        && (firstPass.objectZero.type !== 0 || firstPass.objectZero.field3 !== 65_535))
    ) contentMismatch("The PDF base cross-reference table has an invalid object-zero entry");
  }
  scanBoundedClassicPdfXref(source, (objectNumber, type, field2, field3) => {
    mergePdfXrefEntry(context, bytes, size, upperBound, objectNumber, type, field2, field3);
  });
  if (firstPass.totalEntries < 1) contentMismatch("The PDF cross-reference table is empty");
  return { context, endOffset: xrefOffset + parsed.end, prevOffset };
}

function inspectPdfDictionaryObject(
  bytes: Uint8Array,
  objectOffset: number,
  objectNumber: number,
  generation: number,
): { dictionary: Extract<PdfValue, { kind: "dictionary" }>; source: string; end: number } {
  const source = new TextDecoder("latin1").decode(bytes.subarray(
    objectOffset,
    Math.min(bytes.byteLength, objectOffset + PDF_MAX_XREF_DICTIONARY_BYTES + 256),
  ));
  const header = /^(\d+)[\t\n\f\r ]+(\d+)[\t\n\f\r ]+obj\b/.exec(source);
  if (!header || Number(header[1]) !== objectNumber || Number(header[2]) !== generation) {
    contentMismatch("The PDF object does not match its effective cross-reference entry");
  }
  const start = skipPdfWhitespaceAndComments(source, header[0].length);
  const parsed = parsePdfDictionary(source, start, start + PDF_MAX_XREF_DICTIONARY_BYTES);
  return { dictionary: parsed.value, source, end: parsed.end };
}

function inspectPdfObjectStream(
  bytes: Uint8Array,
  context: PdfXrefContext,
  streamObjectNumber: number,
  capturedObjectNumber: number,
): PdfObjectStreamInspection {
  const objectOffset = context.field2[streamObjectNumber]!;
  const parsed = inspectPdfDictionaryObject(bytes, objectOffset, streamObjectNumber, 0);
  if (pdfDictionaryName(parsed.dictionary, "Type") !== "ObjStm") {
    contentMismatch("A compressed PDF object references a non-object-stream object");
  }
  if (parsed.dictionary.entries.has("F")) contentMismatch("External PDF object streams are not supported");
  const objectCount = pdfDictionaryInteger(parsed.dictionary, "N")!;
  const first = pdfDictionaryInteger(parsed.dictionary, "First")!;
  const streamLength = pdfDictionaryInteger(parsed.dictionary, "Length")!;
  if (objectCount < 1 || objectCount > PDF_MAX_OBJECTS_PER_STREAM || first < 1 || streamLength < 1) {
    contentMismatch("A PDF object stream has an invalid bounded header");
  }

  const filterValue = parsed.dictionary.entries.get("Filter");
  const filters: string[] = [];
  if (filterValue?.kind === "name") {
    filters.push(filterValue.value);
  } else if (filterValue?.kind === "array") {
    for (const entry of filterValue.values) {
      if (entry.kind !== "name") contentMismatch("The PDF object stream uses an unsupported filter");
      filters.push(entry.value);
    }
  } else if (filterValue) {
    contentMismatch("The PDF object stream uses an unsupported filter");
  }
  if (filters.length > 1 || (filters.length === 1 && filters[0] !== "FlateDecode")) {
    contentMismatch("The PDF object stream uses an unsupported filter");
  }
  const decodeParameters = parsed.dictionary.entries.get("DecodeParms");
  const resolvedParameters = decodeParameters?.kind === "array" && decodeParameters.values.length === 1
    ? decodeParameters.values[0]
    : decodeParameters;
  if (resolvedParameters && resolvedParameters.kind !== "null") {
    contentMismatch("The PDF object stream uses unsupported decode parameters");
  }

  let marker = skipPdfWhitespaceAndComments(parsed.source, parsed.end);
  if (!parsed.source.startsWith("stream", marker) || !isPdfTokenBoundary(parsed.source[marker + 6])) {
    contentMismatch("The PDF object stream marker is missing");
  }
  marker += 6;
  let relativeDataStart: number;
  if (parsed.source.startsWith("\r\n", marker)) relativeDataStart = marker + 2;
  else if (parsed.source[marker] === "\n" || parsed.source[marker] === "\r") relativeDataStart = marker + 1;
  else contentMismatch("The PDF object stream marker is not followed by an end-of-line");
  const dataStart = objectOffset + relativeDataStart;
  const dataEnd = dataStart + streamLength;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.byteLength) {
    contentMismatch("The PDF object stream /Length is invalid");
  }
  recordPdfEncodedStreamSpan(context, dataStart, dataEnd);
  const encoded = bytes.subarray(dataStart, dataEnd);
  let decoded: Uint8Array;
  if (filters.length === 0) {
    decoded = encoded;
  } else {
    try {
      const result = inflateSync(
        encoded,
        { info: true, maxOutputLength: MAX_DOCUMENT_BYTES + 1 },
      ) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
      if (result.engine.bytesWritten !== encoded.byteLength) {
        contentMismatch("The PDF object stream contains trailing compressed data");
      }
      decoded = Uint8Array.from(result.buffer);
    } catch (error) {
      if (error instanceof DocumentSecurityError) throw error;
      contentMismatch("The PDF object stream could not be decoded within the supported limit");
    }
  }
  if (decoded.byteLength > MAX_DOCUMENT_BYTES || first >= decoded.byteLength) {
    contentMismatch("The PDF object stream exceeds the supported decoded size");
  }
  chargePdfDecodedStream(context, decoded.byteLength);

  let endingOffset = dataEnd;
  if (bytes[endingOffset] === 0x0d && bytes[endingOffset + 1] === 0x0a) endingOffset += 2;
  else if (bytes[endingOffset] === 0x0a || bytes[endingOffset] === 0x0d) endingOffset += 1;
  else contentMismatch("The PDF object stream data is not followed by an end-of-line");
  const ending = new TextDecoder("latin1").decode(bytes.subarray(endingOffset, Math.min(bytes.byteLength, endingOffset + 256)));
  if (!ending.startsWith("endstream") || !isPdfTokenBoundary(ending[9])) {
    contentMismatch("The PDF object stream has a mismatched /Length");
  }
  const endStream = skipPdfWhitespaceAndComments(ending, 9);
  if (!ending.startsWith("endobj", endStream) || !isPdfTokenBoundary(ending[endStream + 6])) {
    contentMismatch("The PDF object stream object is incomplete");
  }

  const header = new TextDecoder("latin1").decode(decoded.subarray(0, first));
  const objectNumbers = new Uint32Array(objectCount);
  const offsets: number[] = [];
  const seen = new Set<number>();
  let cursor = 0;
  const integer = /(\d+)/y;
  for (let index = 0; index < objectCount; index += 1) {
    cursor = skipPdfWhitespaceAndComments(header, cursor);
    integer.lastIndex = cursor;
    const objectMatch = integer.exec(header);
    if (!objectMatch || !isPdfTokenBoundary(header[integer.lastIndex])) {
      contentMismatch("The PDF object stream contains a malformed object table");
    }
    const objectNumber = Number(objectMatch[1]);
    cursor = skipPdfWhitespaceAndComments(header, integer.lastIndex);
    integer.lastIndex = cursor;
    const offsetMatch = integer.exec(header);
    if (!offsetMatch || !isPdfTokenBoundary(header[integer.lastIndex])) {
      contentMismatch("The PDF object stream contains a malformed object table");
    }
    const relativeOffset = Number(offsetMatch[1]);
    if (
      !Number.isSafeInteger(objectNumber)
      || !Number.isSafeInteger(relativeOffset)
      || objectNumber < 1
      || objectNumber >= context.size
      || seen.has(objectNumber)
      || (index > 0 && relativeOffset <= offsets[index - 1]!)
    ) contentMismatch("The PDF object stream contains an invalid object table");
    seen.add(objectNumber);
    objectNumbers[index] = objectNumber;
    offsets.push(relativeOffset);
    cursor = integer.lastIndex;
  }
  if (skipPdfWhitespaceAndComments(header, cursor) !== header.length) {
    contentMismatch("The PDF object stream contains extra object-table data");
  }
  const bodyLength = decoded.byteLength - first;
  if (offsets[0] !== 0 || offsets.some((offset) => offset >= bodyLength)) {
    contentMismatch("The PDF object stream contains an out-of-range object offset");
  }
  const body = new TextDecoder("latin1").decode(decoded.subarray(first));
  let capturedValue: PdfValue | null = null;
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]!;
    const end = offsets[index + 1] ?? body.length;
    if (end <= start) contentMismatch("The PDF object stream contains an empty compressed object");
    const parser: PdfValueParser = { source: body, cursor: start, limit: end, tokens: 0 };
    const value = parsePdfValue(parser);
    pdfParserSkip(parser);
    if (parser.cursor !== end) contentMismatch("The PDF object stream contains malformed compressed-object data");
    if (objectNumbers[index] === capturedObjectNumber) capturedValue = value;
  }
  return { objectNumbers, capturedValue };
}

function inspectEffectivePdfObjects(bytes: Uint8Array, context: PdfXrefContext): void {
  const root = context.root;
  if (!root || root.objectNumber >= context.size || context.entryKinds[root.objectNumber] !== 2) {
    contentMismatch("The PDF document root is not an in-use uncompressed cross-reference object");
  }
  if (context.field3[root.objectNumber] !== root.generation) {
    contentMismatch("The PDF document root generation does not match its cross-reference entry");
  }
  const rootObject = inspectPdfDictionaryObject(
    bytes,
    context.field2[root.objectNumber]!,
    root.objectNumber,
    root.generation,
  );
  if (pdfDictionaryName(rootObject.dictionary, "Type") !== "Catalog") {
    contentMismatch("The PDF document root is not a catalog object");
  }
  const rootEnd = skipPdfWhitespaceAndComments(rootObject.source, rootObject.end);
  if (!rootObject.source.startsWith("endobj", rootEnd) || !isPdfTokenBoundary(rootObject.source[rootEnd + 6])) {
    contentMismatch("The PDF catalog object is incomplete");
  }
  const pagesReference = rootObject.dictionary.entries.get("Pages");
  if (
    pagesReference?.kind !== "reference"
    || pagesReference.objectNumber >= context.size
    || pagesReference.generation > 65_535
  ) contentMismatch("The PDF catalog is missing a valid /Pages reference");

  const objectStreamTables = new Map<number, PdfObjectStreamInspection>();
  for (let objectNumber = 0; objectNumber < context.size; objectNumber += 1) {
    if (context.entryKinds[objectNumber] !== 3) continue;
    const streamObjectNumber = context.field2[objectNumber]!;
    const streamIndex = context.field3[objectNumber]!;
    if (
      !Number.isSafeInteger(streamObjectNumber)
      || streamObjectNumber >= context.size
      || context.entryKinds[streamObjectNumber] !== 2
      || context.field3[streamObjectNumber] !== 0
    ) contentMismatch("A compressed PDF object does not reference an in-use generation-zero object stream");
    let objectTable = objectStreamTables.get(streamObjectNumber);
    if (!objectTable) {
      if (objectStreamTables.size >= PDF_MAX_OBJECT_STREAMS) {
        contentMismatch("The PDF contains too many distinct object streams");
      }
      objectTable = inspectPdfObjectStream(bytes, context, streamObjectNumber, pagesReference.objectNumber);
      objectStreamTables.set(streamObjectNumber, objectTable);
    }
    if (
      streamIndex >= objectTable.objectNumbers.length
      || objectTable.objectNumbers[streamIndex] !== objectNumber
    ) {
      contentMismatch("A compressed PDF object does not match its object-stream table entry");
    }
  }
  const encodedStreamSpanIndex = buildPdfEncodedStreamSpanIndex(context.encodedStreamSpans);
  for (let objectNumber = 0; objectNumber < context.size; objectNumber += 1) {
    if (context.entryKinds[objectNumber] !== 2) continue;
    const offset = context.field2[objectNumber]!;
    if (pdfOffsetInsideEncodedStream(encodedStreamSpanIndex, offset)) {
      contentMismatch("A PDF in-use object header is embedded inside encoded stream data");
    }
  }
  const pagesKind = context.entryKinds[pagesReference.objectNumber];
  let pagesValue: PdfValue;
  if (pagesKind === 2) {
    if (context.field3[pagesReference.objectNumber] !== pagesReference.generation) {
      contentMismatch("The PDF page tree generation does not match its cross-reference entry");
    }
    const pagesObject = inspectPdfDictionaryObject(
      bytes,
      context.field2[pagesReference.objectNumber]!,
      pagesReference.objectNumber,
      pagesReference.generation,
    );
    const pagesEnd = skipPdfWhitespaceAndComments(pagesObject.source, pagesObject.end);
    if (!pagesObject.source.startsWith("endobj", pagesEnd) || !isPdfTokenBoundary(pagesObject.source[pagesEnd + 6])) {
      contentMismatch("The PDF page-tree object is incomplete");
    }
    pagesValue = pagesObject.dictionary;
  } else if (pagesKind === 3 && pagesReference.generation === 0) {
    const streamObjectNumber = context.field2[pagesReference.objectNumber]!;
    const streamIndex = context.field3[pagesReference.objectNumber]!;
    const pageTable = objectStreamTables.get(streamObjectNumber);
    if (
      pageTable?.objectNumbers[streamIndex] !== pagesReference.objectNumber
      || pageTable.capturedValue === null
    ) {
      contentMismatch("The PDF page tree does not match its object-stream entry");
    }
    pagesValue = pageTable.capturedValue;
  } else {
    contentMismatch("The PDF page tree is missing from the effective cross-reference map");
  }
  if (pagesValue.kind !== "dictionary" || pdfDictionaryName(pagesValue, "Type") !== "Pages") {
    contentMismatch("The PDF catalog does not reference a valid page-tree dictionary");
  }
}

function inspectBoundedPdfXrefChain(
  bytes: Uint8Array,
  xrefOffset: number,
  upperBound: number,
  context: PdfXrefContext | null,
  finalSection: boolean,
  linearized: PdfLinearizedTopology | null,
  traversalBudget: PdfXrefTraversalBudget,
): PdfXrefContext {
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 9 || xrefOffset >= upperBound) {
    contentMismatch("The PDF cross-reference offset is invalid");
  }
  if (context?.visitedOffsets.has(xrefOffset)) contentMismatch("The PDF cross-reference revision chain contains a cycle");
  if (context && context.sections >= 128) contentMismatch("The PDF has too many cross-reference revisions");
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(xrefOffset, Math.min(upperBound, xrefOffset + 16)));
  const classic = prefix.startsWith("xref") && isPdfTokenBoundary(prefix[4]);
  if (classic) {
    traversalBudget.classicSourceBytes += upperBound - xrefOffset;
    if (
      !Number.isSafeInteger(traversalBudget.classicSourceBytes)
      || traversalBudget.classicSourceBytes > PDF_MAX_TOTAL_PARSED_XREF_BYTES
    ) contentMismatch("The PDF cross-reference revisions exceed the supported aggregate parse size");
  }
  const section = classic
    ? parseBoundedClassicPdfXref(
      bytes,
      xrefOffset,
      upperBound,
      context,
      Boolean(
        linearized
        && linearized.mainXrefCandidates.includes(xrefOffset)
        && context?.visitedOffsets.has(linearized.earlyXrefOffset),
      ),
    )
    : parseBoundedPdfXrefStream(bytes, xrefOffset, upperBound, context);
  section.context.sections += 1;
  section.context.visitedOffsets.add(xrefOffset);
  if (linearized && xrefOffset === linearized.earlyXrefOffset) {
    if (
      section.prevOffset === null
      || !linearized.mainXrefCandidates.includes(section.prevOffset)
    ) contentMismatch("The PDF linearized first-page cross-reference does not link to its main cross-reference");
    const markerSource = new TextDecoder("latin1").decode(bytes.subarray(
      section.endOffset,
      Math.min(linearized.endFirstPageOffset, section.endOffset + PDF_TRAILER_SEARCH_BYTES),
    ));
    const markerCursor = skipPdfWhitespaceAndComments(markerSource, 0);
    const marker = /startxref[\t\n\f\r ]+0[\t\n\f\r ]+%%EOF(?:[\t\n\f\r ]|$)/y;
    marker.lastIndex = markerCursor;
    if (!marker.exec(markerSource)) {
      contentMismatch("The PDF linearized first-page cross-reference has an invalid special trailer");
    }
  }
  if (finalSection && (!linearized || xrefOffset !== linearized.earlyXrefOffset)) {
    const between = new TextDecoder("latin1").decode(bytes.subarray(section.endOffset, upperBound));
    if (skipPdfWhitespaceAndComments(between, 0) !== between.length) {
      contentMismatch("The PDF contains unexpected data before its final startxref marker");
    }
  }
  if (section.prevOffset === null) return section.context;
  if (section.prevOffset < 9 || section.prevOffset >= upperBound) {
    contentMismatch("The PDF cross-reference /Prev offset is invalid");
  }
  return inspectBoundedPdfXrefChain(
    bytes,
    section.prevOffset,
    upperBound,
    section.context,
    false,
    linearized,
    traversalBudget,
  );
}

function boundedPdfLinearizedTopology(bytes: Uint8Array, finalXrefOffset: number): PdfLinearizedTopology | null {
  const source = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, PDF_MAX_XREF_DICTIONARY_BYTES)));
  const headerEnd = source.search(/\r|\n/);
  if (headerEnd < 0) return null;
  try {
    let cursor = skipPdfWhitespaceAndComments(source, headerEnd + 1);
    const object = /(\d+)[\t\n\f\r ]+(\d+)[\t\n\f\r ]+obj\b/y;
    object.lastIndex = cursor;
    const header = object.exec(source);
    if (!header) return null;
    cursor = skipPdfWhitespaceAndComments(source, object.lastIndex);
    const parsed = parsePdfDictionary(source, cursor, cursor + PDF_MAX_XREF_DICTIONARY_BYTES);
    const dictionary = parsed.value;
    const linearized = dictionary.entries.get("Linearized");
    if (linearized?.kind !== "number" || linearized.value !== 1) return null;
    const objectEnd = skipPdfWhitespaceAndComments(source, parsed.end);
    if (!source.startsWith("endobj", objectEnd) || !isPdfTokenBoundary(source[objectEnd + 6])) return null;
    const length = pdfDictionaryInteger(dictionary, "L")!;
    const firstPageObject = pdfDictionaryInteger(dictionary, "O")!;
    const endFirstPageOffset = pdfDictionaryInteger(dictionary, "E")!;
    const pageCount = pdfDictionaryInteger(dictionary, "N")!;
    const mainXrefHint = pdfDictionaryInteger(dictionary, "T")!;
    const hints = pdfIntegerArray(dictionary.entries.get("H"), "H");
    if (
      length < 9
      || length > bytes.byteLength
      || firstPageObject < 1
      || firstPageObject >= PDF_MAX_XREF_ENTRIES
      || pageCount < 1
      || pageCount > PDF_MAX_XREF_ENTRIES
      || endFirstPageOffset < 9
      || endFirstPageOffset >= length
      || mainXrefHint < endFirstPageOffset
      || mainXrefHint + 1 >= length
      || (hints.length !== 2 && hints.length !== 4)
      || hints.some((value) => !Number.isSafeInteger(value))
    ) return null;
    for (let index = 0; index < hints.length; index += 2) {
      const offset = hints[index]!;
      const byteLength = hints[index + 1]!;
      if (offset < 9 || byteLength < 1 || offset + byteLength > endFirstPageOffset) return null;
    }
    const originalTailOffset = Math.max(0, length - PDF_TRAILER_SEARCH_BYTES);
    const originalTail = new TextDecoder("latin1").decode(bytes.subarray(originalTailOffset, length));
    const originalTrailer = /startxref[\t\n\f\r ]+(\d+)[\t\n\f\r ]+%%EOF[\t\n\f\r ]*$/.exec(originalTail);
    if (!originalTrailer) return null;
    const earlyXrefOffset = Number(originalTrailer[1]);
    if (
      !Number.isSafeInteger(earlyXrefOffset)
      || earlyXrefOffset < 9
      || earlyXrefOffset >= endFirstPageOffset
      || (finalXrefOffset === earlyXrefOffset
        ? length !== bytes.byteLength
        : finalXrefOffset < length)
    ) return null;
    return {
      earlyXrefOffset,
      endFirstPageOffset,
      firstPageObject,
      length,
      mainXrefCandidates: [mainXrefHint, mainXrefHint + 1],
    };
  } catch (error) {
    if (error instanceof DocumentSecurityError) return null;
    throw error;
  }
}

function inspectPdf(bytes: Uint8Array): void {
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 9));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)/.test(header)) contentMismatch();
  const tailOffset = Math.max(0, bytes.byteLength - PDF_TRAILER_SEARCH_BYTES);
  const tail = new TextDecoder("latin1").decode(bytes.subarray(tailOffset));
  const trailer = /startxref[\t\n\f\r ]+(\d+)[\t\n\f\r ]+%%EOF[\t\n\f\r ]*$/.exec(tail);
  if (!trailer) contentMismatch("The PDF is missing a complete final trailer");
  const startxrefOffset = tailOffset + trailer.index;
  const xrefOffset = Number(trailer[1]);
  const linearized = boundedPdfLinearizedTopology(bytes, xrefOffset);
  const context = inspectBoundedPdfXrefChain(
    bytes,
    xrefOffset,
    startxrefOffset,
    null,
    true,
    linearized,
    { classicSourceBytes: 0 },
  );
  if (
    linearized
    && (
      !context.visitedOffsets.has(linearized.earlyXrefOffset)
      || !linearized.mainXrefCandidates.some((offset) => context.visitedOffsets.has(offset))
    )
  ) contentMismatch("The PDF linearized cross-reference topology is incomplete");
  if (
    linearized
    && (
      linearized.firstPageObject >= context.size
      || (context.entryKinds[linearized.firstPageObject] !== 2
        && context.entryKinds[linearized.firstPageObject] !== 3)
    )
  ) contentMismatch("The PDF linearized first-page object is missing from the effective cross-reference map");
  if (
    context.requiresCompleteClassicMap
    && (
      context.entryKinds.some((kind) => kind === 0)
      || context.entryKinds[0] !== 1
      || (context.field3[0] !== 0 && context.field3[0] !== 65_535)
    )
  ) contentMismatch("The PDF classic cross-reference map is incomplete or has an invalid object-zero entry");
  inspectEffectivePdfObjects(bytes, context);
}

function decodeControlledUtf8(bytes: Uint8Array, label: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    contentMismatch(`${label} is not valid UTF-8`);
  }
  for (let index = 0; index < decoded.length; index += 1) {
    const codePoint = decoded.codePointAt(index)!;
    if (codePoint > 0xffff) index += 1;
    const allowedWhitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d;
    if ((!allowedWhitespace && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)))
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)) {
      contentMismatch(`${label} contains unsupported control characters`);
    }
  }
  return decoded;
}

function rejectUnsafeRtfControls(rtf: string): void {
  const blocked = new Set(["bin", "object", "objdata"]);
  for (let index = 0; index < rtf.length; index += 1) {
    if (rtf[index] !== "\\") continue;
    const next = rtf[index + 1];
    if (!next) break;
    if (!/[A-Za-z]/.test(next)) {
      index += next === "'" ? Math.min(3, rtf.length - index - 1) : 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < rtf.length && /[A-Za-z]/.test(rtf[cursor]!)) cursor += 1;
    const control = rtf.slice(index + 1, cursor).toLowerCase();
    if (blocked.has(control)) contentMismatch("Embedded binary or object RTF content is not supported");
    if (rtf[cursor] === "-") cursor += 1;
    while (cursor < rtf.length && /[0-9]/.test(rtf[cursor]!)) cursor += 1;
    if (rtf[cursor] === " ") cursor += 1;
    index = cursor - 1;
  }
}

function inspectRtf(bytes: Uint8Array): void {
  const rtf = decodeControlledUtf8(bytes, "The RTF document");
  if (!/^\{\\rtf1(?:\\|[\t\n\r ])/.test(rtf)) contentMismatch();
  rejectUnsafeRtfControls(rtf);
  let depth = 0;
  let rootClosedAt = -1;
  for (let index = 0; index < rtf.length; index += 1) {
    const value = rtf[index]!;
    if (value !== "{" && value !== "}") continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && rtf[cursor] === "\\"; cursor -= 1) slashCount += 1;
    if (slashCount % 2 === 1) continue;
    if (value === "{") {
      depth += 1;
      if (rootClosedAt >= 0 || depth > RTF_MAX_NESTING_DEPTH) contentMismatch("The RTF document has invalid group nesting");
    } else {
      depth -= 1;
      if (depth < 0) contentMismatch("The RTF document has invalid group nesting");
      if (depth === 0) rootClosedAt = index;
    }
  }
  if (depth !== 0 || rootClosedAt < 0 || rtf.slice(rootClosedAt + 1).trim() !== "") {
    contentMismatch("The RTF document is incomplete or has trailing content");
  }
}

export function normalizedDocumentName(fileName: string): string {
  const normalized = fileName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 140);
  return normalized || "document";
}

export function inspectDocument(bytes: Uint8Array, fileName: string): SupportedDocument {
  if (bytes.byteLength === 0) throw new DocumentSecurityError("empty_file", "The selected document is empty", 400);
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentSecurityError("file_too_large", "Documents must be smaller than 20 MB", 413);
  }

  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!extension || !(extension in extensionTypes)) {
    throw new DocumentSecurityError("unsupported_file", "Use a PDF, DOCX, RTF, or text document", 415);
  }

  const supportedExtension = extension as SupportedDocument["extension"];
  if (supportedExtension === "pdf") inspectPdf(bytes);
  if (supportedExtension === "docx") inspectDocxArchive(bytes);
  if (supportedExtension === "rtf") inspectRtf(bytes);
  if (supportedExtension === "txt") decodeControlledUtf8(bytes, "The text document");

  return { extension: supportedExtension, contentType: extensionTypes[supportedExtension] };
}

export async function sha256Hex(input: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input instanceof Uint8Array ? Uint8Array.from(input) : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function scannerEndpoint(value: string): URL | null {
  try {
    const endpoint = new URL(value);
    const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
    if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:"))) {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
}

function hasOnlyKeys(candidate: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(candidate).every((key) => allowedKeys.has(key));
}

export function customerHostedOcrSignaturePayload(input: Readonly<{
  timestamp: string;
  requestId: string;
  documentId: string;
  sha256: string;
  modelId: string;
  profileId: string;
}>): string {
  return [
    `notice-scanner/${CUSTOMER_HOSTED_OCR_PROTOCOL_VERSION}`,
    input.timestamp,
    input.requestId,
    input.documentId,
    input.sha256,
    "extract-text",
    input.modelId,
    input.profileId,
    String(CUSTOMER_HOSTED_OCR_MAX_CHARACTERS),
  ].join("\n");
}

/**
 * Request bounded OCR from the already approved scanner gateway. Notice never
 * sends document bytes to a model host directly: the gateway owns the exact
 * customer-hosted model/profile allowlist, isolation, and retention policy.
 */
export async function extractDocumentTextWithCustomerHostedOcr(
  bytes: Uint8Array,
  document: { id: string; fileName: string; contentType: string; sha256: string },
  configuration: ScannerConfiguration,
): Promise<CustomerHostedOcrResult> {
  const endpoint = configuration.endpoint ? scannerEndpoint(configuration.endpoint) : null;
  const secretBytes = configuration.secret ? new TextEncoder().encode(configuration.secret).byteLength : 0;
  const profile = configuration.ocr;
  if (
    !endpoint
    || !configuration.secret
    || secretBytes < 32
    || secretBytes > 4_096
    || !profile
    || !isValidCustomerHostedOcrIdentifier(profile.modelId)
    || !isValidCustomerHostedOcrIdentifier(profile.profileId)
  ) {
    throw new CustomerHostedOcrError("not_configured", "The customer-hosted OCR profile is not completely configured.", 503);
  }
  if (!["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(document.contentType)) {
    throw new CustomerHostedOcrError("unsupported_document", "Customer-hosted OCR accepts only inspected PDF or DOCX sources.", 415);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new CustomerHostedOcrError("invalid_document_size", "The OCR source is outside the supported document-size boundary.", 413);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(document.id) || !/^[0-9a-f]{64}$/.test(document.sha256)) {
    throw new CustomerHostedOcrError("invalid_document_identity", "The OCR source identity is invalid.", 400);
  }
  if (await sha256Hex(bytes) !== document.sha256) {
    throw new CustomerHostedOcrError("document_integrity_failure", "The OCR source bytes do not match their declared SHA-256.", 409);
  }

  const timestamp = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const signature = await hmacHex(configuration.secret, customerHostedOcrSignaturePayload({
    timestamp,
    requestId,
    documentId: document.id,
    sha256: document.sha256,
    modelId: profile.modelId,
    profileId: profile.profileId,
  }));
  const body = new FormData();
  body.set("file", new Blob([Uint8Array.from(bytes).buffer], { type: document.contentType }), document.fileName);
  body.set("requestId", requestId);
  body.set("documentId", document.id);
  body.set("sha256", document.sha256);
  body.set("operation", "extract-text");
  body.set("modelId", profile.modelId);
  body.set("profileId", profile.profileId);
  body.set("maximumCharacters", String(CUSTOMER_HOSTED_OCR_MAX_CHARACTERS));

  const timeoutMs = configuration.timeoutMs ?? 30_000;
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const response = await fetchWithHeaderDeadline(
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-notice-scanner-protocol": CUSTOMER_HOSTED_OCR_PROTOCOL_VERSION,
          "x-notice-timestamp": timestamp,
          "x-notice-signature": `sha256=${signature}`,
        },
        body,
        redirect: "manual",
      },
      {
        timeoutMs,
        timeoutMessage: "OCR gateway request timed out",
        failureMessage: "OCR gateway request failed",
      },
    );
    if (!response.ok) {
      cancelResponseBody(response, "OCR gateway request was rejected");
      throw new CustomerHostedOcrError("gateway_unavailable", `The customer-hosted OCR gateway returned HTTP ${response.status}.`, 503);
    }
    const remainingTimeoutMs = deadlineAt - Date.now();
    if (remainingTimeoutMs < 1) {
      cancelResponseBody(response, "OCR gateway exceeded its total deadline");
      throw new CustomerHostedOcrError("gateway_timeout", "The customer-hosted OCR gateway timed out.", 503);
    }
    const responseBytes = await readBoundedResponseBody(response, {
      maximumBytes: CUSTOMER_HOSTED_OCR_RESPONSE_MAX_BYTES,
      timeoutMs: remainingTimeoutMs,
      invalidLengthMessage: "OCR response Content-Length was invalid",
      tooLargeMessage: "OCR response exceeded the configured limit",
      timeoutMessage: "OCR response body timed out",
      readFailureMessage: "OCR response could not be read",
    });
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
    } catch {
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR gateway returned invalid JSON.", 503);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.getPrototypeOf(payload) !== Object.prototype) {
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR gateway returned an invalid response.", 503);
    }
    const responseObject = payload as Record<string, unknown>;
    const correlatedMalicious = responseObject.requestId === requestId && responseObject.verdict === "malicious";
    const maliciousEvidence = (fallbackDetail: string): CustomerHostedOcrVerdictEvidence => Object.freeze({
      requestId,
      provider: isValidOcrEvidenceString(responseObject.provider, 120) ? responseObject.provider : "scan-gateway",
      detail: isValidOcrEvidenceString(responseObject.detail, 500) ? responseObject.detail : fallbackDetail,
      scannedAt: new Date().toISOString(),
    });
    if (!hasOnlyKeys(responseObject, ["verdict", "requestId", "provider", "detail", "extraction"])) {
      if (correlatedMalicious) {
        throw new CustomerHostedOcrError(
          "malicious_source",
          "The customer-hosted gateway rejected the OCR source as malicious; unsupported ancillary response fields were ignored.",
          422,
          maliciousEvidence("Correlated malicious verdict with unsupported ancillary fields"),
        );
      }
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR gateway returned unsupported response fields.", 503);
    }
    if (responseObject.requestId !== requestId) {
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR gateway response did not match the signed request.", 503);
    }
    if (responseObject.provider !== undefined && !isValidOcrEvidenceString(responseObject.provider, 120)) {
      if (correlatedMalicious) {
        throw new CustomerHostedOcrError(
          "malicious_source",
          "The customer-hosted gateway rejected the OCR source as malicious; malformed provider evidence was replaced with safe fallback evidence.",
          422,
          maliciousEvidence("Correlated malicious verdict with malformed provider evidence"),
        );
      }
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR provider evidence is invalid.", 503);
    }
    if (responseObject.detail !== undefined && !isValidOcrEvidenceString(responseObject.detail, 500)) {
      if (correlatedMalicious) {
        throw new CustomerHostedOcrError(
          "malicious_source",
          "The customer-hosted gateway rejected the OCR source as malicious; malformed detail evidence was replaced with safe fallback evidence.",
          422,
          maliciousEvidence("Correlated malicious verdict with malformed detail evidence"),
        );
      }
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR detail is invalid.", 503);
    }
    const provider = typeof responseObject.provider === "string" ? responseObject.provider : "scan-gateway";
    const detail = typeof responseObject.detail === "string" ? responseObject.detail : "Customer-hosted OCR completed";
    if (responseObject.verdict === "malicious") {
      if (responseObject.extraction !== undefined) {
        throw new CustomerHostedOcrError(
          "malicious_source",
          "The customer-hosted gateway rejected the OCR source as malicious; prohibited extraction content was ignored.",
          422,
          maliciousEvidence("Correlated malicious verdict with prohibited extraction content"),
        );
      }
      throw new CustomerHostedOcrError(
        "malicious_source",
        "The customer-hosted gateway rejected the OCR source as malicious.",
        422,
        Object.freeze({ requestId, provider, detail, scannedAt: new Date().toISOString() }),
      );
    }
    if (responseObject.verdict !== "clean" || !responseObject.extraction || typeof responseObject.extraction !== "object" || Array.isArray(responseObject.extraction)) {
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR gateway did not return a clean, complete extraction.", 503);
    }
    const extraction = responseObject.extraction as Record<string, unknown>;
    if (
      !hasOnlyKeys(extraction, ["status", "modelId", "profileId", "sourceSha256", "text"])
      || extraction.status !== "complete"
      || extraction.modelId !== profile.modelId
      || extraction.profileId !== profile.profileId
      || extraction.sourceSha256 !== document.sha256
      || typeof extraction.text !== "string"
      || !extraction.text.trim()
      || extraction.text.length > CUSTOMER_HOSTED_OCR_MAX_CHARACTERS
      || new TextEncoder().encode(extraction.text).byteLength > CUSTOMER_HOSTED_OCR_MAX_TEXT_BYTES
      || extraction.text.includes("\u0000")
      || !isWellFormedUtf16(extraction.text)
    ) {
      throw new CustomerHostedOcrError("invalid_response", "The customer-hosted OCR result did not match the selected bounded profile and source.", 503);
    }
    return Object.freeze({
      text: extraction.text,
      requestId,
      provider,
      detail,
      modelId: profile.modelId,
      profileId: profile.profileId,
      sourceSha256: document.sha256,
    });
  } catch (error) {
    if (error instanceof CustomerHostedOcrError) throw error;
    if (error instanceof ResponseBoundaryError && [
      "invalid_content_length",
      "response_too_large",
      "body_timeout",
      "body_read_failed",
    ].includes(error.code)) {
      // A 2xx response whose body cannot be fully bounded and authenticated as
      // one exact result is untrusted evidence, not ordinary unavailability.
      // The import route preserves its pre-inference quarantine claim.
      throw new CustomerHostedOcrError(
        "invalid_response",
        "The customer-hosted OCR gateway returned an incomplete or invalid bounded response.",
        503,
      );
    }
    const timedOut = error instanceof ResponseBoundaryError
      && error.code === "header_timeout";
    throw new CustomerHostedOcrError(
      timedOut ? "gateway_timeout" : "gateway_unavailable",
      timedOut ? "The customer-hosted OCR gateway timed out." : "The customer-hosted OCR gateway request failed.",
      503,
    );
  }
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isValidOcrEvidenceString(value: unknown, maximumCharacters: number): value is string {
  return typeof value === "string"
    && value.length <= maximumCharacters
    && !value.includes("\u0000")
    && isWellFormedUtf16(value);
}

export async function scanDocument(
  bytes: Uint8Array,
  document: { id: string; fileName: string; contentType: string; sha256: string },
  configuration: ScannerConfiguration,
): Promise<ScanVerdict> {
  if (!configuration.endpoint || !configuration.secret) {
    return { status: "unavailable", provider: "unconfigured", detail: "A malware-scanning gateway is required", scannedAt: null };
  }

  const endpoint = scannerEndpoint(configuration.endpoint);
  if (!endpoint) {
    return { status: "unavailable", provider: "scan-gateway", detail: "Scanner endpoint is invalid", scannedAt: null };
  }

  const timestamp = new Date().toISOString();
  const signaturePayload = `${timestamp}.${document.id}.${document.sha256}`;
  const signature = await hmacHex(configuration.secret, signaturePayload);
  const body = new FormData();
  body.set("file", new Blob([Uint8Array.from(bytes).buffer], { type: document.contentType }), document.fileName);
  body.set("documentId", document.id);
  body.set("sha256", document.sha256);

  const timeoutMs = configuration.timeoutMs ?? 15_000;
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const response = await fetchWithHeaderDeadline(
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-notice-timestamp": timestamp,
          "x-notice-signature": `sha256=${signature}`,
        },
        body,
        redirect: "manual",
      },
      {
        timeoutMs,
        timeoutMessage: "Scanner request timed out",
        failureMessage: "Scanner request failed",
      },
    );
    if (!response.ok) {
      cancelResponseBody(response, "Scanner request was rejected");
      return { status: "unavailable", provider: "scan-gateway", detail: `Scanner returned HTTP ${response.status}`, scannedAt: null };
    }
    const remainingTimeoutMs = deadlineAt - Date.now();
    if (remainingTimeoutMs < 1) {
      cancelResponseBody(response, "Scanner exceeded its total deadline");
      throw new ResponseBoundaryError("body_timeout", "Scanner response body timed out");
    }
    const responseBytes = await readBoundedResponseBody(response, {
      maximumBytes: SCANNER_RESPONSE_MAX_BYTES,
      timeoutMs: remainingTimeoutMs,
      invalidLengthMessage: "Scanner response Content-Length was invalid",
      tooLargeMessage: "Scanner response exceeded the configured limit",
      timeoutMessage: "Scanner response body timed out",
      readFailureMessage: "Scanner response could not be read",
    });
    const payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
    ) as { verdict?: unknown; provider?: unknown; detail?: unknown };
    if (payload.verdict !== "clean" && payload.verdict !== "malicious") {
      return { status: "unavailable", provider: "scan-gateway", detail: "Scanner response did not contain a supported verdict", scannedAt: null };
    }
    return {
      status: payload.verdict,
      provider: typeof payload.provider === "string" ? payload.provider.slice(0, 120) : "scan-gateway",
      detail: typeof payload.detail === "string" ? payload.detail.slice(0, 500) : payload.verdict === "clean" ? "No malware detected" : "Malware detected",
      scannedAt: new Date().toISOString(),
    };
  } catch (error) {
    const timedOut = error instanceof ResponseBoundaryError
      && (error.code === "header_timeout" || error.code === "body_timeout");
    return {
      status: "unavailable",
      provider: "scan-gateway",
      detail: timedOut ? "Scanner timed out" : "Scanner request failed",
      scannedAt: null,
    };
  }
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  return hmacHex(secret, payload);
}

export class DocumentSecurityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DocumentSecurityError";
    this.code = code;
    this.status = status;
  }
}

export class CustomerHostedOcrError extends Error {
  readonly code: string;
  readonly status: number;
  readonly verdictEvidence: CustomerHostedOcrVerdictEvidence | null;

  constructor(code: string, message: string, status: number, verdictEvidence: CustomerHostedOcrVerdictEvidence | null = null) {
    super(message);
    this.name = "CustomerHostedOcrError";
    this.code = code;
    this.status = status;
    this.verdictEvidence = verdictEvidence;
  }
}
