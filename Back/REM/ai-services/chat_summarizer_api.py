from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


def _model_source(env_name: str, default_model: str) -> str:
    configured = os.getenv(env_name)
    if configured:
        configured_path = Path(configured)
        if configured_path.exists():
            return str(configured_path) if (configured_path / "config.json").exists() else default_model
        return configured

    local_dir = Path(__file__).resolve().parent / "models" / default_model.split("/")[-1]
    if (local_dir / "config.json").exists():
        return str(local_dir)
    return default_model


_TRANSLATION_MODEL_SOURCE = _model_source(
    "TRANSLATION_MODEL_PATH",
    "Helsinki-NLP/opus-mt-ar-en",
)
_SUMMARY_MODEL_SOURCE = _model_source(
    "SUMMARY_MODEL_PATH",
    "facebook/bart-large-cnn",
)

_ARABIC_CHAR_RE = re.compile(r"[\u0600-\u06FF]")
_translation_pipeline_cache: Dict[str, Any] = {}
_summary_pipeline_cache: Dict[str, Any] = {}
_voice_whisper_cache: Dict[str, Any] = {}
_CHUNK_CHAR_LIMIT = 3000
_VOICE_WHISPER_MODEL = os.getenv("VOICE_WHISPER_MODEL", "medium")
_VOICE_WHISPER_DEVICE = os.getenv("VOICE_WHISPER_DEVICE", "cpu")
_VOICE_WHISPER_COMPUTE_TYPE = os.getenv("VOICE_WHISPER_COMPUTE_TYPE", "int8")


def _first_value(record: Dict[str, Any], paths: List[tuple]) -> Any:
    for path in paths:
        current: Any = record
        found = True
        for part in path:
            if not isinstance(current, dict) or part not in current:
                found = False
                break
            current = current[part]
        if found and current not in (None, ""):
            return current
    return ""


def _attachment_url(record: Dict[str, Any], expected_types: set[str]) -> str:
    attachments = record.get("attachments") or record.get("files") or []
    if isinstance(attachments, dict):
        attachments = [attachments]
    if not isinstance(attachments, list):
        return ""

    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        attachment_type = str(
            attachment.get("type")
            or attachment.get("messageType")
            or attachment.get("kind")
            or ""
        ).lower()
        mime_type = str(
            attachment.get("mimeType")
            or attachment.get("mimetype")
            or attachment.get("mime")
            or ""
        ).lower()
        if attachment_type not in expected_types and not any(
            mime_type.startswith(f"{expected_type}/") for expected_type in expected_types
        ):
            continue
        url = _first_value(
            attachment,
            [
                ("url",),
                ("secure_url",),
                ("secureUrl",),
                ("fileUrl",),
                ("file_url",),
                ("src",),
            ],
        )
        if url:
            return str(url).strip()
    return ""


def _normalize_record(record: Dict[str, Any]) -> Dict[str, str]:
    channel = _first_value(
        record,
        [
            ("channel",),
            ("channel_name",),
            ("room",),
            ("room_name",),
            ("conversation",),
            ("conversation_name",),
            ("chat",),
            ("chat_name",),
            ("channel", "name"),
            ("room", "name"),
            ("conversation", "name"),
            ("chat", "name"),
        ],
    )
    user = _first_value(
        record,
        [
            ("user",),
            ("username",),
            ("sender",),
            ("author",),
            ("member",),
            ("from",),
            ("user", "name"),
            ("sender", "name"),
            ("author", "name"),
            ("member", "name"),
            ("from", "name"),
        ],
    )
    text = _first_value(
        record,
        [
            ("text",),
            ("message",),
            ("content",),
            ("body",),
            ("text", "content"),
            ("message", "text"),
            ("content", "text"),
        ],
    )
    audio_url = _first_value(
        record,
        [
            ("audio_url",),
            ("audioUrl",),
            ("voice_url",),
            ("voiceUrl",),
            ("attachment_url",),
            ("attachmentUrl",),
        ],
    )
    if not audio_url:
        audio_url = _attachment_url(record, {"audio", "voice"})
    image_url = _first_value(
        record,
        [
            ("image_url",),
            ("imageUrl",),
            ("screenshot_url",),
            ("screenshotUrl",),
        ],
    )
    if not image_url:
        image_url = _attachment_url(record, {"image"})
    ts = _first_value(
        record,
        [
            ("ts",),
            ("timestamp",),
            ("time",),
            ("date",),
            ("created_at",),
            ("createdAt",),
            ("sent_at",),
            ("sentAt",),
            ("datetime",),
        ],
    )
    return {
        "channel": str(channel).strip() or "unknown",
        "user": str(user).strip() or "unknown",
        "text": str(text).strip(),
        "audio_url": str(audio_url).strip(),
        "image_url": str(image_url).strip(),
        "ts": str(ts).strip(),
    }


