import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { githubFetch } from "@/lib/github-fetch";
import { getGithubToken, getGithubTokenStatus, isValidGithubToken, removeGithubToken, saveGithubToken } from "@/lib/github-token";
import { isApiRequestOriginAllowed } from "@/lib/request-security";
import { isRecord } from "@/lib/type-guards";

const noStore = { "cache-control": "no-store" };
const fail = (error: string, code: string, status: number) => Response.json({ error, code }, { status, headers: noStore });

function errorResponse(error: unknown): Response {
  if (error instanceof RequestBodyTooLargeError) return fail("Request body exceeds the allowed size", "body_too_large", 413);
  if (error instanceof SyntaxError || error instanceof TypeError) return fail("Invalid JSON request body", "invalid_json", 400);
  return fail("Could not update or test the GitHub token", "github_token_failed", 500);
}

export async function GET(request: Request) {
  if (!isApiRequestOriginAllowed(request)) return fail("Cross-origin API requests are not allowed", "cross_origin_forbidden", 403);
  try {
    return Response.json(getGithubTokenStatus(), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  if (!isApiRequestOriginAllowed(request)) return fail("Cross-origin API requests are not allowed", "cross_origin_forbidden", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return fail("Content-Type must be application/json", "unsupported_media_type", 415);
  try {
    const body = await parseJsonWithinLimit<unknown>(request, 4096);
    if (!isRecord(body) || Object.keys(body).length !== 1 || !isValidGithubToken(body.token)) return fail("Invalid GitHub token", "invalid_github_token", 400);
    saveGithubToken(body.token);
    return Response.json(getGithubTokenStatus(), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  if (!isApiRequestOriginAllowed(request)) return fail("Cross-origin API requests are not allowed", "cross_origin_forbidden", 403);
  try {
    removeGithubToken();
    return Response.json(getGithubTokenStatus(), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Test only the effective server credential; browser requests never receive it. */
export async function POST(request: Request) {
  if (!isApiRequestOriginAllowed(request)) return fail("Cross-origin API requests are not allowed", "cross_origin_forbidden", 403);
  try {
    const response = await githubFetch("https://api.github.com/rate_limit", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ompweb" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    }, getGithubToken());
    if (!response.ok) {
      await response.body?.cancel();
      return Response.json({ ...getGithubTokenStatus(), error: "GitHub token test failed", code: "github_token_test_failed" }, { status: 502, headers: noStore });
    }
    const data: unknown = await response.json();
    const core = isRecord(data) && isRecord(data.resources) ? data.resources.core : undefined;
    if (!isRecord(core) || !Number.isSafeInteger(core.limit) || (core.limit as number) < 0) return fail("GitHub returned an invalid rate limit", "github_rate_limit_invalid", 502);
    return Response.json({ ...getGithubTokenStatus(), limit: core.limit }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}
