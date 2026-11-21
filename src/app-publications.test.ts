import { test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { appNginxRoutePresent, checkAppNginxHostname, registerNginxProxyRoute, setAppNginxRoute } from './nginx-proxy.js';
import { controlAppPublication, projectPublishedHostnames } from './app-publications.js';

test('app HTTPS routing prevents hostname takeover, rolls back reload failures and removes only its own route', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-app-route-'));
    const previous = {
        ENABLE_NGINX_PROXY: process.env.ENABLE_NGINX_PROXY,
        NGINX_PROXY_DIR: process.env.NGINX_PROXY_DIR,
    };
    Object.assign(process.env, {
        ENABLE_NGINX_PROXY: 'true',
        NGINX_PROXY_DIR: dir,
    });
    const reload = async () => {};
    try {
        await fs.writeFile(
            path.join(dir, 'existing.conf'),
            'server { server_name existing.ex.test; }',
        );
        await expect(
            setAppNginxRoute(
                'demo',
                'app',
                { hostname: 'existing.ex.test', port: 22000 },
                reload,
            ),
        ).rejects.toThrow('already assigned');
        await expect(
            setAppNginxRoute(
                'demo',
                'app',
                { hostname: 'bad; include /secrets;', port: 22000 },
                reload,
            ),
        ).rejects.toThrow('valid hostname');
        await setAppNginxRoute(
            'demo',
            'app',
            { hostname: 'app.ex.test', port: 22000 },
            reload,
        );
        const file = path.join(
            dir,
            (await fs.readdir(dir)).find((name) => name.startsWith('app-'))!,
        );
        const original = await fs.readFile(file, 'utf8');
        expect(original).toContain('server_name app.ex.test;');
        expect(original).toContain(':22000;');
        await expect(
            setAppNginxRoute(
                'demo',
                'app',
                { hostname: 'new.ex.test', port: 22001 },
                async () => {
                    throw new Error('reload failed');
                },
            ),
        ).rejects.toThrow('reload failed');
        expect(await fs.readFile(file, 'utf8')).toBe(original);
        await expect(
            setAppNginxRoute('demo', 'app', undefined, async () => {
                throw new Error('reload failed');
            }),
        ).rejects.toThrow('reload failed');
        await expect(
            setAppNginxRoute('demo', 'app', undefined, async () => {
                throw new Error('reload still failed');
            }),
        ).rejects.toThrow('reload still failed');
        await setAppNginxRoute('demo', 'app', undefined, reload);
        expect(await fs.readdir(dir)).toEqual(['existing.conf']);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(dir, { recursive: true, force: true });
    }
});

const ENV_KEYS = ['ENABLE_NGINX_PROXY', 'NGINX_PROXY_DIR', 'NGINX_PROXY_DOMAIN', 'NGINX_PROXY_DOMAIN2'];

