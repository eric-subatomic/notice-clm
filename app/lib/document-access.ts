import type { NoticeMode } from "./notice-config";

/** Evaluation bypass is never portable trust evidence. */
export function isDocumentReadable(scanStatus: string, mode: NoticeMode): boolean {
  return scanStatus === "clean" || (mode === "evaluation" && scanStatus === "evaluation-bypassed");
}

export function canRescanDocument(scanStatus: string, mode: NoticeMode): boolean {
  return scanStatus === "quarantined" || (mode === "production" && scanStatus === "evaluation-bypassed");
}
