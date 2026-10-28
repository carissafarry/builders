/**
 * Asking GitHub about many repositories in one request, and reading the answer.
 *
 * Pure — no Deno, no Supabase — so the Edge Function in index.ts and the
 * Node test suite (tests/repo-signals.test.mjs) share exactly this code.
 *
 * One GraphQL query carries, per repository, an aliased `repository` field
 * (stars, language, last push, archived, who wrote the latest commits) and an
 * aliased `search` for pull requests merged since a date. Forty repositories cost one request instead
 * of eighty REST calls.
 */

/** `owner/name`, lower-cased: how oss_repos already stores a repository. */
export type RepoKey = string;

/** One row of public.repo_signals, as the function writes it. */
export type RepoSignal = {
  repo: RepoKey;
  stars: number | null;
  language: string;
  description: string;
  pushed_at: string | null;
  archived: boolean;
  /** Merged PRs from outside the project in the window; null when GitHub did not say. */
  outside_prs: number | null;
  checked_at: string;
  last_error: string | null;
};

/** How many repositories go into one request. */
export const BATCH_SIZE = 40;

const REPO_KEY = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

export function isRepoKey(value: string): value is RepoKey {
  return REPO_KEY.test(value);
}

/**
 * The repository a URL points at, as a key — the same narrow rule as
 * `parseGitHubRepositoryUrl` in the app: https, github.com, exactly
 * `owner/name`. Anything else is not a repository this job asks about.
 */
export function repoKeyFromUrl(value: string): RepoKey | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const key = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`.toLowerCase();
    return isRepoKey(key) ? key : null;
  } catch {
    return null;
  }
}

export function buildQuery(repos: RepoKey[], since: string): string {
  const fields = repos.map((repo, index) => {
    const [owner, name] = repo.split("/");
    const search = `repo:${repo} is:pr is:merged merged:>=${since}`;
    return `
  r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    stargazerCount
    description
    pushedAt
    isArchived
    primaryLanguage { name }
    defaultBranchRef { target { ... on Commit { history(first: ${HISTORY_READ}) { nodes { author { user { login } } } } } } }
  }
  s${index}: search(type: ISSUE, first: 100, query: ${JSON.stringify(search)}) {
    nodes { ... on PullRequest { authorAssociation author { __typename login } } }
  }`;
  });
  return `query {${fields.join("")}\n}`;
}

const INSIDE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** How many of the latest commits are read to tell who the repository's own author is. */
const HISTORY_READ = 100;

/**
 * Whoever wrote most of the latest commits, lower-cased, or null. Their pull
 * requests are the project's own work whatever GitHub calls them: somebody
 * whose membership of the owning organisation is private shows as a mere
 * CONTRIBUTOR on its repositories, and a one-person project would otherwise
 * read as one that merges outsiders.
 */
function mainAuthor(node: RepositoryNode): string | null {
  const counts = new Map<string, number>();
  for (const commit of node?.defaultBranchRef?.target?.history?.nodes ?? []) {
    const login = commit?.author?.user?.login;
    if (typeof login === "string") counts.set(login.toLowerCase(), (counts.get(login.toLowerCase()) ?? 0) + 1);
  }
  let top: string | null = null;
  for (const [login, count] of counts) if (top === null || count > counts.get(top)!) top = login;
  return top;
}

type RepositoryNode = {
  stargazerCount?: unknown;
  description?: unknown;
  pushedAt?: unknown;
  isArchived?: unknown;
  primaryLanguage?: { name?: unknown } | null;
  defaultBranchRef?: { target?: { history?: { nodes?: Array<{ author?: { user?: { login?: unknown } | null } | null } | null> } } | null } | null;
} | null;

type SearchNode = { nodes?: Array<{ authorAssociation?: unknown; author?: { __typename?: unknown; login?: unknown } | null } | null> } | null;

/**
 * One row per repository asked about. A repository GitHub could not find
 * comes back with `last_error` set and no numbers, so the caller can keep
 * whatever it knew before; a failed search leaves `outside_prs` null —
 * unknown, which the directory treats differently from none.
 */
export function parseResponse(
  repos: RepoKey[],
  body: { data?: Record<string, unknown> | null; errors?: Array<{ path?: unknown[]; message?: string }> },
  checkedAt: string,
): RepoSignal[] {
  const data = body.data ?? {};
  const errorFor = (alias: string) =>
    body.errors?.find((error) => Array.isArray(error.path) && error.path[0] === alias)?.message ?? null;

  return repos.map((repo, index) => {
    const node = data[`r${index}`] as RepositoryNode | undefined;
    const search = data[`s${index}`] as SearchNode | undefined;

    if (!node) {
      return {
        repo,
        stars: null,
        language: "",
        description: "",
        pushed_at: null,
        archived: false,
        outside_prs: null,
        checked_at: checkedAt,
        last_error: errorFor(`r${index}`) ?? "not found",
      };
    }

    // The repository's own people: its owner when that is a person, and
    // whoever writes most of it.
    const own = new Set([repo.split("/")[0], mainAuthor(node)].filter((login): login is string => Boolean(login)));
    const outside = search?.nodes
      ? search.nodes.filter(
          (pr) =>
            pr &&
            typeof pr.authorAssociation === "string" &&
            !INSIDE.has(pr.authorAssociation) &&
            pr.author?.__typename !== "Bot" &&
            !own.has(String(pr.author?.login ?? "").toLowerCase()),
        ).length
      : null;

    return {
      repo,
      stars: typeof node.stargazerCount === "number" ? node.stargazerCount : null,
      language: typeof node.primaryLanguage?.name === "string" ? node.primaryLanguage.name : "",
      description: typeof node.description === "string" ? node.description.slice(0, 200) : "",
      pushed_at: typeof node.pushedAt === "string" ? node.pushedAt : null,
      archived: node.isArchived === true,
      outside_prs: outside,
      checked_at: checkedAt,
      last_error: outside === null ? errorFor(`s${index}`) ?? "search failed" : null,
    };
  });
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}
