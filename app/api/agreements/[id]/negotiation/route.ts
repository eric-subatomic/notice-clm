import { z } from "zod";
import { ensureStorageSchema } from "../../../../../db/ensure";
import { authorizeApiRequest, handleRouteError } from "../../../../lib/api";
import { getNoticeConfig } from "../../../../lib/config";
import { MAX_DOCUMENT_BYTES } from "../../../../lib/document-security";
import { apiError, apiJson } from "../../../../lib/http";
import { NegotiationExchangeError } from "../../../../lib/negotiation-exchange";
import {
  NegotiationServiceError,
  attestManualNegotiationSend,
  closeNegotiationRound,
  getNegotiationReviewText,
  getNegotiationState,
  ingestNegotiationSubmissions,
  markNegotiationSubmissionReady,
  prepareNegotiationRound,
  promoteNegotiationSubmission,
  rejectNegotiationSubmission,
  rotateNegotiationPortal,
  sendNegotiationRound,
} from "../../../../lib/negotiation-service";
import { negotiationPublicOrigin } from "../../../../lib/negotiation-origin";
import { parseJson, readBoundedBody } from "../../../../lib/validation";

const MAX_MULTIPART_BODY_BYTES = MAX_DOCUMENT_BYTES + 1_024 * 1_024;
const roundId = z.string().uuid();
const agreementVersion = z.number().int().nonnegative();
const email = z.string().trim().min(3).max(320);
const headerText = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "Header text cannot contain control characters",
);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prepare"),
    expectedAgreementVersion: agreementVersion,
    counterpartyEmail: email,
    counterpartyName: headerText(200),
  }).strict(),
  z.object({ action: z.literal("rotate_portal"), roundId }).strict(),
  z.object({
    action: z.literal("send"),
    roundId,
    expectedAgreementVersion: agreementVersion,
    recipientEmail: email,
    subject: headerText(300),
    message: z.string().trim().min(1).max(4_000),
  }).strict(),
  z.object({
    action: z.literal("attest_manual_send"),
    roundId,
    expectedAgreementVersion: agreementVersion,
    recipientEmail: email,
    providerMessageId: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    action: z.literal("reject_submission"),
    submissionId: z.string().uuid(),
    note: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({
    action: z.literal("mark_ready"),
    submissionId: z.string().uuid(),
    note: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({
    action: z.literal("close"),
    roundId,
    expectedAgreementVersion: agreementVersion,
    note: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({
    action: z.literal("promote_submission"),
    roundId,
    submissionId: z.string().uuid(),
    expectedAgreementVersion: agreementVersion,
    reviewedText: z.string().max(2_000_000).refine((value) => value.trim().length > 0, "Reviewed text cannot be blank"),
    contentType: z.enum(["text/plain", "text/markdown"]).default("text/plain"),
    label: z.string().trim().min(1).max(120),
    note: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

function agreementIdFrom(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function serviceError(error: unknown, requestId: string, fallback: string): Response {
  if (error instanceof NegotiationServiceError) {
    return apiError(error.code, error.message, { status: error.status, requestId });
  }
  if (error instanceof NegotiationExchangeError) {
    return apiError(error.code, error.message, { status: 400, requestId });
  }
  return handleRouteError(error, requestId, fallback);
}

function reconstructedMultipartRequest(request: Request, body: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body.buffer as ArrayBuffer,
  });
}

function oneString(form: FormData, name: string, required = false): string | null {
  const values = form.getAll(name);
  if (values.length > 1 || (required && values.length !== 1)) {
    throw new NegotiationServiceError("invalid_multipart", `Form field ${name} must appear exactly once.`, 400);
  }
  const value = values[0];
  if (value === undefined) return null;
  if (typeof value !== "string") throw new NegotiationServiceError("invalid_multipart", `Form field ${name} must be text.`, 400);
  return value;
}

async function manualUpload(
  request: Request,
  workspaceId: string,
  agreementId: number,
  actor: { id: string; email: string; displayName: string },
) {
  const body = await readBoundedBody(
    request,
    MAX_MULTIPART_BODY_BYTES,
    `Maximum multipart body size is ${MAX_MULTIPART_BODY_BYTES} bytes`,
  );
  let form: FormData;
  try {
    form = await reconstructedMultipartRequest(request, body).formData();
  } catch {
    throw new NegotiationServiceError("invalid_multipart", "Upload must use valid multipart form data.", 400);
  }
  if (oneString(form, "action", true) !== "upload") {
    throw new NegotiationServiceError("invalid_action", "Multipart requests must use action=upload.", 400);
  }
  const files = form.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) {
    throw new NegotiationServiceError("document_required", "Upload exactly one returned document.", 400);
  }
  const file = files[0];
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new NegotiationServiceError("payload_too_large", "The document exceeds the 20 MiB upload limit.", 413);
  }
  const parsed = z.object({
    roundId,
    senderEmail: email.optional(),
    senderName: z.string().trim().max(200).optional(),
    providerMessageId: z.string().trim().max(500).optional(),
    reviewedText: z.string().max(2_000_000).optional(),
  }).strict().safeParse({
    roundId: oneString(form, "roundId", true),
    senderEmail: oneString(form, "senderEmail") ?? undefined,
    senderName: oneString(form, "senderName") ?? undefined,
    providerMessageId: oneString(form, "providerMessageId") ?? undefined,
    reviewedText: oneString(form, "reviewedText") ?? undefined,
  });
  if (!parsed.success) {
    throw new NegotiationServiceError("invalid_multipart", "Upload fields are invalid.", 400);
  }
  return ingestNegotiationSubmissions({
    workspaceId,
    agreementId,
    roundId: parsed.data.roundId,
    source: "manual",
    senderEmail: parsed.data.senderEmail,
    senderName: parsed.data.senderName,
    providerMessageId: parsed.data.providerMessageId || `manual:${crypto.randomUUID()}`,
    attachments: [{
      fileName: file.name,
      declaredContentType: file.type || null,
      declaredSize: file.size,
      bytes: new Uint8Array(await file.arrayBuffer()),
    }],
    reviewedText: parsed.data.reviewedText,
    reviewer: actor,
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "document:read");
  if (!auth.ok) return auth.response;
  try {
    const agreementId = agreementIdFrom((await context.params).id);
    if (!agreementId) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    await ensureStorageSchema();
    const url = new URL(request.url);
    const submissionId = url.searchParams.get("submissionId");
    if (url.searchParams.get("view") === "review-text") {
      if (!submissionId || !z.string().uuid().safeParse(submissionId).success) {
        return apiError("submission_not_found", "Reviewed text was not found.", { status: 404, requestId: auth.requestId });
      }
      const review = await getNegotiationReviewText({
        workspaceId: auth.context.workspace.id,
        agreementId,
        submissionId,
      });
      const headers = new Headers(auth.headers);
      headers.set("Cache-Control", "private, no-store, max-age=0");
      headers.set("Content-Type", "text/plain; charset=utf-8");
      headers.set("Content-Length", String(review.bytes.byteLength));
      headers.set("Content-Disposition", `attachment; filename="agreement-${agreementId}-review.txt"`);
      headers.set("Content-Security-Policy", "sandbox");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Document-SHA256", review.sha256);
      headers.set("X-Request-Id", auth.requestId);
      return new Response(Uint8Array.from(review.bytes).buffer, { headers });
    }
    const state = await getNegotiationState(
      auth.context.workspace.id,
      agreementId,
      auth.context.permissions.has("document:manage"),
    );
    return apiJson({ ...state, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return serviceError(error, auth.requestId, "Negotiation state could not be loaded.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeApiRequest(request, "document:manage", { limit: 30 });
  if (!auth.ok) return auth.response;
  try {
    const agreementId = agreementIdFrom((await context.params).id);
    if (!agreementId) return apiError("agreement_not_found", "Agreement was not found.", { status: 404, requestId: auth.requestId });
    await ensureStorageSchema();
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("multipart/form-data")) {
      const result = await manualUpload(request, auth.context.workspace.id, agreementId, auth.context.user);
      return apiJson({ ...result, requestId: auth.requestId }, { status: result.replay ? 200 : 201, requestId: auth.requestId, headers: auth.headers });
    }
    if (!contentType.startsWith("application/json")) {
      return apiError("unsupported_media_type", "Use application/json or multipart/form-data.", { status: 415, requestId: auth.requestId });
    }
    const input = await parseJson(request, actionSchema, 2_100_000);
    const common = { workspaceId: auth.context.workspace.id, agreementId, actor: auth.context.user };
    const publicOrigin = negotiationPublicOrigin(getNoticeConfig(), request.url);
    let result: unknown;
    switch (input.action) {
      case "prepare":
        result = await prepareNegotiationRound({ ...common, ...input, publicOrigin });
        break;
      case "rotate_portal":
        result = await rotateNegotiationPortal({ ...common, roundId: input.roundId, publicOrigin });
        break;
      case "send":
        result = await sendNegotiationRound({ ...common, ...input, publicOrigin });
        break;
      case "attest_manual_send":
        result = await attestManualNegotiationSend({ ...common, ...input });
        break;
      case "reject_submission":
        result = await rejectNegotiationSubmission({ ...common, ...input });
        break;
      case "mark_ready":
        result = await markNegotiationSubmissionReady({ ...common, ...input });
        break;
      case "close":
        result = await closeNegotiationRound({ ...common, ...input });
        break;
      case "promote_submission":
        result = await promoteNegotiationSubmission({ ...common, ...input });
        break;
    }
    return apiJson({ result, requestId: auth.requestId }, { requestId: auth.requestId, headers: auth.headers });
  } catch (error) {
    return serviceError(error, auth.requestId, "Negotiation action could not be completed.");
  }
}
