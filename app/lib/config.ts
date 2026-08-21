import { env } from "cloudflare:workers";
import { resolveNoticeConfig, type NoticeConfig } from "./notice-config";

export {
  isBootstrapAdmin,
  NoticeConfigurationError,
  resolveNoticeConfig,
} from "./notice-config";
export type {
  NoticeBindings,
  NoticeConfig,
  NoticeMode,
} from "./notice-config";

/**
 * Production is the default. Evaluation behavior is available only when the runtime
 * explicitly sets NOTICE_APP_MODE=evaluation; an unset or misspelled mode never enables
 * the synthetic identity.
 */
export function getNoticeConfig(): NoticeConfig {
  return resolveNoticeConfig(env as unknown as Record<string, unknown>);
}