async function withProxyDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-app-route-'));
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
        ENABLE_NGINX_PROXY: 'true',
        NGINX_PROXY_DIR: dir,
        NGINX_PROXY_DOMAIN: 'ex.test',
        NGINX_PROXY_DOMAIN2: 'b.lin',
    });
    try {
        await run(dir);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const execCompose = async () => ({ code: 0, stdout: '0.0.0.0:23000\n', stderr: '' });
const squatter = 'server {\n    server_name victim.ex.test;\n}\n';

test('app route cannot claim another project default hostname on any configured domain', async () => {
    await withProxyDir(async (dir) => {
        const reload = async () => {};
        for (const hostname of ['victim.ex.test', 'victim.b.lin']) {
            await expect(
                setAppNginxRoute('demo', 'app', { hostname, port: 22000 }, reload),
            ).rejects.toThrow('reserved');
        }
        expect(await fs.readdir(dir)).toEqual([]);
        // Multi-label hosts under a project domain and the caller's own label stay allowed.
        await setAppNginxRoute('demo', 'app', { hostname: 'x.victim.ex.test', port: 22000 }, reload);
        const own = createHash('sha256').update(JSON.stringify(['demo', 'own'])).digest('hex').slice(0, 16);
        await setAppNginxRoute('demo', 'own', { hostname: `app-${own}.ex.test`, port: 22001 }, reload);
        await expect(
            setAppNginxRoute('other', 'own', { hostname: `app-${own}.ex.test`, port: 22001 }, reload),
        ).rejects.toThrow('reserved');
        // The publishing project's own default hostname and admin aliases are allowed; others' are not.
        await setAppNginxRoute('victim', 'app', { hostname: 'victim.ex.test', port: 22002, ownHostnames: ['victim.ex.test', 'Blog.Ex.Test.'] }, reload);
        await setAppNginxRoute('victim', 'blog', { hostname: 'blog.ex.test', port: 22003, ownHostnames: ['victim.ex.test', 'Blog.Ex.Test.'] }, reload);
        await expect(
            setAppNginxRoute('demo', 'app', { hostname: 'victim.b.lin', port: 22000, ownHostnames: ['demo.b.lin'] }, reload),
        ).rejects.toThrow('reserved');
    });
});

test('registering a project removes app routes squatting its hostnames', async () => {
    await withProxyDir(async (dir) => {
        const stackDir = path.join(dir, 'stack-victim');
        await fs.mkdir(stackDir);
        const squat = path.join(dir, 'app-squat.carapa.conf');
        const unrelated = path.join(dir, 'app-other.carapa.conf');
        await fs.writeFile(squat, squatter);
        await fs.writeFile(unrelated, 'server { server_name other.ex.test; }');
        let reloads = 0;
        const url = await registerNginxProxyRoute(
            stackDir, 'victim', execCompose, undefined, async () => { reloads++; },
        );
        expect(url).toContain('victim.ex.test');
        expect(reloads).toBe(1);
        expect((await fs.readdir(dir)).sort()).toEqual(
            ['app-other.carapa.conf', 'stack-victim', 'victim.carapa.conf'],
        );
        expect(await fs.readFile(path.join(dir, 'victim.carapa.conf'), 'utf8')).toContain('victim.ex.test');
    });
});

test('failed reload restores evicted app routes', async () => {
    await withProxyDir(async (dir) => {
        const stackDir = path.join(dir, 'stack-victim');
        await fs.mkdir(stackDir);
        const squat = path.join(dir, 'app-squat.carapa.conf');
        await fs.writeFile(squat, squatter);
        const presentAtReload: boolean[] = [];
        await expect(
            registerNginxProxyRoute(stackDir, 'victim', execCompose, undefined, async () => {
                presentAtReload.push(await fs.access(squat).then(() => true, () => false));
                throw new Error('reload failed');
            }),
        ).rejects.toThrow('reload failed');
        // Evicted before the first reload, restored before the retry reload.
        expect(presentAtReload).toEqual([false, true]);
        expect(await fs.readFile(squat, 'utf8')).toBe(squatter);
        expect((await fs.readdir(dir)).sort()).toEqual(['app-squat.carapa.conf', 'stack-victim']);
    });
});

test('status reports routeMissing instead of a ready URL once a project evicted the app hostname route', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'carapa-app-status-'));
    const settings = { NGINX_PROXY_DOMAIN: 'ex.test', INGRESS_PUBLIC_HOST: '192.168.1.10', INGRESS_STATE_HOST_DIR: '/private/ingress', INGRESS_HTTP_ALLOW_CIDRS: '172.19.0.2/32', INGRESS_SSH_ALLOW_CIDRS: '192.168.1.0/24' };
    const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
    Object.assign(process.env, settings);
    try {
        await fs.mkdir(path.join(directory, 'compose'));
        await fs.mkdir(path.join(directory, 'targets'));
        await fs.writeFile(path.join(directory, 'compose', 'demo.json'), JSON.stringify({ services: { agent: {} } }));
        await fs.writeFile(path.join(directory, 'targets', 'demo.json'), '[]');
        let routePresent = true;
        const deps = {
            directory,
            enabled: () => true,
            proxyEnabled: () => true,
            migrate: async () => {},
            reserve: async () => 22000,
            wait: async () => {},
            endpoints: async () => [{ kind: 'http', service: 'agent', targetPort: 3000, port: 22000 }],
            route: async () => {},
            checkHostname: async () => '',
            routePresent: async () => routePresent,
        } as unknown as Parameters<typeof controlAppPublication>[2]; // endpoints are partial ingress records
        await controlAppPublication('demo', { id: 'app', action: 'publish', service: 'agent', targetPort: 3000, hostname: 'shop.ex.test' }, deps);
        const present = await controlAppPublication('demo', { id: 'app', action: 'status' }, deps);
        expect(present).toMatchObject({ enabled: true, ready: true, url: 'https://shop.ex.test/' });
        expect(present).not.toHaveProperty('routeMissing');
        routePresent = false;
        const evicted = await controlAppPublication('demo', { id: 'app', action: 'status' }, deps);
        expect(evicted).toMatchObject({ enabled: true, ready: false, url: undefined, routeMissing: true, ingressUrl: present.ingressUrl });
        expect(evicted.message).toContain('unpublish and publish with another hostname');
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('published hostnames list only names nginx routes to the project: its route and live enabled apps', async () => {
    await withProxyDir(async (dir) => {
        const settings = { ENABLE_INGRESS_PROXY: 'true', INGRESS_STATE_DIR: path.join(dir, 'ingress'), INGRESS_PUBLIC_HOST: '192.168.1.10', INGRESS_STATE_HOST_DIR: '/private/ingress', INGRESS_HTTP_ALLOW_CIDRS: '172.19.0.2/32', INGRESS_SSH_ALLOW_CIDRS: '192.168.1.0/24' };
        const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
        Object.assign(process.env, settings);
        try {
            const directory = settings.INGRESS_STATE_DIR;
            const reload = async () => {};
            await fs.mkdir(path.join(dir, 'stack-demo'));
            await registerNginxProxyRoute(path.join(dir, 'stack-demo'), 'demo', execCompose, undefined, reload);
            await fs.mkdir(path.join(directory, 'compose'), { recursive: true });
            await fs.mkdir(path.join(directory, 'targets'));
            await fs.writeFile(path.join(directory, 'compose', 'demo.json'), JSON.stringify({ services: { agent: {} } }));
            await fs.writeFile(path.join(directory, 'targets', 'demo.json'), '[]');
            let port = 22000;
            const deps = {
                directory,
                enabled: () => true,
                proxyEnabled: () => true,
                migrate: async () => {},
                reserve: async () => port++,
                wait: async () => {},
                endpoints: async () => [],
                route: (project: string, id: string, target?: { hostname: string; port: number }) => setAppNginxRoute(project, id, target, reload),
                checkHostname: checkAppNginxHostname,
                routePresent: appNginxRoutePresent,
            } as unknown as Parameters<typeof controlAppPublication>[2];
            const publish = (id: string, targetPort: number, hostname: string) =>
                controlAppPublication('demo', { id, action: 'publish', service: 'agent', targetPort, hostname }, deps);
            await publish('shop', 3000, 'shop.demo.ex.test');
            await publish('old', 3001, 'old.demo.ex.test');
            await publish('evicted', 3002, 'gone.demo.ex.test');
            await controlAppPublication('demo', { id: 'old', action: 'unpublish' }, deps);
            // Publication still enabled, but its route was removed (as a claiming project does).
            await setAppNginxRoute('demo', 'evicted', undefined, reload);

            expect(await projectPublishedHostnames('demo')).toEqual(['demo.b.lin', 'demo.ex.test', 'shop.demo.ex.test']);
            expect(await projectPublishedHostnames('other')).toEqual([]);
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });
});
