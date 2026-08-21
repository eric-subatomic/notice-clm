import { ensureStorageSchema } from "../../../../db/ensure";
import { handleRouteError, withResponseHeaders } from "../../../lib/api";
import { MAX_DOCUMENT_BYTES } from "../../../lib/document-security";
import {
  apiError,
  apiJson,
  createRequestId,
  guardMutationRequest,
} from "../../../lib/http";
import { NegotiationExchangeError } from "../../../lib/negotiation-exchange";
import {
  NegotiationServiceError,
  getNegotiationPortalDocument,
  ingestNegotiationSubmissions,
  recordNegotiationPortalUploadFailure,
  reserveNegotiationPortalUpload,
  resolveNegotiationPortal,
} from "../../../lib/negotiation-service";
import type { NegotiationPortalUploadReservation } from "../../../lib/negotiation-portal-budget";
import { readBoundedBody } from "../../../lib/validation";

const MAX_MULTIPART_BODY_BYTES = MAX_DOCUMENT_BYTES + 1_024 * 1_024;

function securityHeaders(contentType?: string): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

function tokenFrom(value: string): string | null {
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayBytes(size: number): string {
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MiB (${size} bytes)`;
  if (size >= 1_024) return `${(size / 1_024).toFixed(1)} KiB (${size} bytes)`;
  return `${size} bytes`;
}

function displayTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function html(body: string, requestId: string, status = 200): Response {
  const headers = securityHeaders("text/html; charset=utf-8");
  headers.set("X-Request-Id", requestId);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure contract exchange</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.2rem;color:#18202b}main{border:1px solid #ccd4df;border-radius:12px;padding:1.5rem}dl,dd,small{overflow-wrap:anywhere}dt{margin-top:.7rem;font-weight:700}dd{margin:.2rem 0 0}label{display:block;margin-top:1rem;font-weight:600}input{box-sizing:border-box;width:100%;padding:.7rem;margin-top:.35rem;font:inherit}button,a.button{display:inline-block;margin-top:1.2rem;padding:.75rem 1rem;border:0;border-radius:8px;background:#163a63;color:white;text-decoration:none;font:inherit;font-weight:700}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #6f9229;outline-offset:3px}small{color:#46574d}@media(max-width:420px){body{margin:1rem auto;padding:0 .75rem}main{padding:1rem}button,a.button{box-sizing:border-box;width:100%;text-align:center}}</style></head><body><main>${body}</main></body></html>`, { status, headers });
}

function prefersHtml(request: Request): boolean {
  if (new URL(request.url).searchParams.get("format") === "json") return false;
  const accept = request.headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("text/html") && !accept.startsWith("application/json");
}

function publicError(request: Request, code: string, message: string, status: number, requestId: string): Response {
  if (!prefersHtml(request)) {
    return apiError(code, message, { status, requestId, headers: securityHeaders() });
  }
  const recovery = code.endsWith("_limit_reached")
    ? "Ask the contract sender to start a new exchange round and send its secure link. Replacing this round's link does not reset its transfer limits."
    : status === 404 || status === 410
      ? "Ask the contract sender for a new secure exchange link. Do not forward or reuse an older link."
    : status === 429
      ? "Wait a moment, then reload this secure exchange page before trying again."
      : "Return to the secure exchange page, check the required fields and file, then try again.";
  return html(`<h1>The secure exchange could not continue</h1><p>${escapeHtml(message)}</p><p>${escapeHtml(recovery)}</p><p><small>Support reference: ${escapeHtml(requestId)}</small></p>`, requestId, status);
}

