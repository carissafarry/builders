/**
 * refresh-github-activity — keeps the /activity page current: members' pull
 * requests to other people's repositories, and a commit summary of their own,
 * read from GitHub so no page view ever waits on it.
 *
 * Called two ways, both from the database (see
 * 20261024000000_github_activity.sql):
 *
 *   - by pg_cron every half hour, with an empty body: every member who has
 *     agreed to be shown (profiles.github_activity_shown) and has linked a
 *     GitHub account (profiles.github_id, see 20261103000000_linked_github.sql);
 *   - by a trigger when somebody changes either of those, with
 *     `{ "users": ["<uuid>"] }`: just them, now.
 *
 * Nobody else is asked about at all: what has not been agreed to is not
 * gathered, not merely hidden.
 *
 * It answers 202 at once and works in the background, like refresh-repos.
 *
 * Deployed with `--no-verify-jwt`; the caller proves itself with the same
 * REFRESH_SECRET refresh-repos uses (Vault: refresh_repos_secret).
 *
 * Secrets: GITHUB_TOKEN (any read-only token; GraphQL requires one),
 * REFRESH_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by
 * the platform and never leave it.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.51.0";
import {
  authorQuestions,
  BATCH_SIZE,
  buildAuthorQuery,
  buildQuery,
  buildSearchQuery,
  chunk,
  contributionsFrom,
  githubHandle,
  mainAuthorsOf,
  parseResponse,
  SUGGESTION_PREFIX,
  suggestionsFrom,
  type ContributionRow,
  type Member,
  type MemberActivity,
} from "./activity.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve(async (request) => {
  const secret = Deno.env.get("REFRESH_SECRET");
  if (!secret || request.headers.get("x-refresh-secret") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const asked = Array.isArray(body?.users)
    ? body.users.filter((id: unknown): id is string => typeof id === "string" && UUID.test(id))
    : null;

  EdgeRuntime.waitUntil(
    refresh(asked).catch((error) => console.error(`[refresh-github-activity] ${error instanceof Error ? error.message : error}`)),
  );
  return new Response("Accepted", { status: 202 });
});

async function refresh(asked: string[] | null): Promise<void> {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) throw new Error("GITHUB_TOKEN is not set.");

  // Only accounts linked through OAuth (github_id set): a handle somebody
  // typed is not gathered, and the clean-up below clears what was.
  let request = supabase
    .from("profiles")
    .select("id, github, github_id")
    .eq("github_activity_shown", true)
    .neq("github", "")
    .not("github_id", "is", null);
  if (asked) request = request.in("id", asked);
  const { data, error } = await request;
  if (error) throw new Error(error.message);

  const members: Member[] = [];
  for (const row of data ?? []) {
    const handle = githubHandle(String(row.github ?? ""));
    const githubId = Number(row.github_id);
    if (handle && Number.isSafeInteger(githubId)) members.push({ id: row.id, handle, githubId });
  }

  // Somebody asked about who took their yes back, or has no GitHub account
  // any more: what was stored for them goes.
  const without = (asked ?? []).filter((id) => !members.some((member) => member.id === id));
  if (without.length > 0) await forget(supabase, without);
  // A full run also clears anyone who is no longer on the list at all.
  if (!asked) await forgetAllBut(supabase, members.map((member) => member.id));

  const now = new Date();
  for (const batch of chunk(members, BATCH_SIZE)) {
    const response = await askGitHub(token, buildQuery(batch, now));
    if (!response.ok) {
      // Leave every row as it was: yesterday's activity beats none.
      console.error(`[refresh-github-activity] GitHub answered ${response.status} for ${batch.length} members.`);
      continue;
    }
    const body = await response.json();
    let activities = parseResponse(batch, body, now);
    let narrowed: Parameters<typeof parseResponse>[3];

    // Somebody whose own repositories filled the search: ask again without
    // them. If that fails, the first answer stands.
    const narrow = activities.flatMap((activity, index) =>
      activity.found && activity.narrowSearch.length > 0 ? [{ index, handle: activity.member.handle, exclude: activity.narrowSearch }] : [],
    );
    if (narrow.length > 0) {
      const again = await askGitHub(token, buildSearchQuery(narrow, now));
      if (again.ok) narrowed = await again.json();
      else console.error(`[refresh-github-activity] GitHub answered ${again.status} to the narrowed search.`);
      activities = parseResponse(batch, body, now, narrowed);
    }

    // Who wrote the repositories they sent pull requests to: one written
    // mostly by the member is theirs, not a contribution. If GitHub does not
    // answer, the line drawn so far stands.
    const repos = authorQuestions(activities);
    if (repos.length > 0) {
      const authors = await askGitHub(token, buildAuthorQuery(repos));
      if (authors.ok) activities = parseResponse(batch, body, now, narrowed, mainAuthorsOf(repos, await authors.json()));
      else console.error(`[refresh-github-activity] GitHub answered ${authors.status} to the authors question.`);
    }

    for (const activity of activities) {
      await store(supabase, activity);
    }
  }
}

function askGitHub(token: string, query: string): Promise<Response> {
  return fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "builders-refresh-github-activity" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(25_000),
  });
}

async function store(supabase: SupabaseClient, activity: MemberActivity): Promise<void> {
  const id = activity.member.id;
  if (!activity.found) {
    // A handle GitHub does not know is a typo or a renamed account; nothing
    // stored under it can be trusted to be this person's any more.
    await forget(supabase, [id]);
    return;
  }

  if (!activity.searchFailed) {
    if (activity.pullRequests.length > 0) {
      const { error } = await supabase.from("github_pull_requests").upsert(activity.pullRequests, { onConflict: "url" });
      if (error) throw new Error(error.message);
    }
    // Closed without merging, or out of the window: gone from the page.
    let stale = supabase.from("github_pull_requests").delete().eq("user_id", id);
    if (activity.pullRequests.length > 0) stale = stale.not("url", "in", inList(activity.pullRequests.map((row) => row.url)));
    const { error } = await stale;
    if (error) throw new Error(error.message);

    await keepContributions(supabase, activity);
  }

  const { error } = activity.summary
    ? await supabase.from("github_commit_summaries").upsert(activity.summary, { onConflict: "user_id" })
    : await supabase.from("github_commit_summaries").delete().eq("user_id", id);
  if (error) throw new Error(error.message);
}

/**
 * Merged pull requests become lasting contributions — the directory's badges
 * and the profile's record — and a repository nobody has listed yet is put
 * forward to the catalogue as pending. See 20261027000100_github_contributions.sql.
 */
