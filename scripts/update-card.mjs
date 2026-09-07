// Refreshes the live stats baked into dark_mode.svg / light_mode.svg.
// Only the value text inside the existing tspans is replaced — labels, dots,
// colors and the SMIL reveal animations added to the cards are left untouched.

import { readFileSync, writeFileSync } from "node:fs";

const LOGIN = "harshitsaini-dev";
const TOKEN = process.env.GH_PAT || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("Missing GH_PAT (or GITHUB_TOKEN) env var");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const PROFILE_QUERY = `
query($login: String!) {
  user(login: $login) {
    createdAt
    location
    company
    email
    websiteUrl
    followers { totalCount }
    pullRequests { totalCount }
    issues { totalCount }
    repositoriesContributedTo(first: 1, includeUserRepositories: false, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST]) {
      totalCount
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      nodes {
        name
        stargazerCount
        forkCount
        languages(first: 6, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

const YEAR_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      restrictedContributionsCount
    }
  }
}`;

const LAST_YEAR_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date } }
      }
    }
  }
}`;

function fmt(n) {
  return n.toLocaleString("en-US");
}

function uptimeString(createdAt) {
  const start = new Date(createdAt);
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  let days = now.getDate() - start.getDate();
  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return `${years} years, ${months} months, ${days} days`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

async function main() {
  const data = await gql(PROFILE_QUERY, { login: LOGIN });
  const user = data.user;

  const repos = user.repositories.nodes;
  const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const forks = repos.reduce((s, r) => s + r.forkCount, 0);
  const topRepo = repos.reduce((a, b) => (b.stargazerCount > (a?.stargazerCount ?? -1) ? b : a), null);

  const langSizes = new Map();
  for (const r of repos) {
    for (const e of r.languages.edges) {
      langSizes.set(e.node.name, (langSizes.get(e.node.name) || 0) + e.size);
    }
  }
  const totalLangSize = [...langSizes.values()].reduce((a, b) => a + b, 0) || 1;
  const topLangs = [...langSizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, size]) => `${name} ${Math.round((size / totalLangSize) * 100)}%`)
    .join(", ");

  // lifetime commits: sum per-year contributionsCollection windows
  const createdAt = new Date(user.createdAt);
  const now = new Date();
  let lifetimeCommits = 0;
  for (let y = createdAt.getFullYear(); y <= now.getFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1)).toISOString();
    const toDate = y === now.getFullYear() ? now : new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    const to = toDate.toISOString();
    const yearData = await gql(YEAR_QUERY, { login: LOGIN, from, to });
    const cc = yearData.user.contributionsCollection;
    lifetimeCommits += cc.totalCommitContributions + cc.restrictedContributionsCount;
  }

  // last 12 months
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const lastYearData = await gql(LAST_YEAR_QUERY, {
    login: LOGIN,
    from: oneYearAgo.toISOString(),
    to: now.toISOString(),
  });
  const cal = lastYearData.user.contributionsCollection;

  // sparkline: bucket the last 52 weeks into 8 groups
  const weeks = cal.contributionCalendar.weeks;
  const weekTotals = weeks.map((w) => w.contributionDays.reduce((s, d) => s + d.contributionCount, 0));
  const bucketCount = 8;
  const bucketSize = Math.max(1, Math.ceil(weekTotals.length / bucketCount));
  const buckets = [];
  for (let i = 0; i < weekTotals.length; i += bucketSize) {
    const chunk = weekTotals.slice(i, i + bucketSize);
    buckets.push(chunk.reduce((a, b) => a + b, 0));
  }
  const blocks = " ▁▂▃▄▅▆▇█";
  const maxBucket = Math.max(1, ...buckets);
  const sparkline = buckets
    .slice(-bucketCount)
    .map((v) => blocks[Math.min(8, Math.round((v / maxBucket) * 8))])
    .join("");

  const fields = {
    Uptime: uptimeString(user.createdAt),
    Location: user.location || "—",
    Company: user.company || "—",
    Languages: topLangs || "—",
    Email: user.email || "harshitsaini.dev@gmail.com",
    Website: user.websiteUrl || "https://harshitsaini.in",
    GitHub: `github.com/${LOGIN}`,
    "Top repo": topRepo ? `${topRepo.name} (${topRepo.stargazerCount} ★)` : "—",
  };

  const pairs = [
    ["Repos", fmt(user.repositories.totalCount), "Stars", fmt(stars)],
    ["Forks", fmt(forks), "Followers", fmt(user.followers.totalCount)],
    ["Commits", fmt(lifetimeCommits), "Contributed", fmt(user.repositoriesContributedTo.totalCount)],
    ["PRs", fmt(user.pullRequests.totalCount), "Issues", fmt(user.issues.totalCount)],
    ["Contributions", fmt(cal.contributionCalendar.totalContributions), "Reviews", fmt(cal.totalPullRequestReviewContributions)],
  ];
  const single = [["Private", fmt(cal.restrictedContributionsCount)]];

  function setValue(svg, label, value) {
    const re = new RegExp(
      `(<tspan fill="[^"]*">\\. ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: </tspan><tspan fill="[^"]*">[.]*</tspan><tspan fill="[^"]*">)[^<]*(</tspan>)`
    );
    if (!re.test(svg)) {
      console.warn(`  ! field not found: ${label}`);
      return svg;
    }
    return svg.replace(re, `$1 ${escapeXml(value)}$2`);
  }

  function setSparkline(svg, spark) {
    const re = /(<tspan fill="#39d353">\s*)[^\s<][^<]*(<\/tspan>)/;
    return svg.replace(re, (m, p1, p2) => {
      const pad = m.match(/^<tspan fill="#39d353">(\s*)/)[1];
      return `<tspan fill="#39d353">${pad}${spark}</tspan>`;
    });
  }

  for (const file of ["dark_mode.svg", "light_mode.svg"]) {
    let svg = readFileSync(file, "utf8");
    for (const [label, value] of Object.entries(fields)) {
      svg = setValue(svg, label, value);
    }
    for (const [l1, v1, l2, v2] of pairs) {
      svg = setValue(svg, l1, v1);
      svg = setValue(svg, l2, v2);
    }
    for (const [label, value] of single) {
      svg = setValue(svg, label, value);
    }
    svg = setSparkline(svg, sparkline);
    writeFileSync(file, svg);
    console.log(`updated ${file}`);
  }

  // ---- self-hosted replacement for the third-party stats/langs/streak widgets ----

  const LANG_COLORS = {
    TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5", HTML: "#e34c26",
    CSS: "#563d7c", Java: "#b07219", "C++": "#f34b7d", C: "#555555", Shell: "#89e051",
    PowerShell: "#012456", PLpgSQL: "#336790", Vue: "#41b883", Go: "#00ADD8",
    Rust: "#dea584", Dockerfile: "#384d54", SCSS: "#c6538c", EJS: "#a91e50",
  };
  const FALLBACK_COLORS = ["#58a6ff", "#79c0ff", "#39d353", "#f85149", "#d2a8ff", "#ffa657"];

  const langList = [...langSizes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, size], i) => ({
      name,
      pct: (size / totalLangSize) * 100,
      color: LANG_COLORS[name] || FALLBACK_COLORS[i % FALLBACK_COLORS.length],
    }));

  // streak: walk the daily contribution calendar chronologically
  const days = weeks.flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, count: d.contributionCount }));
  let longestStreak = 0, longestStart = null, longestEnd = null;
  let run = 0, runStart = null;
  for (const d of days) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run++;
      if (run > longestStreak) { longestStreak = run; longestStart = runStart; longestEnd = d.date; }
    } else {
      run = 0;
    }
  }
  let currentStreak = 0, currentStart = null;
  {
    let i = days.length - 1;
    if (days[i] && days[i].count === 0) i--; // today may not be over yet
    while (i >= 0 && days[i].count > 0) { currentStreak++; currentStart = days[i].date; i--; }
  }

  const SANS = "'Segoe UI', Ubuntu, Sans-Serif";

  // ---- stats-card.svg (mirrors the classic "github-readme-stats" card) ----
  {
    const W = 495, H = 195;
    const rows = [
      ["Total Stars Earned", fmt(stars)],
      ["Total Commits", fmt(lifetimeCommits)],
      ["Total PRs", fmt(user.pullRequests.totalCount)],
      ["Total Issues", fmt(user.issues.totalCount)],
      ["Contributed to (last year)", fmt(user.repositoriesContributedTo.totalCount)],
    ];
    const rowsSvg = rows
      .map(
        ([label, value], i) => `
  <text x="25" y="${60 + i * 28}" font-family="${SANS}" font-size="14" fill="#8b949e">${escapeXml(label)}:</text>
  <text x="${W - 25}" y="${60 + i * 28}" text-anchor="end" font-family="${SANS}" font-size="14" font-weight="600" fill="#c9d1d9">${escapeXml(value)}</text>`
      )
      .join("");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Harshit Saini's GitHub stats">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
  <text x="25" y="34" font-family="${SANS}" font-size="18" font-weight="700" fill="#c9d1d9">Harshit Saini's GitHub Stats</text>
  ${rowsSvg}
</svg>
`;
    writeFileSync("stats-card.svg", svg);
    console.log("updated stats-card.svg");
  }

  // ---- langs-card.svg ----
  {
    const W = 300, H = 195;
    const barX = 25, barY = 60, barW = W - 50, barH = 10;
    let x = barX;
    const segs = langList
      .map((l) => {
        const w = (l.pct / 100) * barW;
        const rect = `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}" fill="${l.color}"/>`;
        x += w;
        return rect;
      })
      .join("");
    const legend = langList
      .map((l, i) => {
        const col = i % 2, row = Math.floor(i / 2);
        const lx = barX + col * 140, ly = barY + 34 + row * 26;
        return `<circle cx="${lx}" cy="${ly - 4}" r="5" fill="${l.color}"/><text x="${lx + 12}" y="${ly}" font-family="${SANS}" font-size="13" fill="#c9d1d9">${escapeXml(l.name)} ${l.pct.toFixed(1)}%</text>`;
      })
      .join("");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Most used languages">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
  <text x="25" y="34" font-family="${SANS}" font-size="18" font-weight="700" fill="#c9d1d9">Most Used Languages</text>
  <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="#161b22"/>
  ${segs}
  ${legend}
