import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone


def parse_date(value):
    if not value:
        return None
    if isinstance(value, dict) and "$date" in value:
        value = value["$date"]
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def parse_id(value):
    if isinstance(value, dict) and "$oid" in value:
        return str(value["$oid"])
    if value is None:
        return None
    return str(value)


def clamp(x, lo=0.0, hi=100.0):
    return max(lo, min(hi, x))


def recency_bonus(updated_at, now):
    dt = parse_date(updated_at)
    if not dt:
        return 0.0
    hours = max((now - dt).total_seconds() / 3600.0, 0.0)
    if hours <= 24:
        return 12.0
    if hours <= 72:
        return 7.0
    if hours <= 168:
        return 3.0
    return 0.0


# AI-6.1
def basic_relevance_score(task, now):
    priority = str(task.get("priority", "Low"))
    status = str(task.get("status", "Todo"))

    priority_map = {"Urgent": 40, "High": 30, "Medium": 18, "Low": 8}
    status_map = {"InProgress": 24, "Todo": 14, "Done": -35}

    score = priority_map.get(priority, 8) + status_map.get(status, 8)
    score += recency_bonus(task.get("updatedAt"), now)

    return clamp(score + 20)


# AI-6.4
def time_urgency_score(task, now):
    due = parse_date(task.get("dueDate"))
    if not due:
        return 5.0

    diff_days = (due - now).total_seconds() / 86400.0
    if diff_days < 0:
        return 100.0
    if diff_days <= 1:
        return 90.0
    if diff_days <= 3:
        return 75.0
    if diff_days <= 7:
        return 55.0
    if diff_days <= 14:
        return 35.0
    return 15.0


def build_user_profile(tasks):
    by_type = Counter()
    by_priority = Counter()
    by_label = Counter()
    by_space = Counter()

    completion_samples = []

    for t in tasks:
        ttype = str(t.get("type", "Task"))
        pr = str(t.get("priority", "Low"))
        status = str(t.get("status", "Todo"))
        space_id = parse_id(t.get("spaceId"))

        by_type[ttype] += 1
        by_priority[pr] += 1
        if space_id:
            by_space[space_id] += 1

        for lb in t.get("labels") or []:
            by_label[str(lb).lower()] += 1

        if status == "Done":
            created = parse_date(t.get("createdAt"))
            updated = parse_date(t.get("updatedAt"))
            if created and updated and updated >= created:
                completion_samples.append((updated - created).total_seconds() / 3600.0)

    return {
        "by_type": by_type,
        "by_priority": by_priority,
        "by_label": by_label,
        "by_space": by_space,
        "completion_samples": completion_samples,
    }


# AI-6.2
def user_behavior_score(task, profile):
    score = 0.0
    by_type = profile["by_type"]
    by_priority = profile["by_priority"]
    by_label = profile["by_label"]

    total_type = sum(by_type.values()) or 1
    total_priority = sum(by_priority.values()) or 1
    total_label = sum(by_label.values()) or 1

    ttype = str(task.get("type", "Task"))
    pr = str(task.get("priority", "Low"))

    score += 35.0 * (by_type.get(ttype, 0) / total_type)
    score += 25.0 * (by_priority.get(pr, 0) / total_priority)

    labels = [str(x).lower() for x in (task.get("labels") or [])]
    if labels:
        label_fit = max((by_label.get(lb, 0) / total_label) for lb in labels)
        score += 40.0 * label_fit
    else:
        score += 5.0

    return clamp(score)


# AI-6.3
def collaborative_filter_score(task, team_tasks, user_profile):
    if not team_tasks:
        return 10.0

    team_type = Counter()
    team_label = Counter()
    team_space = Counter()
    for t in team_tasks:
        team_type[str(t.get("type", "Task"))] += 1
        sid = parse_id(t.get("spaceId"))
        if sid:
            team_space[sid] += 1
        for lb in t.get("labels") or []:
            team_label[str(lb).lower()] += 1

    total_team_type = sum(team_type.values()) or 1
    total_team_label = sum(team_label.values()) or 1
    total_team_space = sum(team_space.values()) or 1

    ttype = str(task.get("type", "Task"))
    space_id = parse_id(task.get("spaceId"))
    labels = [str(x).lower() for x in (task.get("labels") or [])]

    type_fit = team_type.get(ttype, 0) / total_team_type
    space_fit = (team_space.get(space_id, 0) / total_team_space) if space_id else 0.0
    label_fit = max((team_label.get(lb, 0) / total_team_label) for lb in labels) if labels else 0.0

    # Novelty: prefer team signal that user does less often.
    user_type_count = user_profile["by_type"].get(ttype, 0)
    novelty = 1.0 / (1.0 + user_type_count)

    score = 45.0 * type_fit + 30.0 * label_fit + 20.0 * space_fit + 20.0 * novelty
    return clamp(score)


