import { sha256Hex } from "./document-security";
import { normalizeIsoDate } from "./iso-date";

export type ReminderIdentity = Readonly<{
  workspaceId: string;
  topic: string;
  aggregateId: string;
  recipientUserId: string;
  aggregateVersion: number;
  calendarWindow: string;
}>;

export function reminderCalendarWindow(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function isReminderDue(due: string, calendarWindow: string): boolean {
  const canonicalDue = normalizeIsoDate(due);
  const canonicalWindow = normalizeIsoDate(calendarWindow);
  return canonicalDue !== null && canonicalWindow !== null && canonicalDue <= canonicalWindow;
}

export async function reminderEventId(input: ReminderIdentity): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(input)));
  return `reminder:${digest}`;
}
