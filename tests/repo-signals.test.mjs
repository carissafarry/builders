import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildQuery, chunk, parseResponse, repoKeyFromUrl } from "../supabase/functions/refresh-repos/signals.ts";
import { PR_EVIDENCE_DAYS } from "../app/lib/directory.ts";

test("a product's repo link becomes a key by the same narrow rule as the app", () => {
  assert.equal(repoKeyFromUrl("https://github.com/Aula-ID/koma"), "aula-id/koma");
  assert.equal(repoKeyFromUrl("https://www.github.com/ana/tool.git/"), "ana/tool");
  assert.equal(repoKeyFromUrl("http://github.com/ana/tool"), null);
  assert.equal(repoKeyFromUrl("https://github.com/ana"), null);
  assert.equal(repoKeyFromUrl("https://github.com/ana/tool/issues"), null);
  assert.equal(repoKeyFromUrl("https://gitlab.com/ana/tool"), null);
  assert.equal(repoKeyFromUrl("not a url"), null);
});

test("one query asks about every repository in the batch, with names quoted safely", () => {
  const query = buildQuery(["ana/tool", "aula-id/koma"], "2026-07-22");
  assert.match(query, /r0: repository\(owner: "ana", name: "tool"\)/);
  assert.match(query, /r1: repository\(owner: "aula-id", name: "koma"\)/);
  assert.match(query, /s1: search\(type: ISSUE, first: 100, query: "repo:aula-id\/koma is:pr is:merged merged:>=2026-07-22"\)/);
});

test("the answer becomes rows: outsiders counted, a missing repo and a failed search kept apart", () => {
  const checkedAt = "2026-10-20T00:00:00.000Z";
  const rows = parseResponse(
    ["aula-id/koma", "ana/gone", "ana/quiet"],
    {
      data: {
        r0: { stargazerCount: 81, description: "Coding assistant", pushedAt: "2026-10-19T00:00:00Z", isArchived: false, primaryLanguage: { name: "Rust" } },
        s0: {
          nodes: [
            { authorAssociation: "CONTRIBUTOR", author: { __typename: "User" } },
            { authorAssociation: "FIRST_TIME_CONTRIBUTOR", author: { __typename: "User" } },
            { authorAssociation: "NONE", author: { __typename: "Bot" } },
            { authorAssociation: "MEMBER", author: { __typename: "User" } },
            { authorAssociation: "OWNER", author: { __typename: "User" } },
            {},
          ],
        },
        r1: null,
        s1: { nodes: [] },
        r2: { stargazerCount: 0, description: null, pushedAt: "2026-05-12T15:52:06Z", isArchived: false, primaryLanguage: null },
        s2: null,
      },
      errors: [
        { path: ["r1"], message: "Could not resolve to a Repository with the name 'ana/gone'." },
        { path: ["s2"], message: "Search timed out" },
      ],
    },
    checkedAt,
  );

  assert.deepEqual(rows[0], {
    repo: "aula-id/koma",
    stars: 81,
    language: "Rust",
    description: "Coding assistant",
    pushed_at: "2026-10-19T00:00:00Z",
    archived: false,
    outside_prs: 2,
    checked_at: checkedAt,
    last_error: null,
  });
  assert.equal(rows[1].stars, null);
  assert.match(rows[1].last_error, /Could not resolve/);
  assert.equal(rows[2].stars, 0);
  assert.equal(rows[2].outside_prs, null, "a failed search is unknown, not zero");
  assert.equal(rows[2].last_error, "Search timed out");
});

test("the repository's own author is never an outsider, whatever GitHub calls them", () => {
  const solo = (login) => ({ author: { user: { login } } });
  const rows = parseResponse(
    ["go-routine-id/flowmaid-web", "ana/tool"],
    {
      data: {
        // An organisation's repository, written by one person whose membership
        // is private: their own pull requests come back as CONTRIBUTOR.
        r0: { stargazerCount: 0, pushedAt: "2026-10-28T00:00:00Z", isArchived: false, defaultBranchRef: { target: { history: { nodes: [solo("Rhyanz46"), solo("Rhyanz46"), { author: { user: null } }] } } } },
        s0: { nodes: [
          { authorAssociation: "CONTRIBUTOR", author: { __typename: "User", login: "Rhyanz46" } },
          { authorAssociation: "CONTRIBUTOR", author: { __typename: "User", login: "rhyanz46" } },
        ] },
        // A person's repository: their own PRs never count, a real outsider's do.
        r1: { stargazerCount: 3, pushedAt: "2026-10-28T00:00:00Z", isArchived: false, defaultBranchRef: { target: { history: { nodes: [solo("budi"), solo("budi"), solo("ana")] } } } },
        s1: { nodes: [
          { authorAssociation: "CONTRIBUTOR", author: { __typename: "User", login: "Ana" } },
          { authorAssociation: "CONTRIBUTOR", author: { __typename: "User", login: "budi" } },
          { authorAssociation: "FIRST_TIME_CONTRIBUTOR", author: { __typename: "User", login: "citra" } },
        ] },
      },
    },
    "2026-10-28T00:00:00.000Z",
  );
  assert.equal(rows[0].outside_prs, 0, "a one-person project is still looking for its first contributor");
  assert.equal(rows[1].outside_prs, 1);
});

test("batches split evenly and the function's window matches the app's", async () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const source = await readFile(new URL("../supabase/functions/refresh-repos/index.ts", import.meta.url), "utf8");
  assert.match(source, new RegExp(`const PR_EVIDENCE_DAYS = ${PR_EVIDENCE_DAYS};`));
});
