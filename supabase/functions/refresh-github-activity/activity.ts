/**
 * Asking GitHub what members have been doing in open source, and reading the
 * answer.
 *
 * Pure — no Deno, no Supabase — so the Edge Function in index.ts and the Node
 * test suite (tests/github-activity.test.mjs) share exactly this code, the
 * same arrangement as refresh-repos/signals.ts.
 *
 * One GraphQL query carries, per member, an aliased `user` field (commits per
 * repository in the window, for the summary of their own repositories, and
 * the organisations they show publicly) and an aliased `search` for their
 * public pull requests updated in the window. Ten members cost one request.
 *
 * The search returns at most SEARCH_SIZE pull requests. When somebody's own
 * repositories fill it, a second search for just them leaves those owners
 * out, so their contributions elsewhere are not crowded off: see
 * `narrowSearch` and `buildSearchQuery`.
 *
 * "Their own" is wider than the repositories under their own login: a
 * repository of an organisation they belong to is their own work too, not a
 * contribution to somebody else's project. Otherwise a member who merges
 * their own pull requests into their company's repository fills the page.
 * And a repository the member wrote nearly alone is theirs too, whoever owns
 * it: see `buildAuthorQuery`.
 */

/** How many members go into one request. */
export const BATCH_SIZE = 10;
/** Pull requests updated in this many days are asked about. */
export const PULL_REQUEST_DAYS = 90;
/** Commits to a member's own repositories are summed over this many days. */
export const COMMIT_DAYS = 30;
/** Pull requests one search returns. */
export const SEARCH_SIZE = 50;
/** GitHub refuses a search query longer than this. */
const SEARCH_QUERY_MAX = 256;

/** One row of public.github_pull_requests, as the function writes it. */
export type PullRequestRow = {
  url: string;
  user_id: string;
  repo: string;
  number: number;
  title: string;
  state: "open" | "merged";
  opened_at: string;
  merged_at: string | null;
  checked_at: string;
  /** To the member's own repository or their organisation's: their own work, not a contribution. */
  own: boolean;
};

/** One row of public.github_commit_summaries. */
export type CommitSummaryRow = {
  user_id: string;
  commits: number;
  /** Most commits first. */
  repos: { repo: string; commits: number }[];
  last_commit_at: string | null;
  since: string;
  checked_at: string;
};

/**
 * A member to ask about: their login, and GitHub's numeric id for the account
 * they linked. The id is what is checked — a login can be renamed and then
 * taken by somebody else, the id cannot.
 */
export type Member = { id: string; handle: string; githubId?: number };

/** What GitHub said about one member; `found: false` when the account does not exist. */
export type MemberActivity =
  | { member: Member; found: false }
  | {
      member: Member;
      found: true;
      pullRequests: PullRequestRow[];
      summary: CommitSummaryRow | null;
      /** The pull request search failed: keep the rows already stored rather than clearing them. */
      searchFailed: boolean;
      /**
       * Owners to leave out of a second search, because their repositories
       * — the member's own — filled this one; empty when it was not full.
       */
      narrowSearch: string[];
    };

type GraphQLBody = { data?: Record<string, unknown> | null; errors?: Array<{ path?: unknown[]; message?: string }> };

const HANDLE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const REPO_KEY = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
/**
 * How GitHub says a pull request's author stands to the repository: they own
 * it, or belong to the organisation that does — even when that membership is
 * private, which `organizations` below cannot show.
 */
const INSIDER = new Set(["OWNER", "MEMBER"]);

/**
 * The GitHub username in a profile's github field — the same rule as
 * `githubHandle` in app/lib/oss.ts, which this function cannot import: a URL
 * to exactly one GitHub account, a bare handle, or an `@handle`.
 */
export function githubHandle(value: string): string {
  const raw = value.trim().replace(/^@/, "");
  if (!raw) return "";
  if (HANDLE.test(raw)) return raw;

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 1 && HANDLE.test(parts[0]) ? parts[0] : "";
  } catch {
    return "";
  }
}

export function daysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export function buildQuery(members: Member[], now: Date): string {
  const commitsSince = daysAgo(COMMIT_DAYS, now);

  const fields = members.map(({ handle }, index) => {
    return `
  u${index}: user(login: ${JSON.stringify(handle)}) {
    login
    databaseId
    organizations(first: 100) { nodes { login } }
    contributionsCollection(from: ${JSON.stringify(commitsSince)}) {
      commitContributionsByRepository(maxRepositories: 25) {
        repository { nameWithOwner isPrivate owner { login } }
        contributions(first: 1, orderBy: { field: OCCURRED_AT, direction: DESC }) { totalCount nodes { occurredAt } }
      }
    }
  }${searchField(index, handle, [], now)}`;
  });
  return `query {${fields.join("")}\n}`;
}

