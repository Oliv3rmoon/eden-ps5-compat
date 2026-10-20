#!/usr/bin/env node
// Imports new public ProsperoEden game reports into data/games.json.
//
//   node scripts/import-reports.mjs                 dry run: print what would change
//   node scripts/import-reports.mjs --write         also write data/games.json and data/import-state.json
//   node scripts/import-reports.mjs --since 2026-10-01T00:00:00Z
//   node scripts/import-reports.mjs --write --summary pr-body.md
//
// Issue text is untrusted: it is only parsed as plain text, stripped of markdown and HTML,
// and capped in length. Nothing from an issue is ever run or passed to a shell.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "blackbearreloaded/ProsperoEden";
const API = "https://api.github.com";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAMES_FILE = path.join(ROOT, "data/games.json");
const STATE_FILE = path.join(ROOT, "data/import-state.json");

const RESULTS = {
  "plays well": "well",
  "plays with glitches": "glitches",
  "starts but cannot be played": "unplayable",
  "does not start": "wontstart",
};
const DEFAULT_NOTES = {
  well: "Plays well.",
  glitches: "Plays with glitches.",
  unplayable: "Starts but can't be played.",
  wontstart: "Doesn't start.",
};
const SKIP_LABELS = new Set(["invalid", "duplicate"]);
const MAX_NAME = 100;
const MAX_NOTE = 200;
const MAX_BODY = 20000;

// ---------- arguments ----------

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const WRITE = args.includes("--write");
const SINCE_ARG = opt("--since");
const SUMMARY = opt("--summary");

// ---------- GitHub API ----------

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

