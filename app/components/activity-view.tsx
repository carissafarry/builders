"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "./responsive-link";
import { InstantLink, InstantNav } from "./instant-link";
import { RelativeTime } from "./relative-time";
import { ReactionBar } from "./reaction-bar";
import {
  activityPath,
  isShowOption,
  readActivityFilters,
  readActivityPage,
  showFilters,
  showOf,
  SHOW_OPTIONS,
  type ActivityFilters,
  type ShowOption,
} from "../lib/activity-url";
import {
  activityPeople,
  dayKey,
  groupByDay,
  inPlace,
  inScope,
  kindCounts,
  consistencyBoard,
  ownLeaderboard,
  placeCounts,
  repoSummaries,
  REPO_ORDERS,
  ownerAvatar,
  queryActivity,
  repoName,
  scopeCounts,
  ACTIVITY_PLACES,
  CONSISTENCY_WEEKS,
  SUMMARY_DAYS,
  type ActivityPlace,
  type CommitSummaryEntry,
  type ConsistencyRow,
  type GitHubActivityEntry,
  type LeaderboardRow,
  type PullRequestEntry,
  type RepoOrder,
  type PullRequestItem,
} from "../lib/github-activity";
import type { ReactionCount } from "../lib/reactions";
import { tx, type Locale } from "../lib/locale";

const PAGE_SIZE = 20;
/** Repositories shown under the leaderboard before "See all": a handful, not the list. */
const REPOS_SHOWN = 5;
/** How many repositories a commit summary names before "+N". */
const SUMMARY_REPOS = 4;
/** Pull requests listed in a grouped entry before the rest fold away. */
const PRS_SHOWN = 3;
/** How long typing rests before the address catches up. Browsers throttle history writes. */
const SEARCH_SETTLE_MS = 300;

/**
 * The /activity feed and its filters. The page hands it every entry once —
 * read from the server's shared cache — and from then on the scope toggle,
 * the sidebar, the search and the pages are a re-render in the browser, not
 * a round trip: the address follows every choice (`history.pushState`,
 * which the router keeps in step with `useSearchParams`), so a filtered view
 * can still be shared, reloaded, and gone back from. The directory works
 * the same way; see DirectoryView.
 */
