from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import pytesseract
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from PIL import Image


AI_MODEL = "fastapi-screenshot-ocr-v1"

app = FastAPI(
    title="REM Screenshot Analysis Service",
    version="1.0.0",
)


class ScreenshotAnalysisRequest(BaseModel):
    image_url: str = Field(..., min_length=1)
    captured_at: Optional[datetime] = None
    filename: Optional[str] = None
    tesseract_cmd: Optional[str] = None


class ScreenshotAnalysisResponse(BaseModel):
    aiUsed: bool
    aiModel: str
    aiFallbackReason: Optional[str] = None
    app: str
    category: str
    confidence: float
    textLength: int
    textSample: str
    analyzedAt: datetime


def detect_app_from_text(text: str) -> tuple[str, str]:
    t = text.lower()

    for p, v in {
        "deepseek": ("DeepSeek AI", "Productive"),
        "chatgpt": ("ChatGPT", "Productive"),
        "claude": ("Claude AI", "Productive"),
        "gemini": ("Google Gemini", "Productive"),
        "copilot": ("GitHub Copilot", "Productive"),
    }.items():
        if p in t:
            return v

    for p, v in {
        "coursera": ("Coursera", "Productive"),
        "udemy": ("Udemy", "Productive"),
        "kaggle": ("Kaggle", "Productive"),
        "stack overflow": ("Stack Overflow", "Productive"),
        "github": ("GitHub", "Productive"),
        "gitlab": ("GitLab", "Productive"),
        "medium.com": ("Medium", "Productive"),
        "towards data science": ("Towards Data Science", "Productive"),
    }.items():
        if p in t:
            return v

    if "youtube" in t or "youtu.be" in t:
        educational = [
            "tutorial",
            "course",
            "lecture",
            "learn",
            "programming",
            "coding",
            "python",
            "javascript",
            "data science",
            "algorithm",
        ]
        if any(word in t for word in educational):
            return "YouTube (Educational)", "Productive"
        return "YouTube", "Distracting"

    for p, v in {
        "netflix": ("Netflix", "Distracting"),
        "spotify": ("Spotify", "Distracting"),
        "tiktok": ("TikTok", "Distracting"),
        "instagram": ("Instagram", "Distracting"),
        "facebook": ("Facebook", "Distracting"),
        "twitter": ("Twitter/X", "Distracting"),
        "x.com": ("Twitter/X", "Distracting"),
        "discord": ("Discord", "Distracting"),
        "twitch": ("Twitch", "Distracting"),
        "reddit": ("Reddit", "Distracting"),
    }.items():
        if p in t:
            return v

    for p, v in {
        "pycharm": ("PyCharm", "Productive"),
        "visual studio": ("Visual Studio", "Productive"),
        "vscode": ("VS Code", "Productive"),
        "code": ("VS Code", "Productive"),
        "intellij": ("IntelliJ IDEA", "Productive"),
        "android studio": ("Android Studio", "Productive"),
        "xcode": ("Xcode", "Productive"),
        "eclipse": ("Eclipse", "Productive"),
        "netbeans": ("NetBeans", "Productive"),
        "sublime": ("Sublime Text", "Productive"),
        "atom": ("Atom", "Productive"),
        "jupyter": ("Jupyter Notebook", "Productive"),
        "colab": ("Google Colab", "Productive"),
        "spyder": ("Spyder", "Productive"),
        "rstudio": ("RStudio", "Productive"),
        "terminal": ("Terminal", "Productive"),
        "cmd": ("Command Prompt", "Productive"),
        "powershell": ("PowerShell", "Productive"),
        "bash": ("Bash", "Productive"),
    }.items():
        if p in t:
            return v

    for p, name in {
        "chrome": "Google Chrome",
        "firefox": "Mozilla Firefox",
        "edge": "Microsoft Edge",
        "safari": "Safari",
        "opera": "Opera",
        "brave": "Brave",
    }.items():
        if p in t:
            entertainment = [
                "youtube",
                "netflix",
                "facebook",
                "instagram",
                "tiktok",
                "twitter",
                "reddit",
            ]
            work = [
                "github",
                "stack overflow",
                "docs",
                "tutorial",
                "course",
                "documentation",
                "learn",
                "coding",
                "programming",
            ]
            if any(word in t for word in entertainment):
                return f"{name} (Entertainment)", "Distracting"
            if any(word in t for word in work):
                return f"{name} (Work/Learning)", "Productive"
            return name, "Neutral"

    for p, v in {
        "word": ("Microsoft Word", "Productive"),
        "excel": ("Microsoft Excel", "Productive"),
        "powerpoint": ("Microsoft PowerPoint", "Productive"),
        "outlook": ("Microsoft Outlook", "Productive"),
        "onenote": ("Microsoft OneNote", "Productive"),
        "teams": ("Microsoft Teams", "Productive"),
        "slack": ("Slack", "Productive"),
        "zoom": ("Zoom", "Productive"),
        "meet": ("Google Meet", "Productive"),
        "pdf": ("PDF Reader", "Productive"),
        "acrobat": ("Adobe Acrobat", "Productive"),
    }.items():
        if p in t:
            return v

    if len(text.strip()) < 20:
        lock_words = ["lock", "password", "sign in", "login", "windows", "welcome"]
        if any(word in t for word in lock_words):
            return "Lock Screen", "Idle"
        return "Idle (Minimal Activity)", "Idle"

    work_words = [
        "project",
        "report",
        "analysis",
        "data",
        "code",
        "function",
        "algorithm",
        "database",
        "server",
        "api",
        "document",
        "meeting",
        "presentation",
        "spreadsheet",
        "email",
        "message",
    ]
    if any(word in t for word in work_words):
        return "Unknown (Work-related)", "Productive"

    return "Unknown", "Distracting"


def _load_image(image_url: str) -> Image.Image:
    parsed = urlparse(image_url)
    if parsed.scheme in {"http", "https"}:
        request = Request(image_url, headers={"User-Agent": "REM-Screenshot-AI/1.0"})
        with urlopen(request, timeout=15) as response:
            return Image.open(BytesIO(response.read())).convert("RGB")

    path = Path(image_url)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {image_url}")
    return Image.open(path).convert("RGB")


@app.get("/healthz")
def healthz():
    return {"success": True, "message": "OK", "model": AI_MODEL}


@app.post("/analyze-screenshot", response_model=ScreenshotAnalysisResponse)
def analyze_screenshot(payload: ScreenshotAnalysisRequest):
    if payload.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = payload.tesseract_cmd

    try:
        image = _load_image(payload.image_url)
        text = pytesseract.image_to_string(image)
        app_name, category = detect_app_from_text(text)

        if "deepseek" in text.lower() and "youtube" in text.lower():
            app_name, category = "DeepSeek AI (with YouTube)", "Productive"

        stripped = text.strip()
        return ScreenshotAnalysisResponse(
            aiUsed=True,
            aiModel=AI_MODEL,
            app=app_name,
            category=category,
            confidence=min(len(stripped) / 500, 1.0),
            textLength=len(stripped),
            textSample=stripped[:500],
            analyzedAt=datetime.now(timezone.utc),
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
