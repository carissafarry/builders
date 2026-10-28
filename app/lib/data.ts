import { cache } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { getPublicSupabase, getSupabase, type Supabase } from "./supabase";
import { tags } from "./cache-tags";
import type {
  CommentRow,
  OssRepoRow,
  EventRow,
  GitHubCommitSummaryRow,
  GitHubPullRequestRow,
  ProfileRow,
  ProjectOverviewRow,
  ProposalRow,
  SeatRow,
  TaskRow,
  UpdateRow,
} from "./database.types";
import { seedEvents, seedProjects, seedUsers } from "./seed";
import type { Stage } from "./stages";
import { SEED_REPOS, toOpenSourceRepo, type OpenSourceRepo } from "./open-source";
import type { GitHubRepositoryStats } from "./github";
import type { RepoActivity } from "./directory";
import { githubHandle, isOssRelation, mergeOssRows, type OssContribution, type OssMember, type OssRelation, type OssRow } from "./oss";
import type { Lane } from "./feed";
import { buildGitHubActivity, type ActivityPerson, type GitHubActivityEntry } from "./github-activity";
import {
  buildAuthorQuery,
  buildProfileQuery,
  buildPullRequestQuery,
  organisationsOf,
  parseProfile,
  pullRequestRepos,
  soloReposOf,
  type GitHubProfile,
} from "./github-profile";
import type { ReactionRow } from "./reactions";
import { FEED_KINDS } from "./product-feed";
import { availabilityStatus, type AvailabilityStatus } from "./availability";
import {
  normaliseRole,
  roleAliases,
  roleLabel,
  roleMatchesQuery,
  rolesMatchingQuery,
} from "./roles";

export type Person = {
  id: string;
  username: string;
  name: string;
  profession: string;
  headline: string;
  bio: string;
  skills: string[];
  yearsExperience: number | null;
  fields: string[];
  availability: AvailabilityStatus;
  website: string;
  publicEmail: string;
  github: string;
  /** GitHub's numeric id of the linked account — 20261103000000_linked_github.sql. */
  githubId?: number | null;
  linkedin: string;
  x: string;
  resume: string;
  /** Trail kinds kept off this person's public profile. */
  activityHidden: string[];
  /** Agreed to their GitHub activity being shown on /activity. */
  githubActivityShown: boolean;
};

export type ActivityEvent = {
  id: number;
  kind: string;
  createdAt: string;
  /** Null once the project it happened on has been deleted. */
  projectId: number | null;
  projectSlug: string;
  projectTitle: string;
  payload: Record<string, string>;
  actor: Pick<Person, "id" | "username" | "name"> | null;
};

export type ProjectSummary = {
  id: number;
  slug: string;
  title: string;
  tagline: string;
  stage: Stage;
  /**
   * Why the project exists — one of PROJECT_TYPES, or empty when it predates
   * the question. Deliberately not narrowed to `ProjectType`: an older row can
   * carry the empty string, and pretending otherwise pushes the check onto
   * every reader.
   */
  projectType: string;
  /** The owner's own reason this is worth a look. Empty until they say. */
  highlight: string;
  problem: string;
  solution: string;
  audience: string;
  tags: string[];
  glyph: string;
  docUrl: string;
  liveUrl: string;
  repoUrl: string;
  /** Maintainer explicitly welcomes GitHub pull requests and issues. */
  openForGitHubContributions: boolean;
  /** Project-provided visual identity; favicon remains the fallback. */
  logoUrl: string;
  createdAt: string;
  /** What the project is working on right now. Empty until somebody says. */
  nowText: string;
  /** When that line last changed — the freshness signal people actually read. */
  nowUpdatedAt: string | null;
  /** Newest thing that happened anywhere on the project. */
  lastActivityAt: string;
  owner: Pick<Person, "id" | "username" | "name">;
  seatCount: number;
  openSeatCount: number;
  /** Distinct roles this project is asking for right now. */
  openRoles: string[];
  activeMemberCount: number;
  boostCount: number;
  followerCount: number;
  commentCount: number;
  updateCount: number;
  openTaskCount: number;
  doneTaskCount: number;
};

export type SeatView = {
  id: number;
  role: string;
  roleTitle: string;
  brief: string;
  status: string;
  /** member | admin — see app/lib/access.ts. */
  access: string;
  /** How much time the help would take, in the owner's words. May be empty. */
  commitment: string;
  pitch: string;
  person: Pick<Person, "id" | "username" | "name"> | null;
};

/** A person's proposal for one task or one role. The target stays separate. */
export type ProposalView = {
  id: number;
  taskId: number | null;
  seatId: number | null;
  pitch: string;
  status: string;
  createdAt: string;
  person: Pick<Person, "id" | "username" | "name">;
};

export type TaskView = {
  id: number;
  title: string;
  detail: string;
  status: string;
  createdAt: string;
  /** The role this task supports, if the manager connected one. */
  role: Pick<SeatView, "id" | "role" | "roleTitle"> | null;
  assignee: Pick<Person, "id" | "username" | "name"> | null;
};

export type CommentView = {
  id: number;
  body: string;
  createdAt: string;
  author: Pick<Person, "id" | "username" | "name">;
};

/** One entry in a project's journey, written by whoever runs the project. */
export type UpdateView = {
  id: number;
  title: string;
  body: string;
  createdAt: string;
  author: Pick<Person, "id" | "username" | "name"> | null;
};

export type ProjectDetail = ProjectSummary & {
  seats: SeatView[];
  tasks: TaskView[];
  comments: CommentView[];
  updates: UpdateView[];
};

/** A seat somebody has applied for, shown from either side of the decision. */
export type ApplicationView = {
  proposalId: number;
  targetKind: "task" | "role";
  targetLabel: string;
  status: string;
  pitch: string;
  createdAt: string;
  project: { slug: string; title: string };
  person: Pick<Person, "id" | "username" | "name"> | null;
};

export type FeedQuery = {
  lane?: Lane;
  stage?: string;
  /** One of PROJECT_TYPES — the board only passes values isProjectType() took. */
  projectType?: string;
  tag?: string;
  /** Only projects that are actively asking for at least one collaborator. */
  needsHelp?: boolean;
  /** One of ROLES — the feed only passes values isRole() has accepted. */
  role?: string;
  /** Free-text match against roles on seats that are still open. */
  roleQuery?: string;
  q?: string;
  /** Roles this visitor has held before, used to arrange the "untukmu" lane. */

};

export { LANES, isLane, arrangeForYou, type Lane } from "./feed";

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * Whether a query failed only because its table is not there yet.
 *
 * Migrations are applied by hand in the Supabase SQL editor, so a deploy can
 * legitimately run ahead of the database for a while. When that happens a page
 * should lose the feature the missing table feeds, not fall over — a profile is
 * still a profile without its trail. Everything else still throws.
 *
 * PostgREST reports it as 42P01 from Postgres, or PGRST205 when its schema
 * cache has never heard of the table at all.
 */
function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

/** Says it once per server start, so the gap is visible in the deploy logs. */
const warned = new Set<string>();

function warnMissingTable(table: string): void {
  if (warned.has(table)) return;
  warned.add(table);
  console.warn(
    `[builders] Table "${table}" does not exist in Supabase yet. Run the files in supabase/migrations/ ` +
      `in order. This feature will be skipped for now.`,
  );
}

/**
 * What each lane asks the database for.
 *
 * "untukmu" asks for everything and arranges it afterwards, in
 * `arrangeForYou()` — what belongs at the top depends on who is looking, and
 * that is not a thing an ORDER BY can express.
 */
