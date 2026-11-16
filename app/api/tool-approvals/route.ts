import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { clear, isToolApprovalGrant, list, revoke } from "@/lib/tool-approval-store";
import { bumpToolApprovalClearGeneration, bumpToolApprovalGeneration, withToolPolicyLock } from "@/lib/tool-policy-lock";
import { isRecord } from "@/lib/type-guards";

const MAX_REQUEST_BYTES = 4096;

export function GET(): Response {
  return Response.json({ grants: list() });
}

export async function DELETE(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit(req, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
    }
    return Response.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }

  if (isRecord(body) && Object.keys(body).length === 1 && body.all === true) {
    return Response.json({ cleared: withToolPolicyLock((lock) => {
      bumpToolApprovalClearGeneration(lock);
      return clear();
    }) });
  }
  if (!isToolApprovalGrant(body)) {
    return Response.json({ error: "Expected one grant identity or { all: true }", code: "invalid_request" }, { status: 400 });
  }
  return Response.json({ revoked: withToolPolicyLock((lock) => {
    bumpToolApprovalGeneration(lock, body.sessionId, body.resourceType, body.resourceKey, body.capability);
    return revoke(body.sessionId, body.resourceType, body.resourceKey, body.capability);
  }) });
}
