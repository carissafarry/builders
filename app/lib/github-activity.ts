import type { GitHubCommitSummaryRow, GitHubPullRequestRow } from "./database.types";

/**
 * The /activity feed: what members have been doing in open source, read from
 * GitHub by the refresh-github-activity Edge Function.
 *
 * Two kinds of entry. Pull requests to somebody else's repository come one
 * entry per person, repository, state and day, so a busy afternoon on one
 * project is one line with its PRs under it rather than a screenful. A
 * member's own work — commits and merged pull requests on their own or their
 * organisation's repositories — is one summary line per person, so a busy
 * week on a side project does not bury everybody else.
 *
 * The two are the page's scopes, toggled like the directory's local and
 * global: contributions, which the page exists to show and opens on, and
 * members' own work.
 */

export type ActivityPerson = { id: string; username: string; name: string; handle: string };

export type PullRequestItem = {
  url: string;
  number: number;
  title: string;
  /** When it was merged, or opened while it is still open. */
  at: string;
  /** When it was opened: the week it counts for on the board. */
  openedAt: string;
};

export type PullRequestEntry = {
  kind: "pull_request";
  key: string;
  person: ActivityPerson;
  repo: string;
  /**
   * The day's first pull request: what reactions are left on. Later ones that
   * day join the entry without moving its reactions.
   */
  url: string;
  state: "open" | "merged";
  /** Newest first; at least one. */
  pullRequests: PullRequestItem[];
  /** The newest pull request's time: what the feed sorts by. */
  at: string;
};

export type CommitSummaryEntry = {
  kind: "commit_summary";
  key: string;
  person: ActivityPerson;
  /** Commits in the last SUMMARY_DAYS. */
  commits: number;
  /** Pull requests merged into their own repositories in the same SUMMARY_DAYS. */
  merged: number;
  /** Most commits first, then those with only pull requests. */
  repos: { repo: string; commits: number }[];
  since: string;
  at: string;
};

export type GitHubActivityEntry = PullRequestEntry | CommitSummaryEntry;

/** The window a member's own work is summed over: COMMIT_DAYS in refresh-github-activity. */
export const SUMMARY_DAYS = 30;

/** What kind of entry: a merged PR, one in review, or work on one's own repositories. */
export type GitHubActivityFilter = "all" | "merged" | "open" | "commits";

export function isGitHubActivityFilter(value: string): value is GitHubActivityFilter {
  return value === "all" || value === "merged" || value === "open" || value === "commits";
}

/**
 * Whose repositories: other people's (contributions), the member's own, or
 * both. In the toggle's order; the page opens on "external".
 */
export const ACTIVITY_SCOPES = ["all", "external", "own"] as const;
export type ActivityScope = (typeof ACTIVITY_SCOPES)[number];

export function isActivityScope(value: string): value is ActivityScope {
  return (ACTIVITY_SCOPES as readonly string[]).includes(value);
}

export function scopeOf(entry: GitHubActivityEntry): Exclude<ActivityScope, "all"> {
  return entry.kind === "commit_summary" ? "own" : "external";
}

/** How many entries each scope shows. */
export function scopeCounts(entries: GitHubActivityEntry[]): Record<ActivityScope, number> {
  const counts: Record<ActivityScope, number> = { all: entries.length, external: 0, own: 0 };
  for (const entry of entries) counts[scopeOf(entry)] += 1;
  return counts;
}

/** The entries one scope shows. */
export function inScope(entries: GitHubActivityEntry[], scope: ActivityScope): GitHubActivityEntry[] {
  return scope === "all" ? entries : entries.filter((entry) => scopeOf(entry) === scope);
}

/**
 * Where a contribution went: a local repository — one the directory counts
 * as local, a community member's project or one with Indonesian maintainers —
 * or a global one. Only pull requests to other people's repositories have a
 * place; a member's own work is neither.
 */
