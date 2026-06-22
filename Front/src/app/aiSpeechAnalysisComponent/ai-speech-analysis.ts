import { Component, computed, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService, BASE } from '../services/auth.service';

interface Metric {
  key: string;
  icon: string;
  title: string;
  score: number;
  label: string;
  sublabel: string;
  color: string;
  detail: string[];
}

interface Breakdown {
  productivePct: number;
  distractingPct: number;
  neutralPct: number;
  idlePct: number;
}

interface PieSlice {
  label: string;
  pct: number;
  color: string;
  dash: string;
  offset: number;
}

interface Employee {
  name: string;
  role: string;
  email: string;
  productivityScore: number;
  activeLabel: string;
  idleLabel: string;
  breakdown: Breakdown;
  topApp: string;
}

interface AcousticConclusion {
  emotion: string;
  confidence: string;
  emoji: string;
  description: string;
  basis: string;
}

interface PitchContour {
  type: string;
  note: string;
  range: string;
  spread: string;
  jitter: string;
  shimmer: string;
}

interface VoiceAnalysisPayload {
  language?: string;
  transcript?: string;
  translated_transcript?: string;
  translatedTranscript?: string;
  features?: Record<string, unknown>;
  emotion?: {
    label: string;
    confidence: string;
    verdict: string;
  };
  error?: string;
}

interface VoiceMessageItem {
  messageId: string;
  roomName: string;
  senderName: string;
  createdAt: string;
  audioUrl: string | null;
  status: 'pending' | 'ready' | 'failed' | string;
  analysis: VoiceAnalysisPayload | null;
}

interface VoiceDashboard {
  featured: VoiceMessageItem | null;
  recent: VoiceMessageItem[];
  analyzing: boolean;
}

