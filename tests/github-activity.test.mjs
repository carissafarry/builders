import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_SIZE,
  buildQuery,
  buildSearchQuery,
  chunk,
  githubHandle,
  parseResponse,
} from "../supabase/functions/refresh-github-activity/activity.ts";
import { activityRepos, activityStats, buildGitHubActivity, queryActivity } from "../app/lib/github-activity.ts";
import { githubHandle as appGithubHandle } from "../app/lib/oss.ts";

const now = new Date("2026-10-22T00:00:00.000Z");
const ana = { id: "00000000-0000-4000-8000-000000000001", handle: "ana" };
const budi = { id: "00000000-0000-4000-8000-000000000002", handle: "budi" };

test("the function reads a profile's GitHub field by the same rule as the app", () => {
  for (const value of ["https://github.com/Ana-Dev", "@ana", "ana", "github.com/ana", "https://gitlab.com/ana", "https://github.com/ana/repo", ""]) {
    assert.equal(githubHandle(value), appGithubHandle(value), value);
  }
});

test("one query asks about every member, public pull requests only, names quoted safely", () => {
  const query = buildQuery([ana, budi], now);
  assert.match(query, /u0: user\(login: "ana"\)/);
  assert.match(query, /u1: user\(login: "budi"\)/);
  assert.match(query, /contributionsCollection\(from: "2026-09-22T00:00:00.000Z"\)/);
  assert.match(query, /p1: search\(type: ISSUE, first: 50, query: "is:pr is:public author:budi updated:>=2026-07-24"\)/);
  assert.match(query, /organizations\(first: 100\)/);
  assert.match(query, /authorAssociation/);
});

test("pull requests are kept, own repos' marked as such; own repos' commits become one summary", () => {
  const [activity] = parseResponse(
    [ana],
    {
      data: {
        u0: {
          login: "Ana",
          contributionsCollection: {
            commitContributionsByRepository: [
              { repository: { nameWithOwner: "ana/side", isPrivate: false, owner: { login: "ana" } }, contributions: { totalCount: 3, nodes: [{ occurredAt: "2026-10-20T00:00:00Z" }] } },
              { repository: { nameWithOwner: "Ana/Blog", isPrivate: false, owner: { login: "Ana" } }, contributions: { totalCount: 9, nodes: [{ occurredAt: "2026-10-18T00:00:00Z" }] } },
              { repository: { nameWithOwner: "ana/secret", isPrivate: true, owner: { login: "ana" } }, contributions: { totalCount: 50, nodes: [] } },
              { repository: { nameWithOwner: "org/tool", isPrivate: false, owner: { login: "org" } }, contributions: { totalCount: 4, nodes: [] } },
            ],
          },
        },
        p0: {
          nodes: [
            { url: "https://github.com/org/tool/pull/7", number: 7, title: "Fix crash", state: "MERGED", createdAt: "2026-10-01T00:00:00Z", mergedAt: "2026-10-02T00:00:00Z", repository: { nameWithOwner: "Org/Tool", isPrivate: false, owner: { login: "Org" } } },
            { url: "https://github.com/org/tool/pull/8", number: 8, title: "Add docs", state: "OPEN", createdAt: "2026-10-10T00:00:00Z", mergedAt: null, repository: { nameWithOwner: "org/tool", isPrivate: false, owner: { login: "org" } } },
            { url: "https://github.com/org/tool/pull/9", number: 9, title: "Abandoned", state: "CLOSED", createdAt: "2026-10-10T00:00:00Z", mergedAt: null, repository: { nameWithOwner: "org/tool", isPrivate: false, owner: { login: "org" } } },
            { url: "https://github.com/ana/side/pull/1", number: 1, title: "Own repo", state: "MERGED", createdAt: "2026-10-10T00:00:00Z", mergedAt: "2026-10-11T00:00:00Z", repository: { nameWithOwner: "ana/side", isPrivate: false, owner: { login: "ana" } } },
            { url: "https://github.com/org/old/pull/2", number: 2, title: "Merged long ago", state: "MERGED", createdAt: "2026-01-01T00:00:00Z", mergedAt: "2026-01-02T00:00:00Z", repository: { nameWithOwner: "org/old", isPrivate: false, owner: { login: "org" } } },
          ],
        },
      },
    },
    now,
  );

  assert.equal(activity.found, true);
  assert.deepEqual(
    activity.pullRequests.map((row) => [row.repo, row.number, row.state, row.merged_at, row.own]),
    [
      ["org/tool", 7, "merged", "2026-10-02T00:00:00Z", false],
      ["org/tool", 8, "open", null, false],
      ["ana/side", 1, "merged", "2026-10-11T00:00:00Z", true],
    ],
  );
  assert.equal(activity.pullRequests[0].user_id, ana.id);
  assert.deepEqual(activity.summary, {
    user_id: ana.id,
    commits: 12,
    repos: [
      { repo: "ana/blog", commits: 9 },
      { repo: "ana/side", commits: 3 },
    ],
    last_commit_at: "2026-10-20T00:00:00Z",
    since: "2026-09-22",
    checked_at: now.toISOString(),
  });
});