async function api(url) {
  const res = await fetch(url.startsWith("http") ? url : API + url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "eden-ps5-compat-import",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
  return { data: await res.json(), next: next ? next[1] : null };
}

async function apiAll(url) {
  const out = [];
  for (let u = url; u; ) { const { data, next } = await api(u); out.push(...data); u = next; }
  return out;
}

// ---------- text cleaning ----------

// Plain text only: no HTML, markdown, links, mentions or control characters, capped at max chars.
function clean(text, max) {
  let s = String(text || "").slice(0, MAX_BODY);
  s = s.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[`*_~#>|\\@<\[\]{}]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s,;:.-]+$/, "") + "…";
  return s;
}

const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const TITLE_ID = /\b0100[0-9A-F]{12}\b/i;
// An update shares the base game's ID except for its last three digits.
const baseId = (id) => (id || "").toUpperCase().slice(0, 13);

// "### Heading" sections of an issue form, with "_No response_" as empty.
function sections(body) {
  const out = {};
  const parts = String(body || "").slice(0, MAX_BODY).split(/^###[ \t]+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i].trim().toLowerCase();
    if (!(key in out)) out[key] = parts[i + 1].trim().replace(/^_No response_$/i, "");
  }
  return out;
}

const firstLine = (s) => (String(s || "").split("\n").find((l) => l.trim()) || "").trim();

// ---------- versions ----------

// "v1.003", "01.002.000", "1.4" -> "1.003.000", "1.004.000"; anything else -> "".
function normVersion(s) {
  const m = /(?:^|[^\d.])0*1\.(\d{1,3})(?:\.(\d{1,3}))?(?![\d.]*\d)/.exec(" " + String(s || ""));
  if (!m) return "";
  return `1.${m[1].padStart(3, "0")}.${(m[2] || "0").padStart(3, "0")}`;
}

function reportVersion(fields, body, createdAt, releases) {
  const known = (v) => (releases.some((r) => r.version === v) ? v : "");
  const stated = firstLine(fields["app version"]).slice(0, 60);
  // "v1.002.000 and v1.003.000" -> the newest one named.
  let v = stated.split(/[\s,;/&]+|\band\b/).map((p) => known(normVersion(p))).sort().pop() || "";
  if (v) return v;
  // A crash report pasted into the issue names the exact build.
  const crash = /ProsperoEden crash report[\s\S]{0,200}?\bversion:\s*([\d.]+)/i.exec(String(body || "").slice(0, MAX_BODY));
  if (crash && (v = known(normVersion(crash[1])))) return v;
  // "latest" means the newest release when the issue was opened.
  if (/\b(latest|newest|current)\b/i.test(stated)) {
    const r = releases.find((r) => r.published <= createdAt);
    if (r) return r.version;
  }
  return "";
}

// ---------- names and notes ----------

const NOISE = /\b(?:usa|us|eu|europe|eur|jp|jpn|japan|asia|english|update|ver|version|v\d[\d.]*|nsp|xci|dlc)\b/gi;

const stripTags = (s) => String(s || "").replace(/\[[^\]\n]*\]/g, " ");

function cleanName(raw) {
  let s = clean(stripTags(raw).replace(/\([^)\n]*\)/g, " "), 300).replace(TITLE_ID, " ");
  s = s.replace(/\bwith\b.*\bupdate\b.*$/i, " ")                // "game with 1.2.3 update"
    .replace(/\b(?:v|ver\.?|version|update)\s*\d[\d.]*/gi, " ") // "v1.0.0", "update 1.10"
    .replace(/(?:^|\s)\d+(?:\.\d+){1,3}(?=\s|$)/g, " ")          // a bare "1.4.0"
    .replace(/^switch\s+/i, "")
    .replace(/\s+/g, " ").replace(/^[\s\-–—:,|.]+|[\s\-–—:,|.]+$/g, "");
  // "minecraft" -> "Minecraft"
  if (s === s.toLowerCase()) s = s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return s;
}

const meaningful = (name) => name.replace(NOISE, "").replace(/[^a-z]/gi, "").length >= 3;

// The game name: the form's Game field, or the issue title when that field holds only a region or version.
function gameName(fields, title) {
  const fromField = cleanName(firstLine(fields.game));
  if (meaningful(fromField)) return fromField.slice(0, MAX_NAME);
  const t = clean(stripTags(title), 300).split(/\s+[-–—]\s+/)[0];
  const fromTitle = cleanName(t);
  return meaningful(fromTitle) ? fromTitle.slice(0, MAX_NAME) : "";
}

// Keeps "titleId" right after "name", as in the hand-written entries.
function setTitleId(game, id) {
  const rest = Object.entries(game).filter(([k]) => k !== "name");
  for (const [k] of rest) delete game[k];
  Object.assign(game, { titleId: id }, Object.fromEntries(rest));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// One sentence from the issue title, minus tags, the title ID and the game's name.
function noteFromTitle(title, names, status) {
  let s = clean(stripTags(title), 300).replace(TITLE_ID, " ");
  for (const n of names.filter(Boolean).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(escapeRe(n).replace(/\\?['’]/g, "['’]?"), "i"), " ");
  }
  s = s.replace(/\s+/g, " ").replace(/^[\s\-–—:,|.]+|[\s\-–—:,|]+$/g, "").trim();
  if (s.replace(/[^a-z]/gi, "").length < 4 || /^(?:crash(?: report)?|bug|game|report|issue)s?$/i.test(s)) return DEFAULT_NOTES[status];
  s = s.split(/(?<=[.!?])\s/)[0];
  s = clean(s.charAt(0).toUpperCase() + s.slice(1), MAX_NOTE - 1);
  return /[.!?…]$/.test(s) ? s : s + ".";
}

// ---------- main ----------

const data = JSON.parse(fs.readFileSync(GAMES_FILE, "utf8"));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
const since = SINCE_ARG || state.since || (data.updated ? data.updated + "T00:00:00Z" : "1970-01-01T00:00:00Z");
const startedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");

const releases = (await apiAll(`/repos/${UPSTREAM}/releases?per_page=100`))
  .filter((r) => !r.draft)
  .map((r) => ({ version: normVersion(r.tag_name), published: r.published_at }))
  .filter((r) => r.version)
  .sort((a, b) => (a.published < b.published ? 1 : -1));

const recent = (await apiAll(`/repos/${UPSTREAM}/issues?state=all&since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100`))
  .filter((i) => !i.pull_request);
const issueState = new Map(recent.map((i) => [i.number, i.state]));

const listed = new Map(); // issue number -> game
for (const g of data.games) for (const n of g.issues || []) listed.set(n, g);

const changes = new Map(); // game -> { added, lines[] }
const touch = (g, line, added = false) => {
  if (!changes.has(g)) changes.set(g, { added, lines: [] });
  if (line) changes.get(g).lines.push(line);
};
const skipped = [];

for (const issue of recent) {
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name).toLowerCase());
  if (listed.has(issue.number)) { touch(listed.get(issue.number)); continue; }
  const fields = sections(issue.body);
  const isReport = labels.includes("compatibility") || (labels.includes("bug") && "game" in fields);
  if (!isReport) continue;
  if (labels.some((l) => SKIP_LABELS.has(l))) { skipped.push([issue.number, "labelled invalid or duplicate"]); continue; }

  const status = RESULTS[firstLine(fields.result).toLowerCase()];
  if (!status) { skipped.push([issue.number, "no Result line from the game report form"]); continue; }
  const name = gameName(fields, issue.title);
  if (!name) { skipped.push([issue.number, "no game name found"]); continue; }
  const idMatch = TITLE_ID.exec(firstLine(fields.game)) || TITLE_ID.exec(issue.title)
    || /running: game[^\n]*?\b(0100[0-9A-F]{12})\b/i.exec(String(issue.body || "").slice(0, MAX_BODY));
  const titleId = idMatch ? (idMatch[1] || idMatch[0]).toUpperCase() : "";
  const version = reportVersion(fields, issue.body, issue.created_at, releases);

  let game = data.games.find((g) => titleId && g.titleId && baseId(g.titleId) === baseId(titleId))
    || data.games.find((g) => norm(g.name) === norm(name));

  if (!game) {
    game = { name, ...(titleId ? { titleId } : {}), status, version, issues: [issue.number],
      note: noteFromTitle(issue.title, [name, firstLine(fields.game)], status) };
    data.games.push(game);
    touch(game, `added from issue ${issue.number}: ${status}${version ? " on " + version : ""}`, true);
  } else {
    game.issues.push(issue.number);
    const lines = [`issue ${issue.number} added`];
    if (titleId && !game.titleId) { setTitleId(game, titleId); lines.push(`title ID set to ${titleId}`); }
    // A newer app version decides; a resolved game that gets a new report is reopened with it.
    const newer = version && version > (game.version || "");
    const reopen = game.status === "closed" && (!game.version || !version || version >= game.version);
    if (newer || reopen) {
      if (game.status !== status) lines.push(`status ${game.status} -> ${status}`);
      if (newer) lines.push(`version ${game.version || "(none)"} -> ${version}`);
      game.status = status;
      if (newer) game.version = version;
    }
    touch(game, lines.join(", "));
  }
  listed.set(issue.number, game);
}

// A game counts as resolved only when every one of its issues is closed upstream.
for (const game of changes.keys()) {
  for (const n of game.issues) {
    if (!issueState.has(n)) issueState.set(n, (await api(`/repos/${UPSTREAM}/issues/${n}`)).data.state);
  }
  const allClosed = game.issues.length > 0 && game.issues.every((n) => issueState.get(n) === "closed");
  if (allClosed && game.status !== "closed") {
    touch(game, `status ${game.status} -> closed (all issues closed upstream: ${game.issues.join(", ")})`);
    game.status = "closed";
  }
}

const changed = [...changes].filter(([, c]) => c.lines.length);

// ---------- report ----------

const lines = [];
lines.push(`Reports from \`${UPSTREAM}\` updated since ${since}.`, "");
if (!changed.length) lines.push("No changes.");
const added = changed.filter(([, c]) => c.added);
const updated = changed.filter(([, c]) => !c.added);
if (added.length) {
  lines.push(`### Added (${added.length})`, "");
  for (const [g] of added) {
    lines.push(`- \`${g.name}\`${g.titleId ? ` (\`${g.titleId}\`)` : ""}: **${g.status}**, version ${g.version || "unknown"}, issue ${g.issues.join(", ")}`,
      `  - Note: ${g.note.replace(/`/g, "")}`);
  }
  lines.push("");
}
if (updated.length) {
  lines.push(`### Updated (${updated.length})`, "");
  for (const [g, c] of updated) lines.push(`- \`${g.name}\`: ${c.lines.join("; ")}`);
  lines.push("");
}
if (skipped.length) {
  lines.push(`### Not imported (${skipped.length})`, "");
  for (const [n, why] of skipped) lines.push(`- issue ${n}: ${why}`);
  lines.push("");
}
lines.push("Issue numbers refer to the ProsperoEden repository. Check names and notes before merging; they come from the issue text.");
const report = lines.join("\n") + "\n";
process.stdout.write(report);

if (WRITE && changed.length) {
  data.updated = startedAt.slice(0, 10);
  fs.writeFileSync(GAMES_FILE, JSON.stringify(data, null, 2) + "\n");
  fs.writeFileSync(STATE_FILE, JSON.stringify({ since: startedAt }, null, 2) + "\n");
}
if (SUMMARY) fs.writeFileSync(SUMMARY, report);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length > 0}\n`);
if (!WRITE) process.stderr.write("\nDry run: no files written. Add --write to apply.\n");
