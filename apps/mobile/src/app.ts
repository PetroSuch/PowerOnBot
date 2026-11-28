import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { POSSIBLE_GROUPS, type ScheduleResponse } from '@poweron/shared';

const groupsKey = 'poweron.groups';
const pushKey = 'poweron.pushDevice';
const timeFormat = new Intl.DateTimeFormat('uk-UA', {
  timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short',
});
const calendar = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
});
type View = 'schedule' | 'groups' | 'notifications';

function savedGroups(): string[] {
  try {
    const groups: unknown = JSON.parse(localStorage.getItem(groupsKey) ?? '[]');
    return Array.isArray(groups) ? POSSIBLE_GROUPS.filter((group) => groups.includes(group)) : [];
  } catch {
    return [];
  }
}

function newDeviceToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
  protected readonly device = signal(localStorage.getItem(pushKey));
  private signedIn = false;
  protected readonly serverWatching = signal(true);
  protected readonly pushEnabled = computed(() => !!this.device() && this.pushAvailable && Notification.permission === 'granted');
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
    void this.loadAccount().then(() => fetch('/api/push/config'))
      .then(async (response) => {
        if (response.ok) {
          const config = await response.json() as { publicKey: string | null };
          this.publicKey.set(config.publicKey);
          if (this.pushEnabled() && config.publicKey) await this.restorePush(config.publicKey);
        }
      })
      .catch(() => this.pushMessage.set('Налаштування сповіщень тимчасово недоступні.'));
  }

  private async loadAccount() {
    try {
      const response = await fetch('/api/me');
      if (!response.ok) return;
      const account = await response.json() as { groups: string[] };
      this.signedIn = true;
      this.groups.set(account.groups);
    } catch {
      // Public schedules remain available offline.
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
    const token = this.device();
    this.changingPush.set(true);
    this.groupError.set('');
    try {
      if (this.signedIn) {
        const response = await fetch('/api/me/groups', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
        });
        if (!response.ok) throw new Error('Could not save account groups');
      } else if (token) {
        if (!next.length) {
          await this.disablePush(token);
        } else {
          const subscription = await firstValueFrom(this.swPush.subscription);
          if (!subscription) throw new Error('Push subscription missing');
          await this.savePush(token, subscription, next);
        }
      }
      this.groups.set(next);
      if (!this.signedIn) localStorage.setItem(groupsKey, JSON.stringify(next));
    } catch {
      this.groupError.set('Не вдалося зберегти групи. Спробуйте ще раз.');
    } finally {
      this.changingPush.set(false);
    }
  }

  protected async togglePush() {
    const key = this.publicKey();
    if (!key || !this.pushAvailable || this.changingPush() || !this.groups().length) return;
    this.changingPush.set(true);
    this.pushMessage.set('');
    let newSubscription: PushSubscription | undefined;
    try {
      const token = this.device();
      if (token) {
        await this.disablePush(token);
      } else {
        // Call the permission prompt directly from the button activity for iOS.
        if (await Notification.requestPermission() !== 'granted') {
          this.pushMessage.set('Дозвольте сповіщення в налаштуваннях пристрою.');
          return;
        }
        newSubscription = await this.swPush.requestSubscription({ serverPublicKey: key });
        const newToken = newDeviceToken();
        await this.savePush(newToken, newSubscription, this.groups());
        localStorage.setItem(pushKey, newToken);
        this.device.set(newToken);
        this.serverWatching.set(true);
      }
    } catch {
      await newSubscription?.unsubscribe().catch(() => {});
      this.pushMessage.set('Не вдалося змінити сповіщення. Спробуйте ще раз.');
    } finally {
      this.changingPush.set(false);
    }
  }

  private async restorePush(key: string) {
    const token = this.device();
    if (!token || this.changingPush()) return;
    this.changingPush.set(true);
    try {
      const response = await fetch('/api/push/subscription', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 404) throw new Error('Push settings unavailable');
      let effectiveGroups = this.groups();
      if (response.ok) {
        const preferences = await response.json() as { groups: string[]; watching: boolean };
        effectiveGroups = this.signedIn && this.groups().length ? this.groups() : preferences.groups;
        if (!this.signedIn) {
          this.groups.set(preferences.groups);
          localStorage.setItem(groupsKey, JSON.stringify(preferences.groups));
        }
        this.serverWatching.set(preferences.watching);
      }
      const current = await firstValueFrom(this.swPush.subscription);
      if (effectiveGroups.length && (!current || response.status === 404 || this.signedIn)) {
        const subscription = current ?? await this.swPush.requestSubscription({ serverPublicKey: key });
        await this.savePush(token, subscription, effectiveGroups);
        if (this.signedIn) await this.loadAccount();
      }
    } catch {
      this.pushMessage.set('Не вдалося перевірити підписку на сповіщення.');
    } finally {
      this.changingPush.set(false);
    }
  }

  private async savePush(token: string, subscription: PushSubscription, groups: string[]) {
    const response = await fetch('/api/push/subscription', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON(), groups }),
    });
    if (!response.ok) throw new Error('Push registration failed');
  }

  private async disablePush(token: string) {
    const response = await fetch('/api/push/subscription', {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) throw new Error('Push unsubscribe failed');
    localStorage.removeItem(pushKey);
    this.device.set(null);
    await this.swPush.unsubscribe().catch(() => {});
  }
}