test("an organisation the member belongs to is their own work, not a contribution", () => {
  const repository = (nameWithOwner) => ({ nameWithOwner, isPrivate: false, owner: { login: nameWithOwner.split("/")[0] } });
  const pr = (repo, number, authorAssociation) => ({
    url: `https://github.com/${repo}/pull/${number}`, number, title: `#${number}`, state: "MERGED",
    createdAt: "2026-10-10T00:00:00Z", mergedAt: "2026-10-11T00:00:00Z", authorAssociation, repository: repository(repo),
  });
  const commits = (repo, totalCount) => ({ repository: repository(repo), contributions: { totalCount, nodes: [{ occurredAt: "2026-10-11T00:00:00Z" }] } });
  const [activity] = parseResponse(
    [ana],
    {
      data: {
        u0: {
          login: "ana",
          // Public membership: shown here. Private membership only shows in a PR's authorAssociation.
          organizations: { nodes: [{ login: "Studio" }] },
          contributionsCollection: {
            commitContributionsByRepository: [commits("work/app", 40), commits("studio/site", 5), commits("big/oss", 2)],
          },
        },
        p0: {
          nodes: [pr("work/app", 1, "MEMBER"), pr("work/app", 2, "MEMBER"), pr("studio/site", 3, "CONTRIBUTOR"), pr("big/oss", 4, "CONTRIBUTOR"), pr("friend/lib", 5, "COLLABORATOR")],
        },
      },
    },
    now,
  );
  assert.deepEqual(
    activity.found && activity.pullRequests.map((row) => [row.repo, row.own]),
    [["work/app", true], ["work/app", true], ["studio/site", true], ["big/oss", false], ["friend/lib", false]],
  );
  assert.deepEqual(activity.found && activity.summary?.repos, [
    { repo: "work/app", commits: 40 },
    { repo: "studio/site", commits: 5 },
  ]);
});

test("a search the member's own repos filled is asked again without them", () => {
  const repository = (nameWithOwner) => ({ nameWithOwner, isPrivate: false, owner: { login: nameWithOwner.split("/")[0] } });
  const pr = (repo, number, authorAssociation) => ({
    url: `https://github.com/${repo}/pull/${number}`, number, title: "", state: "OPEN",
    createdAt: "2026-10-10T00:00:00Z", mergedAt: null, authorAssociation, repository: repository(repo),
  });
  const user = (login) => ({ login, contributionsCollection: { commitContributionsByRepository: [] } });
  const first = {
    data: {
      u0: user("ana"),
      p0: { issueCount: 103, nodes: [pr("work/app", 1, "MEMBER"), pr("work/app", 2, "MEMBER"), pr("ana/side", 3, "OWNER"), pr("big/oss", 4, "CONTRIBUTOR")] },
      u1: user("budi"),
      // Everything it found came back: nothing to ask again.
      p1: { issueCount: 1, nodes: [pr("work/app", 5, "MEMBER")] },
    },
  };
  const members = [ana, budi];
  const [anaFirst, budiFirst] = parseResponse(members, first, now);
  assert.deepEqual(anaFirst.found && anaFirst.narrowSearch, ["work", "ana"]);
  assert.deepEqual(budiFirst.found && budiFirst.narrowSearch, []);

  const query = buildSearchQuery([{ index: 0, handle: "ana", exclude: ["work", "ana"] }], now);
  assert.match(query, /p0: search\(type: ISSUE, first: 50, query: "is:pr is:public author:ana updated:>=2026-07-24 -user:work -user:ana"\)/);
  assert.doesNotMatch(query, /u0:/);
  // A query GitHub would refuse for its length keeps only the owners that fit.
  const long = buildSearchQuery([{ index: 0, handle: "ana", exclude: Array.from({ length: 20 }, (_, i) => `organisation-${i}`) }], now);
  assert.ok(JSON.parse(long.match(/query: (".*?")\)/)[1]).length <= 256);

  const [anaBoth] = parseResponse(members, first, now, {
    data: { p0: { issueCount: 2, nodes: [pr("big/oss", 4, "CONTRIBUTOR"), pr("other/lib", 6, "CONTRIBUTOR")] } },
  });
  assert.deepEqual(anaBoth.found && anaBoth.pullRequests.map((row) => [row.number, row.own]), [[1, true], [2, true], [3, true], [4, false], [6, false]]);
  // A failed second search leaves the first answer standing.
  const [anaFailed] = parseResponse(members, first, now, { data: { p0: null }, errors: [{ path: ["p0"], message: "timeout" }] });
  assert.deepEqual(anaFailed.found && anaFailed.pullRequests.map((row) => row.number), [1, 2, 3, 4]);
});