const LANE_QUERY: Record<Lane, { stage?: string; needsHelp?: boolean; column: string }> = {
  "for-you": { column: "last_activity_at" },
  newest: { column: "created_at" },
  active: { column: "last_activity_at" },
  "needs-help": { needsHelp: true, column: "last_activity_at" },
  building: { stage: "building", column: "last_activity_at" },
  live: { stage: "live", column: "last_activity_at" },
};

/** The filters that decide what the database is asked for. */
function projectQueryKey(query: FeedQuery): string {
  return JSON.stringify({
    lane: query.lane ?? "for-you",
    stage: query.stage ?? "",
    projectType: query.projectType ?? "",
    tag: query.tag ?? "",
    needsHelp: Boolean(query.needsHelp),
    role: query.role ?? "",
    roleQuery: query.roleQuery ?? "",
    q: query.q ?? "",
  });
}

/**
 * One board read, shared by everyone asking the same question.
 *
 * The key arrives as a string so the cache entry is keyed on the filters
 * themselves rather than on an object whose property order could vary. Tagged
 * with `seats` as well as `projects` because `project_overview` carries the
 * open seat count and the open roles: opening or closing a seat changes what
 * the board says without touching the projects table.
 */
async function readProjects(key: string): Promise<ProjectSummary[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.projects, tags.seats);

  return queryProjects(JSON.parse(key) as FeedQuery);
}

/**
 * The board for one set of filters.
 *
 * In the order the database gave, deliberately. Arranging the "untukmu" lane
 * for a particular visitor is `arrangeForYou`, and it belongs to the caller
 * that knows who is looking. Keeping it out of here is what lets this read
 * start before the session is known, instead of queueing behind an auth round
 * trip for a sort it could do afterwards.
 */
export async function listProjects(query: FeedQuery = {}): Promise<ProjectSummary[]> {
  return readProjects(projectQueryKey(query));
}

async function queryProjects(query: FeedQuery): Promise<ProjectSummary[]> {
  const lane = query.lane ?? "for-you";
  const shape = LANE_QUERY[lane];

  const supabase = getPublicSupabase();
  if (!supabase) return seedFeed(query);

  let request = supabase.from("project_overview").select("*");

  if (query.roleQuery) {
    const catalogueRoles = rolesMatchingQuery(query.roleQuery).flatMap(roleAliases);
    const catalogueRequest = catalogueRoles.length > 0
      ? supabase
          .from("seats")
          .select("project_id")
          .eq("status", "open")
          .in("role", catalogueRoles)
      : Promise.resolve({ data: [], error: null });
    const customTitleRequest = supabase
      .from("seats")
      .select("project_id")
      .eq("status", "open")
      .ilike("role_title", `%${escapeLike(query.roleQuery)}%`);
    const [catalogueResult, customTitleResult] = await Promise.all([
      catalogueRequest,
      customTitleRequest,
    ]);

    if (catalogueResult.error) throw new Error(catalogueResult.error.message);
    if (customTitleResult.error) throw new Error(customTitleResult.error.message);

    const matchingProjectIds = [
      ...new Set([
        ...(catalogueResult.data ?? []).map((seat) => seat.project_id),
        ...(customTitleResult.data ?? []).map((seat) => seat.project_id),
      ]),
    ];
    if (matchingProjectIds.length === 0) return [];
    request = request.in("id", matchingProjectIds);
  }

  // The lane's own stage wins over the filter chips, which are not offered in
  // the lanes that already fix one.
  const stage = shape.stage ?? query.stage;
  if (stage) request = request.eq("stage", stage);
  if (query.projectType) request = request.eq("project_type", query.projectType);
  if (shape.needsHelp || query.needsHelp) request = request.gt("open_seat_count", 0);
  if (query.tag) request = request.contains("tags", [query.tag]);
  if (query.role) {
    const role = normaliseRole(query.role);
    if (role) request = request.overlaps("open_roles", roleAliases(role));
  }
  if (query.q) {
    // The whole brief, not just its opening: somebody searching "flutter"
    // should find the project that only says so under solution. `search_text`
    // is a generated project column with one trigram index, so this stays fast
    // without maintaining a separate large index for every brief field.
    const term = `%${escapeLike(query.q)}%`;
    request = request.ilike("search_text", term);
  }

  const { data, error } = await request
    .order(shape.column, { ascending: false })
    .order("id", { ascending: false })
    .limit(120);
  if (error) throw new Error(error.message);

  return (data ?? []).map(toSummary);
}

/**
 * The roles somebody has held or applied for — what "untukmu" leans on.
 *
 * Cached even though it is about one person: `seats` is public, so this is not
 * private information, and the board waits on it before it can settle its
 * order. Filed under the site-wide `seats` tag rather than a per-person one —
 * that clears every visitor's entry whenever any seat anywhere moves, which is
 * far rarer than the page views this saves, and the miss costs one small query.
 */
export async function familiarRoles(userId: string): Promise<string[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.seats);

  const supabase = getPublicSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase.from("seats").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);

  return [...new Set((data ?? []).map((row) => row.role))];
}

/**
 * One project, whole: the brief, its seats, discussion, tasks and build log.
 *
 * The most expensive read on the site — five round trips — and the one most
 * worth caching, because a project page is what gets shared and linked to.
 * Cached across visitors and tagged per slug, so the owner editing their own
 * project invalidates that project and nothing else.
 *
 * Still wrapped in `cache()` as well: `generateMetadata` and the page body both
 * ask for it, and that keeps them to one lookup within a single render.
 */
export const getProject = cache(async (slug: string): Promise<ProjectDetail | null> => {
  "use cache";
  cacheLife("board");
  cacheTag(
    tags.project(slug),
    tags.comments(slug),
    tags.updates(slug),
    tags.tasks(slug),
    tags.seats,
  );

  const supabase = getPublicSupabase();
  if (!supabase) return seedDetail(slug);

  const { data: project, error } = await supabase
    .from("project_overview")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!project) return null;

  const [seats, comments, tasks, updates] = await Promise.all([
    supabase
      .from("seats")
      .select("*, person:profiles(id, username, name)")
      .eq("project_id", project.id)
      .order("id"),
    supabase
      .from("comments")
      .select("*, author:profiles(id, username, name)")
      .eq("project_id", project.id)
      .order("id"),
    supabase
      // `tasks` points at `profiles` twice, so the embed has to name the
      // constraint. Without it PostgREST cannot tell assignee from creator.
      // The optional seat embed is similarly named because a task can carry a
      // role without requiring one.
      .from("tasks")
      .select(
        "*, assignee:profiles!tasks_assignee_id_fkey(id, username, name), " +
          "role:seats!tasks_seat_id_fkey(id, role, role_title)",
      )
      .eq("project_id", project.id)
      .order("id"),
    supabase
      .from("updates")
      .select("*, author:profiles(id, username, name)")
      .eq("project_id", project.id)
      .order("id", { ascending: false }),
  ]);
  if (seats.error) throw new Error(seats.error.message);
  if (comments.error) throw new Error(comments.error.message);
  if (tasks.error && !isMissingTable(tasks.error)) throw new Error(tasks.error.message);
  if (tasks.error) warnMissingTable("tasks");
  if (updates.error && !isMissingTable(updates.error)) throw new Error(updates.error.message);
  if (updates.error) warnMissingTable("updates");

  type SeatWithPerson = SeatRow & { person: BriefPerson | null };
  type CommentWithAuthor = CommentRow & { author: BriefPerson | null };
  type TaskWithAssignee = TaskRow & {
    assignee: BriefPerson | null;
    role: Pick<SeatRow, "id" | "role" | "role_title"> | null;
  };
  type UpdateWithAuthor = UpdateRow & { author: BriefPerson | null };

  return {
    ...toSummary(project),
    seats: ((seats.data ?? []) as SeatWithPerson[]).map((seat) => ({
      id: seat.id,
      role: seat.role,
      roleTitle: seat.role_title ?? "",
      brief: seat.brief,
      status: seat.status,
      access: seat.access,
      commitment: seat.commitment ?? "",
      pitch: seat.pitch,
      person: seat.person ?? null,
    })),
    updates: (((updates.data ?? []) as UpdateWithAuthor[] | null) ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      createdAt: entry.created_at,
      author: entry.author ?? null,
    })),
    tasks: ((tasks.data ?? []) as unknown as TaskWithAssignee[] | null ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.detail,
      status: task.status,
      createdAt: task.created_at,
      role: task.role
        ? { id: task.role.id, role: task.role.role, roleTitle: task.role.role_title ?? "" }
        : null,
      assignee: task.assignee ?? null,
    })),
    comments: ((comments.data ?? []) as CommentWithAuthor[])
      .filter((comment) => comment.author)
      .map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.created_at,
        author: comment.author as BriefPerson,
      })),
  };
});

