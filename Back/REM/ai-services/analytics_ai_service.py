import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta


def parse_date(value):
    if not value:
        return None
    if isinstance(value, dict) and "$date" in value:
        value = value["$date"]
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def safe_div(a, b):
    return a / b if b else 0.0


# AI-8.1
def sprint_completion(payload):
    sprint = payload.get("sprint", {}) or {}
    tasks = payload.get("tasks", []) or []
    history = payload.get("history", []) or []
    as_of = parse_date(payload.get("asOf")) or datetime.now(timezone.utc)

    start = parse_date(sprint.get("startDate"))
    end = parse_date(sprint.get("endDate"))
    if not start or not end or end <= start:
        return {
            "aiUsed": False,
            "aiModel": "python-analytics-v1",
            "aiFallbackReason": "Invalid sprint date range",
        }

    total_tasks = len(tasks)
    total_points = sum(float(t.get("points", 0) or 0) for t in tasks)
    done_tasks = sum(1 for t in tasks if str(t.get("status")) == "Done")
    done_points = sum(float(t.get("points", 0) or 0) for t in tasks if str(t.get("status")) == "Done")

    duration_hours = (end - start).total_seconds() / 3600.0
    elapsed_hours = max((as_of - start).total_seconds() / 3600.0, 0.0)
    elapsed_ratio = min(max(safe_div(elapsed_hours, duration_hours), 0.0), 1.0)

    current_completion = safe_div(done_points, total_points) if total_points > 0 else safe_div(done_tasks, total_tasks)
    current_completion = min(max(current_completion, 0.0), 1.0)

    pace_projection = safe_div(current_completion, elapsed_ratio) if elapsed_ratio > 0.01 else current_completion
    pace_projection = min(max(pace_projection, 0.0), 1.3)

    hist_points = [float(x.get("completedPoints", 0) or 0) for x in history]
    hist_tasks = [float(x.get("completedTasks", 0) or 0) for x in history]
    avg_hist_points = sum(hist_points) / len(hist_points) if hist_points else 0.0
    avg_hist_tasks = sum(hist_tasks) / len(hist_tasks) if hist_tasks else 0.0

    expected_capacity = avg_hist_points if total_points > 0 else avg_hist_tasks
    required = total_points if total_points > 0 else total_tasks
    capacity_factor = safe_div(expected_capacity, required) if required > 0 else 1.0
    capacity_factor = min(max(capacity_factor, 0.0), 1.5)

    # Weighted prediction:
    predicted_completion_ratio = 0.7 * pace_projection + 0.3 * capacity_factor
    predicted_completion_ratio = min(max(predicted_completion_ratio, 0.0), 1.2)

    predicted_percent = round(predicted_completion_ratio * 100, 2)
    on_track = predicted_completion_ratio >= 0.95
    risk_level = "low" if predicted_completion_ratio >= 1.0 else "medium" if predicted_completion_ratio >= 0.85 else "high"

    remaining_ratio = max(1.0 - current_completion, 0.0)
    burn_rate = safe_div(current_completion, elapsed_hours) if elapsed_hours > 1 else 0.0
    hours_needed = safe_div(remaining_ratio, burn_rate) if burn_rate > 0 else float("inf")
    projected_finish = None
    if math.isfinite(hours_needed):
        projected_finish = (as_of + timedelta(hours=hours_needed)).isoformat()

    reasons = []
    if elapsed_ratio > 0:
        reasons.append(f"elapsed:{round(elapsed_ratio*100,2)}%")
    reasons.append(f"current_completion:{round(current_completion*100,2)}%")
    if history:
        reasons.append(f"history_sprints:{len(history)}")
    if risk_level == "high":
        reasons.append("pace below target")

    return {
        "aiUsed": True,
        "aiModel": "python-analytics-v1",
        "aiFallbackReason": None,
        "prediction": {
            "predictedCompletionPercent": predicted_percent,
            "currentCompletionPercent": round(current_completion * 100, 2),
            "onTrack": on_track,
            "riskLevel": risk_level,
            "projectedFinishAt": projected_finish,
            "reasons": reasons,
        },
        "meta": {
            "totalTasks": total_tasks,
            "doneTasks": done_tasks,
            "totalPoints": total_points,
            "donePoints": done_points,
            "elapsedPercent": round(elapsed_ratio * 100, 2),
        },
    }


