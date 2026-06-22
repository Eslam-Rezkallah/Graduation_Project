import Sprint from "../../../DB/Model/sprint.model.js";
import Task from "../../../DB/Model/task.model.js";
import * as dbService from "../../../DB/db.service.js";
import { asyncHandler } from "../../../utils/response/error.response.js";
import { successResponse } from "../../../utils/response/success.response.js";

// ✅ Phase 9 caching (optional but recommended)
import { cache, cacheKey } from "../../../utils/cache/lru.cache.js";
import { requireOrgMember } from "../../../utils/permissions/org.permissions.js";
import { httpError } from "../../../utils/errors/index.js";

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function eachDayInclusive(from, to) {
  const days = [];
  let cur = startOfDay(from);
  const last = startOfDay(to);
  while (cur <= last) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

// =========================
// BE-8.3 Sprint report (Phase 9 optimized)
// =========================
export const sprintReport = asyncHandler(async (req, res, next) => {
  const { orgId, spaceId, sprintId } = req.params;

  await requireOrgMember(orgId, req.user._id);

  // ✅ Cache (60s). Key includes ids to prevent wrong data
  const key = cacheKey(["sprintReport", orgId, spaceId, sprintId]);
  const cached = cache.get(key);
  if (cached) return successResponse({ res, data: cached }, 200);

  const sprint = await dbService.findOne({
    model: Sprint,
    filter: { _id: sprintId, organizationId: orgId, spaceId, isDeleted: false },
  });
  if (!sprint) return next(httpError(404, "Sprint not found"));

  const filter = {
    organizationId: orgId,
    spaceId,
    sprintId,
    isDeleted: false,
  };

  // ✅ Phase 9: projection + lean
  const tasks = await Task.find(filter)
    .select("title status priority type assigneeId reporterId points createdAt updatedAt dueDate")
    .populate("assigneeId", "username fullName email")
    .lean();

  const total = tasks.length;

  // Compute breakdowns in JS (fast because small projection + lean)
  const byStatus = {};
  const byPriority = {};
  let done = 0;
  let totalPoints = 0;
  let donePoints = 0;

  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;

    const p = Number(t.points) || 0;
    totalPoints += p;

    if (t.status === "Done") {
      done++;
      donePoints += p;
    }
  }

  const completionRate = total ? Math.round((done / total) * 100) : 0;

  const payload = {
    sprint: {
      id: sprint._id,
      name: sprint.name,
      status: sprint.status,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
    },
    totals: {
      total,
      done,
      completionRatePercent: completionRate,
      totalPoints,
      donePoints,
    },
    breakdown: {
      byStatus,
      byPriority,
    },
    tasks,
  };

  cache.set(key, payload);
  return successResponse({ res, data: payload }, 200);
});

// =========================
// BE-8.1 Burndown (Phase 9 optimized + cached)
// =========================
// Output: array of { date, scope, done, remaining }
export const burndown = asyncHandler(async (req, res, next) => {
  const { orgId, spaceId, sprintId } = req.params;

  await requireOrgMember(orgId, req.user._id);

  const key = cacheKey(["burndown", orgId, spaceId, sprintId]);
  const cached = cache.get(key);
  if (cached) return successResponse({ res, data: cached }, 200);

  const sprint = await dbService.findOne({
    model: Sprint,
    filter: { _id: sprintId, organizationId: orgId, spaceId, isDeleted: false },
  });
  if (!sprint) return next(httpError(404, "Sprint not found"));

  const days = eachDayInclusive(sprint.startDate, sprint.endDate);

  // ✅ Phase 9: projection + lean (no heavy documents)
  const allSprintTasks = await Task.find({
    organizationId: orgId,
    spaceId,
    sprintId,
    isDeleted: false,
  })
    .select("status createdAt updatedAt")
    .lean();

  // Pre-convert dates once (less work in the loop)
  const tasksLite = allSprintTasks.map((t) => ({
    status: t.status,
    createdAt: new Date(t.createdAt).getTime(),
    updatedAt: new Date(t.updatedAt).getTime(),
  }));

  const series = days.map((day) => {
    const dayEndTs = endOfDay(day).getTime();

    let scope = 0;
    let done = 0;

    for (const t of tasksLite) {
      if (t.createdAt <= dayEndTs) scope++;
      if (t.status === "Done" && t.updatedAt <= dayEndTs) done++;
    }

    return {
      date: day.toISOString().slice(0, 10),
      scope,
      done,
      remaining: Math.max(scope - done, 0),
    };
  });

  const payload = {
    sprint: {
      id: sprint._id,
      name: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
    },
    series,
  };

  cache.set(key, payload);
  return successResponse({ res, data: payload }, 200);
});

