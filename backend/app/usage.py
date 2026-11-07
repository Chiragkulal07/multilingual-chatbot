from datetime import datetime

from app.database import get_conn


def _today() -> str:
    return datetime.now().date().isoformat()  # your local date


def calls_today() -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT calls FROM gemini_usage WHERE day = ?", (_today(),)).fetchone()
    return row["calls"] if row else 0


def record_call() -> int:
    day = _today()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO gemini_usage (day, calls) VALUES (?, 1) "
            "ON CONFLICT(day) DO UPDATE SET calls = calls + 1",
            (day,),
        )
        return conn.execute("SELECT calls FROM gemini_usage WHERE day = ?", (day,)).fetchone()["calls"]
