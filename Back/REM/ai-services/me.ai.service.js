/**
 * ai-services/me.ai.service.js
 *
 * Pure-JS port of me_ai_service.py.
 *
 * Replaces the previous spawn("python", ...) wrapper. Same exported
 * names + return shapes (`rerankForYouWithPythonAI`, `annotateWorkedOnWithAI`)
 * so modules/me consumes it unchanged.
 *
 * Model identifier bumped to `js-heuristic-v1` so analytics dashboards
 * can see the cutover. All scoring weights kept identical to the
 * Python version so ranked output is bit-for-bit equivalent.
 */

// ── Helpers ────────────────────────────────────────────────────

function parseDate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value.$date) value = value.$date;
  if (value instanceof Date) return value;
  const t = String(value).trim();
  if (!t) return null;
  const d = new Date(t.endsWith("Z") ? t : t);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseId(value) {
  if (value == null) return null;
  if (typeof value === "object" && value.$oid) return String(value.$oid);
  return String(value);
}

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round2 = (n) => Math.round(n * 100) / 100;

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function recencyBonus(updatedAt, now) {
  const dt = parseDate(updatedAt);
  if (!dt) return 0;
  const hours = Math.max((now - dt) / 3_600_000, 0);
  if (hours <= 24) return 12;
  if (hours <= 72) return 7;
  if (hours <= 168) return 3;
  return 0;
}

// ── AI-6.1 basic relevance ─────────────────────────────────────

function basicRelevanceScore(task, now) {
  const priority = String(task.priority || "Low");
  const status = String(task.status || "Todo");
  const priorityMap = { Urgent: 40, High: 30, Medium: 18, Low: 8 };
  const statusMap = { InProgress: 24, Todo: 14, Done: -35 };
  const score =
    (priorityMap[priority] ?? 8) +
    (statusMap[status] ?? 8) +
    recencyBonus(task.updatedAt, now);
  return clamp(score + 20);
}

// ── AI-6.4 time urgency ────────────────────────────────────────

function timeUrgencyScore(task, now) {
  const due = parseDate(task.dueDate);
  if (!due) return 5;
  const diffDays = (due - now) / 86_400_000;
  if (diffDays < 0) return 100;
  if (diffDays <= 1) return 90;
  if (diffDays <= 3) return 75;
  if (diffDays <= 7) return 55;
  if (diffDays <= 14) return 35;
  return 15;
}

// ── User profile (used by AI-6.2 / 6.3 / 6.5) ──────────────────

function buildUserProfile(tasks) {
  const byType = new Map();
  const byPriority = new Map();
  const byLabel = new Map();
  const bySpace = new Map();
  const completionSamples = [];

  for (const t of tasks) {
    const ttype = String(t.type || "Task");
    const pr = String(t.priority || "Low");
    const status = String(t.status || "Todo");
    const spaceId = parseId(t.spaceId);

    bump(byType, ttype);
    bump(byPriority, pr);
    if (spaceId) bump(bySpace, spaceId);

    for (const lb of t.labels || []) bump(byLabel, String(lb).toLowerCase());

    if (status === "Done") {
      const created = parseDate(t.createdAt);
      const updated = parseDate(t.updatedAt);
      if (created && updated && updated >= created) {
        completionSamples.push((updated - created) / 3_600_000);
      }
    }
  }
  return { byType, byPriority, byLabel, bySpace, completionSamples };
}

// ── AI-6.2 behavior ────────────────────────────────────────────

function userBehaviorScore(task, profile) {
  const { byType, byPriority, byLabel } = profile;
  const totalType = sumMap(byType) || 1;
  const totalPriority = sumMap(byPriority) || 1;
  const totalLabel = sumMap(byLabel) || 1;

  const ttype = String(task.type || "Task");
  const pr = String(task.priority || "Low");

  let score = 35 * ((byType.get(ttype) || 0) / totalType);
  score += 25 * ((byPriority.get(pr) || 0) / totalPriority);

  const labels = (task.labels || []).map((x) => String(x).toLowerCase());
  if (labels.length) {
    const labelFit = Math.max(
      ...labels.map((lb) => (byLabel.get(lb) || 0) / totalLabel),
    );
    score += 40 * labelFit;
  } else {
    score += 5;
  }
  return clamp(score);
}

// ── AI-6.3 collaborative ───────────────────────────────────────

