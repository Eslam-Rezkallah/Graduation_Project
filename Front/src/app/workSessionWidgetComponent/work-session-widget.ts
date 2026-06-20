import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkSessionService } from '../services/work-session.service';
import { ToastService } from '../services/toast.service';

@Component({
  selector: 'app-work-session-widget',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './work-session-widget.html',
  styleUrls: ['./work-session-widget.css'],
})
export class WorkSessionWidgetComponent {
  ws = inject(WorkSessionService);
  private toast = inject(ToastService);

  isLoading = signal(false);

  async onToggleCapture() {
    const wasCapturing = this.ws.isCapturing();
    await this.ws.toggleScreenCapture();
    const err = this.ws.captureError();
    if (!wasCapturing && err) {
      this.toast.error(err);
    } else if (!wasCapturing && this.ws.isCapturing()) {
      this.toast.success('Screen capture started — uploading a snapshot every 30s.');
    } else if (wasCapturing) {
      this.toast.info('Screen capture stopped.');
    }
  }

  async onStart() {
    this.isLoading.set(true);
    await this.ws.start();
    this.isLoading.set(false);
  }

  async onPause() {
    this.isLoading.set(true);
    await this.ws.pause();
    this.isLoading.set(false);
  }

  async onResume() {
    this.isLoading.set(true);
    await this.ws.resume();
    this.isLoading.set(false);
  }

  async onStop() {
    this.isLoading.set(true);
    await this.ws.stop();
    this.isLoading.set(false);
  }
}