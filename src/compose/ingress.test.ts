import { expect, test } from 'bun:test';
import { migrateIngressCompose } from './ingress.js';

test('migration removes publications and portonly while retaining workloads and private networking', () => {
    const model = { name: 'demo', services: {
        nginx: { image: 'nginx', ports: [{ target: 80, published: '30080', protocol: 'tcp' }, { target: 8081 }], networks: { internal: null, agent_egress: null, portonly: null } },
        agent: { runtime: 'runsc', ports: [{ target: 3100 }, { target: 2222 }], networks: { agent_egress: { ipv4_address: '172.20.0.100' }, portonly: null }, environment: { TOKEN: 'literal$secret' } },
    }, networks: { portonly: { driver: 'bridge' }, internal: { internal: true }, agent_egress: { name: 'agent_egress_demo', external: true } } };
    const migrated = migrateIngressCompose(model, 'demo');
    expect(migrated.model.networks.portonly).toBeUndefined();
    expect(migrated.model.services.agent.networks).toEqual({ agent_egress: { ipv4_address: '172.20.0.100' } });
    expect(migrated.model.services.agent.environment).toEqual(model.services.agent.environment);
    expect(migrated.model.services.nginx.ports).toBeUndefined();
    expect(migrated.targets).toEqual([{ service: 'nginx', targetPort: 80, kind: 'http' }, { service: 'nginx', targetPort: 8081, kind: 'http' }, { service: 'agent', targetPort: 3100, kind: 'http' }]);
    expect(model.services.nginx.ports).toHaveLength(2);
    for (const change of [(m: any) => m.services.agent.network_mode = 'host', (m: any) => m.services.nginx.ports[0].protocol = 'udp', (m: any) => m.networks.agent_egress.name = 'agent_egress_other']) {
        const invalid = structuredClone(model); change(invalid);
        expect(() => migrateIngressCompose(invalid, 'demo')).toThrow();
    }
});