</svg>
`;
    writeFileSync("langs-card.svg", svg);
    console.log("updated langs-card.svg");
  }

  // ---- streak-card.svg ----
  {
    const W = 820, H = 240;
    const cx1 = W * 0.18, cx2 = W / 2, cx3 = W - W * 0.18;
    const dateY = 44, numY = 150, labelY = 180;
    const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
    const firstDay = days[0]?.date;
    const todayLabel = fmtDate(days[days.length - 1]?.date);

    const flame = `
    <g transform="translate(${cx2},70)">
      <circle r="38" fill="none" stroke="#f0883e" stroke-width="2" opacity="0.5"/>
      <path d="M0 -18 C 8 -8 10 0 5 8 C 10 4 13 -3 10 -10 C 15 -4 17 5 10 13 C 5 18 -5 18 -10 13 C -17 6 -15 -4 -9 -11 C -10 -5 -8 -1 -4 -4 C -4 -10 -3 -15 0 -18 Z" fill="#f0883e"/>
    </g>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Contribution streak">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
  <line x1="${(cx1 + cx2) / 2}" y1="30" x2="${(cx1 + cx2) / 2}" y2="${H - 30}" stroke="#30363d"/>
  <line x1="${(cx2 + cx3) / 2}" y1="30" x2="${(cx2 + cx3) / 2}" y2="${H - 30}" stroke="#30363d"/>

  <text x="${cx1}" y="${dateY}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="#8b949e">${fmtDate(firstDay)} &#8211; ${todayLabel}</text>
  <text x="${cx1}" y="${numY}" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="700" fill="#c9d1d9">${fmt(cal.contributionCalendar.totalContributions)}</text>
  <text x="${cx1}" y="${labelY}" text-anchor="middle" font-family="${SANS}" font-size="14" fill="#8b949e">Total Contributions</text>

  ${flame}
  <text x="${cx2}" y="${numY}" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="700" fill="#f0883e">${currentStreak}</text>
  <text x="${cx2}" y="${labelY}" text-anchor="middle" font-family="${SANS}" font-size="14" font-weight="700" fill="#f0883e">Current Streak</text>

  <text x="${cx3}" y="${dateY}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="#8b949e">${longestStreak > 0 ? `${fmtDate(longestStart)} &#8211; ${fmtDate(longestEnd)}` : "—"}</text>
  <text x="${cx3}" y="${numY}" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="700" fill="#c9d1d9">${longestStreak}</text>
  <text x="${cx3}" y="${labelY}" text-anchor="middle" font-family="${SANS}" font-size="14" fill="#8b949e">Longest Streak</text>
</svg>
`;
    writeFileSync("streak-card.svg", svg);
    console.log("updated streak-card.svg");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