/**
 * One public profile.
 *
 * Cached per username and tagged with it, so somebody editing their profile
 * refreshes their own page without disturbing anyone else's. The `cache()`
 * wrapper still earns its place for the generateMetadata-plus-page pair.
 */
export const getPerson = cache(async (username: string): Promise<Person | null> => {
  "use cache";
  cacheLife("board");
  cacheTag(tags.person(username));

  const supabase = getPublicSupabase();
  if (!supabase) {
    const seed = seedUsers.find((user) => user.username === username);
    return seed ? { ...seed } : null;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("username", username)
    .maybeSingle();
  if (error) throw new Error(error.message);

  return data ? toPerson(data) : null;
});

/**
 * The current username of whoever once used `former`, or null.
 *
 * Only called when a profile lookup missed, so it is the slow path and stays
 * uncached. It resolves through the holder's id rather than the stored name,
 * so a chain of renames (a to b to c) still lands on the live one.
 */
export async function currentUsernameForFormer(former: string): Promise<string | null> {
  const supabase = getPublicSupabase();
  if (!supabase) return null;

  const { data: past } = await supabase
    .from("username_history")
    .select("user_id")
    .eq("username", former)
    .maybeSingle();
  if (!past) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("username")
    .eq("id", past.user_id)
    .maybeSingle();
  return profile?.username ?? null;
}

/**
 * Whether `username` is free for `self` to take: nobody else has it now, and
 * nobody else has left it behind. The database decides on save; this only
 * keeps the editor from suggesting a name it would refuse.
 */
export async function isUsernameFreeFor(username: string, self: string): Promise<boolean> {
  const supabase = getPublicSupabase();
  if (!supabase) return true;

  const [live, former] = await Promise.all([
    supabase.from("profiles").select("id").eq("username", username).neq("id", self).limit(1),
    supabase.from("username_history").select("user_id").eq("username", username).neq("user_id", self).limit(1),
  ]);
  if (live.error || former.error) return false;
  return (live.data ?? []).length === 0 && (former.data ?? []).length === 0;
}

/**
 * A member's open source work as GitHub tells it, for their profile — see
 * lib/github-profile.ts. Asked of GitHub's GraphQL API with the site's
 * GITHUB_TOKEN, at most hourly per account; null without a token, for an
 * account GitHub does not know, or one that is no longer the linked id.
 */
export async function getGitHubProfile(login: string, githubId: number | null): Promise<GitHubProfile | null> {
  "use cache";
  cacheLife("github");
  cacheTag(tags.githubProfile(login.toLowerCase()));

  const token = process.env.GITHUB_TOKEN;
  const first = buildProfileQuery(login);
  if (!token || !first) return null;

  const ask = async (request: object) => {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "builders-profile" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${login}'s profile.`);
    return response.json();
  };
  // The searches leave out the organisations the first request names; a third
  // asks who wrote the repositories they found, since a private membership
  // hides some of the member's own. Without its answer the line drawn so far
  // stands.
  const profile = await ask(first);
  const second = buildPullRequestQuery(login, organisationsOf(profile));
  if (!second) return null;
  const pullRequests = await ask(second);
  const repos = pullRequestRepos(pullRequests);
  const third = buildAuthorQuery(repos);
  const solo = third ? await ask(third).then((body) => soloReposOf(repos, body, login), () => new Set<string>()) : new Set<string>();
  return parseProfile(profile, pullRequests, githubId, solo);
}

/** A project somebody helps on, together with the role they hold there. */
export type Contribution = ProjectSummary & { role: string };

/**
 * Projects this person owns, plus the ones they hold a filled seat on.
 *
 * Keyed on the id rather than the whole `Person` so the entry survives an
 * unrelated edit to their bio, and tagged with both the projects and the seats
 * it is assembled from.
 */
export async function getPortfolio(person: Person) {
  return readPortfolio(person.id);
}

async function readPortfolio(personId: string) {
  "use cache";
  cacheLife("board");
  cacheTag(tags.projects, tags.seats);

  const supabase = getPublicSupabase();

  if (!supabase) {
    const owned = seedFeed({}).filter((project) => project.owner.id === personId);
    return { owned, contributing: seedContributions(personId) };
  }

  const [ownedResult, seatResult] = await Promise.all([
    supabase
      .from("project_overview")
      .select("*")
      .eq("owner_id", personId)
      .order("created_at", { ascending: false }),
    supabase
      .from("seats")
      .select("project_id, role")
      .eq("user_id", personId)
      .eq("status", "filled"),
  ]);
  if (ownedResult.error) throw new Error(ownedResult.error.message);
  if (seatResult.error) throw new Error(seatResult.error.message);

  const owned = (ownedResult.data ?? []).map(toSummary);
  // A person can hold at most one seat per project, so this map has one role
  // per project even though they may have sent several proposals before one
  // was accepted.
  const roleByProject = new Map(
    (seatResult.data ?? []).map((seat) => [seat.project_id, seat.role]),
  );
  if (roleByProject.size === 0) return { owned, contributing: [] as Contribution[] };

  const { data, error } = await supabase
    .from("project_overview")
    .select("*")
    .in("id", [...roleByProject.keys()])
    .neq("owner_id", personId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const contributing: Contribution[] = (data ?? []).map((row) => ({
    ...toSummary(row),
    role: roleByProject.get(row.id) ?? "other",
  }));
  return { owned, contributing };
}

/**
 * Everybody with a profile, newest first.
 *
 * Feeds the people directory and the sitemap — until now a profile could only
 * be reached by clicking through from a card or a comment, which is no way to
 * be found.
 */
const listPeopleCached = cache(async (limit: number): Promise<Person[]> => {
  "use cache";
  cacheLife("board");
  cacheTag(tags.people);

  const supabase = getPublicSupabase();
  if (!supabase) return seedUsers.map((user) => ({ ...user }));

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  return (data ?? []).map(toPerson);
});

/** One profile-directory read for each distinct limit within a server render. */
export function listPeople(limit = 200): Promise<Person[]> {
  return listPeopleCached(limit);
}

/**
 * Everybody, with what they are actually working on.
 *
 * A directory of headlines is a thin CV wall; what makes somebody worth
 * opening here is the work with their name on it. Built from one pass over the
 * board and one pass over the filled seats rather than a portfolio query per
 * person, so the page costs two round trips however many people there are.
 */
export type PersonAtWork = {
  person: Person;
  building: ProjectSummary[];
  helping: ProjectSummary[];
  /** Roles held on filled seats, kept as readable labels for search/fallback. */
  roles: string[];
};

/* ------------------------------------------------------------------ *
 * Applications
 * ------------------------------------------------------------------ */

/**
 * Proposals visible on one project.
 *
 * The table's read policy returns all of them to a manager and only the
 * caller's own rows to a contributor. This read is deliberately not cached:
 * its result depends on who is looking, unlike the public project detail.
 */
export async function listProjectProposals(
  taskIds: number[],
  seatIds: number[],
): Promise<ProposalView[]> {
  if (taskIds.length === 0 && seatIds.length === 0) return [];

  const supabase = await getSupabase();
  if (!supabase) return [];

  const columns = "*, person:profiles!proposals_person_id_fkey(id, username, name)";
  const [taskResult, seatResult] = await Promise.all([
    taskIds.length > 0
      ? supabase.from("proposals").select(columns).in("task_id", taskIds)
      : Promise.resolve({ data: [], error: null }),
    seatIds.length > 0
      ? supabase.from("proposals").select(columns).in("seat_id", seatIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const error = taskResult.error ?? seatResult.error;
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("proposals");
    return [];
  }

  type ProposalWithPerson = ProposalRow & { person: BriefPerson | null };
  return [...(taskResult.data ?? []), ...(seatResult.data ?? [])]
    .filter((row): row is ProposalWithPerson => Boolean(row.person))
    .map((proposal) => ({
      id: proposal.id,
      taskId: proposal.task_id,
      seatId: proposal.seat_id,
      pitch: proposal.pitch,
      status: proposal.status,
      createdAt: proposal.created_at,
      person: proposal.person as BriefPerson,
    }))
    .sort((a, b) => b.id - a.id);
}

/**
 * Which projects this person may answer applications on.
 *
 * The same set `can_manage_project()` decides in the database: the ones they
 * own, plus the ones they hold an admin seat on. It takes two queries rather
 * than one because PostgREST cannot express "owner of the parent row, or holder
 * of a sibling row" as a single filter — they go out together, so the header
 * badge pays one extra round trip rather than two, and both are index lookups.
 */
async function managedProjectIds(supabase: Supabase, userId: string): Promise<number[]> {
  const [owned, administered] = await Promise.all([
    supabase.from("projects").select("id").eq("owner_id", userId),
    supabase
      .from("seats")
      .select("project_id")
      .eq("user_id", userId)
      .eq("status", "filled")
      .eq("access", "admin"),
  ]);
  if (owned.error) throw new Error(owned.error.message);
  if (administered.error) throw new Error(administered.error.message);

  return [
    ...new Set([
      ...(owned.data ?? []).map((row) => row.id),
      ...(administered.data ?? []).map((row) => row.project_id),
    ]),
  ];
}

/**
 * Applications waiting on the projects this person runs.
 *
 * Admins are included on purpose: they are offered the Terima/Buka lagi
 * buttons on the project page, so leaving them out here meant the inbox and
 * the project page disagreed about what was waiting for them.
 */
export async function listIncomingApplications(userId: string): Promise<ApplicationView[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const projectIds = await managedProjectIds(supabase, userId);
  if (projectIds.length === 0) return [];

  const [tasks, seats] = await Promise.all([
    supabase.from("tasks").select("id").in("project_id", projectIds),
    supabase.from("seats").select("id").in("project_id", projectIds),
  ]);
  if (tasks.error) throw new Error(tasks.error.message);
  if (seats.error) throw new Error(seats.error.message);

  const proposals = await listProjectProposals(
    (tasks.data ?? []).map((task) => task.id),
    (seats.data ?? []).map((seat) => seat.id),
  );
  return proposalApplications(supabase, proposals.filter((proposal) => proposal.status === "pending"));
}

/**
 * Seats this person is holding or still waiting on.
 *
 * Not a full history: declining releases the seat and clears its holder, so a
 * refused application leaves this list at that moment. What it left behind is
 * the notice in `notices`, which belongs to the applicant rather than the seat.
 */
export async function listMyApplications(userId: string): Promise<ApplicationView[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("proposals")
    .select("*, person:profiles!proposals_person_id_fkey(id, username, name)")
    .eq("person_id", userId)
    .order("id", { ascending: false });
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("proposals");
    return [];
  }

  type ProposalWithPerson = ProposalRow & { person: BriefPerson | null };
  const proposals: ProposalView[] = (data ?? [])
    .filter((row): row is ProposalWithPerson => Boolean(row.person))
    .map((proposal) => ({
      id: proposal.id,
      taskId: proposal.task_id,
      seatId: proposal.seat_id,
      pitch: proposal.pitch,
      status: proposal.status,
      createdAt: proposal.created_at,
      person: proposal.person as BriefPerson,
    }));
  return proposalApplications(supabase, proposals);
}

/**
 * How many applications are waiting on the projects this person runs.
 *
 * Runs on every page for a signed-in visitor to feed the header badge, so it
 * asks for the count alone rather than the rows.
 */
export async function countIncomingApplications(userId: string): Promise<number> {
  const supabase = await getSupabase();
  if (!supabase) return 0;

  const projectIds = await managedProjectIds(supabase, userId);
  if (projectIds.length === 0) return 0;

  const [tasks, seats] = await Promise.all([
    supabase.from("tasks").select("id").in("project_id", projectIds),
    supabase.from("seats").select("id").in("project_id", projectIds),
  ]);
  if (tasks.error) throw new Error(tasks.error.message);
  if (seats.error) throw new Error(seats.error.message);
  const proposals = await listProjectProposals(
    (tasks.data ?? []).map((task) => task.id),
    (seats.data ?? []).map((seat) => seat.id),
  );
  return proposals.filter((proposal) => proposal.status === "pending").length;
}

async function proposalApplications(
  supabase: Supabase,
  proposals: ProposalView[],
): Promise<ApplicationView[]> {
  if (proposals.length === 0) return [];
  const taskIds = proposals.flatMap((proposal) => proposal.taskId === null ? [] : [proposal.taskId]);
  const seatIds = proposals.flatMap((proposal) => proposal.seatId === null ? [] : [proposal.seatId]);
  const [tasks, seats] = await Promise.all([
    taskIds.length > 0 ? supabase.from("tasks").select("id, project_id, title").in("id", taskIds) : Promise.resolve({ data: [], error: null }),
    seatIds.length > 0 ? supabase.from("seats").select("id, project_id, role, role_title").in("id", seatIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (tasks.error) throw new Error(tasks.error.message);
  if (seats.error) throw new Error(seats.error.message);

  const taskById = new Map((tasks.data ?? []).map((task) => [task.id, task]));
  const seatById = new Map((seats.data ?? []).map((seat) => [seat.id, seat]));
  const projectIds = [...new Set([
    ...(tasks.data ?? []).map((task) => task.project_id),
    ...(seats.data ?? []).map((seat) => seat.project_id),
  ])];
  const { data: projects, error: projectError } = await supabase
    .from("projects")
    .select("id, slug, title")
    .in("id", projectIds);
  if (projectError) throw new Error(projectError.message);
  const projectById = new Map((projects ?? []).map((project) => [project.id, project]));

  return proposals.flatMap((proposal) => {
    const task = proposal.taskId === null ? null : taskById.get(proposal.taskId);
    const seat = proposal.seatId === null ? null : seatById.get(proposal.seatId);
    const project = projectById.get(task?.project_id ?? seat?.project_id ?? -1);
    if (!project) return [];
    return [{
      proposalId: proposal.id,
      targetKind: task ? "task" as const : "role" as const,
      targetLabel: task?.title ?? roleLabel(seat?.role ?? "other", seat?.role_title ?? ""),
      status: proposal.status,
      pitch: proposal.pitch,
      createdAt: proposal.createdAt,
      project: { slug: project.slug, title: project.title },
      person: proposal.person,
    }];
  });
}

/* ------------------------------------------------------------------ *
 * Notices — what happened while somebody was away
 * ------------------------------------------------------------------ */

export type NoticeView = {
  id: number;
  kind: string;
  createdAt: string;
  seen: boolean;
  payload: Record<string, string>;
};

/** This person's notices, newest first. */
export async function listNotices(userId: string, limit = 40): Promise<NoticeView[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("notices")
    .select("*")
    .eq("recipient_id", userId)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("notices");
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    seen: row.seen,
    payload: row.payload ?? {},
  }));
}

/**
 * How many notices this person has not opened yet.
 *
 * Rides along in the header beside the incoming-application count, for the
 * same reason: a decision nobody sees is a decision nobody acts on.
 */
export async function countUnseenNotices(userId: string): Promise<number> {
  const supabase = await getSupabase();
  if (!supabase) return 0;

  const { count, error } = await supabase
    .from("notices")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", userId)
    .eq("seen", false);
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("notices");
    return 0;
  }

  return count ?? 0;
}

/**
 * Whoever is looking, as far as a trail is concerned.
 *
 * Structural rather than the `Viewer` type so `data.ts` stays free of an
 * import from `session.ts`, which imports from here.
 */
export type TrailViewer = Pick<Person, "id" | "activityHidden">;

/**
 * Whether this visitor would see more of a trail than the public does.
 *
 * `events` is the one public table whose SELECT policy depends on who is
 * asking: it shows a person their own hidden entries. So for them the cached
 * public copy would be wrong, and their read has to go to the database as
 * themselves. For a guest, and for the great majority of signed-in people, who
 * have hidden nothing, the public copy is exactly what the policy would return
 * — and that is the copy worth caching and sharing.
 *
 * `actorId` narrows the question to one person's trail. Left out — as on a
 * project's trail, where any of several people may be the actor — the answer
 * is simply whether this visitor hides anything at all.
 */
function seesOwnHiddenTrail(viewer: TrailViewer | null | undefined, actorId?: string): boolean {
  if (!viewer || viewer.activityHidden.length === 0) return false;
  return actorId === undefined || viewer.id === actorId;
}

/**
 * Somebody's trail, newest first.
 *
 * `kinds` narrows to a set of event kinds — the profile's "sorotan" reading
 * mode. Visibility is not decided here on purpose: the SELECT policy on
 * `events` already hides what this person chose to hide, and shows them their
 * own hidden entries. Re-filtering that in the query would only get it wrong.
 *
 * Pass `viewer` so this can tell those two cases apart: without it every read
 * is treated as public, which is right for a guest and wrong for the one
 * person whose hidden entries are at stake.
 */
export async function listPersonActivity(
  personId: string,
  {
    limit = 40,
    kinds,
    viewer,
  }: { limit?: number; kinds?: readonly string[]; viewer?: TrailViewer | null } = {},
): Promise<ActivityEvent[]> {
  if (seesOwnHiddenTrail(viewer, personId)) {
    return queryPersonActivity(await getSupabase(), personId, limit, kinds);
  }
  return readPersonActivity(personId, limit, kinds);
}

async function readPersonActivity(
  personId: string,
  limit: number,
  kinds: readonly string[] | undefined,
): Promise<ActivityEvent[]> {
  "use cache";
  cacheLife("trail");
  cacheTag(tags.trail(personId));

  return queryPersonActivity(getPublicSupabase(), personId, limit, kinds);
}

async function queryPersonActivity(
  supabase: Supabase | null,
  personId: string,
  limit: number,
  kinds: readonly string[] | undefined,
): Promise<ActivityEvent[]> {
  if (!supabase) {
    const events = seedActivity(personId);
    return (kinds ? events.filter((event) => kinds.includes(event.kind)) : events).slice(0, limit);
  }

  let request = supabase.from("events").select("*").eq("actor_id", personId);
  if (kinds) request = request.in("kind", [...kinds]);

  const { data, error } = await request.order("id", { ascending: false }).limit(limit);
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("events");
    return [];
  }

  return (data ?? []).map((row) => toActivity(row as EventRow));
}

/**
 * The builders site's /activity: every member's product events, newest first
 * — see app/lib/product-feed.ts for which kinds and how they are grouped.
 *
 * Read publicly, so the SELECT policy on `events` leaves out whatever an actor
 * chose to hide, and cached for everybody: any event by anybody bumps
 * `tags.activity` through trailChanged() in actions.ts. Actors' names come
 * from the cached people list rather than a join, as the catalogue does.
 */
export async function listProductFeed(limit = 300): Promise<ActivityEvent[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.activity, tags.people);

  const supabase = getPublicSupabase();
  if (!supabase) {
    return seedEvents
      .filter((event) => (FEED_KINDS as readonly string[]).includes(event.kind))
      .map((event) => {
        const person = seedUsers.find((user) => user.id === event.actorId);
        return {
          id: event.id,
          kind: event.kind,
          createdAt: event.createdAt,
          projectId: seedProjects.find((project) => project.slug === event.projectSlug)?.id ?? null,
          projectSlug: event.payload.slug ?? event.projectSlug,
          projectTitle: event.payload.title ?? "deleted project",
          payload: event.payload,
          actor: person ? { id: person.id, username: person.username, name: person.name } : null,
        };
      })
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  const [{ data, error }, people] = await Promise.all([
    supabase.from("events").select("*").in("kind", [...FEED_KINDS]).order("id", { ascending: false }).limit(limit),
    listPeople(1000),
  ]);
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("events");
    return [];
  }

  const byId = new Map(people.map((person) => [person.id, { id: person.id, username: person.username, name: person.name }]));
  return (data ?? []).map((row) => {
    const event = row as EventRow;
    return toActivity({ ...event, actor: byId.get(event.actor_id) ?? null });
  });
}