test("an unknown account and a failed search are told apart from an empty answer", () => {
  const [missing, failed, quiet] = parseResponse(
    [ana, budi, { id: "00000000-0000-4000-8000-000000000003", handle: "cici" }],
    {
      data: {
        u0: null,
        u1: { login: "budi", contributionsCollection: { commitContributionsByRepository: [] } },
        p1: null,
        u2: { login: "cici", contributionsCollection: { commitContributionsByRepository: [] } },
        p2: { nodes: [] },
      },
      errors: [{ path: ["u0"], message: "Could not resolve to a User" }, { path: ["p1"], message: "timeout" }],
    },
    now,
  );
  assert.equal(missing.found, false);
  assert.equal(failed.found && failed.searchFailed, true);
  assert.equal(quiet.found && quiet.searchFailed, false);
  assert.equal(quiet.found && quiet.summary, null);
});

test("members go to GitHub in batches", () => {
  const members = Array.from({ length: BATCH_SIZE * 2 + 1 }, (_, index) => ({ id: String(index), handle: `m${index}` }));
  assert.deepEqual(chunk(members, BATCH_SIZE).map((batch) => batch.length), [BATCH_SIZE, BATCH_SIZE, 1]);
});

test("the feed puts newest first, and the sidebar and search narrow it", () => {
  const person = { id: ana.id, username: "ana", name: "Ana", handle: "ana" };
  const entries = buildGitHubActivity(
    [
      { url: "https://github.com/org/tool/pull/7", user_id: ana.id, repo: "org/tool", number: 7, title: "Fix", state: "merged", opened_at: "2026-10-01T00:00:00Z", merged_at: "2026-10-05T00:00:00Z", checked_at: "", person },
      { url: "https://github.com/org/tool/pull/8", user_id: ana.id, repo: "org/tool", number: 8, title: "Docs", state: "open", opened_at: "2026-10-03T00:00:00Z", merged_at: null, checked_at: "", person },
      { url: "https://github.com/org/tool/pull/9", user_id: "gone", repo: "org/tool", number: 9, title: "No person", state: "open", opened_at: "2026-10-09T00:00:00Z", merged_at: null, checked_at: "", person: null },
    ],
    [{ user_id: ana.id, commits: 4, repos: [{ repo: "ana/side", commits: 4 }], last_commit_at: "2026-10-04T00:00:00Z", since: "2026-09-22", checked_at: "", person }],
  );

  assert.deepEqual(entries.map((entry) => entry.key), [
    "https://github.com/org/tool/pull/7",
    `commits:${ana.id}`,
    "https://github.com/org/tool/pull/8",
  ]);
  const any = { kind: "all", member: "", repo: "", q: "" };
  assert.deepEqual(queryActivity(entries, { ...any, kind: "merged" }).map((entry) => entry.key), ["https://github.com/org/tool/pull/7"]);
  assert.deepEqual(queryActivity(entries, { ...any, kind: "open" }).map((entry) => entry.key), ["https://github.com/org/tool/pull/8"]);
  assert.deepEqual(queryActivity(entries, { ...any, kind: "commits" }).map((entry) => entry.key), [`commits:${ana.id}`]);
  assert.deepEqual(queryActivity(entries, { ...any, repo: "ana/side" }).map((entry) => entry.key), [`commits:${ana.id}`]);
  assert.deepEqual(queryActivity(entries, { ...any, q: "DOCS" }).map((entry) => entry.key), ["https://github.com/org/tool/pull/8"]);
});

