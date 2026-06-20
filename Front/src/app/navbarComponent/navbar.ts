import { Component, inject, signal, computed, HostListener, OnInit } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { RouterModule }  from '@angular/router';
import { Router }        from '@angular/router';
import { HttpClient }    from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService, BASE } from '../services/auth.service';
import { RoleService }   from '../services/role.service';
import { ThemeService }  from '../services/theme.service';
import { WorkSessionWidgetComponent } from '../workSessionWidgetComponent/work-session-widget';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, RouterModule, WorkSessionWidgetComponent],
  templateUrl: './navbar.html',
  styleUrls: ['./navbar.css'],
})
export class NavbarComponent implements OnInit {
  private authService = inject(AuthService);
  private roleService = inject(RoleService);
  private router      = inject(Router);
  private http        = inject(HttpClient);
  themeService        = inject(ThemeService);

  user     = this.authService.currentUser;
  menuOpen = signal(false);

  // ── Organization switcher ──────────────────────────────────
  orgs        = signal<any[]>([]);
  orgMenuOpen = signal(false);

  /** The org the user is currently working in (matches user().orgId). */
  currentOrg = computed(() =>
    this.orgs().find((o) => o._id === this.user()?.orgId) ?? null,
  );

  currentOrgName(): string {
    return this.currentOrg()?.name ?? 'Workspace';
  }

  async ngOnInit(): Promise<void> {
    if (!this.authService.isLoggedIn()) return;
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: { organizations: any[] } }>(`${BASE}/org/me`),
      );
      this.orgs.set(res?.data?.organizations ?? []);
    } catch {
      // Non-fatal — the switcher just won't list anything.
    }
  }

  toggleOrgMenu(): void {
    this.orgMenuOpen.set(!this.orgMenuOpen());
    this.menuOpen.set(false);
  }

  /**
   * Switch the active organization. Persists the new orgId + membership
   * role, then does a full reload so every screen re-fetches its data
   * scoped to the new org (signals read orgId at init, so a soft route
   * change wouldn't refresh already-loaded components).
   */
  switchOrg(org: any): void {
    this.orgMenuOpen.set(false);
    if (!org?._id || org._id === this.user()?.orgId) return;
    this.authService.updateUser({ orgId: org._id, role: org.memberRole });
    window.location.href = '/dashboard';
  }

  get userInitial(): string {
    return this.user()?.fullName?.charAt(0)?.toUpperCase() ?? '?';
  }

  /** Avatar URL from the (Cloudinary) image object, if the user has one. */
  get avatarUrl(): string | null {
    const img = this.user()?.image;
    if (!img) return null;
    return typeof img === 'string' ? img : (img.secure_url ?? img.url ?? null);
  }

  roleName(): string {
    const r = this.roleService.role();
    return r === 'owner' ? 'Owner' : r === 'admin' ? 'Admin' : 'Member';
  }

  isAdmin(): boolean { return this.roleService.isAdmin(); }

  toggleMenu(): void {
    this.menuOpen.set(!this.menuOpen());
    this.orgMenuOpen.set(false);
  }

  logout(): void {
    this.menuOpen.set(false);
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('app-navbar')) {
      this.menuOpen.set(false);
      this.orgMenuOpen.set(false);
    }
  }
}