export function ActivityView({
  entries,
  reactions,
  viewerName,
  today,
  locale,
  unavailable,
  viewerHandle = null,
  localRepos = [],
}: {
  entries: GitHubActivityEntry[];
  /** Per pull request URL, or per summary key. */
  reactions: Record<string, ReactionCount[]>;
  viewerName: string | null;
  /** Today in Jakarta, from the server, so "Today" and "Yesterday" match on both sides. */
  today: string;
  locale: Locale;
  unavailable: boolean;
  /** The signed-in member's GitHub handle, when they are shown here: their own row on the board. */
  viewerHandle?: string | null;
  /** Repositories the directory counts as local (`owner/name`, lower case): the local and global toggle. */
  localRepos?: string[];
}) {
  const searchParams = useSearchParams();
  const fromUrl = readActivityFilters(searchParams);
  // What is typed is held here and written to the address once typing rests:
  // the list follows every key, the history does not.
  const [q, setQ] = useState(fromUrl.q);
  const settle = useRef<number | undefined>(undefined);
  const results = useRef<HTMLElement>(null);

  // Back and Forward make the address the truth again.
  useEffect(() => {
    const onPop = () => {
      window.clearTimeout(settle.current);
      setQ(readActivityFilters(new URLSearchParams(window.location.search)).q);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.clearTimeout(settle.current);
    };
  }, []);

  const navigate = useCallback((href: string) => {
    const url = new URL(href, window.location.href);
    window.clearTimeout(settle.current);
    setQ(readActivityFilters(url.searchParams).q);
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    // The list changed under the reader; if its top has scrolled away, bring it back.
    const list = results.current;
    if (list && list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: "start" });
  }, []);

  const search = (value: string, now = false) => {
    setQ(value);
    window.clearTimeout(settle.current);
    const write = () => window.history.replaceState(null, "", activityPath({ ...fromUrl, q: value.trim().slice(0, 100) }));
    if (now) write();
    else settle.current = window.setTimeout(write, SEARCH_SETTLE_MS);
  };

  const current = { ...fromUrl, q: q.slice(0, 100) };
  const scopes = useMemo(() => scopeCounts(entries), [entries]);
  const local = useMemo(() => new Set(localRepos), [localRepos]);
  // Local or global only means something for pull requests to other people's repos.
  const place = current.scope === "own" ? "all" : current.place;
  const inThisScope = useMemo(() => inScope(entries, current.scope), [entries, current.scope]);
  const places = useMemo(() => placeCounts(inThisScope, local), [inThisScope, local]);
  // Everything else narrows within the scope and place showing.
  const scoped = useMemo(() => inPlace(inThisScope, place, local), [inThisScope, place, local]);
  const people = useMemo(() => activityPeople(entries), [entries]);
  // Members' own work — the Own scope, or summaries — has its own board;
  // otherwise the board is who keeps contributing to other people's repos, in
  // the place showing. It counts merged PRs whatever kind the feed shows.
  const ownBoard = current.scope === "own" || current.kind === "commits";
  const board = useMemo<Board>(
    () => (ownBoard ? { own: true, rows: ownLeaderboard(entries) } : { own: false, rows: consistencyBoard(inPlace(entries, place, local), today) }),
    [entries, ownBoard, place, local, today],
  );
  const matched = useMemo(
    () => queryActivity(scoped, current),
    [scoped, current.kind, current.member, current.repo, current.q], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // A search still settling has already left the page it started on.
  const requested = q === fromUrl.q ? readActivityPage(searchParams) : 1;
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const page = Math.min(requested, pages);
  const shown = matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const filtered = current.kind !== "all" || Boolean(current.member || current.repo || current.q.trim());
  const reset = activityPath({ scope: current.scope });

  const showLabels: Record<ShowOption, string> = {
    contributions: tx(locale, "Semua kontribusi", "All contributions"),
    merged: tx(locale, "PR merged", "Merged PRs"),
    open: tx(locale, "PR direview", "PRs in review"),
    own: tx(locale, "Repo sendiri", "Own repos"),
  };
  // Each choice's count, within the place showing: what picking it would list.
  const contributions = inPlace(inScope(entries, "external"), current.place, local);
  const contributionKinds = kindCounts(contributions);
  const showCounts: Record<ShowOption, number> = {
    contributions: contributions.length,
    merged: contributionKinds.merged,
    open: contributionKinds.open,
    own: scopes.own,
  };
  const memberName = people.find(({ person }) => person.handle.toLowerCase() === current.member.toLowerCase())?.person.name;
  // Who or where the feed is narrowed to, each with a way back.
  const chips = [
    ...(current.member ? [{ label: memberName || `@${current.member}`, href: activityPath({ ...current, member: "" }) }] : []),
    ...(current.repo ? [{ label: current.repo, href: activityPath({ ...current, repo: "" }) }] : []),
  ];

  return (
    <InstantNav navigate={navigate}>
      <div className="dx-layout ax-layout">
        {/* The left column: the leaderboard, and under it where the PRs went.
            On a phone the column comes apart: the board above the feed, the
            repos after it. */}
        <div className="ax-side">
          <Leaderboard
            board={board}
            current={current}
            places={current.scope !== "own" && local.size > 0 ? places : null}
            viewerHandle={viewerHandle}
            locale={locale}
            navigate={navigate}
          />

          <RepoList entries={scoped} current={current} locale={locale} />
        </div>

        <section ref={results} className="dx-results" aria-labelledby="feed-title">
          {/* The feed under its own name: the page is the leaderboard, this is
              what the ranking is made of. */}
          <div className="ax-feed-head">
            <h2 id="feed-title">{tx(locale, "Aktivitas publik terbaru dari GitHub anggota", "Latest public activity from members' GitHub")}</h2>
            <p className="dx-count" role="status">
              <strong>{matched.length}</strong> {tx(locale, "aktivitas", "entries")}
              {filtered ? <> · <InstantLink href={reset}>reset</InstantLink></> : null}
            </p>
          </div>
          <div className="dx-toolbar ax-toolbar">
            {/* What to show: contributions of every kind or one, or members'
                own repos — scope and kind in one choice, steering the board
                too. A real GET form, like the directory's sort, so it works
                before the script does. */}
            <form className="dx-sort ax-show" action="/">
              {current.member ? <input type="hidden" name="member" value={current.member} /> : null}
              {current.repo ? <input type="hidden" name="repo" value={current.repo} /> : null}
              {current.q ? <input type="hidden" name="q" value={current.q} /> : null}
              {current.place !== "all" ? <input type="hidden" name="place" value={current.place} /> : null}
              <label>
                <span className="sr-only">{tx(locale, "Tampilkan", "Show")}</span>
                <select
                  name="view"
                  value={showOf(current)}
                  onChange={(event) =>
                    isShowOption(event.target.value) ? navigate(activityPath({ ...current, ...showFilters(event.target.value), member: "", repo: "" })) : undefined
                  }
                >
                  {SHOW_OPTIONS.map((show) => (
                    <option key={show} value={show}>
                      {showLabels[show]}
                      {` (${showCounts[show]})`}
                    </option>
                  ))}
                </select>
              </label>
              <noscript>
                <button type="submit">{tx(locale, "Terapkan", "Apply")}</button>
              </noscript>
            </form>
            <form
              className="dx-search"
              action="/"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                search(q, true);
              }}
            >
              <label>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <span className="sr-only">{tx(locale, "Cari aktivitas", "Search activity")}</span>
                <input
                  type="search"
                  name="q"
                  value={q}
                  onChange={(event) => search(event.target.value)}
                  placeholder={tx(locale, "Cari judul PR, repo, atau nama…", "Search PR titles, repos, or names…")}
                />
              </label>
            </form>
          </div>

          {chips.length > 0 ? (
            <ul className="ax-chips" aria-label={tx(locale, "Filter aktif", "Active filters")}>
              {chips.map((chip) => (
                <li key={chip.href}>
                  <InstantLink href={chip.href} aria-label={tx(locale, `Hapus filter ${chip.label}`, `Remove filter ${chip.label}`)}>
                    {chip.label} <span aria-hidden="true">×</span>
                  </InstantLink>
                </li>
              ))}
            </ul>
          ) : null}

          {unavailable ? (
            <p className="public-data-notice" role="status">
              {tx(locale, "Aktivitas belum dapat dimuat.", "The activity could not be loaded.")}{" "}
              <a href={activityPath(current, page)}>{tx(locale, "Muat ulang", "Reload")}</a>.
            </p>
          ) : null}

          {shown.length === 0 ? (
            <div className="dx-empty ax-empty">
              <p>
                {entries.length === 0
                  ? tx(locale, "Belum ada aktivitas yang tercatat. ", "No activity recorded yet. ")
                  : tx(locale, "Tidak ada aktivitas yang cocok. ", "No activity matches. ")}
                {filtered ? <InstantLink href={reset}>{tx(locale, "Reset filter", "Reset filters")}</InstantLink> : null}
              </p>
              <p>
                {tx(locale, "Mau muncul di sini? Isi GitHub-mu dan centang “Tampilkan aktivitas GitHub-ku” di ", "Want to show up here? Add your GitHub and tick “Show my GitHub activity” on ")}
                <Link href="/account/profile#github-account">{tx(locale, "halaman edit profil", "the edit profile page")}</Link>.
              </p>
            </div>
          ) : (
            <div className="ax-timeline">
              {groupByDay(shown).map(({ day, entries: onDay }) => (
                <section key={day} className="ax-day" aria-labelledby={`day-${day}`}>
                  <h2 id={`day-${day}`} className="ax-day-title">
                    {dayLabel(day, today, locale)}
                  </h2>
                  <ol className="ax-events">
                    {onDay.map((entry) => (
                      <li key={entry.key} className="ax-event">
                        <Avatar handle={entry.person.handle} size={32} />
                        {entry.kind === "pull_request" ? (
                          <PullRequestEvent entry={entry} locale={locale} reactions={reactions[entry.url] ?? []} viewerName={viewerName} />
                        ) : (
                          <CommitSummaryEvent entry={entry} locale={locale} reactions={reactions[entry.key] ?? []} viewerName={viewerName} />
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )}

          {pages > 1 ? (
            <nav className="dx-pager" aria-label={tx(locale, "Halaman", "Pages")}>
              {page > 1 ? (
                <InstantLink href={activityPath(current, page - 1)} rel="prev">
                  <span aria-hidden="true">←</span> {tx(locale, "Sebelumnya", "Previous")}
                </InstantLink>
              ) : (
                <span aria-hidden="true" />
              )}
              <p>{tx(locale, `Halaman ${page} dari ${pages}`, `Page ${page} of ${pages}`)}</p>
              {page < pages ? (
                <InstantLink href={activityPath(current, page + 1)} rel="next">
                  {tx(locale, "Berikutnya", "Next")} <span aria-hidden="true">→</span>
                </InstantLink>
              ) : (
                <span aria-hidden="true" />
              )}
            </nav>
          ) : null}

          <p className="ax-note">
            {tx(locale, "Hanya repo publik, dan hanya member yang memilih tampil.", "Public repositories only, and only members who chose to be shown.")}
          </p>
        </section>
      </div>
    </InstantNav>
  );
}

/** Where the board's pull requests went, in a sentence: the place the feed is filtered to. */
function countedLabel(place: ActivityPlace, locale: Locale): string {
  const where =
    place === "local"
      ? tx(locale, "repo lokal", "local repos")
      : place === "global"
        ? tx(locale, "repo global", "global repos")
        : tx(locale, "repo orang lain", "other people's repos");
  return tx(
    locale,
    `Satu minggu terisi kalau ada PR ke ${where} yang dibuka minggu itu dan sudah di-merge. Yang dihitung rutinnya, bukan banyaknya. `,
    `A week counts when a PR to ${where} opened that week has been merged. It counts keeping at it, not volume. `,
  );
}

/** Repos shown before "See all" on a phone, where the card sits above the feed. */
const REPOS_SHOWN_PHONE = 3;
/** Faces shown per repo before "+n". */
const FACES_SHOWN = 3;

/**
 * Where the pull requests in the feed went, as a card under the ranking: who
 * went there and how lately, not only how many PRs — newest first by default,
 * so one very busy repo does not sit on top for good, with most PRs and most
 * people a pill away. Each repo narrows the feed to it; long names stay on one
 * line, whole in the tooltip.
 */
function RepoList({ entries, current, locale }: { entries: GitHubActivityEntry[]; current: ActivityFilters; locale: Locale }) {
  const [order, setOrder] = useState<RepoOrder>("recent");
  const [expanded, setExpanded] = useState(false);
  const repos = useMemo(() => repoSummaries(entries, order), [entries, order]);
  if (repos.length === 0) return null;
  // The repo being looked at is never folded away.
  const open = expanded || repos.findIndex(({ repo }) => repo === current.repo) >= REPOS_SHOWN_PHONE;
  const orderLabels: Record<RepoOrder, string> = {
    recent: tx(locale, "terbaru", "newest"),
    prs: tx(locale, "PR terbanyak", "most PRs"),
    people: tx(locale, "kontributor terbanyak", "most people"),
  };

  // No card: a plain list under the ranking, the way the directory's
  // sidebar lists read — a small title with the order beside it, then rows.
  return (
    <section className="ax-where" aria-labelledby="repos-title">
      <div className="ax-where-head">
        <h2 id="repos-title">{tx(locale, "Repo tujuan PR", "Where PRs went")}</h2>
        <label>
          <span className="sr-only">{tx(locale, "Urutkan repo", "Order repos")}</span>
          <select className="ax-where-order" value={order} onChange={(event) => setOrder(REPO_ORDERS.find((each) => each === event.target.value) ?? "recent")}>
            {REPO_ORDERS.map((each) => (
              <option key={each} value={each}>
                {orderLabels[each]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ol className={`ax-where-list ${open ? "is-expanded" : ""}`}>
        {repos.map(({ repo, prs, people, lastAt }) => {
          const on = current.repo === repo;
          return (
            <li key={repo} className={on ? "is-active" : ""}>
              <InstantLink href={activityPath({ ...current, repo: on ? "" : repo })} aria-current={on ? "true" : undefined} title={repo}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the repository owner's GitHub picture */}
                <img className="ax-where-logo" src={ownerAvatar(repo, 36)} alt="" width={20} height={20} loading="lazy" />
                <span className="ax-where-body">
                  <span className="ax-where-name">
                    <small>{repo.slice(0, repo.indexOf("/") + 1)}</small>
                    {repoName(repo)}
                  </span>
                  <span className="ax-where-meta">
                    <span className="ax-where-faces" aria-label={people.map((person) => person.name || person.handle).join(", ")}>
                      {people.slice(0, FACES_SHOWN).map((person) => (
                        <Avatar key={person.id} handle={person.handle} size={16} />
                      ))}
                      {people.length > FACES_SHOWN ? <span className="ax-where-more">+{people.length - FACES_SHOWN}</span> : null}
                    </span>
                    <span aria-hidden="true">·</span>
                    <RelativeTime value={lastAt} locale={locale} />
                  </span>
                </span>
                <span className="ax-where-count">{prs}</span>
              </InstantLink>
            </li>
          );
        })}
      </ol>
      {repos.length > REPOS_SHOWN_PHONE ? (
        <button
          type="button"
          className={`ax-where-toggle ${repos.length <= REPOS_SHOWN ? "is-phone-only" : ""}`}
          aria-expanded={open}
          onClick={() => setExpanded((was) => !was)}
        >
          {open ? tx(locale, "Tampilkan lebih sedikit", "Show fewer") : tx(locale, `Lihat semua (${repos.length})`, `See all (${repos.length})`)}
        </button>
      ) : null}
    </section>
  );
}

/** How many rows the board shows before "See all": fewer on a phone, where it sits above the feed. */
const BOARD_SHOWN = 10;
const BOARD_SHOWN_PHONE = 5;
const MEDALS = ["🥇", "🥈", "🥉"];

/** Either board: who keeps contributing, or members' own work. */
type Board = { own: false; rows: ConsistencyRow[] } | { own: true; rows: LeaderboardRow[] };

/**
 * The left column: who keeps contributing to other people's repositories —
 * weeks with a merged PR out of the last CONSISTENCY_WEEKS, and the streak
 * (see `consistencyBoard`) — or, on the Own scope, members' own work. Each row
 * also narrows the feed beside it to that person. A signed-in member outside
 * the shown rows still sees their own.
 */
function Leaderboard({
  board,
  current,
  places,
  viewerHandle,
  locale,
  navigate,
}: {
  board: Board;
  current: ActivityFilters;
  /** Moves the page to another address without a reload: the pill's choices. */
  navigate: (href: string) => void;
  /** How many contributions went to local and global repos; null when the split is not offered. */
  places: Record<ActivityPlace, number> | null;
  viewerHandle: string | null;
  locale: Locale;
}) {
  const [expanded, setExpanded] = useState(false);
  const { own, rows } = board;
  const viewerKey = viewerHandle?.toLowerCase() ?? "";
  const viewerRank = viewerKey ? rows.findIndex(({ person }) => person.handle.toLowerCase() === viewerKey) : -1;
  const placeLabels: Record<ActivityPlace, string> = {
    all: tx(locale, "semua repo", "all repos"),
    local: tx(locale, "repo lokal", "local repos"),
    global: tx(locale, "repo global", "global repos"),
  };
  const score = (index: number) => {
    if (board.own) {
      const { prs, repos } = board.rows[index];
      return { main: `${prs} PR`, side: tx(locale, `${repos} repo`, `${repos} ${repos === 1 ? "repo" : "repos"}`) };
    }
    const { filled, streak } = board.rows[index];
    return { main: `${filled}/${CONSISTENCY_WEEKS}`, side: streak > 0 ? `🔥 ${streak}` : "" };
  };

  return (
    <aside className="ax-board tone-done" aria-labelledby="board-title">
      <div className="ax-board-head">
        <h2 id="board-title">
          <span aria-hidden="true">🏆</span> {tx(locale, "Leaderboard", "Leaderboard")}
        </h2>
        {/* The board's choices read as one line under its name — "last 12
            weeks · all repos" — the place a pill that opens a native picker.
            A real GET form, so it works before the script does. Own repos
            have no choice: their numbers only come as the last SUMMARY_DAYS. */}
        {own ? (
          <p className="ax-board-pills">
            <span className="ax-pill">{tx(locale, `${SUMMARY_DAYS} hari terakhir`, `last ${SUMMARY_DAYS} days`)}</span>
            <span aria-hidden="true">·</span>
            <span className="ax-pill">{tx(locale, "repo sendiri", "own repos")}</span>
          </p>
        ) : (
          <form className="ax-board-pills" action="/">
            {current.kind !== "all" ? <input type="hidden" name="show" value={current.kind} /> : null}
            {current.member ? <input type="hidden" name="member" value={current.member} /> : null}
            {current.repo ? <input type="hidden" name="repo" value={current.repo} /> : null}
            {current.q ? <input type="hidden" name="q" value={current.q} /> : null}
            <span className="ax-pill">{tx(locale, `${CONSISTENCY_WEEKS} minggu terakhir`, `last ${CONSISTENCY_WEEKS} weeks`)}</span>
            {places ? (
              <>
                <span aria-hidden="true">·</span>
                <label>
                  <span className="sr-only">{tx(locale, "Repo lokal atau global", "Local or global repos")}</span>
                  <select
                    name="place"
                    className={`ax-pill ${current.place !== "all" ? "is-set" : ""}`}
                    value={current.place}
                    onChange={(event) =>
                      navigate(activityPath({ ...current, place: ACTIVITY_PLACES.find((place) => place === event.target.value) ?? "all" }))
                    }
                  >
                    {ACTIVITY_PLACES.map((place) => (
                      <option key={place} value={place}>
                        {placeLabels[place]}
                      </option>
                    ))}
                  </select>
                </label>
                <noscript>
                  <button type="submit">{tx(locale, "Terapkan", "Apply")}</button>
                </noscript>
              </>
            ) : null}
          </form>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="ax-board-empty">
          {own
            ? tx(locale, `Belum ada PR merged ke repo sendiri dalam ${SUMMARY_DAYS} hari terakhir.`, `No PRs merged into members' own repos in the last ${SUMMARY_DAYS} days.`)
            : tx(
                locale,
                `Belum ada PR merged dalam ${CONSISTENCY_WEEKS} minggu terakhir. Satu PR minggu ini sudah cukup untuk mulai!`,
                `No merged PRs in the last ${CONSISTENCY_WEEKS} weeks. One PR this week is enough to start!`,
              )}
        </p>
      ) : (
        <ol className={`ax-board-list ${expanded ? "is-expanded" : ""}`}>
          {rows.map(({ person }, index) => {
            const on = person.handle.toLowerCase() === current.member.toLowerCase();
            const mine = person.handle.toLowerCase() === viewerKey;
            const { main, side } = score(index);
            return (
              <li key={person.id} className={`${on ? "is-active" : ""} ${mine ? "is-mine" : ""}`}>
                <InstantLink
                  href={activityPath({ ...current, member: on ? "" : person.handle })}
                  aria-current={on ? "true" : undefined}
                  title={on ? tx(locale, "Tampilkan semua orang", "Show everyone") : tx(locale, "Tampilkan aktivitasnya saja", "Show only their activity")}
                >
                  <span className="ax-board-rank" aria-label={tx(locale, `Peringkat ${index + 1}`, `Rank ${index + 1}`)}>
                    {MEDALS[index] ?? index + 1}
                  </span>
                  <Avatar handle={person.handle} size={24} />
                  <span className="ax-board-who">
                    <span className="ax-board-name">{person.name || `@${person.handle}`}</span>
                    {board.own ? null : <WeekDots weeks={board.rows[index].weeks} locale={locale} />}
                  </span>
                  <span className="ax-board-score">
                    <strong>{main}</strong>
                    {side ? <small>{side}</small> : null}
                  </span>
                </InstantLink>
              </li>
            );
          })}
        </ol>
      )}

      {viewerRank >= BOARD_SHOWN_PHONE && !expanded ? (
        <p className={`ax-board-you ${viewerRank < BOARD_SHOWN ? "is-phone-only" : ""}`}>
          {tx(locale, "Kamu", "You")}: <strong>#{viewerRank + 1}</strong> · {score(viewerRank).main}
        </p>
      ) : null}

      {rows.length > BOARD_SHOWN_PHONE ? (
        <button
          type="button"
          className={`ax-board-toggle ${rows.length <= BOARD_SHOWN ? "is-phone-only" : ""}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? tx(locale, "Tampilkan lebih sedikit", "Show fewer") : tx(locale, `Lihat semua (${rows.length})`, `See all (${rows.length})`)}
        </button>
      ) : null}

      <p className="ax-board-foot">
        {own
          ? tx(locale, "Dihitung dari PR merged ke repo sendiri; seri dipecah jumlah commit. ", "Counts PRs merged into their own repos; commits break ties. ")
          : countedLabel(current.place, locale)}
        {/* The full leaderboard — points, badges — is still to come. A plain
            Link: it leaves this page, where InstantLink only swaps the
            feed's filters in place. */}
        <Link href="/leaderboard">
          {tx(locale, "Leaderboard lengkap segera", "Full leaderboard coming soon")} <span aria-hidden="true">→</span>
        </Link>
      </p>
    </aside>
  );
}

/** The last CONSISTENCY_WEEKS weeks as dots, oldest first: filled when a PR landed. */
function WeekDots({ weeks, locale }: { weeks: boolean[]; locale: Locale }) {
  const filled = weeks.filter(Boolean).length;
  return (
    <span
      className="ax-weeks"
      role="img"
      aria-label={tx(locale, `${filled} dari ${weeks.length} minggu terakhir ada PR merged`, `${filled} of the last ${weeks.length} weeks had a merged PR`)}
    >
      {weeks.map((on, index) => (
        <i key={index} className={on ? "is-on" : undefined} />
      ))}
    </span>
  );
}

function PullRequestIcon({ merged }: { merged: boolean }) {
  return (
    <svg className={`ax-pr-icon ${merged ? "is-merged" : "is-open"}`} viewBox="0 0 16 16" aria-hidden="true">
      {merged ? (
        <path d="M4.25 2.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM4.25 11a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM11.75 11a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM4.25 5v6M4.25 5c0 3 3 4 7.5 4v2" />
      ) : (
        <path d="M4.25 2.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM4.25 11a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM11.75 11a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5ZM4.25 5v6M11.75 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
      )}
    </svg>
  );
}

function Avatar({ handle, size }: { handle: string; size: number }) {
  // GitHub serves a small avatar at this address for any username, the same
  // way the directory's badges show faces.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="ax-avatar" src={`https://github.com/${encodeURIComponent(handle)}.png?size=${size * 2}`} alt="" width={size} height={size} loading="lazy" />;
}

/** "Hari ini", "Kemarin", or the date, for a day key from groupByDay. */
function dayLabel(day: string, today: string, locale: Locale): string {
  if (day === today) return tx(locale, "Hari ini", "Today");
  if (day === dayKey(new Date(Date.parse(`${today}T12:00:00+07:00`) - 86_400_000), "Asia/Jakarta")) return tx(locale, "Kemarin", "Yesterday");
  return new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-US", { day: "numeric", month: "long", timeZone: "Asia/Jakarta" }).format(
    new Date(`${day}T12:00:00+07:00`),
  );
}

function Who({ entry }: { entry: GitHubActivityEntry }) {
  return (
    <Link className="ax-who" href={`/u/${entry.person.username}`}>
      {entry.person.name || `@${entry.person.handle}`}
    </Link>
  );
}

function RepoLink({ repo }: { repo: string }) {
  return (
    <a className="ax-repo" href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element -- the repository owner's GitHub picture */}
      <img src={ownerAvatar(repo, 32)} alt="" width={14} height={14} loading="lazy" />
      {repo}
    </a>
  );
}

/**
 * "Zikrul got a pull request merged in owner/repo", then the PR itself; or
 * "got 4 pull requests merged", with the first few and the rest folded away.
 */
function PullRequestEvent({
  entry,
  locale,
  reactions,
  viewerName,
}: {
  entry: PullRequestEntry;
  locale: Locale;
  reactions: ReactionCount[];
  viewerName: string | null;
}) {
  const merged = entry.state === "merged";
  const count = entry.pullRequests.length;
  const shown = entry.pullRequests.slice(0, count > PRS_SHOWN ? PRS_SHOWN - 1 : PRS_SHOWN);
  const folded = entry.pullRequests.slice(shown.length);
  const what =
    count === 1
      ? merged
        ? tx(locale, "PR-nya di-merge di", "got a pull request merged in")
        : tx(locale, "membuka pull request di", "opened a pull request in")
      : merged
        ? tx(locale, `${count} PR-nya di-merge di`, `got ${count} pull requests merged in`)
        : tx(locale, `membuka ${count} pull request di`, `opened ${count} pull requests in`);
  const item = (pr: PullRequestItem) => (
    <li key={pr.url}>
      <a className="ax-pr" href={pr.url} target="_blank" rel="noopener noreferrer">
        <PullRequestIcon merged={merged} />
        <span className="ax-pr-title">{pr.title || `#${pr.number}`}</span>
        <span className="ax-number">#{pr.number}</span>
      </a>
    </li>
  );
  return (
    <div className="ax-event-body">
      <p className="ax-event-line">
        <Who entry={entry} /> {what} <RepoLink repo={entry.repo} />
        <span className="ax-time">
          <RelativeTime value={entry.at} locale={locale} />
        </span>
      </p>
      <ul className="ax-prs">{shown.map(item)}</ul>
      {folded.length > 0 ? (
        <details className="ax-prs-more">
          <summary>{tx(locale, `${folded.length} PR lainnya`, `${folded.length} more`)}</summary>
          <ul className="ax-prs">{folded.map(item)}</ul>
        </details>
      ) : null}
      <ReactionBar url={entry.url} initial={reactions} viewerName={viewerName} />
    </div>
  );
}

/** Work on one's own repositories — commits and merged PRs — one event per person. */
function CommitSummaryEvent({
  entry,
  locale,
  reactions,
  viewerName,
}: {
  entry: CommitSummaryEntry;
  locale: Locale;
  reactions: ReactionCount[];
  viewerName: string | null;
}) {
  const named = entry.repos.slice(0, SUMMARY_REPOS);
  const more = entry.repos.length - named.length;
  return (
    <div className="ax-event-body">
      <p className="ax-event-line">
        <Who entry={entry} />{" "}
        {ownWork(entry, locale)}
        <span className="ax-time">{tx(locale, `${SUMMARY_DAYS} hari terakhir`, `last ${SUMMARY_DAYS} days`)}</span>
      </p>
      <ul className="ax-repos">
        {named.map((repo) => (
          <li key={repo.repo}>
            <a href={`https://github.com/${repo.repo}`} target="_blank" rel="noopener noreferrer">
              {repoName(repo.repo)}
            </a>
            {repo.commits > 0 ? <span>{repo.commits}</span> : null}
          </li>
        ))}
        {more > 0 ? <li className="ax-repos-more">+{more}</li> : null}
      </ul>
      <ReactionBar url={entry.key} initial={reactions} viewerName={viewerName} />
    </div>
  );
}

/** "made 205 commits and merged 40 pull requests in 7 of their own repos", leaving out what is zero. */
function ownWork(entry: CommitSummaryEntry, locale: Locale): string {
  const repos = entry.repos.length;
  const id = [entry.commits > 0 ? `membuat ${entry.commits} commit` : "", entry.merged > 0 ? `merge ${entry.merged} PR` : ""].filter(Boolean);
  const en = [
    entry.commits > 0 ? `made ${entry.commits} ${entry.commits === 1 ? "commit" : "commits"}` : "",
    entry.merged > 0 ? `merged ${entry.merged} ${entry.merged === 1 ? "pull request" : "pull requests"}` : "",
  ].filter(Boolean);
  return tx(
    locale,
    `${id.join(" dan ")} di ${repos} repo miliknya`,
    `${en.join(" and ")} in ${repos} of their own ${repos === 1 ? "repo" : "repos"}`,
  );
}
