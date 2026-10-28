import { parseReadme, type ReadmeBlock } from "./readme";

/**
 * A member's open source work as GitHub tells it, for their profile: the
 * repositories they pinned, the year's contribution counts, the pull requests
 * still open on other people's repositories, and where their merged ones
 * landed.
 *
 * "Other people's" means a repository neither under their own login nor one
 * whose owner they belong to (GitHub's OWNER / MEMBER author association) —
 * the same line /activity draws between contributions and own work.
 *
 * Their profile README comes with it, as the description: see readme.ts.
 *
 * No Next.js or Supabase imports, so tests/github-profile.test.mjs can call
 * these directly; data.ts does the fetching and the caching.
 */

/** How many merged pull requests are read to group by repository. */
export const MERGED_READ = 100;
/** How many open pull requests are read. */
export const OPEN_READ = 30;

export type PinnedRepo = {
  repo: string;
  url: string;
  description: string;
  stars: number;
  language: { name: string; color: string } | null;
};

export type OpenPullRequest = { repo: string; title: string; url: string; number: number; openedAt: string; draft: boolean };

export type MergedRepo = { repo: string; url: string; merged: number; lastMergedAt: string; stars: number };

export type GitHubProfile = {
  login: string;
  /** The profile README's words, or none. */
  readme: ReadmeBlock[];
  pinned: PinnedRepo[];
  /** This year's numbers, from GitHub's contribution calendar. */
  year: { contributions: number; commits: number; pullRequests: number; reviews: number };
  /** Repositories of other people they have opened a pull request to, ever. */
  reposContributedTo: number;
  open: OpenPullRequest[];
  merged: {
    /** Merged pull requests to other people's repositories, all of them. */
    count: number;
    /** More were merged than were read, so `repos` covers the latest ones only. */
    more: boolean;
    repos: MergedRepo[];
  };
};

const INSIDER = new Set(["OWNER", "MEMBER"]);
const HANDLE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/**
 * The first of two GraphQL requests for one member: who they are, the
 * organisations they belong to — whose repositories count as their own — and
 * the numbers. Null for a login that is not plainly one.
 */
export function buildProfileQuery(login: string): { query: string; variables: Record<string, string> } | null {
  if (!HANDLE.test(login)) return null;
  return {
    query: `query($login: String!) {
  user(login: $login) {
    login
    databaseId
    organizations(first: 100) { nodes { login } }
    pinnedItems(first: 6, types: [REPOSITORY]) {
      nodes { ... on Repository { nameWithOwner url description stargazerCount isPrivate primaryLanguage { name color } } }
    }
    contributionsCollection {
      contributionCalendar { totalContributions }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
    }
    repositoriesContributedTo(first: 1, contributionTypes: [PULL_REQUEST], includeUserRepositories: false) { totalCount }
  }
  readme: repository(owner: $login, name: $login) {
    isPrivate
    object(expression: "HEAD:README.md") { ... on Blob { text } }
  }
}`,
    variables: { login },
  };
}

/** The organisations in the first answer, to leave out of the searches. */
export function organisationsOf(body: unknown): string[] {
  const user = (body as { data?: { user?: { organizations?: { nodes?: Array<{ login?: unknown } | null> } } } } | null)?.data?.user;
  return (user?.organizations?.nodes ?? []).flatMap((node) => (typeof node?.login === "string" && HANDLE.test(node.login) ? [node.login] : []));
}

/**
 * The second request: their open and merged pull requests, leaving out their
 * own repositories and their organisations' at the search, so the hundred read
 * are all other people's and the count is GitHub's own.
 */
export function buildPullRequestQuery(login: string, organisations: string[]): { query: string; variables: Record<string, string> } | null {
  if (!HANDLE.test(login)) return null;
  const outside = [`-user:${login}`, ...organisations.filter((org) => HANDLE.test(org)).map((org) => `-org:${org}`)].join(" ");
  const pr = `... on PullRequest { title url number createdAt mergedAt isDraft authorAssociation repository { nameWithOwner url stargazerCount isPrivate owner { login } } }`;
  return {
    query: `query($open: String!, $merged: String!) {
  open: search(type: ISSUE, first: ${OPEN_READ}, query: $open) { nodes { ${pr} } }
  merged: search(type: ISSUE, first: ${MERGED_READ}, query: $merged) { issueCount nodes { ${pr} } }
}`,
    variables: {
      open: `is:pr is:public is:open archived:false author:${login} ${outside} sort:created-desc`,
      merged: `is:pr is:public is:merged author:${login} ${outside} sort:updated-desc`,
    },
  };
}