function collaborativeFilterScore(task, teamTasks, userProfile) {
  if (!teamTasks?.length) return 10;

  const teamType = new Map();
  const teamLabel = new Map();
  const teamSpace = new Map();
  for (const t of teamTasks) {
    bump(teamType, String(t.type || "Task"));
    const sid = parseId(t.spaceId);
    if (sid) bump(teamSpace, sid);
    for (const lb of t.labels || []) bump(teamLabel, String(lb).toLowerCase());
  }
  const totalTeamType = sumMap(teamType) || 1;
  const totalTeamLabel = sumMap(teamLabel) || 1;
  const totalTeamSpace = sumMap(teamSpace) || 1;

  const ttype = String(task.type || "Task");
  const spaceId = parseId(task.spaceId);
  const labels = (task.labels || []).map((x) => String(x).toLowerCase());

  const typeFit = (teamType.get(ttype) || 0) / totalTeamType;
  const spaceFit = spaceId
    ? (teamSpace.get(spaceId) || 0) / totalTeamSpace
    : 0;
  const labelFit = labels.length
    ? Math.max(
        ...labels.map((lb) => (teamLabel.get(lb) || 0) / totalTeamLabel),
      )
    : 0;

  // Novelty: prefer team signal that user does less often
  const userTypeCount = userProfile.byType.get(ttype) || 0;
  const novelty = 1 / (1 + userTypeCount);

  return clamp(45 * typeFit + 30 * labelFit + 20 * spaceFit + 20 * novelty);
}

// ── AI-6.5 project/space affinity ──────────────────────────────

function projectAffinityScore(task, profile) {
  const totalSpace = sumMap(profile.bySpace) || 1;
  const sid = parseId(task.spaceId);
  const spaceFit = sid ? (profile.bySpace.get(sid) || 0) / totalSpace : 0;
  const parentBonus = task.parentTaskId ? 12 : 0;
  return clamp(20 + 70 * spaceFit + parentBonus);
}

function explainComponents(components) {
  const labels = {
    relevance: "AI-6.1 relevance",
    behavior: "AI-6.2 behavior",
    collab: "AI-6.3 collaborative",
    urgency: "AI-6.4 urgency",
    affinity: "AI-6.5 affinity",
  };
  const top = Object.entries(components)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  return top.map(([k]) => labels[k]).join(", ");
}

// ── Public API (preserves the previous wrapper's exports) ──────

export async function rerankForYouWithPythonAI({
  scored = [],
  limit = 15,
  userHistory = [],
  teamHistory = [],
} = {}) {
  const now = new Date();
  const userProfile = buildUserProfile(userHistory);
  const cap = Number(limit) || 15;

  const ranked = scored.map((row) => {
    const task = row.task || {};
    const baseRule = Number(row.score) || 0;

    const cRelevance = basicRelevanceScore(task, now);
    const cBehavior = userBehaviorScore(task, userProfile);
    const cCollab = collaborativeFilterScore(task, teamHistory, userProfile);
    const cUrgency = timeUrgencyScore(task, now);
    const cAffinity = projectAffinityScore(task, userProfile);

    const aiScore =
      0.22 * cRelevance +
      0.20 * cBehavior +
      0.18 * cCollab +
      0.25 * cUrgency +
      0.15 * cAffinity;

    const finalScore = round2(baseRule * 0.35 + aiScore * 0.65);
    const components = {
      relevance: round2(cRelevance),
      behavior: round2(cBehavior),
      collab: round2(cCollab),
      urgency: round2(cUrgency),
      affinity: round2(cAffinity),
    };

    return {
      ...row,
      score: finalScore,
      aiScore: round2(aiScore),
      aiReason: explainComponents(components),
      aiBreakdown: components,
    };
  });

  ranked.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

  return {
    aiUsed: true,
    aiModel: "js-heuristic-v1",
    aiFallbackReason: null,
    items: ranked.slice(0, cap),
  };
}

// Legacy alias preserved so existing callers don't break.
export async function rerankForYouWithAI(args) {
  return rerankForYouWithPythonAI(args);
}

export async function annotateWorkedOnWithAI({ items = [] } = {}) {
  const now = new Date();
  const notes = [];
  // Match Python behavior: cap at first 60 items.
  for (const t of items.slice(0, 60)) {
    const taskId = parseId(t._id);
    const status = String(t.status || "Todo");
    const urgency = timeUrgencyScore(t, now);
    const relevance = basicRelevanceScore(t, now);
    const score = round2(0.55 * urgency + 0.45 * relevance);

    let note;
    if (status === "Done") note = "Completed recently; keep for context.";
    else if (urgency >= 75) note = "High urgency due date; prioritize next.";
    else if (relevance >= 65)
      note = "Strong personal relevance based on activity.";
    else note = "Moderate relevance; schedule when free.";

    notes.push({ id: taskId, score, note });
  }

  // Existing consumer expects `notesById` as a Map.
  const notesById = new Map();
  for (const n of notes) {
    if (!n?.id) continue;
    notesById.set(String(n.id), { aiScore: n.score, aiNote: n.note });
  }

  return {
    aiUsed: true,
    aiModel: "js-heuristic-v1",
    aiFallbackReason: null,
    notesById,
  };
}

// ── helpers ────────────────────────────────────────────────────
function sumMap(m) {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}
