import { Injectable, signal, computed, inject, OnDestroy, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService, BASE } from './auth.service';

export type SessionStatus = 'idle' | 'active' | 'paused' | 'stopped';

export interface WorkSession {
  _id: string;
  userId: string;
  organizationId: string;
  taskId?: string;
  status: SessionStatus;
  startTime: string;
  endTime: string | null;
  activeSeconds: number;
  idleSeconds: number;
  pausedSeconds: number;
  totalSeconds: number;
  lastActivityAt: string;
  isIdle: boolean;
  pauseSegments: { pausedAt: string; resumedAt: string | null }[];
  note?: string;
  liveSeconds?: number;
}

const BASE_URL = `${BASE}/work-session`;

@Injectable({ providedIn: 'root' })
export class WorkSessionService implements OnDestroy {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private zone = inject(NgZone);

  private get orgId(): string {
    return this.auth.currentUser()?.orgId ?? '';
  }

  // ── State ─────────────────────────────────────────────────────
  session = signal<WorkSession | null>(null);
  status = computed<SessionStatus>(() => this.session()?.status ?? 'idle');
  isActive = computed(() => this.status() === 'active');
  isPaused = computed(() => this.status() === 'paused');
  isIdle = computed(() => this.session()?.isIdle ?? false);
  elapsedSeconds = signal(0);

  // ── Screen capture (in-browser "desktop agent") ───────────────
  // Uses the Screen Capture API (getDisplayMedia). The browser prompts
  // the user ONCE to pick a screen/window, we hold that stream, then grab
  // a JPEG frame on an interval and POST it to the SAME endpoint the
  // native desktop agent uses: POST /work-session/:sessionId/screenshots.
  isCapturing       = signal(false);
  screenshotsSent   = signal(0);
  screenshotsFailed = signal(0);
  captureError      = signal<string | null>(null);

  private captureStream: MediaStream | null = null;
  private captureVideo: HTMLVideoElement | null = null;
  private captureTimer: any = null;
  private readonly captureIntervalMs = 30_000; // 30s cadence, like the agent

  formattedTime = computed(() => {
    const s = this.elapsedSeconds();
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  });

  private timerInterval: any = null;
  private activityInterval: any = null;
  private activityListeners: (() => void)[] = [];
  private lastActivitySent = 0;

  constructor() {
    // ── Restore active session on app load ──
    this.fetchActiveSession();
  }

  // ── Fetch active session (on load) ───────────────────────────
  async fetchActiveSession(): Promise<void> {
    if (!this.orgId) return;
    try {
      const res = await firstValueFrom(
        this.http.get<{ message: string; data: { items: WorkSession[] } }>(
          `${BASE_URL}/me?orgId=${this.orgId}&status=active&limit=1`,
        ),
      );

      const active = res?.data?.items?.find((s) => s.status === 'active' || s.status === 'paused');
      if (active) {
        this.session.set(active);
        // Sync elapsed time from liveSeconds
        this.elapsedSeconds.set(active.liveSeconds ?? active.activeSeconds ?? 0);
        if (active.status === 'active') {
          this.startTimer();
          this.startActivityPing();
          this.listenToUserActivity();
        }
      }
    } catch {
      /* no active session — stay idle */
    }
  }

  // ── Start ─────────────────────────────────────────────────────
  async start(taskId?: string, note?: string): Promise<void> {
    if (!this.orgId) {
      console.warn('No orgId');
      return;
    }
    try {
      const res = await firstValueFrom(
        this.http.post<{ message: string; data: WorkSession }>(`${BASE_URL}/start`, {
          orgId: this.orgId,
          taskId,
          note,
        }),
      );
      if (res?.data) {
        this.session.set(res.data);
        this.elapsedSeconds.set(0);
        this.startTimer();
        this.startActivityPing();
        this.listenToUserActivity();
        // Auto-begin screen capture with the same click. Best-effort: the
        // browser still shows its mandatory screen-picker, and if the user
        // dismisses it the session keeps running (capture just stays off).
        // The POST above is fast on localhost, so we're still inside the
        // click's transient activation window that getDisplayMedia needs.
        this.startScreenCapture();
      }
    } catch (e: any) {
      console.error('Start failed:', e?.error?.message ?? e);
    }
  }

