"""
Voice Transcription + Emotion Analysis
=====================================

One click: transcribe with Whisper medium, translate, then estimate emotion from
local acoustic features. No Docker and no API key required.

Run:
    streamlit run ai-services/voice_emotion_streamlit.py
"""
from __future__ import annotations

import json
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import streamlit as st


ROOT = Path(__file__).resolve().parent
AUDIO_DIR = ROOT / "test_media" / "audio"
OUTPUT_DIR = ROOT / "outputs"
MODELS_DIR = ROOT / "models"

AUDIO_EXTENSIONS = {".mp3", ".mpeg", ".wav", ".ogg", ".m4a", ".webm", ".mp4"}

PITCH_SCALE = [
    ("Very Low", "Sad / Depressed", "", "#5d6d7e"),
    ("Low", "Calm / Subdued", "", "#2980b9"),
    ("Medium", "Neutral / Relaxed", "", "#27ae60"),
    ("High", "Engaged / Excited", "", "#f39c12"),
    ("Very High", "Excited / Anxious", "", "#e74c3c"),
]
PACE_SCALE = [
    ("Very Slow", "Very Calm / Disengaged", "", "#95a5a6"),
    ("Slow", "Calm / Thoughtful", "", "#1abc9c"),
    ("Moderate", "Neutral", "", "#27ae60"),
    ("Fast", "Nervous / Energetic", "", "#e67e22"),
    ("Very Fast", "Panicked / Frantic", "", "#c0392b"),
]
VOLUME_SCALE = [
    ("Very Quiet", "Sad / Withdrawn", "", "#7f8c8d"),
    ("Quiet", "Subdued / Sad", "", "#2980b9"),
    ("Moderate", "Neutral", "", "#27ae60"),
    ("Loud", "Assertive / Angry", "", "#e67e22"),
    ("Very Loud", "Angry / Aggressive", "", "#c0392b"),
]
TREMOR_SCALE = [
    ("Stable", "Calm / Confident", "", "#27ae60"),
    ("Slight", "Mild Anxiety", "", "#f39c12"),
    ("Moderate", "Nervous / Fearful", "", "#e67e22"),
    ("High", "Fearful / Distressed", "", "#e74c3c"),
    ("Extreme", "Very Fearful / Panicked", "", "#922b21"),
]
HESIT_SCALE = [
    ("None", "Fluent / Confident", "", "#27ae60"),
    ("Rare", "Slight Uncertainty", "", "#f39c12"),
    ("Occasional", "Uncertain / Nervous", "", "#e67e22"),
    ("Frequent", "Nervous / Anxious", "", "#e74c3c"),
    ("Very Frequent", "Very Nervous / Confused", "", "#922b21"),
]
VOICED_SCALE = [
    ("Very Low", "Long pauses / disengaged", "", "#95a5a6"),
    ("Low", "Hesitant / uncertain", "", "#7f8c8d"),
    ("Moderate", "Normal speech rhythm", "", "#27ae60"),
    ("High", "Engaged / continuous", "", "#f39c12"),
    ("Very High", "Rapid / pressured speech", "", "#e74c3c"),
]
SPECTRAL_SCALE = [
    ("Dull / Flat", "Monotone / depressed", "", "#7f8c8d"),
    ("Low Brightness", "Calm / restrained", "", "#2980b9"),
    ("Balanced", "Neutral / natural", "", "#27ae60"),
    ("Bright", "Lively / excited", "", "#f39c12"),
    ("Very Bright", "Tense / stressed", "", "#e74c3c"),
]


def _to_scale(score: float, scale: list[tuple[str, str, str, str]]) -> tuple[str, str, str, str]:
    idx = int(round(score / 100 * (len(scale) - 1)))
    return scale[min(max(idx, 0), len(scale) - 1)]