/** What a profile can claim in numbers, counted from the visible trail. */
export type PersonStats = {
  tasksDone: number;
  /** Seats this person was accepted onto — the joins other people decided. */
  rolesTaken: number;
  /** When the first visible trail entry happened; "" with no trail yet. */
  since: string;
};

/**
 * Counted from the same `events` reads the trail uses, so the SELECT policy
 * decides what a visitor's numbers include, exactly as it decides their trail.
 * The cap saturates the counts on an absurdly long trail rather than paging;
 * by the time that is a lie worth fixing, counting belongs in the database.
 */
export async function getPersonStats(
  personId: string,
  viewer?: TrailViewer | null,
): Promise<PersonStats> {
  if (seesOwnHiddenTrail(viewer, personId)) {
    return queryPersonStats(await getSupabase(), personId);
  }
  return readPersonStats(personId);
}

async function readPersonStats(personId: string): Promise<PersonStats> {
  "use cache";
  cacheLife("trail");
  cacheTag(tags.trail(personId));

  return queryPersonStats(getPublicSupabase(), personId);
}

async function queryPersonStats(
  supabase: Supabase | null,
  personId: string,
): Promise<PersonStats> {
  if (!supabase) {
    return statsFrom(
      seedActivity(personId).map((event) => ({ kind: event.kind, created_at: event.createdAt })),
    );
  }

  const { data, error } = await supabase
    .from("events")
    .select("kind, created_at")
    .eq("actor_id", personId)
    .order("id", { ascending: true })
    .limit(2000);
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("events");
    return { tasksDone: 0, rolesTaken: 0, since: "" };
  }

  return statsFrom(data ?? []);
}

