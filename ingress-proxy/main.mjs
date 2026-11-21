import { startProxy } from './proxy.mjs';

const proxy = await startProxy({
  bindAddress: process.env.INGRESS_EDGE_IP,
  firstPort: Number(process.env.INGRESS_PORT_START || 22000),
  lastPort: Number(process.env.INGRESS_PORT_END || 22255),
  configPath: '/app/config/routes.json', statusPath: '/run/ingress-status.json',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void proxy.close());
