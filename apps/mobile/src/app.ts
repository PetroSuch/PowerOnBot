import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { POSSIBLE_GROUPS, type MobileDevice, type ScheduleResponse } from '@poweron/shared';

const groupsKey = 'poweron.groups';
const deviceKey = 'poweron.device';
const nameKey = 'poweron.deviceName';
const timeFormat = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short',
});
const calendar = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
});
type View = 'schedule' | 'groups' | 'notifications' | 'profile';

function savedGroups(): string[] {
  try {
    const groups: unknown = JSON.parse(localStorage.getItem(groupsKey) ?? '[]');
    return Array.isArray(groups) ? POSSIBLE_GROUPS.filter((group) => groups.includes(group)) : [];
  } catch {
    return [];
  }
}

function deviceToken(): string {
  for (const key of [deviceKey, 'poweron.pushDevice']) {
    const saved = localStorage.getItem(key);
    if (saved && /^[a-f0-9]{64}$/.test(saved)) {
      localStorage.setItem(deviceKey, saved);
      return saved;
    }
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(deviceKey, token);
  return token;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  private readonly swPush = inject(SwPush);
  protected readonly view = signal<View>('schedule');
  protected readonly selectedDay = signal<'today' | 'tomorrow'>('today');
  protected readonly possibleGroups = POSSIBLE_GROUPS;
  protected readonly groups = signal(savedGroups());
  protected readonly response = signal<ScheduleResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly changingPush = signal(false);
  protected readonly scheduleError = signal('');
  protected readonly groupError = signal('');
  protected readonly pushMessage = signal('');
  protected readonly publicKey = signal<string | null>(null);
  protected readonly pushAvailable = this.swPush.isEnabled && typeof Notification !== 'undefined'
    && typeof PushManager !== 'undefined';
  protected readonly isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  private readonly token = deviceToken();
  protected readonly name = signal(localStorage.getItem(nameKey));
  protected readonly profileMessage = signal('');
  protected readonly pushEnabled = signal(false);
  private readonly clock = signal(Date.now());
  protected readonly schedule = computed(() => {
    const snapshot = this.response()?.snapshot;
    const now = this.clock();
    const today = calendar.format(now);
    const tomorrow = calendar.format(Date.parse(`${today}T12:00:00Z`) + 24 * 60 * 60 * 1000);
    const isToday = this.selectedDay() === 'today';
    const day = isToday ? snapshot?.today : snapshot?.tomorrow;
    return { day, stale: !!day && day.date !== (isToday ? today : tomorrow) };
  });
  protected readonly updated = computed(() => {
    const at = this.response()?.snapshot?.fetchedAt;
    return at === undefined ? '' : timeFormat.format(at);
  });
  protected readonly nextFetch = computed(() => {
    const next = this.response()?.nextFetchAt ?? 0;
    return next > this.clock() ? timeFormat.format(next) : '';
  });

  protected openView(view: View, content: HTMLElement) {
    if (this.view() === view) return;
    this.view.set(view);
    window.scrollTo(0, 0);
    requestAnimationFrame(() => content.focus({ preventScroll: true }));
  }

  constructor() {
    const timer = setInterval(() => this.clock.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    void this.load();
    this.changingPush.set(true);
    void this.loadDevice()
      .catch(() => this.profileMessage.set('???????????? ???????? ????????? ??????????.'))
      .finally(() => this.changingPush.set(false));
    void this.loadPushConfig();
  }

  private async loadDevice() {
    const response = await this.deviceRequest('/api/device');
    if (response.status === 404) {
      if (this.groups().length || this.name()) await this.saveDevice(this.groups(), this.name());
      return;
    }
    if (!response.ok) throw new Error('Device profile unavailable');
    this.applyDevice(await response.json() as MobileDevice);
  }

  private async loadPushConfig() {
    try {
      const response = await fetch('/api/push/config', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('Push setup unavailable');
      const config = await response.json() as { publicKey: string | null };
      this.publicKey.set(config.publicKey);
    } catch {
      this.pushMessage.set('???????????? ????????? ????????? ??????????.');
    }
  }

  private applyDevice(device: MobileDevice) {
    this.groups.set(device.groups);
    this.name.set(device.name);
    this.pushEnabled.set(device.notificationsEnabled);
    localStorage.setItem(groupsKey, JSON.stringify(device.groups));
    if (device.name) localStorage.setItem(nameKey, device.name);
    else localStorage.removeItem(nameKey);
  }

  private deviceRequest(path: string, method = 'GET', body?: unknown) {
    const headers = new Headers({ Authorization: 'Bearer ' + this.token });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return fetch(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  }

  private async saveDevice(groups: string[], name: string | null) {
    const response = await this.deviceRequest('/api/device', 'PUT', { groups, name });
    if (!response.ok) throw new Error('Could not save device profile');
    this.applyDevice(await response.json() as MobileDevice);
  }

  protected async saveName(name: string) {
    if (this.changingPush()) return;
    this.changingPush.set(true);
    this.profileMessage.set('');
    try {
      await this.saveDevice(this.groups(), name.trim() || null);
      this.profileMessage.set('???? ?????????.');
    } catch {
      this.profileMessage.set('?? ??????? ???????? ????. ????????? ?? ???.');
    } finally {
      this.changingPush.set(false);
    }
  }

  protected async load(refresh = false) {
    if (this.loading()) return;
    this.loading.set(true);
    this.scheduleError.set('');
    try {
      const response = await fetch(refresh ? '/api/schedule/refresh' : '/api/schedule', refresh
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : undefined);
      if (!response.ok) throw new Error('Schedule request failed');
      this.response.set(await response.json() as ScheduleResponse);
    } catch {
      this.scheduleError.set('Сервер графіків недоступний. Спробуйте ще раз, коли буде з’єднання.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async toggleGroup(group: string) {
    if (this.changingPush()) return;
    const current = this.groups();
    const next = POSSIBLE_GROUPS.filter((id) => id === group ? !current.includes(id) : current.includes(id));
    this.changingPush.set(true);
    this.groupError.set('');
    try {
      await this.saveDevice(next, this.name());
    } catch {
      this.groupError.set('?? ??????? ???????? ?????. ????????? ?? ???.');
    } finally {
      this.changingPush.set(false);
    }
  }

  protected async togglePush() {
    if (this.changingPush()) return;
    const enabled = this.pushEnabled();
    const key = this.publicKey();
    if (!enabled && (!key || !this.pushAvailable || !this.groups().length)) return;
    this.changingPush.set(true);
    this.pushMessage.set('');
    let created: PushSubscription | undefined;
    try {
      if (enabled) {
        const response = await this.deviceRequest('/api/push/subscription', 'DELETE');
        if (!response.ok) throw new Error('Push unsubscribe failed');
        this.pushEnabled.set(false);
        if (this.pushAvailable) await this.swPush.unsubscribe().catch(() => {});
      } else if (key) {
        // Request permission directly from the tap for iOS.
        if (await Notification.requestPermission() !== 'granted') {
          this.pushMessage.set('????????? ?????????? ? ????????????? ????????.');
          return;
        }
        let subscription = await firstValueFrom(this.swPush.subscription);
        if (!subscription) subscription = created = await this.swPush.requestSubscription({ serverPublicKey: key });
        const response = await this.deviceRequest('/api/push/subscription', 'PUT', subscription.toJSON());
        if (!response.ok) throw new Error('Push registration failed');
        this.pushEnabled.set(true);
      }
    } catch {
      await created?.unsubscribe().catch(() => {});
      this.pushMessage.set('?? ??????? ??????? ??????????. ????????? ?? ???.');
    } finally {
      this.changingPush.set(false);
    }
  }
}