def _contains_arabic(text: str) -> bool:
    return bool(_ARABIC_CHAR_RE.search(text or ""))


def _load_translation_pipeline():
    if _TRANSLATION_MODEL_SOURCE in _translation_pipeline_cache:
        return _translation_pipeline_cache[_TRANSLATION_MODEL_SOURCE]
    from transformers import pipeline

    pipe = pipeline("translation", model=_TRANSLATION_MODEL_SOURCE)
    _translation_pipeline_cache[_TRANSLATION_MODEL_SOURCE] = pipe
    return pipe


def translate_batch(texts: List[str], batch_size: int = 8, max_length: int = 256) -> List[str]:
    results: List[str] = [""] * len(texts)
    arabic_indices: List[int] = []
    arabic_texts: List[str] = []

    for index, raw in enumerate(texts):
        text = (raw or "").strip()
        if not text:
            results[index] = ""
        elif _contains_arabic(text):
            arabic_indices.append(index)
            arabic_texts.append(text[:1000])
        else:
            results[index] = text

    if arabic_texts:
        pipe = _load_translation_pipeline()
        outputs = pipe(arabic_texts, batch_size=batch_size, max_length=max_length, truncation=True)
        for index, output in zip(arabic_indices, outputs):
            results[index] = output["translation_text"].strip()

    return results


def _load_summary_pipeline():
    if _SUMMARY_MODEL_SOURCE in _summary_pipeline_cache:
        return _summary_pipeline_cache[_SUMMARY_MODEL_SOURCE]
    from transformers import pipeline

    pipe = pipeline("summarization", model=_SUMMARY_MODEL_SOURCE)
    _summary_pipeline_cache[_SUMMARY_MODEL_SOURCE] = pipe
    return pipe


def _chunk_lines(text: str, max_chars: int = _CHUNK_CHAR_LIMIT) -> List[str]:
    lines = text.splitlines()
    chunks: List[str] = []
    current: List[str] = []
    current_len = 0
    for line in lines:
        if current and current_len + len(line) + 1 > max_chars:
            chunks.append("\n".join(current))
            current, current_len = [], 0
        current.append(line)
        current_len += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def summarize_text(text: str, max_length: int = 150, min_length: int = 30) -> str:
    text = (text or "").strip()
    if not text:
        return ""

    pipe = _load_summary_pipeline()
    chunks = _chunk_lines(text)

    if len(chunks) == 1:
        out = pipe(chunks[0], max_length=max_length, min_length=min_length, truncation=True)
        return out[0]["summary_text"].strip()

    partial_summaries = []
    for chunk in chunks:
        out = pipe(chunk, max_length=120, min_length=20, truncation=True)
        partial_summaries.append(out[0]["summary_text"].strip())

    combined = " ".join(partial_summaries)
    final = pipe(combined, max_length=max_length, min_length=min_length, truncation=True)
    return final[0]["summary_text"].strip()


def _load_voice_whisper_model():
    cache_key = f"{_VOICE_WHISPER_MODEL}:{_VOICE_WHISPER_DEVICE}:{_VOICE_WHISPER_COMPUTE_TYPE}"
    if cache_key in _voice_whisper_cache:
        return _voice_whisper_cache[cache_key]
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="faster-whisper is not installed. Run: pip install -r ai-services/requirements.txt",
        ) from exc

    model = WhisperModel(
        _VOICE_WHISPER_MODEL,
        device=_VOICE_WHISPER_DEVICE,
        compute_type=_VOICE_WHISPER_COMPUTE_TYPE,
        download_root=str(Path(__file__).resolve().parent / "models"),
    )
    _voice_whisper_cache[cache_key] = model
    return model