test("a person's pull requests to one repo on one day are one entry", () => {
  const person = { id: ana.id, username: "ana", name: "Ana", handle: "ana" };
  const merged = (number, merged_at, repo = "org/tool") => ({
    url: `https://github.com/${repo}/pull/${number}`, user_id: ana.id, repo, number, title: `PR ${number}`, state: "merged",
    opened_at: "2026-10-01T00:00:00Z", merged_at, checked_at: "", person,
  });
  const entries = buildGitHubActivity(
    [
      merged(234, "2026-10-12T02:00:00Z"),
      merged(236, "2026-10-12T09:00:00Z"),
      merged(235, "2026-10-12T05:00:00Z"),
      // 18:00 UTC is the next day in Jakarta: a separate entry.
      merged(237, "2026-10-12T18:00:00Z"),
      merged(9, "2026-10-12T04:00:00Z", "org/other"),
      { ...merged(238, null), state: "open", opened_at: "2026-10-12T06:00:00Z" },
    ],
    [],
  );

  const tool = entries.filter((entry) => entry.repo === "org/tool");
  assert.deepEqual(
    tool.map((entry) => [entry.state, entry.pullRequests.map((pr) => pr.number)]),
    [["merged", [237]], ["merged", [236, 235, 234]], ["open", [238]]],
  );
  // Reactions stay on the day's first PR when later ones join it.
  const day = tool[1];
  assert.equal(day.url, "https://github.com/org/tool/pull/234");
  assert.equal(day.key, day.url);
  assert.equal(day.at, "2026-10-12T09:00:00Z");

  assert.deepEqual(activityStats(entries), { people: 1, merged: 5, open: 1, repos: 2 });
  assert.deepEqual(activityRepos(entries), [{ repo: "org/tool", count: 5 }, { repo: "org/other", count: 1 }]);
  assert.deepEqual(queryActivity(entries, { kind: "all", member: "", repo: "", q: "pr 235" }).map((entry) => entry.key), [day.key]);
});

test("contributions and own work are told apart, like local and global", async () => {
  const { inScope, scopeCounts, activityStats } = await import("../app/lib/github-activity.ts");
  const person = { id: ana.id, username: "ana", name: "Ana", handle: "ana" };
  const row = (repo, number, own, merged_at = `2026-10-0${number}T00:00:00Z`) => ({
    url: `https://github.com/${repo}/pull/${number}`, user_id: ana.id, repo, number, title: "", state: merged_at ? "merged" : "open",
    opened_at: "2026-10-01T00:00:00Z", merged_at, checked_at: "", own, person,
  });
  const entries = buildGitHubActivity(
    [
      row("org/tool", 1, false),
      // Their own: counted into the summary, not listed one by one.
      row("work/app", 2, true),
      row("work/app", 3, true),
      row("ana/side", 5, true),
      row("ana/new", 6, true),
      // Still in review, or merged before the summary's 30 days: not counted.
      row("ana/side", 7, true, null),
      row("ana/side", 8, true, "2026-08-01T00:00:00Z"),
    ],
    [{ user_id: ana.id, commits: 4, repos: [{ repo: "ana/side", commits: 4 }], last_commit_at: "2026-10-04T00:00:00Z", since: "2026-09-22", checked_at: "", person }],
    "Asia/Jakarta",
    now,
  );
  assert.deepEqual(scopeCounts(entries), { all: 2, external: 1, own: 1 });
  assert.deepEqual(inScope(entries, "external").map((entry) => entry.key), ["https://github.com/org/tool/pull/1"]);
  const [summary] = inScope(entries, "own");
  assert.equal(summary.key, `commits:${ana.id}`);
  assert.equal(summary.commits, 4);
  assert.equal(summary.merged, 4);
  assert.deepEqual(summary.repos, [{ repo: "ana/side", commits: 4 }, { repo: "work/app", commits: 0 }, { repo: "ana/new", commits: 0 }]);
  // The newest of its commits and merges.
  assert.equal(summary.at, "2026-10-06T00:00:00Z");
  // The heading counts contributions only.
  assert.deepEqual(activityStats(entries), { people: 1, merged: 1, open: 0, repos: 1 });
});