def analyse_voice_features(audio_path: Path, transcript: str = "") -> dict[str, Any]:
    """Extract self-calibrated acoustic features from a local audio file."""
    try:
        import librosa
        import numpy as np
    except ImportError:
        return {"error": "librosa is not installed. Run: pip install -r ai-services/requirements.txt"}

    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        duration = float(librosa.get_duration(y=y, sr=sr))
        if duration <= 0:
            return {"error": "Audio file appears to be empty."}

        hop = 256
        f0, voiced_flag, _ = librosa.pyin(y, fmin=60, fmax=500, sr=sr, hop_length=hop, fill_na=np.nan)
        voiced_f0 = f0[voiced_flag & ~np.isnan(f0)]

        if len(voiced_f0) < 5:
            mean_pitch = pitch_std = pitch_min = pitch_max = pitch_range = 0.0
        else:
            mean_pitch = float(np.median(voiced_f0))
            pitch_min = float(np.percentile(voiced_f0, 10))
            pitch_max = float(np.percentile(voiced_f0, 90))
            pitch_range = pitch_max - pitch_min
            pitch_std = float(np.mean(np.abs(np.diff(voiced_f0))))

        if len(voiced_f0) >= 10:
            pitch_score = float(np.clip((mean_pitch - pitch_min) / max(pitch_range, 1) * 100, 0, 100))
            pitch_var_score = float(np.clip(pitch_range / max(mean_pitch * 0.5, 1) * 100, 0, 100))
        else:
            pitch_score = pitch_var_score = 50.0

        if len(voiced_f0) >= 20:
            n = len(voiced_f0)
            thirds = [float(np.median(voiced_f0[i * n // 3 : (i + 1) * n // 3])) for i in range(3)]
            slope = thirds[2] - thirds[0]
            if slope > pitch_range * 0.15:
                pitch_contour = "Rising"
                contour_meaning = "questioning / building excitement"
            elif slope < -pitch_range * 0.15:
                pitch_contour = "Falling"
                contour_meaning = "concluding / losing energy"
            elif max(thirds) - min(thirds) < pitch_range * 0.1:
                pitch_contour = "Flat"
                contour_meaning = "monotone / neutral delivery"
            else:
                pitch_contour = "Variable"
                contour_meaning = "dynamic / emotional speech"
        else:
            pitch_contour = "Unknown"
            contour_meaning = ""

        word_count = len(transcript.split()) if transcript.strip() else 0
        wpm = round(word_count / max(duration / 60, 0.01)) if word_count else None

        zcr = librosa.feature.zero_crossing_rate(y, hop_length=hop)[0]
        rms = librosa.feature.rms(y=y, hop_length=hop)[0]
        speech_thresh = float(np.percentile(rms, 20))
        voiced_frames = rms > speech_thresh
        if np.any(voiced_frames):
            zcr_voiced = zcr * voiced_frames
            zcr_cutoff = float(np.percentile(zcr_voiced[voiced_frames], 75))
            syl_rate_approx = float(np.sum(zcr_voiced > zcr_cutoff) / max(duration, 1))
        else:
            syl_rate_approx = 0.0

        if wpm is not None:
            pace_score = float(np.clip((wpm - 60) / (220 - 60) * 100, 0, 100))
            pace_source = "WPM"
        else:
            pace_score = float(np.clip((syl_rate_approx - 3) / (7 - 3) * 100, 0, 100))
            pace_source = "syllable rate"

        active_rms = rms[rms > np.percentile(rms, 10)]
        mean_rms = float(np.mean(active_rms)) if len(active_rms) else 0.0
        peak_rms = float(np.percentile(rms, 95))
        rms_std = float(np.std(active_rms)) if len(active_rms) else 0.0
        cv_volume = rms_std / max(mean_rms, 1e-6)
        dyn_range = float(peak_rms / max(mean_rms, 1e-6))
        loud_pct = float(np.mean(rms > np.percentile(rms, 70)) * 100)
        volume_score = float(np.clip(loud_pct * 1.5, 0, 100))

        if len(voiced_f0) >= 5:
            jitter_pct = float(np.mean(np.abs(np.diff(voiced_f0))) / max(mean_pitch, 1) * 100)
            jitter_score = float(np.clip(jitter_pct / 6.0 * 100, 0, 100))
        else:
            jitter_pct = jitter_score = 0.0

        vf_len = len(rms)
        f0_len = len(voiced_flag)
        vf_resampled = voiced_flag[np.linspace(0, f0_len - 1, vf_len).astype(int)] if f0_len else np.zeros(vf_len)
        voiced_rms = rms[vf_resampled]
        if len(voiced_rms) >= 5:
            shimmer_pct = float(np.mean(np.abs(np.diff(voiced_rms))) / max(np.mean(voiced_rms), 1e-6) * 100)
            shimmer_score = float(np.clip(shimmer_pct / 15.0 * 100, 0, 100))
        else:
            shimmer_pct = shimmer_score = 0.0
        tremor_score = float(jitter_score * 0.55 + shimmer_score * 0.45)

        frame_dur_s = hop / sr
        min_gap_fr = int(0.30 / frame_dur_s)
        silence_thresh = float(np.percentile(rms, 15))
        silent = rms < silence_thresh
        run_len = 0
        long_gaps: list[float] = []
        for is_sil in silent:
            if is_sil:
                run_len += 1
            else:
                if run_len >= min_gap_fr:
                    long_gaps.append(run_len * frame_dur_s)
                run_len = 0
        if run_len >= min_gap_fr:
            long_gaps.append(run_len * frame_dur_s)

        gap_count = len(long_gaps)
        silence_sec = float(sum(long_gaps))
        silence_pct = silence_sec / max(duration, 1) * 100
        speech_sec = max(duration - silence_sec, 1)
        gaps_per_speech_min = gap_count / max(speech_sec / 60, 0.01)
        hesit_score = float(np.clip((gaps_per_speech_min - 5) / (25 - 5) * 100, 0, 100))

        fillers = ["um", "uh", "er", "erm", "hmm", "like", "you know", "اه", "يعني", "اممم", "مممم", "اوف", "اوه"]
        filler_count = 0
        if transcript.strip():
            low = f" {transcript.lower()} "
            for filler in fillers:
                filler_count += len(re.findall(rf"(?<!\w){re.escape(filler)}(?!\w)", low))

        voiced_ratio = float(np.sum(voiced_flag) / max(len(voiced_flag), 1))
        voiced_score = float(np.clip(voiced_ratio * 100, 0, 100))

        s_matrix = np.abs(librosa.stft(y, hop_length=hop))
        freqs = librosa.fft_frequencies(sr=sr)
        lf_mask = freqs < 1000
        hf_mask = (freqs >= 1000) & (freqs < 4000)
        lf_energy = float(np.mean(s_matrix[lf_mask, :]))
        hf_energy = float(np.mean(s_matrix[hf_mask, :]))
        hf_lf_ratio = hf_energy / max(lf_energy, 1e-6)
        spectral_score = float(np.clip((hf_lf_ratio - 0.1) / (0.6 - 0.1) * 100, 0, 100))

        return {
            "pitch_score": round(pitch_score, 1),
            "pitch_var_score": round(pitch_var_score, 1),
            "pitch_scale": _to_scale(pitch_score, PITCH_SCALE),
            "pitch_hz": round(mean_pitch, 1),
            "pitch_jitter_hz": round(pitch_std, 2),
            "pitch_min_hz": round(pitch_min, 1),
            "pitch_max_hz": round(pitch_max, 1),
            "pitch_range_hz": round(pitch_range, 1),
            "pitch_contour": pitch_contour,
            "contour_meaning": contour_meaning,
            "pace_score": round(pace_score, 1),
            "pace_scale": _to_scale(pace_score, PACE_SCALE),
            "wpm": wpm,
            "pace_source": pace_source,
            "volume_score": round(volume_score, 1),
            "volume_scale": _to_scale(volume_score, VOLUME_SCALE),
            "rms_mean": round(mean_rms, 5),
            "rms_peak": round(peak_rms, 5),
            "dynamic_range": round(dyn_range, 2),
            "volume_cv": round(cv_volume, 3),
            "tremor_score": round(tremor_score, 1),
            "tremor_scale": _to_scale(tremor_score, TREMOR_SCALE),
            "jitter_score": round(jitter_score, 1),
            "jitter_pct": round(jitter_pct, 3),
            "shimmer_score": round(shimmer_score, 1),
            "shimmer_pct": round(shimmer_pct, 3),
            "hesitation_score": round(hesit_score, 1),
            "hesitation_scale": _to_scale(hesit_score, HESIT_SCALE),
            "silence_gaps": gap_count,
            "silence_sec": round(silence_sec, 1),
            "silence_pct": round(silence_pct, 1),
            "filler_words": filler_count,
            "voiced_score": round(voiced_score, 1),
            "voiced_scale": _to_scale(voiced_score, VOICED_SCALE),
            "voiced_ratio": round(voiced_ratio, 3),
            "spectral_score": round(spectral_score, 1),
            "spectral_scale": _to_scale(spectral_score, SPECTRAL_SCALE),
            "hf_lf_ratio": round(hf_lf_ratio, 3),
            "duration_sec": round(duration, 1),
        }
    except Exception as exc:
        return {"error": str(exc)}


def conclude_emotional_state(vf: dict[str, Any]) -> tuple[str, str, str, str, str, dict[str, float]]:
    """Weighted multi-signal emotional state estimate."""
    pitch = vf.get("pitch_score", 50.0)
    pitch_var = vf.get("pitch_var_score", 50.0)
    pace = vf.get("pace_score", 50.0)
    volume = vf.get("volume_score", 50.0)
    tremor = vf.get("tremor_score", 50.0)
    jitter = vf.get("jitter_score", 50.0)
    shimmer = vf.get("shimmer_score", 50.0)
    hesit = vf.get("hesitation_score", 50.0)
    voiced = vf.get("voiced_score", 50.0)
    spectral = vf.get("spectral_score", 50.0)
    dyn = vf.get("dynamic_range", 1.5)
    fillers = vf.get("filler_words", 0)
    wpm = vf.get("wpm")
    contour = vf.get("pitch_contour", "")
    jitter_pct = vf.get("jitter_pct", 0.0)
    shimmer_pct = vf.get("shimmer_pct", 0.0)
    pitch_hz = vf.get("pitch_hz", 150.0)

    def sig(score: float, support_above: float = 65, contradict_below: float = 35, weight: float = 1.0) -> float:
        if score >= support_above:
            return weight * min((score - support_above) / (100 - support_above), 1.0)
        if score <= contradict_below:
            return -weight * min((contradict_below - score) / contradict_below, 1.0)
        return 0.0

    def inv(score: float, support_below: float = 35, contradict_above: float = 65, weight: float = 1.0) -> float:
        if score <= support_below:
            return weight * min((support_below - score) / support_below, 1.0)
        if score >= contradict_above:
            return -weight * min((score - contradict_above) / (100 - contradict_above), 1.0)
        return 0.0

    filler_bonus = min(fillers / 5.0, 1.0)
    votes = {
        "Angry": sig(volume, 65, 35, 2.0) + sig(pitch, 60, 30, 1.5) + inv(hesit, 30, 60, 1.0)
        + sig(spectral, 60, 30, 0.8) + (0.5 if dyn > 2.5 else 0.0) + inv(tremor, 35, 65, 0.5),
        "Fearful": sig(tremor, 60, 30, 2.0) + sig(jitter, 55, 30, 1.5) + sig(shimmer, 55, 30, 1.0)
        + inv(volume, 35, 65, 1.2) + sig(hesit, 55, 30, 1.0) + sig(pace, 60, 30, 0.8)
        + (0.6 if "Rising" in contour else 0.0),
        "Nervous": sig(tremor, 50, 25, 1.5) + sig(pace, 55, 30, 1.5) + sig(hesit, 50, 25, 1.5)
        + filler_bonus + sig(pitch, 55, 30, 0.8) + sig(spectral, 55, 30, 0.7)
        + (0.4 if jitter_pct > 2.0 else 0.0),
        "Excited": sig(pitch, 60, 30, 1.5) + sig(pitch_var, 60, 30, 1.5) + sig(pace, 60, 30, 1.2)
        + sig(volume, 55, 30, 1.0) + inv(tremor, 35, 60, 1.2) + inv(hesit, 30, 55, 0.8)
        + (0.5 if "Rising" in contour else 0.0) + (0.5 if "Variable" in contour else 0.0),
        "Sad": inv(pitch, 35, 60, 2.0) + inv(pitch_var, 35, 60, 1.5) + inv(pace, 35, 60, 1.5)
        + inv(volume, 35, 60, 1.5) + inv(voiced, 40, 65, 1.0) + sig(hesit, 50, 25, 0.8)
        + (0.8 if "Falling" in contour else 0.0) + (0.5 if "Flat" in contour else 0.0),
        "Stressed": sig(pace, 60, 35, 1.8) + sig(spectral, 55, 30, 1.5) + sig(tremor, 45, 20, 1.2)
        + sig(shimmer, 45, 20, 1.0) + sig(hesit, 45, 20, 0.8) + sig(volume, 50, 25, 0.7)
        + (0.5 if jitter_pct > 1.5 and shimmer_pct > 5 else 0.0),
        "Calm": inv(tremor, 30, 55, 2.0) + inv(hesit, 30, 55, 1.5) + inv(jitter, 30, 55, 1.0)
        + inv(shimmer, 30, 55, 0.8) + (0.6 if 25 <= pace <= 65 else 0.0)
        + (0.6 if 25 <= volume <= 70 else 0.0) + (0.5 if "Flat" in contour or "Falling" in contour else 0.0)
        + inv(spectral, 35, 60, 0.7),
    }
    extremeness = (abs(pitch - 50) + abs(pace - 50) + abs(volume - 50) + abs(tremor - 50) + abs(hesit - 50)) / 5.0
    votes["Neutral"] = max(0.0, 1.5 - extremeness / 25.0)

    winner = max(votes, key=votes.get)
    if votes[winner] < 0.3:
        winner = "Neutral"

    states = {
        "Angry": ("", "#c0392b"),
        "Fearful": ("", "#6c3483"),
        "Nervous": ("", "#e67e22"),
        "Excited": ("", "#f39c12"),
        "Sad": ("", "#2980b9"),
        "Stressed": ("", "#e74c3c"),
        "Calm": ("", "#27ae60"),
        "Neutral": ("", "#7f8c8d"),
    }
    emoji, color = states.get(winner, ("", "#7f8c8d"))

    sorted_votes = sorted(votes.values(), reverse=True)
    gap = sorted_votes[0] - sorted_votes[1] if len(sorted_votes) > 1 else 1.0
    confidence = "High" if gap > 1.2 else "Moderate" if gap > 0.5 else "Low"
    runner_up = [e for e in sorted(votes, key=lambda x: -votes[x]) if e != winner]
    secondary = f" (with hints of {runner_up[0]})" if runner_up and votes[runner_up[0]] > 0.4 else ""

    wpm_str = f"{wpm} WPM" if wpm else "unknown pace"
    hz_str = f"{pitch_hz:.0f} Hz" if pitch_hz > 0 else "unknown pitch"
    verdicts = {
        "Angry": f"The speaker sounds angry or assertive. Volume is elevated ({volume:.0f}%), pitch is high ({hz_str}), and hesitations are limited.",
        "Fearful": f"The speaker's voice shows signs of fear or distress. Trembling is prominent (jitter {jitter_pct:.1f}%, shimmer {shimmer_pct:.1f}%), with pauses and reduced volume.",
        "Nervous": f"The speaker appears nervous or anxious. Pace ({wpm_str}), tremor ({tremor:.0f}%), and hesitations or fillers ({fillers}) point to anxiety.",
        "Excited": f"The speaker sounds excited and engaged. High pitch ({hz_str}), wide intonation ({vf.get('pitch_range_hz', 0):.0f} Hz), and pace ({wpm_str}) indicate high energy.",
        "Sad": f"The speaker's voice suggests sadness or low mood. Pitch ({hz_str}), quiet volume ({volume:.0f}%), pace ({wpm_str}), and contour ({contour}) fit withdrawal.",
        "Stressed": f"The speaker sounds stressed or under pressure. Pace ({wpm_str}), spectral score ({spectral:.0f}%), and tremor ({tremor:.0f}%) suggest load.",
        "Calm": f"The speaker sounds calm and composed. Tremor is low ({tremor:.0f}%), pacing is measured ({wpm_str}), and hesitations are limited.",
        "Neutral": f"The speaker's voice does not show strong emotional signals. Pitch ({hz_str}), pace ({wpm_str}), volume, and trembling are balanced.",
    }
    return winner, emoji, color, verdicts[winner] + secondary, confidence, votes


def _feature_card(col: Any, title: str, score: float, scale_entry: tuple[str, str, str, str], sub1: str, sub2: str = "") -> None:
    cat, meaning, emoji, color = scale_entry
    pct = int(min(max(score, 0), 100))
    col.markdown(
        f"""
        <div style="background:linear-gradient(160deg,{color}1A,{color}06);border:1px solid {color}66;border-radius:8px;
            padding:14px 12px;text-align:center;min-height:190px;display:flex;flex-direction:column;justify-content:space-between;">
            <div style="font-size:0.72em;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:0.04em;">{title}</div>
            <div style="font-size:1.8rem;line-height:1;">{emoji}</div>
            <div><div style="font-size:1.8rem;font-weight:900;color:{color};line-height:1;">{pct}</div><div style="font-size:0.65em;color:#888;">/100</div></div>
            <div style="background:{color}22;border-radius:6px;height:8px;"><div style="background:{color};width:{pct}%;height:8px;border-radius:6px;"></div></div>
            <div style="font-size:0.78em;font-weight:800;color:{color};">{cat}</div>
            <div style="font-size:0.68em;color:#555;line-height:1.3;">{meaning}</div>
            <div style="font-size:0.65em;color:#777;border-top:1px solid #eee;padding-top:5px;line-height:1.5;">{sub1}{("<br>" + sub2) if sub2 else ""}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_voice_features(vf: dict[str, Any]) -> None:
    if "error" in vf:
        st.warning(f"Voice feature analysis unavailable: {vf['error']}")
        return

    dur = vf.get("duration_sec", 0)
    st.caption(f"Audio duration: **{dur}s**. Features extracted acoustically via librosa.")

    c1, c2, c3, c4, c5 = st.columns(5)
    _feature_card(c1, "Pitch / Tone", vf["pitch_score"], vf["pitch_scale"], f"Median: <b>{vf['pitch_hz']} Hz</b>", f"Range: {vf['pitch_min_hz']}-{vf['pitch_max_hz']} Hz")
    _feature_card(c2, "Speaking Pace", vf["pace_score"], vf["pace_scale"], f"<b>{vf['wpm']} WPM</b>" if vf.get("wpm") else "<b>syllable-rate mode</b>", f"Source: {vf.get('pace_source', '')}")
    _feature_card(c3, "Volume / Energy", vf["volume_score"], vf["volume_scale"], f"Dyn. range: <b>{vf['dynamic_range']}x</b>", f"CV: {vf['volume_cv']}")
    _feature_card(c4, "Voice Trembling", vf["tremor_score"], vf["tremor_scale"], f"Jitter: <b>{vf['jitter_pct']}%</b> / Shimmer: <b>{vf['shimmer_pct']}%</b>", f"Jitter {vf['jitter_score']:.0f}% / Shimmer {vf['shimmer_score']:.0f}%")
    _feature_card(c5, "Hesitations", vf["hesitation_score"], vf["hesitation_scale"], f"<b>{vf['silence_gaps']} gaps</b> / {vf['silence_sec']}s ({vf['silence_pct']}%)", f"Filler words: {vf['filler_words']}")

    r2c1, r2c2, r2c3 = st.columns([1, 1, 2])
    _feature_card(r2c1, "Voiced Ratio", vf["voiced_score"], vf["voiced_scale"], f"<b>{vf['voiced_ratio'] * 100:.1f}%</b> speech", f"{100 - vf['voiced_ratio'] * 100:.1f}% silence / unvoiced")
    _feature_card(r2c2, "Spectral Brightness", vf["spectral_score"], vf["spectral_scale"], f"HF/LF ratio: <b>{vf['hf_lf_ratio']}</b>", "Higher = tenser / brighter voice")

    contour = vf.get("pitch_contour", "Unknown")
    contour_meaning = vf.get("contour_meaning", "")
    c_color = "#f39c12" if "Rising" in contour else "#2980b9" if "Falling" in contour else "#9b59b6" if "Variable" in contour else "#7f8c8d"
    r2c3.markdown(
        f"""
        <div style="background:linear-gradient(135deg,{c_color}18,{c_color}05);border:1px solid {c_color}55;border-radius:8px;
            padding:20px 22px;min-height:190px;display:flex;flex-direction:column;justify-content:center;">
            <div style="font-size:0.72em;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:0.04em;">Pitch Contour</div>
            <div style="font-size:1.2rem;font-weight:800;color:{c_color};margin-top:10px;">{contour}</div>
            <div style="font-size:0.82em;color:#555;margin-top:6px;">{contour_meaning}</div>
            <div style="font-size:0.82em;color:#444;margin-top:12px;line-height:1.5;">
                Pitch range: <b>{vf['pitch_min_hz']}-{vf['pitch_max_hz']} Hz</b> / Spread: <b>{vf['pitch_range_hz']} Hz</b><br>
                Jitter: <b>{vf['jitter_pct']}%</b> / Shimmer: <b>{vf['shimmer_pct']}%</b>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    with st.expander("Detailed Signal Bars", expanded=True):
        bars = [
            ("Pitch level", vf["pitch_score"], vf["pitch_scale"][3], f"{vf['pitch_hz']} Hz median / range {vf['pitch_range_hz']} Hz"),
            ("Pitch variability", vf["pitch_var_score"], vf["pitch_scale"][3], f"Intonation spread / jitter {vf['jitter_pct']}%"),
            ("Speaking Pace", vf["pace_score"], vf["pace_scale"][3], (f"{vf['wpm']} WPM" if vf.get("wpm") else "syllable rate") + f" / {vf.get('pace_source', '')}"),
            ("Volume / Energy", vf["volume_score"], vf["volume_scale"][3], f"Dyn range {vf['dynamic_range']}x / CV {vf['volume_cv']}"),
            ("Trembling - Jitter", vf["jitter_score"], vf["tremor_scale"][3], f"Cycle-to-cycle F0 variation: {vf['jitter_pct']}%"),
            ("Trembling - Shimmer", vf["shimmer_score"], vf["tremor_scale"][3], f"Amplitude perturbation: {vf['shimmer_pct']}%"),
            ("Hesitations / Pauses", vf["hesitation_score"], vf["hesitation_scale"][3], f"{vf['silence_gaps']} pauses >300ms / {vf['silence_sec']}s / {vf['filler_words']} fillers"),
            ("Voiced Ratio", vf["voiced_score"], vf["voiced_scale"][3], f"{vf['voiced_ratio'] * 100:.1f}% speech"),
            ("Spectral Tilt (HF/LF)", vf["spectral_score"], vf["spectral_scale"][3], f"HF/LF ratio {vf['hf_lf_ratio']}"),
        ]
        bars_html = ""
        for label, score, color, detail in bars:
            pct = int(min(max(score, 0), 100))
            bars_html += (
                f"<div style='margin:9px 0'><div style='display:flex;justify-content:space-between;font-size:0.82em;color:#444;margin-bottom:3px;'>"
                f"<span><b>{label}</b> <span style='color:#777;font-size:0.88em;'>/ {detail}</span></span>"
                f"<span style='font-weight:800;color:{color};'>{pct}%</span></div>"
                f"<div style='background:#e8e8e8;border-radius:8px;height:12px;'><div style='background:{color};width:{pct}%;height:12px;border-radius:8px;'></div></div></div>"
            )
        st.markdown(bars_html, unsafe_allow_html=True)

    winner, emoji, color, verdict, confidence, votes = conclude_emotional_state(vf)
    st.markdown(
        f"""
        <div style="background:linear-gradient(135deg,{color}1F,{color}08);border:1px solid {color}66;border-radius:8px;padding:18px 20px;margin-top:14px;">
            <div style="font-size:0.78em;font-weight:800;color:#555;text-transform:uppercase;letter-spacing:0.04em;">Estimated Emotional State</div>
            <div style="font-size:1.8rem;font-weight:900;color:{color};margin:4px 0;">{emoji} {winner}</div>
            <div style="font-size:0.9rem;color:#444;line-height:1.5;">{verdict}</div>
            <div style="font-size:0.78rem;color:#666;margin-top:10px;">Confidence: <b>{confidence}</b></div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    with st.expander("Raw acoustic values and emotion votes"):
        st.json({"features": vf, "emotion_votes": votes})


@st.cache_resource(show_spinner=False)
def _load_whisper_model(model_name: str):
    import whisper

    return whisper.load_model(model_name, download_root=str(MODELS_DIR))


@st.cache_resource(show_spinner=False)
def _load_translation_pipeline():
    from transformers import pipeline

    local_model = MODELS_DIR / "opus-mt-ar-en"
    model_source = str(local_model) if (local_model / "config.json").exists() else "Helsinki-NLP/opus-mt-ar-en"
    return pipeline("translation", model=model_source)


def transcribe_audio(audio_path: Path, model_name: str = "medium") -> dict[str, Any]:
    model = _load_whisper_model(model_name)
    return model.transcribe(str(audio_path), task="transcribe", fp16=False)


def translate_text(text: str) -> str:
    if not text.strip():
        return ""
    translator = _load_translation_pipeline()
    chunks = [text[i : i + 900] for i in range(0, len(text), 900)]
    translated = []
    for chunk in chunks:
        result = translator(chunk)
        translated.append(result[0]["translation_text"])
    return " ".join(translated)


def _available_audio_files() -> list[Path]:
    if not AUDIO_DIR.exists():
        return []
    return sorted(path for path in AUDIO_DIR.iterdir() if path.suffix.lower() in AUDIO_EXTENSIONS)


def _save_uploaded_audio(uploaded_file: Any) -> Path:
    suffix = Path(uploaded_file.name).suffix.lower()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(uploaded_file.getbuffer())
        return Path(tmp.name)


def _write_output(source_name: str, result: dict[str, Any]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^a-zA-Z0-9_.-]+", "_", Path(source_name).stem).strip("_") or "audio"
    out_path = OUTPUT_DIR / f"{safe_stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return out_path


def main() -> None:
    st.set_page_config(page_title="Voice Emotion Analysis", page_icon="audio", layout="wide")
    st.title("Voice Transcription + Emotion Analysis")
    st.caption("Local Whisper transcription, local translation, and acoustic emotion estimation.")

    with st.sidebar:
        st.header("Input")
        source_mode = st.radio("Audio source", ["Upload file", "Use test_media/audio"], horizontal=False)
        whisper_model = st.selectbox("Whisper model", ["medium", "small", "base", "tiny"], index=0)
        save_json = st.checkbox("Save JSON output", value=True)

    audio_path: Path | None = None
    source_name = ""

    if source_mode == "Upload file":
        uploaded = st.file_uploader("Choose an audio file", type=sorted(ext.lstrip(".") for ext in AUDIO_EXTENSIONS))
        if uploaded is not None:
            audio_path = _save_uploaded_audio(uploaded)
            source_name = uploaded.name
            st.audio(uploaded)
    else:
        files = _available_audio_files()
        if not files:
            st.info(f"No audio files found in {AUDIO_DIR}.")
        else:
            selected = st.selectbox("Audio file", files, format_func=lambda p: p.name)
            audio_path = selected
            source_name = selected.name
            st.audio(str(selected))

    if not audio_path:
        st.stop()

    if st.button("Transcribe, Translate, Analyze", type="primary"):
        with st.spinner("Transcribing with Whisper..."):
            transcript_result = transcribe_audio(audio_path, whisper_model)
            transcript = transcript_result.get("text", "").strip()

        with st.spinner("Translating transcript..."):
            translation = translate_text(transcript)

        with st.spinner("Extracting acoustic features..."):
            features = analyse_voice_features(audio_path, transcript)

        st.subheader("Transcript")
        st.text_area("Original", transcript, height=160)
        st.text_area("English translation", translation, height=160)

        st.subheader("Acoustic Voice Features")
        render_voice_features(features)

        result = {
            "source": source_name,
            "model": f"whisper-{whisper_model}",
            "created_at": datetime.now().isoformat(),
            "transcript": transcript,
            "translation": translation,
            "features": features,
        }
        if "error" not in features:
            winner, _, _, verdict, confidence, votes = conclude_emotional_state(features)
            result["emotion"] = {
                "label": winner,
                "confidence": confidence,
                "verdict": verdict,
                "votes": votes,
            }

        if save_json:
            out_path = _write_output(source_name, result)
            st.success(f"Saved output: {out_path}")


if __name__ == "__main__":
    main()
