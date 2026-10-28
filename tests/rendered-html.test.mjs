import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test, { after, before } from "node:test";

/**
 * Opens the built site the way a visitor does: `next start` on the output of
 * the last `next build`, with no Supabase, so the pages read the seed data.
 * Which site it checks follows NEXT_PUBLIC_SITE, as the build did, so run it
 * once after each build:
 *
 *   npm test                                                    # builders
 *   NEXT_PUBLIC_SITE=oss npx next build && \
 *   NEXT_PUBLIC_SITE=oss npm run test:rendered                  # oss
 *
 * Pure-logic tests cannot see a page that throws for a guest or a redirect
 * between the two sites that points the wrong way; this can.
 */

const oss = process.env.NEXT_PUBLIC_SITE === "oss";
const label = oss ? "oss" : "builders";

const BUILDERS_ORIGIN = "https://builders.swegrowth.id";
const OSS_ORIGIN = "https://oss.swegrowth.id";

// Seed data (app/lib/seed.ts): the one member and a project on the builders site.
const SEED_USER = "zikrulihsan";
const SEED_PROJECT = "warung-antre";

// Public pages: 200 and a heading.
const pages = [
  "/",
  "/directory",
  "/how-it-works",
  "/about",
  "/privacy",
  "/feedback",
  "/community",
  "/signin",
  "/forgot-password",
  "/account/password",
  "/account/language",
  `/u/${SEED_USER}`,
  ...(oss ? ["/recommend", "/leaderboard"] : ["/new", `/projects/${SEED_PROJECT}`]),
];

// Pages that need an account. A guest gets a 200 whose body carries the
// redirect to /signin, because it streams in after the status is sent. [path,
// where the guest is sent].
const guestOnly = [
  ["/admin", "/signin?next=%2Fadmin"],
  ["/account/profile", "/signin?next=%2Faccount%2Fprofile"],
  ["/get-started", "/signin?next=%2Fget-started"],
  ["/signup", "/signin"],
  ...(oss
    ? []
    : [
        ["/inbox", "/signin?next=%2Finbox"],
        [`/projects/${SEED_PROJECT}/edit`, `/signin?next=%2Fprojects%2F${SEED_PROJECT}%2Fedit`],
      ]),
];

// Addresses nothing lives at: still a 200 (the status is sent before the page
// knows), so the page's title is what says it was not found. [path, title].
const missing = [
  ["/u/no-such-member", /person not found/i],
  ...(oss ? [] : [["/projects/no-such-project", /project not found/i]]),
];

// [from, where it should land]. A path stays on the site; a full URL leaves it.
// /activity is the home page now, so it redirects rather than rendering.
const redirects = [
  ["/activity", "/"],
  ...(oss ? [["/new", `${BUILDERS_ORIGIN}/new`]] : [["/recommend", `${OSS_ORIGIN}/recommend`]]),
];

let server;
let base;
let output = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function untilReady(url, deadline) {
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`next start exited with ${server.exitCode}\n${output}`);
    }
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  throw new Error(`next start was not ready in time\n${output}`);
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    // No database, whatever the machine has in its environment.
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    output = (output + chunk).slice(-4000);
  };
  server.stdout.on("data", collect);
  server.stderr.on("data", collect);
  await untilReady(`${base}/`, Date.now() + 60_000);
});

after(() => {
  server?.kill();
});

for (const path of pages) {
  test(`${label}: ${path} renders with a heading`, async () => {
    const response = await fetch(base + path, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1[\s>]/);
  });
}

for (const [path, to] of guestOnly) {
  test(`${label}: ${path} sends a guest to ${to}`, async () => {
    const response = await fetch(base + path, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(`NEXT_REDIRECT;replace;${to};307;`));
  });
}

for (const [path, title] of missing) {
  test(`${label}: ${path} says it was not found`, async () => {
    const response = await fetch(base + path, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.match((await response.text()).match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? "", title);
  });
}

for (const [from, to] of redirects) {
  test(`${label}: ${from} redirects to ${to}`, async () => {
    const response = await fetch(base + from, { redirect: "manual" });
    assert.ok([307, 308].includes(response.status), `expected a redirect, got ${response.status}`);
    assert.equal(response.headers.get("location"), to);
  });
}