test("own pull requests alone still make a summary", () => {
  const person = { id: ana.id, username: "ana", name: "Ana", handle: "ana" };
  const entries = buildGitHubActivity(
    [{ url: "https://github.com/work/app/pull/1", user_id: ana.id, repo: "work/app", number: 1, title: "", state: "merged", opened_at: "2026-10-01T00:00:00Z", merged_at: "2026-10-20T00:00:00Z", checked_at: "", own: true, person }],
    [],
    "Asia/Jakarta",
    now,
  );
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.commits, entry.merged, entry.repos]), [["commit_summary", 0, 1, [{ repo: "work/app", commits: 0 }]]]);
});

test("the page's numbers and the sidebar's groups come from the same entries", async () => {
  const { activityPeople, activityRepos, activityStats, kindCounts } = await import("../app/lib/github-activity.ts");
  const ana = { id: "a", username: "ana", name: "Ana", handle: "Ana" };
  const budi = { id: "b", username: "budi", name: "Budi", handle: "budi" };
  const pr = (key, person, repo, state, at, count = 1) => ({
    kind: "pull_request", key, person, repo, url: key, state, at,
    pullRequests: Array.from({ length: count }, (_, index) => ({ url: `${key}/${index}`, number: index + 1, title: "", at })),
  });
  const entries = [
    pr("1", ana, "org/a", "merged", "2026-10-21T00:00:00Z", 3),
    pr("2", ana, "org/b", "open", "2026-10-10T00:00:00Z"),
    pr("3", budi, "org/a", "merged", "2026-08-01T00:00:00Z"),
    { kind: "commit_summary", key: "c", person: budi, commits: 4, merged: 2, repos: [], since: "", at: "2026-10-20T00:00:00Z" },
  ];
  // Numbers count pull requests; the kind facets count entries, as the list shows them.
  assert.deepEqual(activityStats(entries), { people: 2, merged: 4, open: 1, repos: 2 });
  assert.deepEqual(kindCounts(entries), { all: 4, merged: 2, open: 1, commits: 1 });
  assert.deepEqual(activityRepos(entries), [{ repo: "org/a", count: 4 }, { repo: "org/b", count: 1 }]);
  assert.deepEqual(activityPeople(entries).map(({ person, count }) => [person.handle, count]), [["Ana", 4], ["budi", 3]]);
});

test("merged pull requests become lasting contributions and pending suggestions", async () => {
  const { contributionsFrom, suggestionsFrom } = await import("../supabase/functions/refresh-github-activity/activity.ts");
  const pr = (repo, number, state, merged_at) => ({
    url: `https://github.com/${repo}/pull/${number}`, user_id: "u", repo, number, title: "", state, opened_at: "2026-10-01T00:00:00Z", merged_at, checked_at: "",
  });
  const prs = [
    pr("org/a", 2, "merged", "2026-10-10T00:00:00Z"),
    pr("org/a", 1, "merged", "2026-10-05T00:00:00Z"),
    pr("org/b", 3, "open", null),
    pr("org/c", 4, "merged", "2026-10-20T00:00:00Z"),
    // Their own repository's: their own work, neither a contribution nor a suggestion.
    { ...pr("u/side", 5, "merged", "2026-10-21T00:00:00Z"), own: true },
  ];
  // org/c was first merged long ago, before the 90-day window: that stays.
  const stored = [{ user_id: "u", repo: "org/c", first_merged_at: "2026-01-01T00:00:00Z", last_merged_at: "2026-02-01T00:00:00Z" }];
  assert.deepEqual(contributionsFrom(prs, stored), [
    { user_id: "u", repo: "org/c", first_merged_at: "2026-01-01T00:00:00Z", last_merged_at: "2026-10-20T00:00:00Z" },
    { user_id: "u", repo: "org/a", first_merged_at: "2026-10-05T00:00:00Z", last_merged_at: "2026-10-10T00:00:00Z" },
  ]);
  assert.deepEqual(suggestionsFrom(prs, "ana"), [
    { repo: "org/a", why: "PR dari @ana sudah di-merge: https://github.com/org/a/pull/1", submitted_by: "u" },
    { repo: "org/c", why: "PR dari @ana sudah di-merge: https://github.com/org/c/pull/4", submitted_by: "u" },
  ]);
});

