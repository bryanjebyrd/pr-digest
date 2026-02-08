const fs = require("fs");

module.exports = async ({ github, core }) => {
  const cfgPath = process.env.PR_DIGEST_CONFIG;

  if (!cfgPath) {
    core.setFailed("Missing PR_DIGEST_CONFIG environment variable.");
    return;
  }

  if (!fs.existsSync(cfgPath)) {
    core.setFailed(`PR digest config file not found: ${cfgPath}`);
    return;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    core.setFailed(`Invalid JSON in ${cfgPath}: ${e.message}`);
    return;
  }

  const org = cfg.org;
  const repos = Array.isArray(cfg.repos) ? cfg.repos : [];
  const users = Array.isArray(cfg.users) ? cfg.users : [];

  const MAX_PRS_PER_REPO = cfg.max_prs_per_repo ?? 25;
  const MAX_TOTAL_PRS = cfg.max_total_prs ?? 200;
  const MAX_SEARCH_RESULTS_PER_USER = cfg.max_search_results_per_user ?? 500;

  if (!org) {
    core.setFailed(`${cfgPath} must include "org"`);
    return;
  }

  if (repos.length === 0 && users.length === 0) {
    core.setFailed(`${cfgPath} must include at least one repo or one user`);
    return;
  }

  function daysOpen(iso) {
    return Math.floor((Date.now() - new Date(iso)) / 86400000);
  }

  function prettyDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[m - 1]} ${d}, ${y}`;
  }

  const prMap = new Map();

  async function addPR(owner, repo, number) {
    try {
      const { data } = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: number
      });

      prMap.set(data.html_url, {
        repo: `${owner}/${repo}`,
        number: data.number,
        title: data.title,
        url: data.html_url,
        author: data.user?.login || "unknown",
        days: daysOpen(data.created_at),
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        draft: !!data.draft
      });
    } catch (e) {
      if (e?.status === 404) return;
      throw e;
    }
  }

  for (const repoFull of repos) {
    if (prMap.size >= MAX_TOTAL_PRS) break;

    const parts = String(repoFull || "").trim().split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) continue;

    for await (const page of github.paginate.iterator(
      github.rest.pulls.list,
      { owner, repo, state: "open", per_page: 100 }
    )) {
      const prs = page?.data ?? [];

      for (const pr of prs) {
        if (prMap.size >= MAX_TOTAL_PRS) break;
        if (!pr || !pr.number) continue;

        await addPR(owner, repo, pr.number);
      }
    }
  }

  for (const userRaw of users) {
    if (prMap.size >= MAX_TOTAL_PRS) break;

    const user = String(userRaw || "").trim().replace(/^@/, "");
    if (!user) continue;

    const q = `is:pr is:open org:${org} author:${user}`;

    const results = await github.paginate(
      github.rest.search.issuesAndPullRequests,
      { q, per_page: 100 },
      (r) => Array.isArray(r?.data?.items) ? r.data.items : []
    );

    for (const it of results.slice(0, MAX_SEARCH_RESULTS_PER_USER)) {
      if (!it || typeof it !== "object") continue;
      if (!it.url) continue;

      // https://api.github.com/repos/{owner}/{repo}/issues/{number}
      const match = it.url.match(/\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
      if (!match) continue;

      const owner = match[1];
      const repo = match[2];
      const number = Number(match[3]);
      if (!Number.isFinite(number)) continue;

      await addPR(owner, repo, number);
    }
  }

  const teamRepoSet = new Set(repos.map(r => String(r || "").trim()));
  const teamOwned = [];
  const teamNonOwned = [];

  for (const pr of prMap.values()) {
    if (teamRepoSet.has(pr.repo)) {
      teamOwned.push(pr);
    } else {
      teamNonOwned.push(pr);
    }
  }

  function renderSection(title, prs) {
    const lines = [];

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push(title);
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push("");

    if (!prs.length) {
      lines.push("_None today 🎉_");
      lines.push("");
      return lines;
    }

    prs.sort((a, b) => b.days - a.days);

    const byRepo = {};
    for (const pr of prs) {
      if (!byRepo[pr.repo]) byRepo[pr.repo] = [];
      byRepo[pr.repo].push(pr);
    }

    lines.push("*PR* | *Age* | *Author* | *Δ*");
    lines.push("");

    for (const repo of Object.keys(byRepo).sort()) {
      const repoPRs = byRepo[repo];

      lines.push("");
      lines.push(`*${repo}* — ${repoPRs.length} open`);
      lines.push("");

      for (const pr of repoPRs.slice(0, MAX_PRS_PER_REPO)) {
        const draft = pr.draft ? " 📝(draft)" : "";

        lines.push(
          `• <${pr.url}|#${pr.number} ${pr.title}>${draft}`
        );
        lines.push(
          `  🕒 ${pr.days}d   |   👤 @${pr.author}   |   🧮 +${pr.additions} / -${pr.deletions}`
        );
        lines.push("");
      }
    }

    return lines;
  }

  const today = prettyDate(new Date().toISOString().slice(0, 10));
  const out = [];

  out.push(`📬 *PR Digest* — ${today}`);

  out.push(...renderSection("📦 *Team Owned Repos*", teamOwned));
  out.push(...renderSection("🧑‍💻 *Team PRs in Non-Owned Repos*", teamNonOwned));

  core.setOutput("slack_text", out.join("\n"));
};