/**
 * The second search, for the members whose first one their own repositories
 * filled: the same aliases, so parseResponse can lay it over the first.
 */
export function buildSearchQuery(searches: { index: number; handle: string; exclude: string[] }[], now: Date): string {
  return `query {${searches.map(({ index, handle, exclude }) => searchField(index, handle, exclude, now)).join("")}\n}`;
}

function searchField(index: number, handle: string, exclude: string[], now: Date): string {
  // `is:public`: the function's token may be able to see private
  // repositories, and nothing private belongs on a public page.
  let search = `is:pr is:public author:${handle} updated:>=${daysAgo(PULL_REQUEST_DAYS, now).slice(0, 10)}`;
  // `-user:` leaves out an organisation's repositories as well as a person's.
  // Most crowded first, as many as fit.
  for (const owner of exclude) {
    if (search.length + ` -user:${owner}`.length > SEARCH_QUERY_MAX) break;
    search += ` -user:${owner}`;
  }
  return `
  p${index}: search(type: ISSUE, first: ${SEARCH_SIZE}, query: ${JSON.stringify(search)}) {
    issueCount
    nodes {
      ... on PullRequest {
        url number title state createdAt mergedAt authorAssociation
        repository { nameWithOwner isPrivate owner { login } }
      }
    }
  }`;
}

/** How many of a repository's latest commits are read to tell who writes it. */
const HISTORY_READ = 100;
/**
 * The share of those commits somebody must have written for the repository to
 * be theirs. "Most" would not do: a busy contributor to somebody else's
 * project can write more of it than its owner, and their pull requests there
 * are still contributions.
 */
const SOLO_SHARE = 0.8;
/** Repositories asked about in one author query. */
export const AUTHOR_REPOS_MAX = 40;

/**
 * A third question, for the repositories members sent pull requests to that
 * did not already count as their own: who wrote their latest commits.
 *
 * An organisation's membership can be private, and then neither
 * `organizations` nor the pull request's author association shows it — a
 * member's one-person project under an organisation reads as a contribution
 * to somebody else's, and tops the leaderboard with their own merges.
 * Whoever wrote nearly all of a repository's latest commits (SOLO_SHARE) is
 * its author; their pull requests to it are their own work.
 */
export function buildAuthorQuery(repos: string[]): string {
  const fields = repos.slice(0, AUTHOR_REPOS_MAX).flatMap((repo, index) => {
    if (!REPO_KEY.test(repo)) return [];
    const [owner, name] = repo.split("/");
    return [`
  a${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    defaultBranchRef { target { ... on Commit { history(first: ${HISTORY_READ}) { nodes { author { user { login } } } } } } }
  }`];
  });
  return `query {${fields.join("")}
}`;
}