function statsFrom(rows: { kind: string; created_at: string }[]): PersonStats {
  let tasksDone = 0;
  let rolesTaken = 0;
  let since = "";

  for (const row of rows) {
    if (row.kind === "task_done") tasksDone += 1;
    if (row.kind === "seat_filled") rolesTaken += 1;
    if (!since || row.created_at < since) since = row.created_at;
  }

  return { tasksDone, rolesTaken, since };
}

/** An update, with enough of its project to read as a line in somebody's inbox. */
export type FollowedUpdate = UpdateView & { project: { slug: string; title: string } };

/**
 * What has moved on the projects somebody follows.
 *
 * This is the whole point of following: the inbox is where a follow pays off,
 * otherwise the button is decoration. Two queries rather than an embed with a
 * filter, because "updates whose project I follow" is a join PostgREST cannot
 * express from this side.
 */
export async function listFollowedUpdates(userId: string, limit = 12): Promise<FollowedUpdate[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const follows = await supabase.from("follows").select("project_id").eq("user_id", userId);
  if (follows.error) {
    if (!isMissingTable(follows.error)) throw new Error(follows.error.message);
    warnMissingTable("follows");
    return [];
  }

  const projectIds = (follows.data ?? []).map((row) => row.project_id);
  if (projectIds.length === 0) return [];

  const { data, error } = await supabase
    .from("updates")
    .select("*, author:profiles(id, username, name), project:projects(slug, title)")
    .in("project_id", projectIds)
    .order("id", { ascending: false })
    .limit(limit);
  if (error) {
    if (!isMissingTable(error)) throw new Error(error.message);
    warnMissingTable("updates");
    return [];
  }

  type Row = UpdateRow & {
    author: BriefPerson | null;
    project: { slug: string; title: string } | null;
  };

  return ((data ?? []) as Row[]).map((entry) => ({
    id: entry.id,
    title: entry.title,
    body: entry.body,
    createdAt: entry.created_at,
    author: entry.author ?? null,
    project: entry.project ?? { slug: "", title: "Deleted project" },
  }));
}