  // ── Pause ─────────────────────────────────────────────────────
  async pause(note?: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ message: string; data: WorkSession }>(`${BASE_URL}/pause`, {
          orgId: this.orgId,
          note,
        }),
      );
      if (res?.data) {
        this.session.set(res.data);
        this.stopTimer();
        this.stopActivityPing();
        this.removeActivityListeners();
      }
    } catch (e: any) {
      console.error('Pause failed:', e?.error?.message ?? e);
    }
  }

  // ── Resume ────────────────────────────────────────────────────
  async resume(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ message: string; data: WorkSession }>(`${BASE_URL}/resume`, {
          orgId: this.orgId,
        }),
      );
      if (res?.data) {
        this.session.set(res.data);
        this.startTimer();
        this.startActivityPing();
        this.listenToUserActivity();
      }
    } catch (e: any) {
      console.error('Resume failed:', e?.error?.message ?? e);
    }
  }

  // ── Stop ──────────────────────────────────────────────────────
  async stop(note?: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ message: string; data: WorkSession }>(`${BASE_URL}/stop`, {
          orgId: this.orgId,
          note,
        }),
      );
      if (res?.data) {
        this.session.set(res.data);
        this.stopTimer();
        this.stopActivityPing();
        this.removeActivityListeners();
        this.stopScreenCapture(); // releases the shared screen on Stop
        setTimeout(() => {
          this.session.set(null);
          this.elapsedSeconds.set(0);
        }, 1500);
      }
    } catch (e: any) {
      console.error('Stop failed:', e?.error?.message ?? e);
    }
  }

  // ── Activity ping to backend ──────────────────────────────────
  async sendActivity(type: 'keyboard' | 'mouse' = 'keyboard'): Promise<void> {
    if (!this.isActive()) return;

    const user = this.auth.currentUser();

    // The backend POST /work-session/activity validator only accepts
    // { orgId, type, details } and REJECTS unknown keys (400). It resolves
    // the user + active session from the auth token server-side, so we must
    // NOT send userId/sessionId/timestamp — doing so 400s every ping and
    // silently breaks idle/activity tracking.
    const payload = {
      orgId: user?.orgId,
      type,
    };

    try {
      const res = await firstValueFrom(
        this.http.post<{ message: string; data: { isIdle: boolean; lastActivityAt: string } }>(
          `${BASE_URL}/activity`,
          payload,
        ),
      );

      if (res?.data && this.session()) {
        this.session.update((s) =>
          s ? { ...s, isIdle: res.data.isIdle, lastActivityAt: res.data.lastActivityAt } : s,
        );
      }
    } catch (err: any) {
      console.log('❌ ACTIVITY ERROR:', err?.error);
      console.log('❌ DETAILS:', err?.error?.details);
    }
  }

  // ── Listen to real user activity (mouse/keyboard) ────────────
  private listenToUserActivity(): void {
    this.removeActivityListeners();

    const handler = (type: 'keyboard' | 'mouse') => {
      const now = Date.now();
      // Send immediately if was idle, otherwise debounce to 15s
      const minInterval = this.isIdle() ? 0 : 15000;
      if (now - this.lastActivitySent >= minInterval) {
        this.lastActivitySent = now;
        this.zone.run(() => this.sendActivity(type));
      }
    };

    const mouseHandler = () => handler('mouse');
    const keyHandler = () => handler('keyboard');

    this.zone.runOutsideAngular(() => {
      document.addEventListener('mousemove', mouseHandler, { passive: true });
      document.addEventListener('mousedown', mouseHandler, { passive: true });
      document.addEventListener('keydown', keyHandler, { passive: true });
      document.addEventListener('touchstart', mouseHandler, { passive: true });
    });

    this.activityListeners = [
      () => document.removeEventListener('mousemove', mouseHandler),
      () => document.removeEventListener('mousedown', mouseHandler),
      () => document.removeEventListener('keydown', keyHandler),
      () => document.removeEventListener('touchstart', mouseHandler),
    ];
  }

  private removeActivityListeners(): void {
    this.activityListeners.forEach((fn) => fn());
    this.activityListeners = [];
  }

  // ── Timer ─────────────────────────────────────────────────────
  private startTimer(): void {
    this.stopTimer();
    this.zone.runOutsideAngular(() => {
      this.timerInterval = setInterval(() => {
        if (this.isActive()) {
          this.zone.run(() => this.elapsedSeconds.update((s) => s + 1));
        }
      }, 1000);
    });
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  // ── Periodic ping every 20s ───────────────────────────────────
  private startActivityPing(): void {
    this.stopActivityPing();
    this.zone.runOutsideAngular(() => {
      this.activityInterval = setInterval(() => {
        this.zone.run(() => this.sendActivity('keyboard'));
      }, 20000);
    });
  }

  private stopActivityPing(): void {
    if (this.activityInterval) {
      clearInterval(this.activityInterval);
      this.activityInterval = null;
    }
  }

  // ── Screen capture control ────────────────────────────────────
  async toggleScreenCapture(): Promise<void> {
    if (this.isCapturing()) {
      this.stopScreenCapture();
    } else {
      await this.startScreenCapture();
    }
  }

  async startScreenCapture(): Promise<void> {
    if (this.isCapturing()) return; // already running — don't re-prompt
    this.captureError.set(null);

    const sid = this.session()?._id;
    if (!sid) {
      this.captureError.set('Start a work session first.');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.captureError.set('Screen capture is not supported in this browser.');
      return;
    }

    try {
      // Prompt the user ONCE; keep the stream alive across captures.
      this.captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 }, // ~1fps is plenty for periodic snapshots
        audio: false,
      });
    } catch {
      // User dismissed the picker or denied permission.
      this.captureError.set('Screen share was cancelled.');
      return;
    }

    // If the user hits the browser's native "Stop sharing" bar.
    const track = this.captureStream.getVideoTracks()[0];
    track?.addEventListener('ended', () => this.stopScreenCapture());

    this.isCapturing.set(true);
    this.screenshotsSent.set(0);
    this.screenshotsFailed.set(0);

    // Fire one immediately for fast feedback, then on the interval.
    this.captureAndUpload();
    this.captureTimer = setInterval(
      () => this.captureAndUpload(),
      this.captureIntervalMs,
    );
  }

  stopScreenCapture(): void {
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((t) => t.stop());
      this.captureStream = null;
    }
    this.captureVideo = null;
    this.isCapturing.set(false);
  }

  private async captureAndUpload(): Promise<void> {
    const sid = this.session()?._id;
    if (!sid || !this.captureStream) {
      this.stopScreenCapture();
      return;
    }
    try {
      const dataUrl = await this.grabFrame();
      await firstValueFrom(
        this.http.post(`${BASE_URL}/${sid}/screenshots`, {
          imageUrl: dataUrl,
          capturedAt: new Date().toISOString(),
        }),
      );
      this.screenshotsSent.update((n) => n + 1);
    } catch (e: any) {
      this.screenshotsFailed.update((n) => n + 1);
      this.captureError.set(
        e?.error?.message ?? e?.message ?? 'Screenshot upload failed',
      );
    }
  }

  /** Draw the current frame of the shared screen to a JPEG data-URI. */
  private async grabFrame(): Promise<string> {
    if (!this.captureStream) throw new Error('No active capture stream');

    // A hidden <video> is more reliable than ImageCapture.grabFrame()
    // across browsers, especially when the tab is backgrounded.
    if (!this.captureVideo) {
      const v = document.createElement('video');
      v.srcObject = this.captureStream;
      v.muted = true;
      await v.play();
      await new Promise((r) => setTimeout(r, 200)); // let first frame arrive
      this.captureVideo = v;
    }

    const v = this.captureVideo;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth || 1280;
    canvas.height = v.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported');
    ctx.drawImage(v, 0, 0);

    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Frame encode failed'))),
        'image/jpeg',
        0.6,
      ),
    );

    return await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.readAsDataURL(blob);
    });
  }

  ngOnDestroy(): void {
    this.stopTimer();
    this.stopActivityPing();
    this.removeActivityListeners();
    this.stopScreenCapture();
  }
}
