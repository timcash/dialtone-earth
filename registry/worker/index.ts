import { handleGatewayRequest, type GatewayEnv } from "./gateway";

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handleGatewayRequest(request, env);
  },
};
