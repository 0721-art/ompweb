import { getGitHubReleaseNotes } from "@/lib/github-release-notes";
import { checkNpmUpdate } from "@/lib/npm-update";
import { checkPrereleaseUpdate } from "@/lib/ompweb-releases";
import { getGithubToken } from "@/lib/github-token";
import { getHostUpdateSettings } from "@/lib/hosts/hub";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function noContent(): Response {
  return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
}

export async function GET() {
  try {
    const channel = await getHostUpdateSettings("local").then((settings) => settings.ompwebChannel, () => "stable");
    const status = channel === "prerelease" ? await checkPrereleaseUpdate(false, getGithubToken()) : await checkNpmUpdate(false);
    if (!status.updateAvailable || !status.availableVersion) return noContent();

    const notes = await getGitHubReleaseNotes(status.availableVersion);
    if (!notes || notes.version !== status.availableVersion) return noContent();
    return Response.json(notes, { headers: NO_STORE_HEADERS });
  } catch {
    return noContent();
  }
}
