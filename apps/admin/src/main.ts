import { Component, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { POSSIBLE_GROUPS, type ManagedSubscription } from '@poweron/shared';

@Component({
  selector: 'app-root',
  template: `
    <main>
      <p class="brand">PowerOn</p>
      <h1>Підписки</h1>
      <p><a href="/account.html?return=/admin/">Увійти або налаштувати двофакторний захист</a></p>
      <button type="button" [disabled]="busy()" (click)="load()">Показати підписки</button>
      <p role="status">{{ message() }}</p>
      @if (rows(); as subscriptions) {
        @for (row of subscriptions; track row.channel + row.id) {
          <div class="row">
            <strong>{{ row.channel === 'telegram' ? 'Telegram' : 'Web Push' }}</strong>
            <span>{{ row.channel === 'telegram' ? row.id : row.id.slice(0, 12) }}</span>
            <span>{{ row.groups.join(', ') }}</span>
            <span>{{ row.watching ? 'Увімкнено' : 'Вимкнено' }}</span>
            <button type="button" [disabled]="busy()" (click)="selected.set(row)">Редагувати</button>
          </div>
        } @empty { <p>Підписок ще немає.</p> }
      }
      @if (selected(); as row) {
        <section aria-labelledby="edit">
          <h2 id="edit">Редагування {{ row.channel === 'telegram' ? 'Telegram' : 'Web Push' }}</h2>
          <div class="groups">
            @for (group of groups; track group) {
              <button type="button" [attr.aria-pressed]="row.groups.includes(group)" [disabled]="busy()"
                (click)="toggleGroup(row, group)">{{ group }}</button>
            }
          </div>
          <p><label><input type="checkbox" [checked]="row.watching" [disabled]="busy()"
            (change)="selected.set({ ...row, watching: $any($event.target).checked })"> Надсилати сповіщення</label></p>
          <button type="button" [disabled]="busy() || (row.channel === 'push' && !row.groups.length)" (click)="save(row)">Зберегти</button>
          <button type="button" [disabled]="busy()" (click)="selected.set(null)">Скасувати</button>
        </section>
      }
    </main>
  `,
  styles: `
    form, .row, .groups { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
    form { margin-top: 1rem; }
    .row { padding: .5rem 0; border-bottom: 1px solid #cbd7e6; }
    button, input { font: inherit; }
    button { padding: .25rem .55rem; min-height: 2rem; }
    button[aria-pressed=true] { color: white; background: #193764; }
  `,
})
class App {
  protected readonly groups = POSSIBLE_GROUPS;
  protected readonly rows = signal<ManagedSubscription[] | null>(null);
  protected readonly selected = signal<ManagedSubscription | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal('');

  protected toggleGroup(row: ManagedSubscription, group: string) {
    const groups = POSSIBLE_GROUPS.filter((id) => id === group ? !row.groups.includes(id) : row.groups.includes(id));
    this.selected.set({ ...row, groups });
  }

  protected async load() {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set('');
    this.selected.set(null);
    try {
      const response = await this.request();
      this.rows.set(await response.json() as ManagedSubscription[]);
    } catch {
      this.rows.set(null);
      this.message.set('Потрібен обліковий запис адміністратора з підтвердженим TOTP.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async save(row: ManagedSubscription) {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set('');
    try {
      await this.request(row);
      this.rows.update((list) => list?.map((existing) =>
        existing.channel === row.channel && existing.id === row.id ? row : existing) ?? null);
      this.selected.set(null);
      this.message.set('Підписку збережено.');
    } catch {
      this.message.set('Не вдалося зберегти підписку.');
    } finally {
      this.busy.set(false);
    }
  }

  private async request(update?: ManagedSubscription) {
    const headers: Record<string, string> = {};
    if (update) headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/admin/subscriptions', {
      method: update ? 'PATCH' : 'GET',
      headers,
      body: update ? JSON.stringify(update) : undefined,
    });
    if (!response.ok) throw new Error('Admin request failed');
    return response;
  }
}

bootstrapApplication(App).catch(console.error);
