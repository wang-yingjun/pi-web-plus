import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startScheduledJobScheduler } from "@/lib/scheduled-job-runner";
import { startDotDispatchWorker } from "@/lib/dot-dispatch-worker";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();

  // The scheduler is process-global and must outlive individual requests; it
  // polls the on-disk job store and fires due jobs through the agent runtime.
  startScheduledJobScheduler();

  // Dot plan dispatch runs in the background so approving a plan never blocks
  // the request, and a busy target session is retried instead of dropped.
  startDotDispatchWorker();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);
}