/* ------------------------------------------------------------------ *
 * Shaping
 * ------------------------------------------------------------------ */

type BriefPerson = Pick<Person, "id" | "username" | "name">;

function toSummary(row: ProjectOverviewRow): ProjectSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    tagline: row.tagline,
    stage: row.stage as Stage,
    // ?? "" keeps reads alive on a database that has not run 0016 yet; a board
    // without the column simply shows no type badge and offers no type filter.
    projectType: row.project_type ?? "",
    // ?? "" keeps reads alive on a database that has not run
    // 20260829130000_link_first_projects.sql yet.
    highlight: row.highlight ?? "",
    problem: row.problem,
    solution: row.solution,
    audience: row.audience,
    tags: row.tags,
    glyph: row.glyph,
    docUrl: row.doc_url,
    liveUrl: row.live_url,
    repoUrl: row.repo_url,
    openForGitHubContributions: row.open_for_github_contributions ?? false,
    logoUrl: row.logo_url ?? "",
    createdAt: row.created_at,
    nowText: row.now_text ?? "",
    nowUpdatedAt: row.now_updated_at ?? null,
    // ?? keeps reads alive on a database that has not run 0010 yet; a board
    // without the column simply falls back to "when the project last changed".
    lastActivityAt: row.last_activity_at ?? row.created_at,
    owner: { id: row.owner_id, username: row.owner_username, name: row.owner_name },
    seatCount: Number(row.seat_count),
    openSeatCount: Number(row.open_seat_count),
    // ?? [] keeps reads alive on a database that has not run 0007 yet; the
    // role *filter* does need the column, so migrate before deploying that.
    openRoles: row.open_roles ?? [],
    activeMemberCount: Number(row.active_member_count),
    boostCount: Number(row.boost_count),
    followerCount: Number(row.follower_count ?? 0),
    commentCount: Number(row.comment_count),
    updateCount: Number(row.update_count ?? 0),
    openTaskCount: Number(row.open_task_count),
    doneTaskCount: Number(row.done_task_count),
  };
}

function toPerson(row: ProfileRow): Person {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    // Defaults keep reads working during the short window between deploying
    // this build and applying the profile migrations to Supabase.
    profession: row.profession ?? "",
    headline: row.headline ?? "",
    bio: row.bio ?? "",
    skills: row.skills ?? [],
    yearsExperience: row.years_experience ?? null,
    fields: row.fields ?? [],
    availability: availabilityStatus(row.availability_status),
    website: row.website ?? "",
    publicEmail: row.public_email ?? "",
    github: row.github ?? "",
    githubId: row.github_id ?? null,
    linkedin: row.linkedin ?? "",
    x: row.x_url ?? "",
    resume: row.resume_url ?? "",
    activityHidden: row.activity_hidden ?? [],
    githubActivityShown: row.github_activity_shown === true,
  };
}

function toActivity(row: EventRow & { actor?: BriefPerson | null }): ActivityEvent {
  const payload = row.payload ?? {};
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    projectId: row.project_id,
    projectSlug: payload.slug ?? "",
    projectTitle: payload.title ?? "deleted project",
    payload,
    actor: row.actor ?? null,
  };
}

/** `%` and `_` are wildcards in ILIKE; a search box should treat them as text. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/* ------------------------------------------------------------------ *
 * Read-only fallback, used when no Supabase project is attached
 * ------------------------------------------------------------------ */

function seedActivity(personId: string): ActivityEvent[] {
  const person = seedUsers.find((user) => user.id === personId);
  const hidden = person?.activityHidden ?? [];

  return seedEvents
    .filter((event) => event.actorId === personId && !hidden.includes(event.kind))
    .map((event) => ({
      id: event.id,
      kind: event.kind,
      createdAt: event.createdAt,
      projectId: seedProjects.find((project) => project.slug === event.projectSlug)?.id ?? null,
      projectSlug: event.projectSlug,
      projectTitle: event.payload.title ?? "",
      payload: event.payload,
      actor: person ? { id: person.id, username: person.username, name: person.name } : null,
    }));
}

function seedSummaries(): ProjectSummary[] {
  return seedProjects.map((project) => {
    const owner = seedUsers.find((user) => user.id === project.ownerId);
    return {
      ...project,
      stage: project.stage as Stage,
      // The seeded projects predate the question and carry a full brief, so
      // there is nothing for a highlight to stand in for.
      highlight: "",
      docUrl: project.docUrl,
      liveUrl: project.liveUrl,
      repoUrl: project.repoUrl,
      openForGitHubContributions: false,
      logoUrl: project.logoUrl,
      createdAt: project.createdAt,
      owner: {
        id: project.ownerId,
        username: owner?.username ?? "ahsan",
        name: owner?.name ?? "Builders",
      },
      nowText: project.now,
      nowUpdatedAt: project.nowUpdatedAt || null,
      lastActivityAt: [
        project.createdAt,
        project.nowUpdatedAt,
        ...project.updates.map((entry) => entry.createdAt),
      ]
        .filter(Boolean)
        .sort()
        .at(-1) as string,
      seatCount: project.seats.length,
      openSeatCount: project.seats.filter((seat) => seat.status === "open").length,
      openRoles: [
        ...new Set(
          project.seats.filter((seat) => seat.status === "open").map((seat) => seat.role),
        ),
      ],
      activeMemberCount: project.seats.filter((seat) => seat.status === "filled").length,
      boostCount: 0,
      followerCount: 0,
      commentCount: 0,
      updateCount: project.updates.length,
      openTaskCount: project.tasks.filter((task) => task.status !== "done").length,
      doneTaskCount: project.tasks.filter((task) => task.status === "done").length,
    };
  });
}

