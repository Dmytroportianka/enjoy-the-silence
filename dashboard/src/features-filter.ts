/** Pure search/filter logic for the Features (work-order) board. */

export interface WorkOrderLike {
  id: string;
  title: string;
  prompt?: string;
  state: string;
  taskType: string;
  tags?: string[];
  projectId: string;
  lane?: string;
}

export interface WorkOrderFilters {
  query: string;
  projectId?: string;
  state?: string;
}

const normalize = (value: string) => value.trim().toLowerCase();

function haystack(task: WorkOrderLike, projectName: (projectId: string) => string): string {
  return [
    task.id,
    task.title,
    task.prompt ?? "",
    task.state,
    task.taskType,
    task.lane ?? "",
    task.projectId,
    projectName(task.projectId),
    ...(task.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

/** Every whitespace-separated query token must appear somewhere in the order. */
export function filterWorkOrders<T extends WorkOrderLike>(
  tasks: readonly T[],
  filters: WorkOrderFilters,
  projectName: (projectId: string) => string,
): T[] {
  const tokens = normalize(filters.query).split(/\s+/).filter(Boolean);
  return tasks.filter((task) => {
    if (filters.projectId && task.projectId !== filters.projectId) return false;
    if (filters.state && task.state !== filters.state) return false;
    if (tokens.length === 0) return true;
    const text = haystack(task, projectName);
    return tokens.every((token) => text.includes(token));
  });
}

export function countByProject(tasks: readonly WorkOrderLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  return counts;
}

export function countByState(tasks: readonly WorkOrderLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  return counts;
}

export function hasActiveWorkOrderFilters(filters: WorkOrderFilters): boolean {
  return Boolean(normalize(filters.query) || filters.projectId || filters.state);
}