# AI-6.5
def project_affinity_score(task, profile):
    by_space = profile["by_space"]
    total_space = sum(by_space.values()) or 1
    sid = parse_id(task.get("spaceId"))
    space_fit = (by_space.get(sid, 0) / total_space) if sid else 0.0

    # Mild bonus if task has parent epic/story (deeper project context)
    has_parent = task.get("parentTaskId") is not None
    parent_bonus = 12.0 if has_parent else 0.0

    return clamp(20.0 + 70.0 * space_fit + parent_bonus)


def explain_components(components):
    labels = {
        "relevance": "AI-6.1 relevance",
        "behavior": "AI-6.2 behavior",
        "collab": "AI-6.3 collaborative",
        "urgency": "AI-6.4 urgency",
        "affinity": "AI-6.5 affinity",
    }
    top = sorted(components.items(), key=lambda kv: kv[1], reverse=True)[:2]
    return ", ".join(labels[k] for k, _ in top)


def for_you_v2(payload):
    scored = payload.get("scored", []) or []
    limit = int(payload.get("limit", 15))
    user_history = payload.get("userHistory", []) or []
    team_history = payload.get("teamHistory", []) or []

    now = datetime.now(timezone.utc)
    user_profile = build_user_profile(user_history)

    ranked = []
    for row in scored:
        task = row.get("task", {}) or {}
        base_rule = float(row.get("score", 0) or 0)

        c_relevance = basic_relevance_score(task, now)
        c_behavior = user_behavior_score(task, user_profile)
        c_collab = collaborative_filter_score(task, team_history, user_profile)
        c_urgency = time_urgency_score(task, now)
        c_affinity = project_affinity_score(task, user_profile)

        # Weighted blend of AI-6.1..AI-6.5
        ai_score = (
            0.22 * c_relevance
            + 0.20 * c_behavior
            + 0.18 * c_collab
            + 0.25 * c_urgency
            + 0.15 * c_affinity
        )

        final_score = round(base_rule * 0.35 + ai_score * 0.65, 2)
        components = {
            "relevance": round(c_relevance, 2),
            "behavior": round(c_behavior, 2),
            "collab": round(c_collab, 2),
            "urgency": round(c_urgency, 2),
            "affinity": round(c_affinity, 2),
        }

        out = dict(row)
        out["score"] = final_score
        out["aiScore"] = round(ai_score, 2)
        out["aiReason"] = explain_components(components)
        out["aiBreakdown"] = components
        ranked.append(out)

    ranked.sort(key=lambda x: float(x.get("score", 0) or 0), reverse=True)

    return {
        "aiUsed": True,
        "aiModel": "python-heuristic-v1",
        "aiFallbackReason": None,
        "items": ranked[:limit],
    }


def worked_on(payload):
    items = payload.get("items", []) or []
    now = datetime.now(timezone.utc)
    notes = []
    for t in items[:60]:
        task_id = parse_id(t.get("_id"))
        status = str(t.get("status", "Todo"))
        urgency = time_urgency_score(t, now)
        relevance = basic_relevance_score(t, now)
        score = round(0.55 * urgency + 0.45 * relevance, 2)

        if status == "Done":
            note = "Completed recently; keep for context."
        elif urgency >= 75:
            note = "High urgency due date; prioritize next."
        elif relevance >= 65:
            note = "Strong personal relevance based on activity."
        else:
            note = "Moderate relevance; schedule when free."

        notes.append({"id": task_id, "score": score, "note": note})

    return {
        "aiUsed": True,
        "aiModel": "python-heuristic-v1",
        "aiFallbackReason": None,
        "notes": notes,
    }


def for_you_legacy(payload):
    # Backward command alias
    return for_you_v2(payload)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}

    try:
        if command == "for_you_v2":
            out = for_you_v2(payload)
        elif command == "for_you":
            out = for_you_legacy(payload)
        elif command == "worked_on":
            out = worked_on(payload)
        else:
            out = {
                "aiUsed": False,
                "aiModel": None,
                "aiFallbackReason": "Unknown command",
            }
    except Exception as exc:
        out = {
            "aiUsed": False,
            "aiModel": "python-heuristic-v1",
            "aiFallbackReason": str(exc),
        }

    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