# AI-8.2
def bottleneck_detection(payload):
    tasks = payload.get("tasks", []) or []
    now = parse_date(payload.get("asOf")) or datetime.now(timezone.utc)

    assignee_in_progress = Counter()
    stale_in_progress = []
    overdue = []
    by_status = Counter()
    by_type = Counter()

    assignee_total = Counter()
    for t in tasks:
        status = str(t.get("status", "Todo"))
        by_status[status] += 1
        by_type[str(t.get("type", "Task"))] += 1

        aid = str(t.get("assigneeId")) if t.get("assigneeId") is not None else "unassigned"
        assignee_total[aid] += 1

        updated = parse_date(t.get("updatedAt"))
        due = parse_date(t.get("dueDate"))

        if status == "InProgress":
            assignee_in_progress[aid] += 1
            if updated:
                age_days = (now - updated).total_seconds() / 86400.0
                if age_days >= 5:
                    stale_in_progress.append(
                        {
                            "taskId": str(t.get("_id")),
                            "title": t.get("title"),
                            "assigneeId": aid,
                            "ageDays": round(age_days, 2),
                        }
                    )

        if due and due < now and status != "Done":
            overdue.append(
                {
                    "taskId": str(t.get("_id")),
                    "title": t.get("title"),
                    "assigneeId": aid,
                    "status": status,
                    "dueDate": due.isoformat(),
                }
            )

    total = len(tasks)
    in_progress = by_status.get("InProgress", 0)
    todo = by_status.get("Todo", 0)
    done = by_status.get("Done", 0)

    bottlenecks = []

    if total > 0 and todo > in_progress * 2 and in_progress > 0:
        bottlenecks.append(
            {
                "type": "queue_congestion",
                "severity": "medium",
                "message": "Todo queue is much larger than active work.",
                "metrics": {"todo": todo, "inProgress": in_progress},
            }
        )

    if stale_in_progress:
        bottlenecks.append(
            {
                "type": "stale_in_progress",
                "severity": "high" if len(stale_in_progress) >= 3 else "medium",
                "message": "Some in-progress tasks are stale.",
                "count": len(stale_in_progress),
                "sample": stale_in_progress[:10],
            }
        )

    if overdue:
        bottlenecks.append(
            {
                "type": "overdue_work",
                "severity": "high" if len(overdue) >= 3 else "medium",
                "message": "There are overdue unfinished tasks.",
                "count": len(overdue),
                "sample": overdue[:10],
            }
        )

    overloaded = [
        {"assigneeId": aid, "inProgress": c, "total": assignee_total.get(aid, 0)}
        for aid, c in assignee_in_progress.items()
        if c >= 4
    ]
    if overloaded:
        bottlenecks.append(
            {
                "type": "assignee_overload",
                "severity": "medium",
                "message": "One or more assignees have too many in-progress tasks.",
                "assignees": overloaded,
            }
        )

    bug_ratio = safe_div(by_type.get("Bug", 0), total)
    if bug_ratio >= 0.35 and total >= 8:
        bottlenecks.append(
            {
                "type": "quality_pressure",
                "severity": "medium",
                "message": "High bug ratio may be slowing delivery.",
                "metrics": {"bugRatioPercent": round(bug_ratio * 100, 2)},
            }
        )

    return {
        "aiUsed": True,
        "aiModel": "python-analytics-v1",
        "aiFallbackReason": None,
        "summary": {
            "totalTasks": total,
            "todo": todo,
            "inProgress": in_progress,
            "done": done,
            "overdueCount": len(overdue),
            "staleInProgressCount": len(stale_in_progress),
            "bottleneckCount": len(bottlenecks),
        },
        "bottlenecks": bottlenecks,
    }


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}

    try:
        if command == "sprint_completion":
            out = sprint_completion(payload)
        elif command == "bottleneck_detection":
            out = bottleneck_detection(payload)
        else:
            out = {"aiUsed": False, "aiModel": "python-analytics-v1", "aiFallbackReason": "Unknown command"}
    except Exception as exc:
        out = {"aiUsed": False, "aiModel": "python-analytics-v1", "aiFallbackReason": str(exc)}

    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
