import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE } from './auth.service';
import { firstValueFrom } from 'rxjs';

/**
 * Reports service — connects to real backend report & metrics endpoints.
 *
 * Backend endpoints:
 *   GET /org/:orgId/spaces/:spaceId/reports/sprints/:sprintId                → sprint report
 *   GET /org/:orgId/spaces/:spaceId/reports/sprints/:sprintId/burndown       → burndown chart
 *   GET /org/:orgId/spaces/:spaceId/reports/sprints/:sprintId/burnup         → burnup chart
 *   GET /org/:orgId/spaces/:spaceId/reports/sprints/:sprintId/cumulative-flow → cumulative flow
 *   GET /org/:orgId/spaces/:spaceId/metrics/velocity?sprints=N               → velocity
 *   GET /org/:orgId/spaces/:spaceId/metrics/cycle-time                       → cycle time
 *   GET /org/:orgId/spaces/:spaceId/devops/summary                           → DevOps DORA metrics
 *   GET /org/:orgId/spaces/:spaceId/ai/sprint-completion                     → AI predictions
 *   GET /org/:orgId/spaces/:spaceId/ai/bottlenecks                           → AI bottleneck detection
 */
@Injectable({ providedIn: 'root' })
export class ReportsService {
  private http = inject(HttpClient);

  // ── Sprint Report ───────────────────────────────────────
  async getSprintReport(orgId: string, spaceId: string, sprintId: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/reports/sprints/${sprintId}`)
    );
  }

  // ── Burndown Chart ──────────────────────────────────────
  async getBurndown(orgId: string, spaceId: string, sprintId: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/reports/sprints/${sprintId}/burndown`)
    );
  }

  // ── Burnup Chart ────────────────────────────────────────
  async getBurnup(orgId: string, spaceId: string, sprintId: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/reports/sprints/${sprintId}/burnup`)
    );
  }

  // ── Cumulative Flow ─────────────────────────────────────
  async getFlow(orgId: string, spaceId: string, sprintId: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/reports/sprints/${sprintId}/cumulative-flow`)
    );
  }

  // ── Velocity ────────────────────────────────────────────
  async getVelocity(orgId: string, spaceId: string, last: number = 5): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/metrics/velocity`, {
        params: { last: last.toString() }
      })
    );
  }

  // ── Cycle Time ──────────────────────────────────────────
  async getCycleTime(orgId: string, spaceId: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/metrics/cycle-time`)
    );
  }

  // ── DevOps Summary (DORA metrics) ───────────────────────
  async getDevopsSummary(orgId: string, spaceId: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/metrics/devops/summary`)
    );
  }

  // ── AI: Sprint Completion Prediction ────────────────────
  async getAiSprintCompletion(orgId: string, spaceId: string, sprintId: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/metrics/ai/sprint-completion`, {
        params: { sprintId },
      }),
    );
  }

  // ── AI: Bottleneck Detection ────────────────────────────
  async getAiBottlenecks(orgId: string, spaceId: string, sprintId?: string): Promise<any> {
    return firstValueFrom(
      this.http.get(`${BASE}/org/${orgId}/spaces/${spaceId}/metrics/ai/bottlenecks`, {
        params: sprintId ? { sprintId } : {},
      }),
    );
  }

  // ── AI Report intelligence (employee ↔ task from uploaded files) ──
  async getAiReportEmployees(): Promise<{ count: number; employees: string[] }> {
    const res = await firstValueFrom(
      this.http.get<{ data: { count: number; employees: string[] } }>(`${BASE}/ai/reports/employees`),
    );
    return res.data;
  }

  async getAiReportTasks(query?: string): Promise<{ count: number; results: { employee: string; task: string }[] }> {
    const res = await firstValueFrom(
      this.http.get<{ data: { count: number; results: { employee: string; task: string }[] } }>(
        `${BASE}/ai/reports/tasks`,
        query ? { params: { q: query } } : {},
      ),
    );
    return res.data;
  }

  async rescanAiReports(): Promise<any> {
    const res = await firstValueFrom(
      this.http.post<{ data: any }>(`${BASE}/ai/reports/rescan`, {}),
    );
    return res.data;
  }
}