test("the timeline groups by day in WIB, not in the server's UTC", async () => {
  const { dayKey, groupByDay } = await import("../app/lib/github-activity.ts");
  // 18:00 UTC is already the next day in Jakarta.
  assert.equal(dayKey("2026-10-21T18:00:00Z", "Asia/Jakarta"), "2026-10-22");
  assert.equal(dayKey("2026-10-21T16:00:00Z", "Asia/Jakarta"), "2026-10-21");
  const at = (key, when) => ({ kind: "pull_request", key, at: when });
  const days = groupByDay([at("a", "2026-10-22T03:00:00Z"), at("b", "2026-10-21T18:00:00Z"), at("c", "2026-10-21T10:00:00Z")]);
  assert.deepEqual(days.map(({ day, entries }) => [day, entries.map((entry) => entry.key)]), [["2026-10-22", ["a", "b"]], ["2026-10-21", ["c"]]]);
});

test("a login that now belongs to another account than the one linked is not the member's", () => {
  const now = new Date("2026-10-27T00:00:00Z");
  const linked = { id: "a", handle: "fajarhide", githubId: 4821 };
  const query = buildQuery([linked], now);
  assert.match(query, /databaseId/);

  const [same] = parseResponse([linked], { data: { u0: { login: "fajarhide", databaseId: 4821 }, p0: { issueCount: 0, nodes: [] } } }, now);
  assert.equal(same.found, true);
  // Renamed, and somebody else took the old login: a different id answers.
  const [taken] = parseResponse([linked], { data: { u0: { login: "fajarhide", databaseId: 9999 }, p0: { issueCount: 0, nodes: [] } } }, now);
  assert.equal(taken.found, false);
});

test("a repository the member wrote nearly alone is their own work, whoever owns it", async () => {
  const { authorQuestions, buildAuthorQuery, mainAuthorsOf, parseResponse } = await import("../supabase/functions/refresh-github-activity/activity.ts");
  const now = new Date("2026-10-28T00:00:00Z");
  const member = { id: "11111111-1111-4111-8111-111111111111", handle: "Rhyanz46" };
  const pr = (repo, number) => ({
    url: `https://github.com/${repo}/pull/${number}`, number, title: "Work", state: "MERGED",
    createdAt: "2026-10-20T00:00:00Z", mergedAt: "2026-10-21T00:00:00Z",
    // A private membership: GitHub calls the author a mere contributor.
    authorAssociation: "CONTRIBUTOR",
    repository: { nameWithOwner: repo, isPrivate: false, owner: { login: repo.split("/")[0] } },
  });
  const body = { data: {
    u0: { login: "Rhyanz46", organizations: { nodes: [] }, contributionsCollection: { commitContributionsByRepository: [
      { repository: { nameWithOwner: "go-routine-id/flowmaid", isPrivate: false, owner: { login: "go-routine-id" } }, contributions: { totalCount: 12, nodes: [{ occurredAt: "2026-10-21T00:00:00Z" }] } },
    ] } },
    p0: { issueCount: 3, nodes: [pr("go-routine-id/flowmaid", 1), pr("ahmadrosid/nakama", 2), pr("busy/shared", 3)] },
  } };

  const first = parseResponse([member], body, now);
  const repos = authorQuestions(first);
  assert.deepEqual(repos, ["ahmadrosid/nakama", "busy/shared", "go-routine-id/flowmaid"]);
  assert.match(buildAuthorQuery(repos), /a2: repository\(owner: "go-routine-id", name: "flowmaid"\)/);

  const commits = (counts) => ({ defaultBranchRef: { target: { history: { nodes: Object.entries(counts).flatMap(([login, n]) => Array.from({ length: n }, () => ({ author: { user: { login } } }))) } } } });
  const authors = mainAuthorsOf(repos, { data: {
    a0: commits({ ahmadrosid: 57, fajarhide: 8 }),
    // The member writes most of it, but not nearly all: still somebody else's.
    a1: commits({ rhyanz46: 60, owner: 40 }),
    a2: commits({ Rhyanz46: 100 }),
  } });
  assert.deepEqual([...authors], [["ahmadrosid/nakama", "ahmadrosid"], ["go-routine-id/flowmaid", "rhyanz46"]]);

  const [activity] = parseResponse([member], body, now, undefined, authors);
  assert.deepEqual(activity.pullRequests.map((row) => [row.repo, row.own]), [
    ["go-routine-id/flowmaid", true],
    ["ahmadrosid/nakama", false],
    ["busy/shared", false],
  ]);
  assert.deepEqual(activity.summary.repos, [{ repo: "go-routine-id/flowmaid", commits: 12 }], "its commits join their own work");
});
