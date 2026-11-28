import { Component, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { POSSIBLE_GROUPS, type ScheduleResponse } from '@poweron/shared';

@Component({
  selector: 'app-root',
  template: `
    <main>
      <p class="brand">PowerOn</p>
      <h1>Графік відключень</h1>
      <p><a href="/">Встановити мобільний застосунок</a></p>
      <p><a href="/account.html?return=/web/">Акаунт і синхронізація</a></p>
      <label for="group">Група </label>
      <select id="group" (change)="group.set($any($event.target).value)">
        @if (accountGroups().length) { <option value="">Мої групи</option> }
        <option value="all">Усі групи</option>
        @for (id of groups; track id) { <option [value]="id">{{ id }}</option> }
      </select>
      <button type="button" [disabled]="loading()" (click)="load(true)">Оновити</button>
      @if (error()) { <p role="alert">{{ error() }}</p> }
      @if (data()?.refreshFailed) { <p>Джерело графіків тимчасово недоступне.</p> }
      @if (data()?.snapshot; as snapshot) {
        @for (day of [snapshot.today, snapshot.tomorrow]; track $index) {
          @if (day) {
            <section>
              <h2>{{ day.date.split('-').reverse().join('.') }}</h2>
              @for (id of (group() === 'all' ? groups : group() ? [group()] : accountGroups()); track id) {
                <p><strong>{{ id }}</strong> · {{ day.groups[id] ?? 'Графік ще недоступний.' }}</p>
              }
            </section>
          }
        }
      } @else if (!loading()) {
        <p>Збереженого графіка ще немає.</p>
      }
    </main>
  `,
  styles: `
    select, button { font: inherit; min-height: 2.5rem; margin-inline-end: .5rem; }
    section p { border-bottom: 1px solid #cbd7e6; padding-bottom: .5rem; }
  `,
})
class App {
  protected readonly groups = POSSIBLE_GROUPS;
  protected readonly group = signal('all');
  protected readonly accountGroups = signal<string[]>([]);
  protected readonly data = signal<ScheduleResponse | null>(null);
  protected readonly error = signal('');
  protected readonly loading = signal(false);

  constructor() {
    void this.load();
    void fetch('/api/me').then(async (response) => {
      if (!response.ok) return;
      const account = await response.json() as { groups: string[] };
      this.accountGroups.set(account.groups);
      if (account.groups.length) this.group.set('');
    }).catch(() => {});
  }

  protected async load(refresh = false) {
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await fetch(refresh ? '/api/schedule/refresh' : '/api/schedule', refresh
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : undefined);
      if (!response.ok) throw new Error('Schedule unavailable');
      this.data.set(await response.json() as ScheduleResponse);
    } catch {
      this.error.set('Не вдалося завантажити графік.');
    } finally {
      this.loading.set(false);
    }
  }
}

bootstrapApplication(App).catch(console.error);