async function keepContributions(supabase: SupabaseClient, activity: Extract<MemberActivity, { found: true }>): Promise<void> {
  // A repository now known to be their own was never a contribution: what was
  // kept for it before goes.
  const ownRepos = [...new Set(activity.pullRequests.filter((pr) => pr.own).map((pr) => pr.repo))];
  if (ownRepos.length > 0) {
    const { error } = await supabase.from("github_contributions").delete().eq("user_id", activity.member.id).in("repo", ownRepos);
    if (error) throw new Error(error.message);
  }

  // Their own repositories' pull requests are their own work, not contributions.
  const merged = activity.pullRequests.filter((pr) => pr.state === "merged" && !pr.own);
  if (merged.length === 0) return;

  const { data, error } = await supabase
    .from("github_contributions")
    .select("user_id, repo, first_merged_at, last_merged_at")
    .eq("user_id", activity.member.id);
  if (error) throw new Error(error.message);

  const rows = contributionsFrom(merged, (data ?? []) as ContributionRow[]);
  const { error: saveError } = await supabase.from("github_contributions").upsert(rows, { onConflict: "user_id,repo" });
  if (saveError) throw new Error(saveError.message);

  // ignoreDuplicates: a repository already listed, pending or ever rejected
  // keeps exactly the row it has.
  const { error: suggestError } = await supabase
    .from("oss_repos")
    .upsert(
      suggestionsFrom(merged, activity.member.handle).map((row) => ({ ...row, list: "recommended", status: "pending" })),
      { onConflict: "repo", ignoreDuplicates: true },
    );
  if (suggestError) console.warn(`[refresh-github-activity] Could not put repositories forward: ${suggestError.message}`);
}

async function forget(supabase: SupabaseClient, ids: string[]): Promise<void> {
  for (const table of ["github_pull_requests", "github_commit_summaries", "github_contributions"]) {
    const { error } = await supabase.from(table).delete().in("user_id", ids);
    if (error) throw new Error(error.message);
  }
  await forgetSuggestions(supabase, ids, "only");
}

async function forgetAllBut(supabase: SupabaseClient, ids: string[]): Promise<void> {
  for (const table of ["github_pull_requests", "github_commit_summaries", "github_contributions"]) {
    let request = supabase.from(table).delete();
    request = ids.length > 0 ? request.not("user_id", "in", inList(ids)) : request.not("user_id", "is", null);
    const { error } = await request;
    if (error) throw new Error(error.message);
  }
  await forgetSuggestions(supabase, ids, "allBut");
}

/**
 * The repositories this function put forward for somebody who is forgotten:
 * one still waiting goes; one already reviewed stays — listed if approved,
 * and never put forward again if rejected — but no longer names them. A
 * member's own suggestions, made through the form, are theirs and are left
 * alone. See 20261028000000_consent_cleanup.sql.
 */
async function forgetSuggestions(supabase: SupabaseClient, ids: string[], which: "only" | "allBut"): Promise<void> {
  const ours = `${SUGGESTION_PREFIX}%`;
  let waiting = supabase.from("oss_repos").delete().eq("status", "pending").like("why", ours);
  let reviewed = supabase.from("oss_repos").update({ submitted_by: null, why: "" }).neq("status", "pending").like("why", ours);
  if (which === "only") {
    waiting = waiting.in("submitted_by", ids);
    reviewed = reviewed.in("submitted_by", ids);
  } else if (ids.length > 0) {
    waiting = waiting.not("submitted_by", "in", inList(ids));
    reviewed = reviewed.not("submitted_by", "in", inList(ids));
  } else {
    waiting = waiting.not("submitted_by", "is", null);
    reviewed = reviewed.not("submitted_by", "is", null);
  }
  for (const request of [waiting, reviewed]) {
    const { error } = await request;
    if (error) throw new Error(error.message);
  }
}

/** A PostgREST `in` list, each value quoted: URLs carry characters the bare form would split on. */
function inList(values: string[]): string {
  return `(${values.map((value) => `"${value.replace(/["\\]/g, "\\$&")}"`).join(",")})`;
}