// =========================
// BE-8.2 Burnup (Phase 9 optimized + cached)
// =========================
// Output: array of { date, scope, completed }
export const burnup = asyncHandler(async (req, res, next) => {
  const { orgId, spaceId, sprintId } = req.params;

  await requireOrgMember(orgId, req.user._id);

  const key = cacheKey(["burnup", orgId, spaceId, sprintId]);
  const cached = cache.get(key);
  if (cached) return successResponse({ res, data: cached }, 200);

  const sprint = await dbService.findOne({
    model: Sprint,
    filter: { _id: sprintId, organizationId: orgId, spaceId, isDeleted: false },
  });
  if (!sprint) return next(httpError(404, "Sprint not found"));

  const days = eachDayInclusive(sprint.startDate, sprint.endDate);

  const allSprintTasks = await Task.find({
    organizationId: orgId,
    spaceId,
    sprintId,
    isDeleted: false,
  })
    .select("status createdAt updatedAt")
    .lean();

  const tasksLite = allSprintTasks.map((t) => ({
    status: t.status,
    createdAt: new Date(t.createdAt).getTime(),
    updatedAt: new Date(t.updatedAt).getTime(),
  }));

  const series = days.map((day) => {
    const dayEndTs = endOfDay(day).getTime();

    let scope = 0;
    let completed = 0;

    for (const t of tasksLite) {
      if (t.createdAt <= dayEndTs) scope++;
      if (t.status === "Done" && t.updatedAt <= dayEndTs) completed++;
    }

    return {
      date: day.toISOString().slice(0, 10),
      scope,
      completed,
    };
  });

  const payload = {
    sprint: {
      id: sprint._id,
      name: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
    },
    series,
  };

  cache.set(key, payload);
  return successResponse({ res, data: payload }, 200);
});

// =========================
// BE-8.5 Cumulative Flow (Phase 9 optimized + cached)
// =========================
// Output: array of { date, todo, inProgress, done, scope }
export const cumulativeFlow = asyncHandler(async (req, res, next) => {
  const { orgId, spaceId, sprintId } = req.params;

  await requireOrgMember(orgId, req.user._id);

  const key = cacheKey(["cumulativeFlow", orgId, spaceId, sprintId]);
  const cached = cache.get(key);
  if (cached) return successResponse({ res, data: cached }, 200);

  const sprint = await dbService.findOne({
    model: Sprint,
    filter: { _id: sprintId, organizationId: orgId, spaceId, isDeleted: false },
  });
  if (!sprint) return next(httpError(404, "Sprint not found"));

  const days = eachDayInclusive(sprint.startDate, sprint.endDate);

  const allSprintTasks = await Task.find({
    organizationId: orgId,
    spaceId,
    sprintId,
    isDeleted: false,
  })
    .select("status createdAt updatedAt")
    .lean();

  const tasksLite = allSprintTasks.map((t) => ({
    status: t.status,
    createdAt: new Date(t.createdAt).getTime(),
    updatedAt: new Date(t.updatedAt).getTime(),
  }));

  const series = days.map((day) => {
    const dayEndTs = endOfDay(day).getTime();

    let scope = 0;
    let done = 0;
    let inProgress = 0;

    for (const t of tasksLite) {
      if (t.createdAt <= dayEndTs) scope++;
      if (t.updatedAt > dayEndTs) continue;

      if (t.status === "Done") done++;
      else if (t.status === "InProgress") inProgress++;
    }

    const todo = Math.max(scope - done - inProgress, 0);

    return {
      date: day.toISOString().slice(0, 10),
      todo,
      inProgress,
      done,
      scope,
    };
  });

  const payload = {
    sprint: {
      id: sprint._id,
      name: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
    },
    series,
  };

  cache.set(key, payload);
  return successResponse({ res, data: payload }, 200);
});
