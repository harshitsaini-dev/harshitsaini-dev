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
  let longestStreak = 0, run = 0;
  for (const d of days) {
    if (d.count > 0) { run++; longestStreak = Math.max(longestStreak, run); } else { run = 0; }
  }
  let currentStreak = 0;
  {
    let i = days.length - 1;
    if (days[i] && days[i].count === 0) i--; // today may not be over yet
    while (i >= 0 && days[i].count > 0) { currentStreak++; i--; }
  }

  const W = 1120, H = 250, PAD = 28;
  const statRows = [
    ["Stars", fmt(stars)],
    ["Followers", fmt(user.followers.totalCount)],
    ["Lifetime commits", fmt(lifetimeCommits)],
    ["Pull requests", fmt(user.pullRequests.totalCount)],
    ["Issues", fmt(user.issues.totalCount)],
  ];

  function statLines() {
    return statRows
      .map(([label, value], i) => {
        const y = 70 + i * 30;
        const dots = ".".repeat(Math.max(3, 28 - label.length));
        return `<text x="${PAD}" y="${y}" font-family="'Consolas','Menlo','DejaVu Sans Mono',monospace" font-size="14"><tspan fill="#ffa657">${escapeXml(label)}</tspan><tspan fill="#484f58"> ${dots} </tspan><tspan fill="#79c0ff">${escapeXml(value)}</tspan></text>`;
      })
      .join("\n  ");
  }

  function langBar() {
    const barX = 400, barY = 70, barW = 330, barH = 10;
    let x = barX;
    const segs = langList
      .map((l) => {
        const w = (l.pct / 100) * barW;
        const rect = `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}" fill="${l.color}"/>`;
        x += w;
        return rect;
      })
      .join("\n    ");
    const legend = langList
      .map((l, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const lx = barX + col * 165;
        const ly = barY + 34 + row * 24;
        return `<circle cx="${lx}" cy="${ly - 4}" r="4" fill="${l.color}"/><text x="${lx + 12}" y="${ly}" font-family="'Consolas','Menlo','DejaVu Sans Mono',monospace" font-size="12" fill="#c9d1d9">${escapeXml(l.name)} ${l.pct.toFixed(1)}%</text>`;
      })
      .join("\n    ");
    return `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="#161b22"/>\n    ${segs}\n    ${legend}`;
  }

  function streakBlock() {
    const cx1 = 800, cx2 = 930, cx3 = 1060;
    const cy = 130;
    const big = (x, value, label) => `
    <text x="${x}" y="${cy}" text-anchor="middle" font-family="'Consolas','Menlo','DejaVu Sans Mono',monospace" font-size="30" font-weight="700" fill="#c9d1d9">${escapeXml(value)}</text>
    <text x="${x}" y="${cy + 22}" text-anchor="middle" font-family="'Consolas','Menlo','DejaVu Sans Mono',monospace" font-size="12" fill="#8b949e">${escapeXml(label)}</text>`;
    return `${big(cx1, fmt(cal.contributionCalendar.totalContributions), "contributions (12mo)")}${big(cx2, String(currentStreak), "current streak")}${big(cx3, String(longestStreak), "longest streak")}`;
  }

  const activityCard = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Live GitHub activity stats">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="#0d1117" stroke="#30363d"/>
  <text x="${PAD}" y="36" font-family="'Consolas','Menlo','DejaVu Sans Mono',monospace" font-size="16"><tspan fill="#3d444d">─</tspan><tspan fill="#58a6ff"> Stats </tspan><tspan fill="#3d444d">──────</tspan></text>
  <text x="400" y="36" font-family="'Consolas','Menlo','DejaVu Sans Mono',monospace" font-size="16"><tspan fill="#3d444d">─</tspan><tspan fill="#58a6ff"> Languages </tspan><tspan fill="#3d444d">──────</tspan></text>
  <text x="740" y="36" font-family="'Consolas','Menlo','DejaVu Sans Mono',monospace" font-size="16"><tspan fill="#3d444d">─</tspan><tspan fill="#58a6ff"> Last 12 months </tspan><tspan fill="#3d444d">──────</tspan></text>
  ${statLines()}
  ${langBar()}
  ${streakBlock()}
</svg>
`;
  writeFileSync("activity-card.svg", activityCard);
  console.log("updated activity-card.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