@Component({
  selector: 'app-ai-speech-analysis',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './ai-speech-analysis.html',
  styleUrls: ['./ai-speech-analysis.css'],
})
export class AiSpeechAnalysisComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private pollTimer?: ReturnType<typeof setInterval>;

  private static readonly EMOTION_EMOJI: Record<string, string> = {
    Excited: '🤩',
    Angry: '😠',
    Fearful: '😨',
    Nervous: '😰',
    Sad: '😢',
    Stressed: '😤',
    Calm: '😌',
    Neutral: '😐',
    Confused: '😕',
  };

  workforceLoading = signal(true);
  workforceError = signal('');

  voiceLoading = signal(true);
  voiceAnalyzing = signal(false);
  voiceError = signal('');
  recentVoice = signal<VoiceMessageItem[]>([]);
  selectedMessageId = signal<string | null>(null);
  selectedMeta = signal<{ senderName: string; roomName: string; createdAt: string } | null>(null);

  hasVoiceAnalysis = signal(false);

  detectedLanguage = signal('');
  translationEngine = signal('Whisper medium');
  transcriptAr = signal('');
  translationEn = signal('');
  audioDuration = signal('—');

  conclusion = signal<AcousticConclusion>({
    emotion: '',
    confidence: '',
    emoji: '🎙️',
    description: '',
    basis: '',
  });

  metrics = signal<Metric[]>([]);

  pitchContour = signal<PitchContour>({
    type: '—',
    note: '',
    range: '—',
    spread: '—',
    jitter: '—',
    shimmer: '—',
  });

  readonly catColors: Record<string, string> = {
    productive: '#10b981',
    distracting: '#ef4444',
    neutral: '#8b5cf6',
    idle: '#f59e0b',
  };

  teamBreakdown = signal<Breakdown>({
    productivePct: 0,
    distractingPct: 0,
    neutralPct: 0,
    idlePct: 0,
  });

  averageProductivity = signal(0);
  employees = signal<Employee[]>([]);

  private readonly noCacheHeaders = new HttpHeaders({
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  });

  private get orgId(): string {
    return this.auth.currentUser()?.orgId ?? '';
  }

  ngOnInit() {
    this.loadWorkforce();
    this.loadVoiceDashboard();
  }

  ngOnDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async loadVoiceDashboard(silent = false) {
    if (!silent) {
      this.voiceLoading.set(true);
      this.voiceError.set('');
    }
    if (!this.orgId) {
      this.voiceError.set('No organization selected.');
      this.voiceLoading.set(false);
      return;
    }

    try {
      const res = await firstValueFrom(
        this.http.get<{ data: VoiceDashboard }>(
          `${BASE}/ai/voice/dashboard?orgId=${this.orgId}`,
          { headers: this.noCacheHeaders },
        ),
      );
      const d = res?.data;
      this.recentVoice.set(d?.recent ?? []);
      this.voiceAnalyzing.set(Boolean(d?.analyzing));

      const currentId = this.selectedMessageId();
      const pick =
        (currentId && d?.recent?.find((m) => m.messageId === currentId)) ||
        d?.featured ||
        d?.recent?.find((m) => this.isAnalysisReady(m)) ||
        d?.recent?.[0] ||
        null;

      if (pick) {
        this.selectVoiceMessage(pick, silent);
      } else if (!d?.recent?.length) {
        this.hasVoiceAnalysis.set(false);
        this.voiceError.set('');
      }

      this.syncPolling(Boolean(d?.analyzing));
    } catch (err: any) {
      this.voiceError.set(
        err?.error?.message || err?.message || 'Failed to load voice analysis.',
      );
      this.hasVoiceAnalysis.set(false);
    } finally {
      this.voiceLoading.set(false);
    }
  }

  selectVoiceMessage(item: VoiceMessageItem, silent = false) {
    this.selectedMessageId.set(item.messageId);
    this.selectedMeta.set({
      senderName: item.senderName,
      roomName: item.roomName,
      createdAt: item.createdAt,
    });

    if (this.isAnalysisReady(item)) {
      try {
        this.applyVoiceAnalysis(item.analysis!);
        this.hasVoiceAnalysis.set(true);
        this.voiceError.set('');
      } catch (e: any) {
        this.hasVoiceAnalysis.set(false);
        this.voiceError.set(e?.message || 'Could not display voice analysis.');
      }
      return;
    }

    if (item.status === 'failed') {
      this.hasVoiceAnalysis.set(false);
      this.voiceError.set(item.analysis?.error || 'Voice analysis failed for this message.');
      return;
    }

    if (!silent) {
      this.hasVoiceAnalysis.set(false);
      this.voiceError.set('');
    }
  }

  private isAnalysisReady(item: VoiceMessageItem): boolean {
    if (item.status !== 'ready' || !item.analysis || item.analysis.error) {
      return false;
    }
    const f = item.analysis.features;
    return Boolean(f && (f['duration_sec'] != null || f['pitch_score'] != null));
  }

  onPickVoice(messageId: string) {
    const item = this.recentVoice().find((m) => m.messageId === messageId);
    if (item) this.selectVoiceMessage(item);
  }

  private syncPolling(analyzing: boolean) {
    const pending = analyzing || this.recentVoice().some((m) => m.status === 'pending');
    if (pending && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.loadVoiceDashboard(true), 4000);
    }
    if (!pending && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private applyVoiceAnalysis(data: VoiceAnalysisPayload) {
    const f = data.features ?? {};
    const featureErr =
      typeof f['error'] === 'string' ? f['error'].trim() : '';
    if (featureErr || (data.error && String(data.error).trim())) {
      throw new Error(featureErr || String(data.error).trim());
    }
    if (f['duration_sec'] == null && f['pitch_score'] == null) {
      throw new Error('Acoustic features are missing — re-analysis in progress.');
    }

    this.detectedLanguage.set(data.language || 'unknown');
    this.transcriptAr.set(data.transcript || '(no speech detected)');
    this.translationEn.set(
      data.translatedTranscript || data.translated_transcript || '—',
    );
    this.audioDuration.set(`${f['duration_sec'] ?? '—'}s`);

    const emo = data.emotion;
    this.conclusion.set({
      emotion: emo?.label ?? 'Unknown',
      confidence: emo?.confidence ?? '—',
      emoji: AiSpeechAnalysisComponent.EMOTION_EMOJI[emo?.label ?? ''] ?? '🎙️',
      description: emo?.verdict ?? '',
      basis: `pitch ${f['pitch_score']}% · pace ${f['pace_score']}% · volume ${f['volume_score']}% · trembling ${f['tremor_score']}% · hesitations ${f['hesitation_score']}%`,
    });

    this.metrics.set(this.buildMetrics(f));
    this.pitchContour.set({
      type: String(f['pitch_contour'] ?? '—'),
      note: String(f['contour_meaning'] ?? ''),
      range: `${f['pitch_min_hz'] ?? '—'}–${f['pitch_max_hz'] ?? '—'} Hz`,
      spread: `${f['pitch_range_hz'] ?? '—'} Hz`,
      jitter: `${f['jitter_pct'] ?? '—'}%`,
      shimmer: `${f['shimmer_pct'] ?? '—'}%`,
    });
  }

  private buildMetrics(f: Record<string, unknown>): Metric[] {
    const pitch = this.scaleParts(f['pitch_scale']);
    const pace = this.scaleParts(f['pace_scale']);
    const volume = this.scaleParts(f['volume_scale']);
    const tremor = this.scaleParts(f['tremor_scale']);
    const hesit = this.scaleParts(f['hesitation_scale']);
    const voiced = this.scaleParts(f['voiced_scale']);
    const spectral = this.scaleParts(f['spectral_scale']);

    return [
      {
        key: 'pitch',
        icon: this.metricIcon('pitch', f['pitch_score']),
        title: 'Pitch / Tone',
        score: this.num(f['pitch_score']),
        label: pitch.label,
        sublabel: pitch.sublabel,
        color: pitch.color,
        detail: [`Median: ${f['pitch_hz'] ?? '—'} Hz`, `Range: ${f['pitch_min_hz'] ?? '—'}–${f['pitch_max_hz'] ?? '—'} Hz`],
      },
      {
        key: 'pace',
        icon: this.metricIcon('pace', f['pace_score']),
        title: 'Speaking Pace',
        score: this.num(f['pace_score']),
        label: pace.label,
        sublabel: pace.sublabel,
        color: pace.color,
        detail: [`${f['wpm'] ?? '—'} WPM`, `Source: ${f['pace_source'] ?? '—'}`],
      },
      {
        key: 'volume',
        icon: this.metricIcon('volume', f['volume_score']),
        title: 'Volume / Energy',
        score: this.num(f['volume_score']),
        label: volume.label,
        sublabel: volume.sublabel,
        color: volume.color,
        detail: [`Dyn. range: ${f['dynamic_range'] ?? '—'}×`, `CV: ${f['volume_cv'] ?? '—'}`],
      },
      {
        key: 'trembling',
        icon: this.metricIcon('trembling', f['tremor_score']),
        title: 'Voice Trembling',
        score: this.num(f['tremor_score']),
        label: tremor.label,
        sublabel: tremor.sublabel,
        color: tremor.color,
        detail: [
          `Jitter: ${f['jitter_pct'] ?? '—'}% · Shimmer: ${f['shimmer_pct'] ?? '—'}%`,
          `Jitter score ${f['jitter_score'] ?? '—'}% · Shimmer ${f['shimmer_score'] ?? '—'}%`,
        ],
      },
      {
        key: 'hesitations',
        icon: this.metricIcon('hesitations', f['hesitation_score']),
        title: 'Hesitations',
        score: this.num(f['hesitation_score']),
        label: hesit.label,
        sublabel: hesit.sublabel,
        color: hesit.color,
        detail: [
          `${f['silence_gaps'] ?? 0} gaps · ${f['silence_sec'] ?? 0}s (${f['silence_pct'] ?? 0}%)`,
          `Filler words: ${f['filler_words'] ?? 0}`,
        ],
      },
      {
        key: 'voiced',
        icon: this.metricIcon('voiced', f['voiced_score']),
        title: 'Voiced Ratio',
        score: this.num(f['voiced_score']),
        label: voiced.label,
        sublabel: voiced.sublabel,
        color: voiced.color,
        detail: [
          `${this.num(Number(f['voiced_ratio'] ?? 0) * 100, 1)}% of audio is speech`,
          `(${(100 - this.num(Number(f['voiced_ratio'] ?? 0) * 100, 1)).toFixed(1)}% silence / unvoiced)`,
        ],
      },
      {
        key: 'spectral',
        icon: this.metricIcon('spectral', f['spectral_score']),
        title: 'Spectral Brightness',
        score: this.num(f['spectral_score']),
        label: spectral.label,
        sublabel: spectral.sublabel,
        color: spectral.color,
        detail: [`HF/LF ratio: ${f['hf_lf_ratio'] ?? '—'}`, 'Higher = more tense / brighter voice'],
      },
    ];
  }

  private scaleParts(scale: unknown): { label: string; sublabel: string; color: string } {
    const arr = Array.isArray(scale) ? scale : [];
    return {
      label: String(arr[0] ?? '—'),
      sublabel: String(arr[1] ?? ''),
      color: String(arr[3] ?? '#10b981'),
    };
  }

  private num(value: unknown, decimals = 0): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return decimals ? Math.round(n * 10 ** decimals) / 10 ** decimals : Math.round(n);
  }

  private metricIcon(key: string, score: unknown): string {
    const s = this.num(score);
    if (key === 'pitch') return s < 35 ? '😟' : s > 65 ? '😊' : '😐';
    if (key === 'trembling' || key === 'hesitations') return s > 55 ? '😰' : s > 35 ? '😧' : '😊';
    if (key === 'spectral') return s < 25 ? '😔' : s > 60 ? '😊' : '😐';
    if (key === 'voiced') return s > 55 ? '😊' : '😐';
    return '😐';
  }

  formatMessageDate(iso: string): string {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async loadWorkforce() {
    this.workforceLoading.set(true);
    this.workforceError.set('');
    if (!this.orgId) {
      this.workforceError.set('No organization selected.');
      this.workforceLoading.set(false);
      return;
    }
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(
          `${BASE}/work-session/analytics/workforce?orgId=${this.orgId}`,
        ),
      );
      const d = res?.data;
      if (d?.team?.breakdown) {
        this.teamBreakdown.set(d.team.breakdown);
      }
      if (d?.team?.averageProductivity != null) {
        this.averageProductivity.set(d.team.averageProductivity);
      }
      const mapped: Employee[] = (d?.employees ?? [])
        .filter((e: any) => e.hasData)
        .map((e: any) => ({
          name: e.name,
          role: e.role,
          email: e.email,
          productivityScore: e.productivityScore,
          activeLabel: this.formatDuration(e.activeSeconds),
          idleLabel: this.formatDuration(e.idleSeconds),
          breakdown: e.breakdown,
          topApp: e.topApplications?.[0]?.name ?? '—',
        }));
      this.employees.set(mapped);
    } catch (err: any) {
      this.workforceError.set(err?.error?.message || 'Failed to load workforce data.');
    } finally {
      this.workforceLoading.set(false);
    }
  }

  formatDuration(seconds: number): string {
    if (!seconds) return '0m';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  buildPie(b: Breakdown): PieSlice[] {
    const slices = [
      { label: 'Productive', pct: b.productivePct, color: this.catColors['productive'] },
      { label: 'Neutral', pct: b.neutralPct, color: this.catColors['neutral'] },
      { label: 'Distracting', pct: b.distractingPct, color: this.catColors['distracting'] },
      { label: 'Idle', pct: b.idlePct, color: this.catColors['idle'] },
    ].filter((s) => s.pct > 0);

    const C = 2 * Math.PI * 16;
    let acc = 0;
    return slices.map((s) => {
      const len = (s.pct / 100) * C;
      const slice: PieSlice = { ...s, dash: `${len} ${C - len}`, offset: -acc };
      acc += len;
      return slice;
    });
  }

  teamPie = computed<PieSlice[]>(() => this.buildPie(this.teamBreakdown()));

  maxScore = computed(() =>
    Math.max(...this.employees().map((e) => e.productivityScore), 1),
  );

  getInitial(name: string): string {
    return name?.charAt(0)?.toUpperCase() ?? '?';
  }

  scoreClass(score: number): string {
    if (score >= 70) return 'score-high';
    if (score >= 40) return 'score-mid';
    return 'score-low';
  }
}