export const ACTIVITY_PLACES = ["all", "local", "global"] as const;
export type ActivityPlace = (typeof ACTIVITY_PLACES)[number];

export function isActivityPlace(value: string): value is ActivityPlace {
  return (ACTIVITY_PLACES as readonly string[]).includes(value);
}

/** The entries one place shows. Narrowing to a place leaves out members' own work. */
export function inPlace(entries: GitHubActivityEntry[], place: ActivityPlace, local: ReadonlySet<string>): GitHubActivityEntry[] {
  if (place === "all") return entries;
  return entries.filter((entry) => entry.kind === "pull_request" && local.has(entry.repo) === (place === "local"));
}

/** How many pull request entries went to local and to global repositories. */
export function placeCounts(entries: GitHubActivityEntry[], local: ReadonlySet<string>): Record<ActivityPlace, number> {
  const counts: Record<ActivityPlace, number> = { all: 0, local: 0, global: 0 };
  for (const entry of entries) {
    if (entry.kind !== "pull_request") continue;
    counts.all += 1;
    counts[local.has(entry.repo) ? "local" : "global"] += 1;
  }
  return counts;
}

function kindOf(entry: GitHubActivityEntry): Exclude<GitHubActivityFilter, "all"> {
  return entry.kind === "commit_summary" ? "commits" : entry.state;
}