def _download_audio_to_temp(audio_url: str) -> Path:
    parsed = urlparse(audio_url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Voice summary audio URLs must be http(s) URLs.")

    suffix = Path(parsed.path).suffix or ".audio"
    request = Request(audio_url, headers={"User-Agent": "REM-chat-summarizer/1.0"})
    with urlopen(request, timeout=60) as response:
        data = response.read(50 * 1024 * 1024)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        return Path(tmp.name)
    finally:
        tmp.close()


def _transcribe_voice_audio(audio_path: Path) -> tuple[str, str]:
    model = _load_voice_whisper_model()
    segments, info = model.transcribe(
        str(audio_path),
        task="transcribe",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    parts = [(seg.text or "").strip() for seg in segments]
    return " ".join(part for part in parts if part), getattr(info, "language", "unknown")


def analyze_voice_message(audio_url: str, user: str, ts: str) -> Dict[str, Any]:
    try:
        from voice_emotion_streamlit import analyse_voice_features, conclude_emotional_state
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="Voice emotion analysis module is unavailable.",
        ) from exc

    audio_path = _download_audio_to_temp(audio_url)
    try:
        transcript, language = _transcribe_voice_audio(audio_path)
        translated = translate_batch([transcript])[0] if transcript else ""
        features = analyse_voice_features(audio_path, transcript=transcript)
        result: Dict[str, Any] = {
            "user": user,
            "ts": ts,
            "audio_url": audio_url,
            "language": language,
            "transcript": transcript,
            "translated_transcript": translated,
            "features": features,
        }
        if "error" not in features:
            state, _, _, verdict, confidence, votes = conclude_emotional_state(features)
            result["emotion"] = {
                "label": state,
                "confidence": confidence,
                "verdict": verdict,
                "votes": votes,
            }
        return result
    finally:
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            pass


def analyze_image_message(image_url: str, user: str, ts: str) -> Dict[str, Any]:
    try:
        import pytesseract
        from screenshot_analysis_api import _load_image, detect_app_from_text
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="Image OCR dependencies are unavailable. Run: pip install -r ai-services/requirements.txt",
        ) from exc

    tesseract_cmd = os.getenv("TESSERACT_CMD")
    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

    try:
        image = _load_image(image_url)
        text = pytesseract.image_to_string(image).strip()
        app_name, category = detect_app_from_text(text)
        return {
            "user": user,
            "ts": ts,
            "image_url": image_url,
            "text": text,
            "text_length": len(text),
            "text_sample": text[:500],
            "app": app_name,
            "category": category,
            "confidence": min(len(text) / 500, 1.0),
        }
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Image OCR failed: {exc}") from exc


class SummarizeRequest(BaseModel):
    messages: Optional[List[Dict[str, Any]]] = Field(default=None)
    jsonl_text: Optional[str] = Field(default=None)
    channel: Optional[str] = Field(default=None)
    window: Optional[str] = Field(default=None, description="'day' or 'week'")
    max_summary_length: int = Field(default=150, ge=20, le=400)
    min_summary_length: int = Field(default=30, ge=5, le=200)
    include_voice_analysis: bool = Field(default=True)
    include_image_ocr: bool = Field(default=True)


class ChannelResult(BaseModel):
    channel: str
    message_count: int
    summary: str
    voice_analyses: List[Dict[str, Any]] = Field(default_factory=list)
    image_ocr: List[Dict[str, Any]] = Field(default_factory=list)


class SummarizeResponse(BaseModel):
    since_utc: Optional[str] = None
    now_utc: Optional[str] = None
    channels: List[ChannelResult]
    overall_summary: str
    voice_analyses: List[Dict[str, Any]] = Field(default_factory=list)
    image_ocr: List[Dict[str, Any]] = Field(default_factory=list)


class TranslateRequest(BaseModel):
    text: str


class TranslateResponse(BaseModel):
    original: str
    translated: str


def _rows_from_request(req: SummarizeRequest) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if req.messages:
        rows.extend(req.messages)
    if req.jsonl_text:
        for line in req.jsonl_text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"Invalid JSONL line: {exc}") from exc
    if not rows:
        raise HTTPException(status_code=400, detail="Provide `messages` or `jsonl_text`.")
    return rows


def _build_dataframe(rows: List[Dict[str, Any]]) -> pd.DataFrame:
    normalized = [_normalize_record(row) for row in rows if isinstance(row, dict)]
    df = pd.DataFrame(normalized)
    for column in ["channel", "ts", "user", "text"]:
        if column not in df.columns:
            df[column] = ""
    if "audio_url" not in df.columns:
        df["audio_url"] = ""
    if "image_url" not in df.columns:
        df["image_url"] = ""

    df["ts"] = pd.to_datetime(df["ts"], errors="coerce", utc=True)
    df = df.dropna(subset=["ts"])
    if df.empty:
        raise HTTPException(
            status_code=400,
            detail="No valid rows after parsing. Check that each message has a parseable `ts` field.",
        )
    return df.sort_values(["channel", "ts"]).reset_index(drop=True)


def _apply_window(df: pd.DataFrame, window: Optional[str]):
    if not window:
        return df, None, None
    if window not in ("day", "week"):
        raise HTTPException(status_code=400, detail="`window` must be 'day' or 'week'.")

    now_utc = df["ts"].max()
    since_utc = now_utc - timedelta(days=1 if window == "day" else 7)
    out = df[df["ts"] >= since_utc].copy()
    return out.sort_values(["channel", "ts"]).reset_index(drop=True), since_utc, now_utc