/** How many of a repository's latest commits are read to tell who writes it. */
const HISTORY_READ = 100;
/** The share of them somebody must have written for the repository to be theirs. */
const SOLO_SHARE = 0.8;
/** Repositories asked about in the third request. */
const AUTHOR_REPOS_MAX = 40;

/**
 * The repositories in the second answer, for the third request: who wrote
 * them. An organisation membership can be private, and then neither the
 * organisation list nor the author association shows it — a member's
 * one-person project under an organisation would read as somebody else's.
 * The same rule as refresh-github-activity, so the profile and /activity
 * agree on what is a contribution.
 */
export function pullRequestRepos(pullRequestBody: unknown): string[] {
  const data = (pullRequestBody as { data?: Record<string, { nodes?: PullRequestNode[] } | null> | null } | null)?.data ?? {};
  const repos = new Set<string>();
  for (const search of [data.open, data.merged]) {
    for (const node of search?.nodes ?? []) {
      const repo = node?.repository?.nameWithOwner;
      if (typeof repo === "string" && REPO.test(repo)) repos.add(repo.toLowerCase());
    }
  }
  return [...repos].sort().slice(0, AUTHOR_REPOS_MAX);
}

export function buildAuthorQuery(repos: string[]): { query: string } | null {
  const fields = repos.slice(0, AUTHOR_REPOS_MAX).flatMap((repo, index) => {
    if (!REPO.test(repo)) return [];
    const [owner, name] = repo.split("/");
    return [`
  a${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    defaultBranchRef { target { ... on Commit { history(first: ${HISTORY_READ}) { nodes { author { user { login } } } } } } }
  }`];
  });
  return fields.length > 0 ? { query: `query {${fields.join("")}\n}` } : null;
}

/** Those of `repos` whose latest commits `login` wrote nearly all of. */
export function soloReposOf(repos: string[], authorBody: unknown, login: string): Set<string> {
  type History = { defaultBranchRef?: { target?: { history?: { nodes?: Array<{ author?: { user?: { login?: unknown } | null } | null } | null> } } | null } | null } | null;
  const data = (authorBody as { data?: Record<string, History> | null } | null)?.data ?? {};
  const solo = new Set<string>();
  repos.slice(0, AUTHOR_REPOS_MAX).forEach((repo, index) => {
    const nodes = data[`a${index}`]?.defaultBranchRef?.target?.history?.nodes ?? [];
    const logins = nodes.flatMap((commit) => (typeof commit?.author?.user?.login === "string" ? [commit.author.user.login.toLowerCase()] : []));
    const theirs = logins.filter((author) => author === login.toLowerCase()).length;
    if (logins.length > 0 && theirs >= logins.length * SOLO_SHARE) solo.add(repo);
  });
  return solo;
}

const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/i;

type Repository = { nameWithOwner?: unknown; url?: unknown; stargazerCount?: unknown; isPrivate?: unknown; owner?: { login?: unknown } | null } | null;
type PullRequestNode = {
  title?: unknown;
  url?: unknown;
  number?: unknown;
  createdAt?: unknown;
  mergedAt?: unknown;
  isDraft?: unknown;
  authorAssociation?: unknown;
  repository?: Repository;
} | null;

/**
 * What GitHub answered, shaped for the profile; null when the account is
 * missing or is not the one linked (`githubId`: a login renamed and then taken
 * by somebody else must not show their work). `solo` is soloReposOf's answer:
 * repositories that are the member's own whoever owns them.
 */