function seedFeed(query: FeedQuery): ProjectSummary[] {
  const lane = query.lane ?? "for-you";
  const shape = LANE_QUERY[lane];
  const needle = query.q?.toLowerCase() ?? "";
  const roleNeedle = query.roleQuery ?? "";
  const stage = shape.stage ?? query.stage;

  const matching = seedSummaries().filter((project) => {
    if (stage && project.stage !== stage) return false;
    if (query.projectType && project.projectType !== query.projectType) return false;
    if ((shape.needsHelp || query.needsHelp) && project.openSeatCount === 0) return false;
    if (query.tag && !project.tags.includes(query.tag)) return false;
    if (query.role) {
      const wantedRole = normaliseRole(query.role);
      if (wantedRole && !project.openRoles.some((role) => normaliseRole(role) === wantedRole)) {
        return false;
      }
    }
    if (roleNeedle) {
      const source = seedProjects.find((entry) => entry.id === project.id);
      const hasMatchingOpenRole = source?.seats.some(
        (seat) =>
          seat.status === "open" &&
          roleMatchesQuery(seat.role, seat.roleTitle ?? "", roleNeedle),
      );
      if (!hasMatchingOpenRole) return false;
    }
    if (needle) {
      const haystack = [
        project.title,
        project.tagline,
        project.highlight,
        project.problem,
        project.solution,
        project.audience,
        project.nowText,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const ordered = matching.sort(
    lane === "newest"
      ? (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id
      : (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id - a.id,
  );

  // Not arranged here, same as the database path: ordering for a visitor is
  // the caller's job once it knows who is looking.
  return ordered;
}

/** Seed projects where this person holds a filled seat, with the role held. */
function seedContributions(personId: string): Contribution[] {
  const summaries = seedSummaries();

  return seedProjects.flatMap((project) => {
    if (project.ownerId === personId) return [];
    const seat = project.seats.find(
      (candidate) => candidate.status === "filled" && candidate.userId === personId,
    );
    const summary = summaries.find((candidate) => candidate.id === project.id);
    return seat && summary ? [{ ...summary, role: seat.role }] : [];
  });
}

function seedDetail(slug: string): ProjectDetail | null {
  const summary = seedSummaries().find((project) => project.slug === slug);
  const source = seedProjects.find((project) => project.slug === slug);
  if (!summary || !source) return null;

  return {
    ...summary,
    seats: source.seats.map((seat, index) => ({
      id: index + 1,
      role: seat.role,
      roleTitle: "",
      brief: seat.brief,
      status: seat.status,
      access: seat.access,
      commitment: seat.commitment,
      pitch: seat.pitch,
      person: null,
    })),
    tasks: source.tasks.map((task, index) => ({
      id: index + 1,
      title: task.title,
      detail: task.detail,
      status: task.status,
      createdAt: source.createdAt,
      role: null,
      assignee: task.assigneeId
        ? (() => {
            const owner = seedUsers.find((user) => user.id === task.assigneeId);
            return owner
              ? { id: owner.id, username: owner.username, name: owner.name }
              : null;
          })()
        : null,
    })),
    comments: [],
    updates: source.updates.map((entry, index) => ({
      id: index + 1,
      title: entry.title,
      body: entry.body,
      createdAt: entry.createdAt,
      author: null,
    })),
  };
}

/** Rows from `oss_contributions`, by whom. Empty when the table is missing. */
async function readOssRows(userId?: string): Promise<OssRow[]> {
  const supabase = getPublicSupabase();
  if (!supabase) return [];

  const [typed, merged] = await Promise.all([readTypedOssRows(supabase, userId), readMergedOssRows(supabase, userId)]);
  return mergeOssRows(typed, merged);
}

/**
 * Repositories GitHub says a member had a pull request merged into — only of
 * members who agreed to be shown, which the table's read policy decides.
 */
async function readMergedOssRows(supabase: Supabase, userId?: string): Promise<{ userId: string; repo: string }[]> {
  let request = supabase.from("github_contributions").select("user_id, repo").order("first_merged_at", { ascending: true }).limit(5000);
  if (userId) request = request.eq("user_id", userId);
  const { data, error } = await request;
  if (error) {
    // A deploy ahead of 20261027000100_github_contributions.sql keeps the
    // typed record alone.
    console.warn(`[builders] Verified open source records were skipped: ${error.message}`);
    return [];
  }
  return (data ?? []).map((row) => ({ userId: row.user_id, repo: row.repo }));
}

async function readTypedOssRows(supabase: Supabase, userId?: string): Promise<{ userId: string; repo: string; relation: OssRelation }[]> {
  let request = supabase
    .from("oss_contributions")
    .select("user_id, repo, relation")
    .order("created_at", { ascending: true })
    .limit(5000);
  if (userId) request = request.eq("user_id", userId);
  const { data, error } = await request;

  if (error) {
    // The records decorate the directory and the profile; neither depends on
    // them. A deploy that runs ahead of 20261020000000_oss_contributions.sql
    // loses the badges, not the page.
    console.warn(`[builders] Open source records were skipped: ${error.message}`);
    return [];
  }

  return (data ?? [])
    .filter((row) => isOssRelation(row.relation))
    .map((row) => ({ userId: row.user_id, repo: row.repo, relation: row.relation as OssRelation }));
}

/**
 * Every member with their open source record, for the directory's badges.
 *
 * Members with no rows are kept too: one of them may own a listed repository
 * on GitHub outright, which is a badge on its own.
 */
export async function listOssMembers(): Promise<OssMember[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.oss, tags.people);

  const [people, rows] = await Promise.all([listPeople(1000), readOssRows()]);
  const byUser = new Map<string, OssContribution[]>();
  for (const row of rows) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), { repo: row.repo, relation: row.relation, manual: row.manual, verified: row.verified }]);
  }

  return people.map((person) => ({
    username: person.username,
    name: person.name,
    handle: githubHandle(person.github),
    contributions: byUser.get(person.id) ?? [],
  }));
}

/** One person's open source record, oldest first — the order they added it. */
export async function listOssContributionsOf(userId: string): Promise<OssContribution[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.oss);

  return (await readOssRows(userId)).map(({ repo, relation, manual, verified }) => ({ repo, relation, manual, verified }));
}

const CATALOGUE_COLUMNS =
  "id, repo, list, reasons, why, summary, indonesian, starter_label, status, submitted_by, created_at";

/** Rows from `oss_repos`, with who put each one forward. */
async function toCatalogue(
  rows: Pick<OssRepoRow, "id" | "repo" | "list" | "reasons" | "why" | "summary" | "indonesian" | "starter_label" | "status" | "submitted_by" | "created_at">[],
): Promise<OpenSourceRepo[]> {
  const people = rows.some((row) => row.submitted_by) ? await listPeople(1000) : [];
  const byId = new Map(people.map((person) => [person.id, { username: person.username, name: person.name }]));
  return rows
    .map((row) => toOpenSourceRepo({ ...row, submitter: row.submitted_by ? byId.get(row.submitted_by) ?? null : null }))
    .filter((repo): repo is OpenSourceRepo => repo !== null);
}

/**
 * The approved catalogue, oldest first: ours before recommendations is the
 * directory's job, and within each list the order things were approved in is
 * as fair as any.
 */
