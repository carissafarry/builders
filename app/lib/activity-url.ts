import {
  isActivityPlace,
  isActivityScope,
  isGitHubActivityFilter,
  type ActivityPlace,
  type ActivityQuery,
  type ActivityScope,
} from "./github-activity";

/**
 * The activity page's address — the home page, `/` — both ways: what a URL asks for, and the URL for a
 * set of filters. Shared by the page on the server (the header's return
 * address) and the feed in the browser, which filters without a round trip —
 * the same arrangement as directory-url.ts.
 */

export type ActivityFilters = ActivityQuery & { scope: ActivityScope; place: ActivityPlace };

type Query = Record<string, string | string[] | undefined> | URLSearchParams;

const HANDLE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const REPO_KEY = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

function read(query: Query, key: string): string {
  const value = query instanceof URLSearchParams ? query.get(key) : query[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function readActivityFilters(query: Query): ActivityFilters {
  const askedKind = read(query, "show");
  const askedScope = read(query, "scope");
  // One "show" choice covers both scope and kind now (see SHOW_OPTIONS):
  // contributions, of every kind or one; or members' own work. Older links
  // that ask for both scopes at once, or for summaries by kind, land on the
  // nearest of those.
  let scope: ActivityScope = isActivityScope(askedScope) && askedScope !== "all" ? askedScope : "external";
  let kind = isGitHubActivityFilter(askedKind) ? askedKind : "all";
  if (kind === "commits") scope = "own";
  // The show select's own field, when it is sent without the script.
  const view = read(query, "view");
  if (isShowOption(view)) ({ scope, kind } = showFilters(view));
  if (scope === "own") kind = "all";
  const member = read(query, "member").trim();
  const repo = read(query, "repo").trim().toLowerCase();
  const place = read(query, "place");
  return {
    // Contributions unless asked otherwise: what the page is for.
    scope,
    // Local or global repositories; both unless asked.
    place: isActivityPlace(place) ? place : "all",
    kind,
    member: HANDLE.test(member) ? member : "",
    repo: REPO_KEY.test(repo) ? repo : "",
    q: read(query, "q").slice(0, 100),
  };
}

/** The page asked for; the feed clamps it to the pages there are. */
export function readActivityPage(query: Query): number {
  const page = Number(read(query, "page"));
  return Number.isInteger(page) && page > 1 ? page : 1;
}

/** The address for a set of filters; changing any of them goes back to page one. */
export function activityPath(filters: Partial<ActivityFilters>, page = 1): string {
  const params = new URLSearchParams();
  if (filters.scope && filters.scope !== "external") params.set("scope", filters.scope);
  if (filters.place && filters.place !== "all") params.set("place", filters.place);
  if (filters.kind && filters.kind !== "all") params.set("show", filters.kind);
  if (filters.member) params.set("member", filters.member);
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return `/${search ? `?${search}` : ""}`;
}

/**
 * The feed's one "show" choice, standing for a scope and a kind together:
 * every contribution, merged PRs, PRs in review, or members' own repos. It
 * steers the leaderboard too.
 */
export const SHOW_OPTIONS = ["contributions", "merged", "open", "own"] as const;
export type ShowOption = (typeof SHOW_OPTIONS)[number];

export function isShowOption(value: string): value is ShowOption {
  return (SHOW_OPTIONS as readonly string[]).includes(value);
}

export function showOf(filters: Pick<ActivityFilters, "scope" | "kind">): ShowOption {
  if (filters.scope === "own") return "own";
  return filters.kind === "merged" || filters.kind === "open" ? filters.kind : "contributions";
}

/** The scope and kind one "show" choice stands for. */
export function showFilters(show: ShowOption): Pick<ActivityFilters, "scope" | "kind"> {
  if (show === "own") return { scope: "own", kind: "all" };
  return { scope: "external", kind: show === "contributions" ? "all" : show };
}
