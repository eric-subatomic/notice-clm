import application from "vinext/server/app-router-entry";
import { dispatchScheduledJob, type ScheduledJobBindings } from "./app/lib/scheduled-jobs";

type NoticeWorkerEnv = ScheduledJobBindings & Record<string, unknown> & {
  ASSETS?: { fetch(request: Request): Promise<Response> | Response };
};

const worker = {
  fetch(request: Request, environment: NoticeWorkerEnv, context: ExecutionContext): Promise<Response> {
    return application.fetch(request, environment, context);
  },

  scheduled(controller: ScheduledController, environment: NoticeWorkerEnv, context: ExecutionContext): void {
    context.waitUntil(dispatchScheduledJob(application, environment, context, controller.cron));
  },
};

export default worker;