export async function listCatalogue(): Promise<OpenSourceRepo[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.catalogue, tags.people);

  const supabase = getPublicSupabase();
  if (!supabase) return SEED_REPOS.map((repo) => ({ ...repo }));

  const { data, error } = await supabase
    .from("oss_repos")
    .select(CATALOGUE_COLUMNS)
    .eq("status", "approved")
    .order("created_at", { ascending: true });

  if (error) {
    // A deploy ahead of 20261021000000_oss_catalogue.sql loses the repos, not
    // the directory: products still list, and the log says why.
    console.warn(`[builders] The open source catalogue was skipped: ${error.message}`);
    return [];
  }
  return toCatalogue(data ?? []);
}

/** What the directory knows about one repository on GitHub, from repo_signals. */
export type RepoSignals = { stats: GitHubRepositoryStats | null; activity: RepoActivity };

/** After this long without a successful check, "who gets merged" counts as unknown. */
const SIGNALS_TRUSTED_DAYS = 3;

/**
 * Every listed repository's GitHub facts, keyed `owner/name` (lower-cased).
 *
 * Written by the refresh-repos Edge Function, so reading them costs one
 * query and no GitHub request. Nothing in the app writes the table, so
 * nothing calls updateTag for it: the `board` lifetime is how soon a refresh
 * shows. The clock is read here, inside the cache, to decide whether a row is
 * too old to vouch for "actively accepting" — a job that stopped running must
 * not keep calling a repository active.
 */
export async function listRepoSignals(): Promise<Record<string, RepoSignals>> {
  "use cache";
  cacheLife("board");

  const supabase = getPublicSupabase();
  if (!supabase) return {};

  const { data, error } = await supabase.from("repo_signals").select("*");
  if (error) {
    // A deploy ahead of 20261022000000_repo_signals.sql loses the numbers and
    // the tiers fall back to "Accepting PRs"; the directory still lists.
    console.warn(`[builders] Repository signals were skipped: ${error.message}`);
    return {};
  }

  const trustedSince = Date.now() - SIGNALS_TRUSTED_DAYS * 86_400_000;
  return Object.fromEntries(
    (data ?? []).map((row) => {
      const checkedAt = Date.parse(row.checked_at);
      return [
        row.repo,
        {
          stats:
            row.stars === null
              ? null
              : {
                  stars: row.stars,
                  description: row.description,
                  language: row.language,
                  pushedAt: row.pushed_at ?? "",
                  archived: row.archived,
                },
          activity: { outsidePRs: checkedAt >= trustedSince ? row.outside_prs : null, checkedAt },
        },
      ];
    }),
  );
}

/**
 * The signed-in person's own submissions, whatever their status. Read with
 * their session, since RLS shows a pending row to its author alone.
 */
export async function listMySubmissions(userId: string): Promise<OpenSourceRepo[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("oss_repos")
    .select(CATALOGUE_COLUMNS)
    .eq("submitted_by", userId)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn(`[builders] Your submissions could not be read: ${error.message}`);
    return [];
  }
  return toCatalogue(data ?? []);
}

/** Every row, for /admin. RLS returns all of them only to a site admin. */
export async function listCatalogueForAdmin(): Promise<OpenSourceRepo[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("oss_repos")
    .select(CATALOGUE_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return toCatalogue(data ?? []);
}

/** Whether the signed-in person curates the catalogue. */
export async function isSiteAdmin(): Promise<boolean> {
  const supabase = await getSupabase();
  if (!supabase) return false;

  const { data, error } = await supabase.rpc("is_site_admin");
  if (error) {
    // Before the migration there are no admins, which is the safe answer.
    console.warn(`[builders] Admin check failed: ${error.message}`);
    return false;
  }
  return data === true;
}

/** How many pull requests the /activity page reads; the newest, merged or opened. */
const GITHUB_ACTIVITY_LIMIT = 300;

type PersonColumns = { id: string; username: string; name: string; github: string } | null;

function activityPerson(person: PersonColumns): ActivityPerson | null {
  if (!person) return null;
  const handle = githubHandle(person.github);
  return handle ? { id: person.id, username: person.username, name: person.name, handle } : null;
}

/**
 * Members' open source work from GitHub, newest first — see
 * supabase/functions/refresh-github-activity. Only people who agreed to be
 * shown: the tables' read policies check profiles.github_activity_shown.
 *
 * Tagged with the site-wide trail, which is what saving one's visibility
 * settings invalidates; the rows themselves change only in the Edge Function, and the
 * board's cache life is the backstop for that.
 */
export async function listGitHubActivity(): Promise<GitHubActivityEntry[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.activity, tags.people);

  const supabase = getPublicSupabase();
  if (!supabase) return [];

  const person = "person:profiles(id, username, name, github)";
  const [pullRequests, summaries] = await Promise.all([
    supabase
      .from("github_pull_requests")
      .select(`*, ${person}`)
      .order("opened_at", { ascending: false })
      .limit(GITHUB_ACTIVITY_LIMIT),
    supabase.from("github_commit_summaries").select(`*, ${person}`),
  ]);
  const error = pullRequests.error ?? summaries.error;
  if (error) {
    // A deploy ahead of 20261024000000_github_activity.sql shows an empty
    // page, not an error.
    console.warn(`[builders] GitHub activity was skipped: ${error.message}`);
    return [];
  }

  type WithPerson<T> = T & { person: PersonColumns };
  return buildGitHubActivity(
    ((pullRequests.data ?? []) as WithPerson<GitHubPullRequestRow>[]).map((row) => ({ ...row, person: activityPerson(row.person) })),
    ((summaries.data ?? []) as WithPerson<GitHubCommitSummaryRow>[]).map((row) => ({ ...row, person: activityPerson(row.person) })),
  );
}

/**
 * Every reaction left on /activity, with the reactor's name for the tooltip.
 * Shared by everybody, so cached; which ones are the viewer's own is worked
 * out by the page from these rows and the viewer's id.
 */
export async function listActivityReactions(): Promise<ReactionRow[]> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.reactions, tags.people);

  const supabase = getPublicSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("activity_reactions")
    .select("pull_request_url, user_id, emoji, person:profiles(name)")
    .order("id", { ascending: true })
    .limit(5000);
  if (error) {
    // A deploy ahead of 20261025000000_activity_reactions.sql shows the
    // activity without reactions, not an error.
    console.warn(`[builders] Activity reactions were skipped: ${error.message}`);
    return [];
  }

  type Row = { pull_request_url: string; user_id: string; emoji: string; person: { name: string } | null };
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    pull_request_url: row.pull_request_url,
    user_id: row.user_id,
    emoji: row.emoji,
    name: row.person?.name ?? "",
  }));
}

/** What a site admin has put first in the directory, by catalogue repo and by product. */
export type AdminPicks = { repoIds: number[]; projectIds: number[] };

/**
 * Every admin pick. Arrays rather than sets: the result is cached, and a
 * cached value has to survive being serialised.
 */
export async function listAdminPicks(): Promise<AdminPicks> {
  "use cache";
  cacheLife("board");
  cacheTag(tags.adminPicks);

  const supabase = getPublicSupabase();
  if (!supabase) return { repoIds: [], projectIds: [] };

  const { data, error } = await supabase.from("admin_picks").select("repo_id, project_id");
  if (error) {
    // A deploy ahead of 20261029000000_admin_picks.sql lists the directory
    // without picks, not an error.
    console.warn(`[builders] Admin picks were skipped: ${error.message}`);
    return { repoIds: [], projectIds: [] };
  }
  return {
    repoIds: (data ?? []).flatMap((row) => (row.repo_id === null ? [] : [row.repo_id])),
    projectIds: (data ?? []).flatMap((row) => (row.project_id === null ? [] : [row.project_id])),
  };
}
