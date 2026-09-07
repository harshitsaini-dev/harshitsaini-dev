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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
