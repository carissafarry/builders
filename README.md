# Builders

[![CI](https://github.com/swegrowthid/builders/actions/workflows/ci.yml/badge.svg)](https://github.com/swegrowthid/builders/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The code behind two sites of the [swegrowth](https://swegrowth.id) community,
built from one codebase and one Supabase database:

| Site | What it is for |
| --- | --- |
| [builders.swegrowth.id](https://builders.swegrowth.id) | **Products** members are building. A directory of every active product, filtered to the ones looking for help (engineer, designer, PM, researcher, writer, QA…); each product's story, stage, journey and open roles; and an activity feed of what those products did, with reactions. |
| [oss.swegrowth.id](https://oss.swegrowth.id) | **Open source.** A directory of repositories taking contributors — ones we maintain, ones a member recommends with their reason, and members' products that take pull requests — plus an activity feed of members' pull requests, straight from GitHub. |

Which site a deploy is comes from `NEXT_PUBLIC_SITE` at build time (`builders`
by default, or `oss`; see `app/lib/site.ts`). Each site redirects the other's
routes to it, and one sign-in works on both.

A profile, on either site, is the work with somebody's name on it: what they
build and help build on builders, their open source record on oss.

Next.js on Netlify, with Supabase for both the database and sign-in.

[builders.swegrowth.id](https://builders.swegrowth.id) · [oss.swegrowth.id](https://oss.swegrowth.id) · [Report a bug](https://github.com/swegrowthid/builders/issues/new?template=bug_report.yml) · [Suggest an improvement](https://github.com/swegrowthid/builders/issues/new?template=feature_request.yml)

> [!NOTE]
> Builders is under active development. The database schema and user-facing
> behavior may change while the project is still young.

## Prerequisites

- Node.js `>=22.13.0`
- A Supabase project (free tier is plenty)

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL and anon key
npm run dev                  # http://localhost:3000, the builders site
NEXT_PUBLIC_SITE=oss npm run dev   # the open source site
```

Without `.env.local` the site still runs: it serves the read-only seed from
`app/lib/seed.ts`, so you can work on the pages without a database. Signing in
and everything that writes will say so rather than failing quietly.

## Setting up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Apply the files in `supabase/migrations/` **in filename order** — with
   `supabase link` then `supabase db push`, or one by one in the SQL editor.
   Each file opens with a comment saying what it adds and why. The deploy
   tolerates running ahead of the database — a page loses the feature a
   missing table feeds rather than falling over, and says so in the server log
   — but nothing new works until they are applied. Make yourself a site admin
   afterwards, in the SQL editor:
   `insert into public.site_admins (user_id) select id from public.profiles where username = '<you>';`
3. Copy the project URL and the **anon** key from Project Settings → API into
   `.env.local`. Never put the `service_role` key in this app; it bypasses every
   policy.
4. Sign up through the site with your own email.
5. Optional: open `supabase/seed.sql`, change `owner_email` at the top to that
   same address, and run it. That imports the starting projects under your
   account.

Email confirmation is on by default in Supabase. The link it sends lands on
`/auth/confirm`, which exchanges the PKCE authorization code for a session.
The callback also accepts `token_hash` and `type` from a custom SSR email
template. If you turn confirmation off, sign-up signs people straight in
instead.

### Google login

1. In Google Auth Platform, configure Branding and Audience, then make sure Data
   Access includes `openid`, `userinfo.email`, and `userinfo.profile`.
2. Create an OAuth 2.0 **Web application** client. Add each app origin under
   Authorized JavaScript origins (for example `http://localhost:3000` and the
   production origin), then add Supabase's callback as an authorized redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. In Supabase, open Authentication → Providers → Google, enable it, then paste
   the Google client ID and client secret.
4. Under Authentication → URL Configuration, add both app callbacks to the
   **Redirect URLs** allow list, for **every** origin people reach the site on —
   the custom domain, the deploy URL behind it, and local:
   - `<origin>/auth/callback`
   - `<origin>/auth/confirm`

> [!IMPORTANT]
> An empty or incomplete Redirect URLs list is the quietest way to break
> sign-in. Supabase does not report a rejected `redirect_to`; it silently
> falls back to the **Site URL**, so the authorization code arrives on a page
> that has no idea what to do with it and the person simply stays signed out.
> Only `/auth/callback` and `/auth/confirm` belong on that list. Nothing else
> in this app trades a code for a session — `/get-started` is where a *successful*
> sign-in lands, and putting it on the allow list would break the very flow it
> is meant to finish.

Sign-in always *starts* at one address. A Netlify site answers to several —
the custom domain, the `*.netlify.app` subdomain behind it, and a per-deploy
permalink like `https://<deploy-id>--<site>.netlify.app` — and the address the
function is invoked with is not always the one in the address bar. Since the
verifier is a cookie, and a cookie belongs to one host, `/auth/google` moves
somebody to the site's primary address *before* writing it (see `pinnedOrigin`
in `app/lib/urls.ts`); everything after that follows the browser instead of
pinning anything. Set `NEXT_PUBLIC_SITE_URL` to name that address, or let
Netlify's own `URL` stand in on production deploys. A sign-in that leaves from
one name and returns on another is what puts `?error=origin-mismatch` on the
sign-in page.

Sign-in starts at `/auth/google`, a route handler, and that is deliberate
rather than incidental. `signInWithOAuth` generates the PKCE code verifier and
writes it as a cookie, and `/auth/callback` reads it back to trade the
authorization code for a session; a verifier that never reaches the browser
fails the callback with a message about a missing verifier, which reads like a
misconfigured redirect URL and is not one. The route handler sets that cookie
on the very redirect that sends somebody to Google — one response carrying both
the destination and the cookie that makes the return trip work. Only
`/auth/callback` and `/auth/confirm` go on Supabase's allow list; `/auth/google`
is an entry point on this site and Supabase never redirects to it.

No Google client secret belongs in this Next.js app. Supabase stores it and the
app only uses the existing public URL and anon key. Supabase's current setup
screens and exact callback value are documented in its
[Google login guide](https://supabase.com/docs/guides/auth/social-login/auth-google).
For a branded domain on Google's account screen, configure a Supabase custom
domain such as `auth.example.com` and update Google's authorized redirect URI to
match it.

## How the site is put together

Both sites share the pages below unless the table says otherwise; a route one
site does not have redirects to the other (`next.config.ts`).

| Route | What it is |
| --- | --- |
| `/` | The directory. **builders:** every active product, with "looking for help" as a filter. **oss:** repositories taking contributors, with signals (`?badge=`), source (`?scope=`), language (`?facet=`) and pull request activity (`?pr=`). Search with `?q=` on both |
| `/activity` | **builders:** what members' products did — listed, a new stage, an update, a role opened or filled — one card per product per day, with reactions. **oss:** members' pull requests and work on their own repositories, from GitHub, with reactions |
| `/projects/<slug>` | builders: one product — the story, what it is doing now, the help it wants, its journey. A GitHub repository links to the oss site |
| `/new` | builders: list a product. One field: the link. Its page supplies the name, description and icon; everything else can be added later |
| `/inbox` | builders: applications, proposals, and notices such as a reaction |
| `/recommend` | oss: suggest an open source repository, with your reason. Waits for an admin |
| `/u/<username>` | One person. builders: products built and helped, and their trail. oss: their open source record, each claim beside a link to the PRs behind it |
| `/get-started` | Where a completed sign-in lands — not a callback, never on the redirect allow list. Picks a path (help a product / build one on builders; contribute on oss) and lists the steps still owed |
| `/how-it-works` | The walk-through for the site's own path: roles on builders, code on GitHub on oss |
| `/admin` | Site admins only (404 for anyone else). builders: members' products. oss: the repository catalogue and its suggestions |
| `/account/profile` | The profile editor — who you are, how to reach you, and on oss whether your GitHub activity is shown |
| `/signin`, `/signup` | GitHub or Google OAuth, or email and password, through Supabase Auth |
| `/about`, `/privacy`, `/feedback` | The story, the privacy notice, and the feedback form (drafts a prefilled GitHub issue; the site stores nothing) |

### Where the rules live

- `app/lib/brief.ts` — what a project may carry and what it must: a name, and
  a ceiling on everything else. The old floors (a full brief before a project
  could exist) are gone — see `20260829130000_link_first_projects.sql`.
- `app/lib/link-metadata.ts` — reads a pasted link's own title, description and
  icon so adding a project costs one field, and fences that read in so a URL
  from a stranger cannot be pointed at anything private.
- `app/lib/profile.ts` — what a profile may carry. The ceilings are the same
  ones the `profiles` columns check, so a typo comes back as a sentence
  rather than a constraint error.
- `app/lib/next-steps.ts` — the steps `/get-started` lists. Named things with a
  link at each, never a percentage: a profile is not a form to fill to 100%.
- `app/lib/open-source.ts` — the catalogue's types, its reason tags, and
  what a suggestion must carry (`validateRepoSubmission`, the same ceilings as
  the `oss_repos` check constraints). The rows themselves are in the database;
  the only built-in one, for running without Supabase, is this repository.
  `app/lib/open-source-live.ts` adds GitHub's stars, language, and
  description, cached for hours per repo; set `GITHUB_TOKEN` (any read-only
  token) to lift GitHub's anonymous rate limit. Without it a refused request
  costs that card its numbers and nothing else.
- `app/lib/oss.ts` — members' open source records and the badges built from
  them. A member lists the repos they contributed to or maintain (profile
  editor, or step 2 of onboarding); every listed repo in the directory then
  shows who among us has been there, with their GitHub avatars, linking to
  their profile. Each claim on a profile sits beside a link to that person's
  PRs on the repo, so anybody can check it. A product's filled seats count as
  its "friends have been here".
- `app/lib/badges.ts` — badge kinds and the hand-set ones, merged per kind
  with the member-derived ones: for what no member can say for themselves
  ("maintainers are Indonesian", ticked on the suggestion form). A product's
  go in `PRODUCT_BADGES`, by slug.
- `app/lib/site.ts` — which site this build is, its name and address, and
  the links that cross to the other one (`builderUrl`, `ossUrl`).
- `app/lib/directory.ts` — the directory's entries. On oss, code through a pull
  request on GitHub (our repos, recommended repos, products open to PRs); on
  builders, every active product, with the roles it is asking for.
- `app/lib/product-feed.ts` — the builders feed: which trail kinds it shows
  and how they group into one card per product per day.
- `app/lib/stages.ts` — the levels (`idea → building → live`, plus `resting`)
  and what each one requires. No level asks for a team: working alone is not a
  lesser project. What they ask for is evidence the work has moved — a link, or
  the line saying what is being worked on right now.
- `app/lib/project-types.ts` — what kind of project it is: pet project,
  komunitas, produk berpengguna, komersial. Deliberately a different question
  from the level (how far it has got) and the topic (what it is about): this one
  says why the project exists, and so what joining it actually means. Empty is a
  valid answer for anything made before the question was asked; new projects
  have to pick.
- `app/lib/feed.ts` — the board's lanes, and how the "untuk kamu" lane is
  arranged. Pure, so the unit tests read it directly.
- `app/lib/updates.ts` — the journey a project writes for itself.
- `app/lib/feedback.ts` — the five kinds a masukan can be, what one has to
  carry to be worth answering, and the GitHub issue it becomes: each kind opens
  a template in `.github/ISSUE_TEMPLATE/` with the message filled in. The old
  `feedback` table is read-only — see
  `20261101000100_feedback_via_github_issues.sql`.
- `app/lib/roles.ts` — the kinds of help a project can ask for.
- `app/lib/tasks.ts` — the three task statuses and what a task must carry.
- `app/lib/activity.ts` — the eleven kinds of trail entry and how each one reads
  as a sentence.
- `app/lib/access.ts` — owner, admin, member. Admins run the work — seats,
  applications, the task list. The project itself — the brief, the level,
  deleting it — stays with the owner.
- `app/lib/data.ts` — every read the pages do.
- `app/actions.ts` — every write, as server actions.

**Authorization is the database's job.** The policies in
`supabase/migrations/0003_policies.sql` decide who may read and write; the
checks in the server actions exist to turn a refusal into a readable sentence.
Taking a seat goes through `apply_for_seat()` and `decide_seat()` rather than a
plain update, so an applicant cannot rewrite the role on their way in. Moving a
task goes through `move_task()` for the same reason: row level security is row
level, not column level, so a policy letting the assignee update their own task
would also let them retitle it and hand it to somebody else. `set_now()` is the
third of the same shape — an admin may rewrite the one line saying what the
project is working on, and nothing else on that row.

`projects.now_updated_at` is written by a trigger for the same reason the trail
is: it is the freshness people read to decide whether a project is still alive,
so it must not be something a request can set. `updates` is the other half of
that pair — the journey in the project's own words. It has no UPDATE policy and
no update grant on purpose: an entry can be written and removed, never quietly
reworded after people have read it.

The activity trail is written by triggers, never by the app, and that is a
security decision rather than a tidiness one: if server actions wrote events,
the table would need `grant insert to authenticated`, and anybody could then
POST a fabricated entry into their own trail. As it stands `events` has no write
grant at all — `record_event()` is the only writer, and it returns early when
`auth.uid()` is null, so a migration or `supabase/seed.sql` cannot manufacture
history that never happened.

Hiding a kind of entry is enforced by the SELECT policy on `events`, not by the
query. Filtering in `listPersonActivity()` would leave
`GET /rest/v1/events?actor_id=eq.…` wide open, and the anon key is public by
design.

Two rules in `0004` are worth knowing before changing anything there.
`can_manage_project()` is SECURITY DEFINER because it reads `seats` and is used
inside the policies on `seats` — as INVOKER it would recurse forever. And
`project_overview` is dropped and recreated rather than replaced, because
`create or replace view` keeps the old reloptions silently, so a replacement
that forgets `security_invoker = true` would stop honouring RLS altogether.

## Tests

```bash
npm test        # builds, then runs everything under tests/
npm run test:unit   # just the pure logic, no build
npm run test:rendered   # just the rendered pages, against the last build
```

`npm test` builds the builders site, then runs the unit tests in `tests/`:
pure logic such as the directory's entries and URLs, the onboarding steps, the
feeds, link metadata and the site switch. It also runs
`tests/rendered-html.test.mjs`, which starts `next start` on the build with no
Supabase (seed mode) and checks that the public pages answer 200 with an
`<h1>` and that the redirects between the two sites go where they should. It
checks whichever site `NEXT_PUBLIC_SITE` names, so CI builds the oss site
(`NEXT_PUBLIC_SITE=oss npx next build`) and runs it again
(`NEXT_PUBLIC_SITE=oss npm run test:rendered`). A change that breaks only one of
the two is caught.

Build in seed mode to match CI: a `.env.local` with real Supabase credentials
is inlined into the build and the pages read that database instead.

The policies have their own suite, which needs a scratch PostgreSQL 16:

```bash
createdb builders_test
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/local/auth-shim.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$f"; done
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/policies.sql
```

`supabase/local/auth-shim.sql` is the smallest slice of Supabase's `auth` schema
the migrations touch, so a plain PostgreSQL can run them. It is for development
only — never run it against a hosted project.

## Deployment

Netlify, using `@netlify/plugin-nextjs` (declared in `netlify.toml`): **two
Netlify sites from the same repository and branch**, one per site. Set these
in each one's Site settings → Environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the same
  project on both sites
- `NEXT_PUBLIC_SITE` — `oss` on the open source site; leave unset (or
  `builders`) on builders
- `NEXT_PUBLIC_COOKIE_DOMAIN=.swegrowth.id` on both, so the auth cookies sit on
  the parent domain and one sign-in works on both sites
- `GITHUB_TOKEN` — optional, any read-only token, for GitHub's rate limit
- `NEXT_PUBLIC_SITE_URL` — the site's primary address. Sign-in starts here, and
  it is the fallback origin for links that leave the app and come back when
  there is no request to read the origin from. On Netlify it may be left unset:
  the primary address in Netlify's own `URL` is used for production deploys.
  If you do set it, set it **per context** — a value shared with deploy previews
  sends a reviewer to sign in on the live site

Register both origins with Supabase (Authentication → URL Configuration) and
with the GitHub App's callback URLs.

`siteOrigin()` in `app/lib/origin.ts` prefers the origin the *browser* asked
for — `x-forwarded-host`, not `request.url`, which is the address the function
was invoked with and behind Netlify can be that deploy's permalink. Redirects
inside the app use `sameOriginRedirect()` in `app/lib/redirect.ts` for the same
reason: a relative `Location` leaves the browser on the host holding its
cookies. Following the request rather than a pinned name is deliberate. Signing in writes the PKCE code verifier as a
cookie on the origin it started from, and the callback has to find that cookie
again; a single origin pinned into every link means anybody arriving by a
second name for the site gets sent to the first one, where the verifier is not,
and the sign-in dies at the exchange. So register **every** origin people use
under Authentication → URL Configuration, each with `/auth/callback` and
`/auth/confirm`, not just the canonical one.

That the forwarded host comes from outside is not a hole: Supabase refuses a
`redirect_to` that is not on the allow list, so the list is the guard.

Canonical and Open Graph URLs come from `site.url` in `app/lib/site.ts`.

### Subdomain shortcuts

`talents.builders.swegrowth.id` is a short address that lands on the builders
directory. The redirect itself lives in `netlify.toml`, but it only fires once
the name reaches this site, which takes two steps outside the repository:

1. Point the DNS record at Netlify: `talents` is a `CNAME` to the builders
   site's `<site>.netlify.app` name. A `CNAME` holding a URL rather than a
   hostname is not a redirect; nothing serves it.
2. Add `talents.builders.swegrowth.id` as a domain alias under Site settings → Domain
   management, so Netlify answers for the name and issues a certificate for it.

Because it is a forced redirect the app never renders there, so the subdomain
is not a second origin for sign-in and needs no entry in Supabase's URL
configuration.

## Useful commands

- `npm run dev` — local development
- `npm run build` — production build (builders; prefix `NEXT_PUBLIC_SITE=oss` for oss)
- `npm run lint` — ESLint
- `npm run db:seed` — regenerate `supabase/seed.sql` from `app/lib/seed.ts`

## Contributing

Bug reports, ideas, documentation improvements, and code contributions are
welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and use [GitHub's private reporting
flow](SECURITY.md) for security vulnerabilities.

Maintainers can find the recommended GitHub access, branch protection, Actions,
and security settings in [docs/maintainer-guide.md](docs/maintainer-guide.md).

## License

Released under the [MIT License](LICENSE).

## Learn more

- [Supabase docs](https://supabase.com/docs)
- [Next.js App Router](https://nextjs.org/docs/app)
