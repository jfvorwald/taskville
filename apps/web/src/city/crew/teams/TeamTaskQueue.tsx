import { useData } from "../../../data/react.ts";
import { type DataStore, dataStore } from "../../../data/store.ts";
import { QUEUE_PAGE_SIZE, useQueuePage } from "./pages.ts";
import { dispatchQueue } from "./queue.ts";

function TeamPage({ teamId, store }: { teamId: string; store: DataStore }) {
  const state = useData((s) => s.state, store);
  const { page, move } = useQueuePage(store, teamId);
  if (!state) return null;
  const team = state.teams[teamId];
  const queue = dispatchQueue(state, teamId);
  const count = Math.max(1, Math.ceil(queue.length / QUEUE_PAGE_SIZE));
  return (
    <section aria-label={`Team tasks: ${team?.name ?? teamId}`}>
      <h3>{team?.name ?? "Team tasks"}</h3>
      <ul>
        {queue.slice(page * QUEUE_PAGE_SIZE, (page + 1) * QUEUE_PAGE_SIZE).map((task) => (
          <li key={task.taskId}>
            <span>{task.title ?? task.taskId}</span> <span>({task.state})</span>
          </li>
        ))}
      </ul>
      {queue.length === 0 && <p>No tasks yet</p>}
      <button type="button" disabled={page === 0} onClick={() => move(-1)}>
        Previous
      </button>
      <span aria-live="polite">
        {" "}
        Page {page + 1} of {count}{" "}
      </span>
      <button type="button" disabled={page + 1 === count} onClick={() => move(1)}>
        Next
      </button>
    </section>
  );
}

/** Literal task text and native paging controls mirror each active team's scene queue. */
export function TeamTaskQueue() {
  const state = useData((s) => s.state);
  return Object.values(state?.teams ?? {})
    .filter((team) => team.endedAt === undefined)
    .map((team) => <TeamPage key={team.id} teamId={team.id} store={dataStore} />);
}