app = FastAPI(
    title="Arabic/English Chat Summarizer",
    description="Translates Arabic chat text to English locally and returns channel summaries.",
    version="1.0.0",
)


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {
        "status": "ok",
        "translation_model": _TRANSLATION_MODEL_SOURCE,
        "summary_model": _SUMMARY_MODEL_SOURCE,
    }


@app.post("/translate", response_model=TranslateResponse)
def translate_endpoint(req: TranslateRequest) -> TranslateResponse:
    translated = translate_batch([req.text])[0]
    return TranslateResponse(original=req.text, translated=translated)


@app.post("/summarize", response_model=SummarizeResponse)
def summarize(req: SummarizeRequest) -> SummarizeResponse:
    rows = _rows_from_request(req)
    df = _build_dataframe(rows)
    df, since_utc, now_utc = _apply_window(df, req.window)

    if req.channel:
        df = df[df["channel"] == req.channel]
        if df.empty:
            raise HTTPException(status_code=404, detail=f"No messages found for channel '{req.channel}'.")

    if df.empty:
        raise HTTPException(status_code=400, detail="No messages left after filtering.")

    channel_results: List[ChannelResult] = []
    all_translated_lines: List[str] = []
    all_voice_analyses: List[Dict[str, Any]] = []
    all_image_ocr: List[Dict[str, Any]] = []

    for channel_name, group in df.groupby("channel", sort=True):
        group = group.sort_values("ts")
        users = group["user"].fillna("Unknown").astype(str).tolist()
        texts = group["text"].fillna("").astype(str).tolist()
        translated_texts = translate_batch(texts)

        lines = [f"{user}: {text}" for user, text in zip(users, translated_texts) if text.strip()]

        voice_analyses: List[Dict[str, Any]] = []
        if req.include_voice_analysis:
            for record in group.to_dict("records"):
                audio_url = str(record.get("audio_url") or "").strip()
                if not audio_url:
                    continue
                analysis = analyze_voice_message(
                    audio_url=audio_url,
                    user=str(record.get("user") or "unknown"),
                    ts=str(record.get("ts") or ""),
                )
                voice_analyses.append(analysis)
                all_voice_analyses.append(analysis)
                voice_text = analysis.get("translated_transcript") or analysis.get("transcript") or ""
                emotion = analysis.get("emotion") or {}
                emotion_label = emotion.get("label", "Unknown")
                confidence = emotion.get("confidence", "Unknown")
                verdict = emotion.get("verdict", "")
                lines.append(
                    f"{analysis['user']} voice message: {voice_text} "
                    f"[Acoustic emotion: {emotion_label}, confidence: {confidence}. {verdict}]"
                )

        image_ocr: List[Dict[str, Any]] = []
        if req.include_image_ocr:
            for record in group.to_dict("records"):
                image_url = str(record.get("image_url") or "").strip()
                if not image_url:
                    continue
                analysis = analyze_image_message(
                    image_url=image_url,
                    user=str(record.get("user") or "unknown"),
                    ts=str(record.get("ts") or ""),
                )
                image_ocr.append(analysis)
                all_image_ocr.append(analysis)
                ocr_text = analysis.get("text", "")
                if ocr_text:
                    lines.append(
                        f"{analysis['user']} image attachment OCR: {ocr_text} "
                        f"[Detected app/context: {analysis.get('app', 'Unknown')}; "
                        f"category: {analysis.get('category', 'Unknown')}]"
                    )

        all_translated_lines.extend(lines)
        transcript = "\n".join(lines)

        summary = summarize_text(
            transcript,
            max_length=req.max_summary_length,
            min_length=req.min_summary_length,
        )
        channel_results.append(
            ChannelResult(
                channel=str(channel_name),
                message_count=len(group),
                summary=summary or "(not enough text to summarize)",
                voice_analyses=voice_analyses,
                image_ocr=image_ocr,
            )
        )

    overall_summary = summarize_text(
        "\n".join(all_translated_lines),
        max_length=req.max_summary_length,
        min_length=req.min_summary_length,
    )

    return SummarizeResponse(
        since_utc=since_utc.isoformat() if since_utc is not None else None,
        now_utc=now_utc.isoformat() if now_utc is not None else None,
        channels=channel_results,
        overall_summary=overall_summary or "(not enough text to summarize)",
        voice_analyses=all_voice_analyses,
        image_ocr=all_image_ocr,
    )
