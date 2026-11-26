import { handleGatewayRequest, type GatewayEnv } from "./gateway";
import { runScheduledHttpDiagnostics } from "./diagnostics";

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handleGatewayRequest(request, env);
  },
  async scheduled(
    _controller: { scheduledTime: number; cron: string },
    env: GatewayEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    ctx.waitUntil(runScheduledHttpDiagnostics(env));
  },
};
