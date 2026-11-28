export const POSSIBLE_GROUPS: readonly string[] = [
  '1.1', '1.2', '2.1', '2.2', '3.1', '3.2',
  '4.1', '4.2', '5.1', '5.2', '6.1', '6.2',
];

export type ScheduleDay = {
  date: string;
  headers: string[];
  groups: Partial<Record<string, string>>;
  imageUrl: string;
};

export type ScheduleSnapshot = {
  fetchedAt: number;
  today?: ScheduleDay;
  tomorrow?: ScheduleDay;
};

export type ScheduleResponse = {
  snapshot?: ScheduleSnapshot;
  nextFetchAt: number;
  refreshFailed: boolean;
};

export type ManagedSubscription = {
  id: string;
  groups: string[];
  watching: boolean;
  channel: 'telegram' | 'push';
};