/** Each repository asked about by buildAuthorQuery whose latest commits are nearly all one person's, with them, lower-cased. */
export function mainAuthorsOf(repos: string[], body: GraphQLBody): Map<string, string> {
  type History = { defaultBranchRef?: { target?: { history?: { nodes?: Array<{ author?: { user?: { login?: unknown } | null } | null } | null> } } | null } | null } | null;
  const authors = new Map<string, string>();
  repos.slice(0, AUTHOR_REPOS_MAX).forEach((repo, index) => {
    const node = body.data?.[`a${index}`] as History | undefined;
    const counts = new Map<string, number>();
    for (const commit of node?.defaultBranchRef?.target?.history?.nodes ?? []) {
      const login = commit?.author?.user?.login;
      if (typeof login === "string") counts.set(login.toLowerCase(), (counts.get(login.toLowerCase()) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    for (const [login, count] of counts) if (count >= total * SOLO_SHARE) authors.set(repo, login);
  });
  return authors;
}

/** The repositories a batch sent pull requests to that are not yet any member's own: what buildAuthorQuery asks about. */
export function authorQuestions(activities: MemberActivity[]): string[] {
  const repos = new Set<string>();
  for (const activity of activities) {
    if (!activity.found) continue;
    for (const pr of activity.pullRequests) if (!pr.own) repos.add(pr.repo);
  }
  return [...repos].sort().slice(0, AUTHOR_REPOS_MAX);
}

type Repository = { nameWithOwner?: unknown; isPrivate?: unknown; owner?: { login?: unknown } | null } | null | undefined;

type UserNode = {
  login?: unknown;
  databaseId?: unknown;
  organizations?: { nodes?: Array<{ login?: unknown } | null> | null } | null;
  contributionsCollection?: {
    commitContributionsByRepository?: Array<{
      repository?: Repository;
      contributions?: { totalCount?: unknown; nodes?: Array<{ occurredAt?: unknown } | null> | null } | null;
    } | null> | null;
  } | null;
} | null;

type PullRequestNode = {
  url?: unknown;
  number?: unknown;
  title?: unknown;
  state?: unknown;
  createdAt?: unknown;
  mergedAt?: unknown;
  authorAssociation?: unknown;
  repository?: Repository;
} | null;

/** `owner/name`, lower-cased, for a public repository; null otherwise. */
function publicRepo(repository: Repository): { key: string; owner: string } | null {
  if (!repository || repository.isPrivate !== false) return null;
  const key = String(repository.nameWithOwner ?? "").toLowerCase();
  if (!REPO_KEY.test(key)) return null;
  return { key, owner: String(repository.owner?.login ?? "").toLowerCase() };
}

/**
 * Splits what GitHub said into the two kinds of row.
 *
 * Pull requests are kept one by one: open, or merged in the window; one
 * closed without merging is dropped. Those to the member's own repositories —
 * under their login, or an organisation they belong to — are marked `own`:
 * their own work, shown apart from contributions. Commits to those
 * repositories are folded into a single summary, so a busy week on a side
 * project reads as one line rather than a page.
 * A search that failed comes back as no pull requests, and the caller keeps
 * what it had — the same caution as refresh-repos.
 *
 * `narrowed` is the answer to buildSearchQuery, when one was asked: its pull
 * requests join the first search's, which still decides whose repositories
 * are the member's own. `mainAuthors` comes from buildAuthorQuery: a
 * repository whose main author is the member is theirs as well.
 */
export function parseResponse(
  members: Member[],
  body: GraphQLBody,
  now: Date,
  narrowed?: GraphQLBody,
  mainAuthors: ReadonlyMap<string, string> = new Map(),
): MemberActivity[] {
  const data = body.data ?? {};
  const checkedAt = now.toISOString();
  const prsSince = Date.parse(daysAgo(PULL_REQUEST_DAYS, now));
  const failed = (answer: GraphQLBody, alias: string) =>
    answer.errors?.some((error) => Array.isArray(error.path) && error.path[0] === alias) ?? false;
  type Search = { issueCount?: unknown; nodes?: PullRequestNode[] | null } | null | undefined;

  return members.map((member, index) => {
    const user = data[`u${index}`] as UserNode | undefined;
    if (!user) return { member, found: false };
    // The login now belongs to a different account than the one linked: the
    // member renamed theirs and somebody took the old name. Nothing it shows
    // is theirs.
    if (member.githubId !== undefined && user.databaseId !== member.githubId) return { member, found: false };
    const searchFailed = failed(body, `p${index}`);
    const search = searchFailed ? undefined : (data[`p${index}`] as Search);
    const nodes = search?.nodes ?? [];

    // Whose repositories count as the member's own.
    const login = String(user.login ?? member.handle).toLowerCase();
    const owners = new Set([login]);
    const isOwn = (repo: { key: string; owner: string }) => owners.has(repo.owner) || mainAuthors.get(repo.key) === login;
    for (const org of user.organizations?.nodes ?? []) if (org?.login) owners.add(String(org.login).toLowerCase());
    for (const node of nodes) {
      const repo = publicRepo(node?.repository);
      if (repo && INSIDER.has(String(node?.authorAssociation ?? ""))) owners.add(repo.owner);
    }

    // A full search that the member's own repositories took places in.
    const crowding = new Map<string, number>();
    for (const node of nodes) {
      const repo = publicRepo(node?.repository);
      if (repo && owners.has(repo.owner)) crowding.set(repo.owner, (crowding.get(repo.owner) ?? 0) + 1);
    }
    const full = Number(search?.issueCount ?? 0) > nodes.length;
    const narrowSearch = full ? [...crowding].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([owner]) => owner) : [];

    const second = narrowed && !failed(narrowed, `p${index}`) ? (narrowed.data?.[`p${index}`] as Search) : undefined;
    const seen = new Set<string>();
    const pullRequests: PullRequestRow[] = [];
    for (const node of [...nodes, ...(second?.nodes ?? [])]) {
      if (!node) continue;
      const repo = publicRepo(node.repository);
      if (!repo) continue;
      if (seen.has(String(node.url))) continue;
      seen.add(String(node.url));
      const url = String(node.url ?? "");
      const number = Number(node.number);
      const openedAt = String(node.createdAt ?? "");
      if (!url.startsWith("https://github.com/") || !Number.isInteger(number) || !openedAt) continue;

      const mergedAt = typeof node.mergedAt === "string" ? node.mergedAt : null;
      if (node.state === "MERGED" && mergedAt && Date.parse(mergedAt) >= prsSince) {
        pullRequests.push(row(member, repo.key, url, number, node.title, "merged", openedAt, mergedAt, checkedAt, isOwn(repo)));
      } else if (node.state === "OPEN") {
        pullRequests.push(row(member, repo.key, url, number, node.title, "open", openedAt, null, checkedAt, isOwn(repo)));
      }
    }

    const own: { repo: string; commits: number }[] = [];
    let lastCommitAt: string | null = null;
    for (const entry of user.contributionsCollection?.commitContributionsByRepository ?? []) {
      const repo = publicRepo(entry?.repository);
      const commits = Number(entry?.contributions?.totalCount ?? 0);
      if (!repo || !isOwn(repo) || !Number.isInteger(commits) || commits <= 0) continue;
      own.push({ repo: repo.key, commits });
      const latest = entry?.contributions?.nodes?.[0]?.occurredAt;
      if (typeof latest === "string" && (!lastCommitAt || latest > lastCommitAt)) lastCommitAt = latest;
    }
    own.sort((a, b) => b.commits - a.commits || a.repo.localeCompare(b.repo));

    const summary: CommitSummaryRow | null =
      own.length === 0
        ? null
        : {
            user_id: member.id,
            commits: own.reduce((sum, entry) => sum + entry.commits, 0),
            repos: own,
            last_commit_at: lastCommitAt,
            since: daysAgo(COMMIT_DAYS, now).slice(0, 10),
            checked_at: checkedAt,
          };

    return { member, found: true, pullRequests, summary, searchFailed, narrowSearch };
  });
}

function row(
  member: Member,
  repo: string,
  url: string,
  number: number,
  title: unknown,
  state: "open" | "merged",
  openedAt: string,
  mergedAt: string | null,
  checkedAt: string,
  own: boolean,
): PullRequestRow {
  return {
    url,
    user_id: member.id,
    repo,
    number,
    title: String(title ?? "").slice(0, 300),
    state,
    opened_at: openedAt,
    merged_at: mergedAt,
    checked_at: checkedAt,
    own,
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}

/** One row of public.github_contributions. */
export type ContributionRow = { user_id: string; repo: string; first_merged_at: string; last_merged_at: string };

/**
 * The member's merged pull requests to other people's repositories folded
 * into one row per repository, kept
 * against what is already stored: the first merge stays the earliest ever
 * seen even after it has left the 90-day window, the last moves forward.
 */
export function contributionsFrom(pullRequests: PullRequestRow[], stored: ContributionRow[]): ContributionRow[] {
  const byRepo = new Map(stored.map((row) => [row.repo, { ...row }]));
  for (const pr of pullRequests) {
    if (pr.state !== "merged" || !pr.merged_at || pr.own) continue;
    const row = byRepo.get(pr.repo);
    if (!row) {
      byRepo.set(pr.repo, { user_id: pr.user_id, repo: pr.repo, first_merged_at: pr.merged_at, last_merged_at: pr.merged_at });
      continue;
    }
    if (pr.merged_at < row.first_merged_at) row.first_merged_at = pr.merged_at;
    if (pr.merged_at > row.last_merged_at) row.last_merged_at = pr.merged_at;
  }
  return [...byRepo.values()];
}

/**
 * How every `why` this function writes begins: what tells its suggestions
 * from a member's own, so forgetting somebody clears only the former. Keep in
 * step with 20261028000000_consent_cleanup.sql.
 */
export const SUGGESTION_PREFIX = "PR dari @";

/**
 * A repository put forward to the catalogue because a member's pull request
 * was merged into it — pending, for an admin to approve, with the evidence
 * as its reason. One per repository: the earliest merge stands for it.
 */
export function suggestionsFrom(pullRequests: PullRequestRow[], handle: string): { repo: string; why: string; submitted_by: string }[] {
  const first = new Map<string, PullRequestRow>();
  for (const pr of pullRequests) {
    if (pr.state !== "merged" || !pr.merged_at || pr.own) continue;
    const seen = first.get(pr.repo);
    if (!seen || pr.merged_at < (seen.merged_at ?? "")) first.set(pr.repo, pr);
  }
  return [...first.values()].map((pr) => ({
    repo: pr.repo,
    // oss_repos_why_length: 10 to 280 characters.
    why: `${SUGGESTION_PREFIX}${handle} sudah di-merge: ${pr.url}`.slice(0, 280),
    submitted_by: pr.user_id,
  }));
}