function serviceError(error: unknown, request: Request, requestId: string): Response {
  if (error instanceof NegotiationServiceError) {
    const response = publicError(request, error.code, error.message, error.status, requestId);
    if (error.code === "exchange_upload_busy") response.headers.set("Retry-After", "5");
    return response;
  }
  if (error instanceof NegotiationExchangeError) {
    return publicError(request, error.code, error.message, 400, requestId);
  }
  if (prefersHtml(request)) {
    return publicError(request, "exchange_failed", "The secure exchange could not be completed.", 500, requestId);
  }
  return withResponseHeaders(
    handleRouteError(error, requestId, "The secure exchange could not be completed."),
    securityHeaders(),
  );
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

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const requestId = createRequestId();
  try {
    const token = tokenFrom((await context.params).token);
    if (!token) return publicError(request, "exchange_not_found", "This exchange link is unavailable.", 404, requestId);
    await ensureStorageSchema();
    const url = new URL(request.url);
    if (url.searchParams.get("download") === "1") {
      const result = await getNegotiationPortalDocument(token);
      const headers = securityHeaders(result.document.contentType);
      headers.set("Content-Length", String(result.bytes.byteLength));
      const encodedName = encodeURIComponent(result.document.fileName).replaceAll("'", "%27");
      headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodedName}`);
      headers.set("X-Document-SHA256", result.document.sha256);
      headers.set("X-Request-Id", requestId);
      return new Response(Uint8Array.from(result.bytes).buffer, { headers });
    }
    const resolved = await resolveNegotiationPortal(token);
    if (url.searchParams.get("format") === "json") {
      return apiJson({ exchange: resolved.metadata, requestId }, { requestId, headers: securityHeaders() });
    }
    const metadata = resolved.metadata;
    return html(`
      <h1>Secure contract exchange</h1>
      <p><strong>${escapeHtml(metadata.requestingOrganization)}</strong> created this exchange for its contract review with <strong>${escapeHtml(metadata.party)}</strong>.</p>
      <p><small>If you did not expect this request, do not upload a file. Contact the sender through the original email or another channel you already trust.</small></p>
      <dl><dt>Agreement</dt><dd>${escapeHtml(metadata.agreementType)}</dd><dt>Round</dt><dd>${metadata.roundNumber}</dd><dt>Document</dt><dd>${escapeHtml(metadata.outboundDocument.fileName)} · ${escapeHtml(displayBytes(metadata.outboundDocument.size))}</dd><dt>SHA-256</dt><dd><small>${metadata.outboundDocument.sha256}</small></dd><dt>Link expires</dt><dd>${escapeHtml(displayTimestamp(metadata.expiresAt))}</dd></dl>
      <p><a class="button" href="?download=1">Download exact draft</a></p>
      <form method="post" enctype="multipart/form-data">
        <label for="senderEmail">Your email</label><input id="senderEmail" name="senderEmail" type="email" maxlength="320" required autocomplete="email">
        <label for="senderName">Your name (optional)</label><input id="senderName" name="senderName" maxlength="200" autocomplete="name">
        <label for="file">Reviewed document</label><input id="file" name="file" type="file" accept=".pdf,.docx,.rtf,.txt" aria-describedby="file-help" required>
        <small id="file-help">Accepted formats: PDF, DOCX, RTF, or plain text, up to 20 MiB. Review Word tracked changes, comments, fields, headers, footers, and hidden content in Microsoft Word before upload; Notice does not interpret them.</small>
        <button type="submit">Upload securely</button>
      </form>
      <p><small>Uploads are hash-verified, malware-scanned, and held for explicit human review. A round accepts at most four uploads and permits at most six rejected or failed attempts; retries and downloads remain bounded across replacement links for that round. Uploading does not accept contract terms.</small></p>
    `, requestId);
  } catch (error) {
    return serviceError(error, request, requestId);
  }
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const requestId = createRequestId();
  let reservation: NegotiationPortalUploadReservation | null = null;
  let consumedUploadBytes = 0;
  const guard = await guardMutationRequest(request, { requestId });
  if (!guard.ok) {
    return prefersHtml(request)
      ? publicError(request, "invalid_request_origin", "Submit the file from the secure exchange page that issued this form.", guard.response.status, requestId)
      : withResponseHeaders(guard.response, securityHeaders());
  }
  try {
    const token = tokenFrom((await context.params).token);
    if (!token) return publicError(request, "exchange_not_found", "This exchange link is unavailable.", 404, requestId);
    await ensureStorageSchema();
    reservation = await reserveNegotiationPortalUpload(token);
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      throw new NegotiationServiceError("unsupported_media_type", "Uploads must use multipart/form-data.", 415);
    }
    // Until the bounded body read completes, retain the full reservation on a
    // stream failure. A caller cannot make oversized/aborted bodies cost-free.
    consumedUploadBytes = reservation.reservedBytes;
    const rawBody = await readBoundedBody(
      request,
      MAX_MULTIPART_BODY_BYTES,
      `Maximum multipart body size is ${MAX_MULTIPART_BODY_BYTES} bytes`,
    );
    consumedUploadBytes = rawBody.byteLength;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    let form: FormData;
    try {
      form = await new Request(request.url, { method: "POST", headers, body: rawBody.buffer as ArrayBuffer }).formData();
    } catch {
      throw new NegotiationServiceError("invalid_multipart", "Upload must use valid multipart form data.", 400);
    }
    const files = form.getAll("file");
    if (files.length !== 1 || !(files[0] instanceof File)) {
      throw new NegotiationServiceError("document_required", "Upload exactly one reviewed document.", 400);
    }
    const file = files[0];
    if (file.size > MAX_DOCUMENT_BYTES) throw new NegotiationServiceError("payload_too_large", "The document exceeds the 20 MiB upload limit.", 413);
    const result = await ingestNegotiationSubmissions({
      workspaceId: reservation.workspaceId,
      agreementId: reservation.agreementId,
      roundId: reservation.roundId,
      source: "portal",
      portalTokenHash: reservation.tokenHash,
      portalReservation: reservation,
      portalConsumedBytes: consumedUploadBytes,
      senderEmail: oneString(form, "senderEmail", true),
      senderName: oneString(form, "senderName"),
      providerMessageId: `portal:${crypto.randomUUID()}`,
      attachments: [{
        fileName: file.name,
        declaredContentType: file.type || null,
        declaredSize: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }],
    });
    reservation = null;
    const rejected = result.submissions.some((submission) => submission.status === "rejected");
    const receipts = result.submissions.map((submission) => ({ receiptId: submission.id }));
    if ((request.headers.get("accept") ?? "").includes("application/json")) {
      return apiJson({ accepted: !rejected, recorded: true, receipts, requestId }, {
        status: rejected ? 422 : 201,
        requestId,
        headers: securityHeaders(),
      });
    }
    if (rejected) {
      return html(`<h1>Upload recorded but not accepted</h1><p><strong>${escapeHtml(file.name)}</strong> failed document validation or malware screening. Do not resend the same file.</p><p>Verify the source, create a safe replacement in PDF, DOCX, RTF, or plain-text format, then return to the exchange form.</p><p><small>Support reference: ${escapeHtml(requestId)}</small></p><p><a class="button" href="?">Return to the secure exchange</a></p>`, requestId, 422);
    }
    return html(`<h1>Upload received</h1><p><strong>${escapeHtml(file.name)}</strong> was captured as immutable evidence and is awaiting the organization’s human review.</p><p>Do not resubmit it unless the contract sender asks you to. You can safely close this page.</p><p><small>Receipt: ${escapeHtml(receipts[0]?.receiptId ?? requestId)} · Support reference: ${escapeHtml(requestId)}</small></p>`, requestId, 201);
  } catch (error) {
    if (reservation) {
      try {
        await recordNegotiationPortalUploadFailure(reservation, consumedUploadBytes);
      } catch (releaseError) {
        console.error("Failed to finalize a durable portal upload reservation", {
          requestId,
          reservationId: reservation.id,
          cause: releaseError instanceof Error ? releaseError.message : "unknown",
        });
      }
    }
    return serviceError(error, request, requestId);
  }
}