export function parseProfile(profileBody: unknown, pullRequestBody: unknown, githubId?: number | null, solo: ReadonlySet<string> = new Set()): GitHubProfile | null {
  const profileData = (profileBody as { data?: { user?: Record<string, unknown> | null; readme?: { isPrivate?: unknown; object?: { text?: unknown } | null } | null } | null } | null)?.data;
  const user = profileData?.user;
  const data = (pullRequestBody as { data?: Record<string, unknown> | null } | null)?.data ?? null;
  if (!user || typeof user.login !== "string") return null;
  if (githubId != null && user.databaseId !== githubId) return null;
  const login = user.login;
  const own = (node: PullRequestNode) => {
    const owner = String(node?.repository?.owner?.login ?? "").toLowerCase();
    return (
      owner === login.toLowerCase() ||
      INSIDER.has(String(node?.authorAssociation ?? "")) ||
      solo.has(String(node?.repository?.nameWithOwner ?? "").toLowerCase())
    );
  };
  const usable = (node: PullRequestNode) =>
    Boolean(node && typeof node.url === "string" && typeof node.repository?.nameWithOwner === "string" && node.repository?.isPrivate !== true) && !own(node);

  const pinnedNodes = ((user.pinnedItems as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<Record<string, unknown> | null>;
  const pinned: PinnedRepo[] = pinnedNodes.flatMap((node) => {
    if (!node || typeof node.nameWithOwner !== "string" || typeof node.url !== "string" || node.isPrivate === true) return [];
    const language = node.primaryLanguage as { name?: unknown; color?: unknown } | null;
    return [{
      repo: node.nameWithOwner,
      url: node.url,
      description: typeof node.description === "string" ? node.description : "",
      stars: Number(node.stargazerCount) || 0,
      language: language && typeof language.name === "string" ? { name: language.name, color: typeof language.color === "string" ? language.color : "" } : null,
    }];
  });

  const collection = (user.contributionsCollection ?? {}) as Record<string, unknown>;
  const calendar = (collection.contributionCalendar ?? {}) as Record<string, unknown>;
  const year = {
    contributions: Number(calendar.totalContributions) || 0,
    commits: Number(collection.totalCommitContributions) || 0,
    pullRequests: Number(collection.totalPullRequestContributions) || 0,
    reviews: Number(collection.totalPullRequestReviewContributions) || 0,
  };
  const reposContributedTo = Number((user.repositoriesContributedTo as { totalCount?: unknown } | undefined)?.totalCount) || 0;

  const openNodes = (((data?.open as { nodes?: unknown[] } | undefined)?.nodes ?? []) as PullRequestNode[]).filter(usable);
  const open: OpenPullRequest[] = openNodes.map((node) => ({
    repo: String(node!.repository!.nameWithOwner),
    title: String(node!.title ?? ""),
    url: String(node!.url),
    number: Number(node!.number) || 0,
    openedAt: String(node!.createdAt ?? ""),
    draft: node!.isDraft === true,
  }));

  const mergedSearch = (data?.merged ?? {}) as { issueCount?: unknown; nodes?: unknown[] };
  const mergedRead = (mergedSearch.nodes ?? []) as PullRequestNode[];
  const mergedNodes = mergedRead.filter(usable);
  const byRepo = new Map<string, MergedRepo>();
  for (const node of mergedNodes) {
    const repo = String(node!.repository!.nameWithOwner);
    const mergedAt = String(node!.mergedAt ?? "");
    const entry = byRepo.get(repo) ?? { repo, url: String(node!.repository!.url ?? `https://github.com/${repo}`), merged: 0, lastMergedAt: "", stars: Number(node!.repository!.stargazerCount) || 0 };
    entry.merged += 1;
    if (mergedAt > entry.lastMergedAt) entry.lastMergedAt = mergedAt;
    byRepo.set(repo, entry);
  }
  const repos = [...byRepo.values()].sort((a, b) => b.merged - a.merged || b.lastMergedAt.localeCompare(a.lastMergedAt));

  // No profile repository is a GraphQL error beside the user, not a failure.
  const readmeRepo = profileData?.readme;
  const readme = readmeRepo && readmeRepo.isPrivate !== true && typeof readmeRepo.object?.text === "string" ? parseReadme(readmeRepo.object.text) : [];

  return {
    login,
    readme,
    pinned,
    year,
    reposContributedTo,
    open,
    merged: {
      // GitHub's count, less any the search let through that were their own
      // after all (an organisation membership the list above could not show).
      count: Math.max(Number(mergedSearch.issueCount) || 0, mergedRead.length) - (mergedRead.length - mergedNodes.length),
      more: Number(mergedSearch.issueCount) > mergedRead.length,
      repos,
    },
  };
}