export function buildGitHubActivity(
  pullRequests: (GitHubPullRequestRow & { person: ActivityPerson | null })[],
  summaries: (GitHubCommitSummaryRow & { person: ActivityPerson | null })[],
  timeZone = "Asia/Jakarta",
  now = new Date(),
): GitHubActivityEntry[] {
  const entries: GitHubActivityEntry[] = [];
  const summarySince = new Date(now.getTime() - SUMMARY_DAYS * 86_400_000).toISOString();

  // A member's own work, gathered per person: their commit summary, and the
  // pull requests merged into their own repositories.
  const own = new Map<string, CommitSummaryEntry>();
  const ownOf = (person: ActivityPerson, userId: string) => {
    let entry = own.get(userId);
    if (!entry) own.set(userId, (entry = { kind: "commit_summary", key: `commits:${userId}`, person, commits: 0, merged: 0, repos: [], since: "", at: "" }));
    return entry;
  };

  for (const row of summaries) {
    if (!row.person || row.commits <= 0 || !Array.isArray(row.repos) || row.repos.length === 0) continue;
    const entry = ownOf(row.person, row.user_id);
    entry.commits = row.commits;
    entry.repos = [...row.repos];
    entry.since = row.since;
    entry.at = row.last_commit_at ?? row.checked_at;
  }

  const groups = new Map<string, { person: ActivityPerson; repo: string; state: "open" | "merged"; items: PullRequestItem[] }>();
  for (const row of pullRequests) {
    if (!row.person || (row.state !== "open" && row.state !== "merged")) continue;
    const at = row.state === "merged" && row.merged_at ? row.merged_at : row.opened_at;
    if (row.own) {
      // Merged within the summary's window is counted; still in review on
      // their own repository is not news.
      if (row.state !== "merged" || at < summarySince) continue;
      const entry = ownOf(row.person, row.user_id);
      entry.merged += 1;
      if (!entry.repos.some((each) => each.repo === row.repo)) entry.repos.push({ repo: row.repo, commits: 0 });
      if (at > entry.at) entry.at = at;
      continue;
    }
    const group = `${row.person.id} ${row.repo} ${row.state} ${dayKey(at, timeZone)}`;
    const found = groups.get(group) ?? { person: row.person, repo: row.repo, state: row.state, items: [] };
    found.items.push({ url: row.url, number: row.number, title: row.title, at, openedAt: row.opened_at });
    groups.set(group, found);
  }
  for (const { person, repo, state, items } of groups.values()) {
    items.sort((a, b) => b.at.localeCompare(a.at) || b.number - a.number);
    const first = items[items.length - 1];
    entries.push({ kind: "pull_request", key: first.url, person, repo, url: first.url, state, pullRequests: items, at: items[0].at });
  }
  entries.push(...own.values());

  return entries.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

/** The short name a summary shows: `builders` for zikrulihsan/builders. */
export function repoName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

export type ActivityQuery = { kind: GitHubActivityFilter; member: string; repo: string; q: string };

/** The repositories an entry touches: its PR's, or every one in a summary. */
function reposOf(entry: GitHubActivityEntry): string[] {
  return entry.kind === "pull_request" ? [entry.repo] : entry.repos.map((each) => each.repo);
}

/**
 * The feed as the sidebar and the search box ask for it. Each part narrows on
 * its own; empty means "any". The search reads the PR's title, the
 * repositories and the person's name and handle.
 */
export function queryActivity(entries: GitHubActivityEntry[], query: ActivityQuery): GitHubActivityEntry[] {
  const member = query.member.toLowerCase();
  const needle = query.q.trim().toLowerCase();
  return entries.filter((entry) => {
    if (query.kind !== "all" && kindOf(entry) !== query.kind) return false;
    if (member && entry.person.handle.toLowerCase() !== member) return false;
    if (query.repo && !reposOf(entry).includes(query.repo)) return false;
    if (!needle) return true;
    const titles = entry.kind === "pull_request" ? entry.pullRequests.map((pr) => pr.title) : [];
    const haystack = [...titles, ...reposOf(entry), entry.person.name, entry.person.handle]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** How many pull requests an entry stands for; none for a commit summary. */
function pullRequestCount(entry: GitHubActivityEntry): number {
  return entry.kind === "pull_request" ? entry.pullRequests.length : 0;
}

/** How many entries of each kind, for the sidebar: what each filter lists. */
export function kindCounts(entries: GitHubActivityEntry[]): Record<GitHubActivityFilter, number> {
  const counts: Record<GitHubActivityFilter, number> = { all: entries.length, merged: 0, open: 0, commits: 0 };
  for (const entry of entries) counts[kindOf(entry)] += 1;
  return counts;
}

/** Repositories pull requests went to, most first: the sidebar's repository group. */
export function activityRepos(entries: GitHubActivityEntry[]): { repo: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.kind === "pull_request") counts.set(entry.repo, (counts.get(entry.repo) ?? 0) + pullRequestCount(entry));
  return [...counts].map(([repo, count]) => ({ repo, count })).sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

/**
 * The orders the "where PRs went" card offers. Newest first by default, so
 * one very busy repository does not sit on top for good; most PRs, or the
 * most people, when asked — the last one being the repos many members have
 * found their way to, not one member's favourite.
 */
export const REPO_ORDERS = ["recent", "prs", "people"] as const;
export type RepoOrder = (typeof REPO_ORDERS)[number];

export function isRepoOrder(value: string): value is RepoOrder {
  return (REPO_ORDERS as readonly string[]).includes(value);
}

export type RepoSummary = {
  repo: string;
  /** Pull requests to it in the entries given. */
  prs: number;
  /** The members who sent them, the most recent first. */
  people: ActivityPerson[];
  /** The newest of those pull requests. */
  lastAt: string;
};

/** Every repository the pull requests went to, with who went and when, in the order asked for. */
export function repoSummaries(entries: GitHubActivityEntry[], order: RepoOrder = "recent"): RepoSummary[] {
  const byRepo = new Map<string, { prs: number; people: Map<string, { person: ActivityPerson; at: string }>; lastAt: string }>();
  for (const entry of entries) {
    if (entry.kind !== "pull_request") continue;
    const found = byRepo.get(entry.repo) ?? { prs: 0, people: new Map(), lastAt: "" };
    found.prs += entry.pullRequests.length;
    if (entry.at > found.lastAt) found.lastAt = entry.at;
    const key = entry.person.handle.toLowerCase();
    const seen = found.people.get(key);
    if (!seen || entry.at > seen.at) found.people.set(key, { person: entry.person, at: entry.at });
    byRepo.set(entry.repo, found);
  }
  const rows = [...byRepo].map(([repo, { prs, people, lastAt }]) => ({
    repo,
    prs,
    lastAt,
    people: [...people.values()].sort((a, b) => b.at.localeCompare(a.at)).map(({ person }) => person),
  }));
  const newest = (a: RepoSummary, b: RepoSummary) => b.lastAt.localeCompare(a.lastAt);
  return rows.sort((a, b) =>
    order === "prs"
      ? b.prs - a.prs || newest(a, b)
      : order === "people"
        ? b.people.length - a.people.length || b.prs - a.prs || newest(a, b)
        : newest(a, b) || a.repo.localeCompare(b.repo),
  );
}

/** Everybody on the page, most active first: the member filter's chips. */
export function activityPeople(entries: GitHubActivityEntry[]): { person: ActivityPerson; count: number }[] {
  const byHandle = new Map<string, { person: ActivityPerson; count: number }>();
  for (const entry of entries) {
    const key = entry.person.handle.toLowerCase();
    const found = byHandle.get(key) ?? { person: entry.person, count: 0 };
    // Their own merged pull requests count too: what is showing is what they did.
    found.count += entry.kind === "pull_request" ? pullRequestCount(entry) : entry.merged;
    byHandle.set(key, found);
  }
  return [...byHandle.values()].sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name));
}

/**
 * The Monday that starts the week `day` is in, as `YYYY-MM-DD`. Calendar
 * arithmetic on the date alone, so it is the same on the server and in the
 * browser.
 */
export function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** How many weeks the board looks back over, this one included. */
export const CONSISTENCY_WEEKS = 12;

export type ConsistencyRow = {
  person: ActivityPerson;
  /** Each of the last CONSISTENCY_WEEKS weeks, oldest first: whether a pull request was opened in it. */
  weeks: boolean[];
  /** How many of them did. */
  filled: number;
  /** Weeks in a row up to this one — or up to last week, while this one is still empty. */
  streak: number;
  repos: number;
  prs: number;
};

/**
 * The leaderboard: who keeps contributing, not who sent the most. A week
 * counts when a pull request to somebody else's repository was opened in it —
 * in review or merged by default, or only one of the two when the feed's kind
 * filter asks. One closed without merging never counts: the Edge Function
 * drops it. Weeks run Monday to Sunday in WIB, where the members live.
 *
 * Ranked by weeks filled, then the streak, then repos reached, then pull
 * requests. Volume only breaks ties: splitting one change into five pull
 * requests earns nothing (#186).
 */
export function consistencyBoard(
  entries: GitHubActivityEntry[],
  today: string,
  states: readonly PullRequestEntry["state"][] = ["merged", "open"],
  timeZone = "Asia/Jakarta",
): ConsistencyRow[] {
  const thisWeek = weekStart(today);
  const weekStarts = Array.from({ length: CONSISTENCY_WEEKS }, (_, index) => {
    const date = new Date(`${thisWeek}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 7 * (CONSISTENCY_WEEKS - 1 - index));
    return date.toISOString().slice(0, 10);
  });
  const slot = new Map(weekStarts.map((week, index) => [week, index]));

  const byHandle = new Map<string, { person: ActivityPerson; weeks: boolean[]; repos: Set<string>; prs: number }>();
  for (const entry of entries) {
    if (entry.kind !== "pull_request" || !states.includes(entry.state)) continue;
    for (const pullRequest of entry.pullRequests) {
      const opened = dayKey(pullRequest.openedAt, timeZone);
      const index = opened > today ? undefined : slot.get(weekStart(opened));
      if (index === undefined) continue;
      const key = entry.person.handle.toLowerCase();
      const row = byHandle.get(key) ?? { person: entry.person, weeks: Array<boolean>(CONSISTENCY_WEEKS).fill(false), repos: new Set<string>(), prs: 0 };
      row.weeks[index] = true;
      row.repos.add(entry.repo);
      row.prs += 1;
      byHandle.set(key, row);
    }
  }

  return [...byHandle.values()]
    .map(({ person, weeks, repos, prs }) => {
      let at = weeks[CONSISTENCY_WEEKS - 1] ? CONSISTENCY_WEEKS - 1 : CONSISTENCY_WEEKS - 2;
      let streak = 0;
      while (at >= 0 && weeks[at]) {
        streak += 1;
        at -= 1;
      }
      return { person, weeks, filled: weeks.filter(Boolean).length, streak, repos: repos.size, prs };
    })
    .sort(
      (a, b) =>
        b.filled - a.filled ||
        b.streak - a.streak ||
        b.repos - a.repos ||
        b.prs - a.prs ||
        (a.person.name || a.person.handle).localeCompare(b.person.name || b.person.handle),
    );
}

/** A row of the own-work board. */
export type LeaderboardRow = {
  person: ActivityPerson;
  /** Pull requests merged into their own repositories. */
  prs: number;
  repos: number;
  /** Commits to their own repositories: the tie-break. */
  commits?: number;
};

/**
 * The board for members' own work: pull requests merged into their own
 * repositories over the last SUMMARY_DAYS, the window GitHub's numbers for
 * own work are summed over — so it has no week or month. Pull requests rather
 * than commits, which depend on how somebody happens to split their work;
 * commits only break ties.
 */
export function ownLeaderboard(entries: GitHubActivityEntry[]): LeaderboardRow[] {
  return entries
    .filter((entry): entry is CommitSummaryEntry => entry.kind === "commit_summary" && entry.merged > 0)
    .map((entry) => ({ person: entry.person, prs: entry.merged, repos: entry.repos.length, commits: entry.commits }))
    .sort(
      (a, b) =>
        b.prs - a.prs ||
        (b.commits ?? 0) - (a.commits ?? 0) ||
        (a.person.name || a.person.handle).localeCompare(b.person.name || b.person.handle),
    );
}

export type ActivityStats = { people: number; merged: number; open: number; repos: number };

/**
 * The numbers at the top of the page: who, what landed, what is waiting, and
 * where. Contributions only: a member's own work is in their summary, not
 * counted as open source they gave to.
 */
export function activityStats(entries: GitHubActivityEntry[]): ActivityStats {
  const pullRequests = entries.filter((entry): entry is PullRequestEntry => entry.kind === "pull_request");
  return {
    people: new Set(entries.map((entry) => entry.person.id)).size,
    merged: pullRequests.filter((entry) => entry.state === "merged").reduce((sum, entry) => sum + pullRequestCount(entry), 0),
    open: pullRequests.filter((entry) => entry.state === "open").reduce((sum, entry) => sum + pullRequestCount(entry), 0),
    repos: new Set(pullRequests.map((entry) => entry.repo)).size,
  };
}

/** The repository owner's GitHub picture, the same address the directory uses. */
export function ownerAvatar(repo: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(repo.slice(0, repo.indexOf("/")))}.png?size=${size}`;
}

/** A calendar day as `YYYY-MM-DD` in the given time zone. */
export function dayKey(at: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/**
 * The timeline's days, newest first, keeping the order within each. Days are
 * counted where the members live — WIB by default — not in the server's UTC,
 * so an evening merge in Jakarta lands on that evening's day.
 */
export function groupByDay(
  entries: GitHubActivityEntry[],
  timeZone = "Asia/Jakarta",
): { day: string; entries: GitHubActivityEntry[] }[] {
  const days: { day: string; entries: GitHubActivityEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayKey(entry.at, timeZone);
    const last = days[days.length - 1];
    if (last?.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}
