import { describe, expect, spyOn, test } from "bun:test";
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    configuredNginxProxyDomains,
    defaultNginxProxyHostnames,
    defaultNginxProxyLabel,
    renderRoute,
    listNginxProxyUrls,
    registerNginxProxyRoute,
    unregisterNginxProxyRoute,
} from "./nginx-proxy.js";
import { logger } from "./logger.js";

test('status advertises only registered proxy names and reflects route removal without recreating it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'box-proxy-status-'));
    const old = { ENABLE_NGINX_PROXY: process.env.ENABLE_NGINX_PROXY, NGINX_PROXY_DIR: process.env.NGINX_PROXY_DIR };
    try {
        process.env.ENABLE_NGINX_PROXY = 'true';
        process.env.NGINX_PROXY_DIR = root;
        expect(await listNginxProxyUrls('demo')).toEqual([]);
        const file = path.join(root, 'demo.carapa.conf');
        await fs.writeFile(file, renderRoute(['demo.ex.test', 'alias.ex.test'], 22000));
        expect(await listNginxProxyUrls('demo')).toEqual(['https://demo.ex.test/', 'https://alias.ex.test/']);
        await fs.rm(file);
        expect(await listNginxProxyUrls('demo')).toEqual([]);
        expect(await fs.readdir(root)).toEqual([]);
    } finally {
        for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        await fs.rm(root, { recursive: true, force: true });
    }
});

describe("nginx route rendering", () => {
    test("routes through a configured ingress edge without allowing nginx configuration injection", () => {
        expect(renderRoute(['app.ex.test'], 22073, '172.29.255.2')).toContain('proxy_pass http://172.29.255.2:22073;');
        for (const host of ['127.0.0.1; include /tmp/evil;', 'http://edge', 'edge/path', '']) {
            expect(() => renderRoute(['app.ex.test'], 22073, host)).toThrow('Invalid nginx proxy upstream host');
        }
    });
    test("closes the server block after its proxy location", () => {
        const route = renderRoute(["app.ex.test"], 8080);

        expect(route).toContain("server_name app.ex.test;");
        expect(route).toContain("proxy_pass http://host.docker.internal:8080;");
        expect(route).toEndWith("    }\n}\n");
    });
});

describe("default nginx proxy label", () => {
    test("uses the project instance instead of the compose stack prefix", () => {
        expect(defaultNginxProxyLabel("/app/stacks/php", "php-demo-admin")).toBe("demo-admin");
        expect(defaultNginxProxyLabel("/app/stacks/demo-site", "demo-site-demo-site")).toBe("demo-site");
    });

    test("keeps the stack label when no instance suffix exists", () => {
        expect(defaultNginxProxyLabel("/app/stacks/php", "php")).toBe("php");
    });

    test("normalizes labels before removing the stack prefix", () => {
        expect(defaultNginxProxyLabel("/app/stacks/My-Stack", "My-Stack-Demo-Project")).toBe(
            "demo-project",
        );
    });

    test("keeps labels distinct for names that differ only by _ versus -", () => {
        const underscore = defaultNginxProxyLabel("/app/stacks/demo", "demo-a_b");
        const hyphen = defaultNginxProxyLabel("/app/stacks/demo", "demo-a-b");
        expect(hyphen).toBe("a-b");
        expect(underscore).toMatch(/^a-b-[0-9a-f]{8}$/);
    });

    test("keeps readable labels for underscore stack names", () => {
        expect(defaultNginxProxyLabel("/app/stacks/my_stack", "my_stack-dev")).toBe("dev");
        expect(defaultNginxProxyLabel("/app/stacks/my_stack", "my_stack")).toMatch(/^my-stack-[0-9a-f]{8}$/);
    });
});

describe("configured nginx proxy domains", () => {
    test("keeps the existing single-domain default", () => {
        expect(configuredNginxProxyDomains({})).toEqual(["carapa.box"]);
    });

    test("supports and normalizes a second default domain", () => {
        expect(configuredNginxProxyDomains({
            NGINX_PROXY_DOMAIN: ".EX.TEST.",
            NGINX_PROXY_DOMAIN2: ".EXAMPLE.ORG.",
        })).toEqual(["ex.test", "example.org"]);
    });

    test("deduplicates identical configured domains", () => {
        expect(configuredNginxProxyDomains({
            NGINX_PROXY_DOMAIN: "ex.test",
            NGINX_PROXY_DOMAIN2: "EX.TEST",
        })).toEqual(["ex.test"]);
    });

    test("builds one default hostname per domain", () => {
        expect(defaultNginxProxyHostnames(
            "/app/stacks/php",
            "php-demo-admin",
            ["ex.test", "example.org"],
        )).toEqual(["demo-admin.ex.test", "demo-admin.example.org"]);
    });
});

describe('concurrent route registration', () => {
    const compose = (async () => ({ code: 0, stdout: '0.0.0.0:22001\n', stderr: '' })) as any;
    async function withRoutes(fn: (root: string, reloads: { n: number }, reload: () => Promise<void>) => Promise<void>) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'box-proxy-conc-'));
        const old = { a: process.env.ENABLE_NGINX_PROXY, b: process.env.NGINX_PROXY_DIR, c: process.env.NGINX_PROXY_DOMAIN };
        process.env.ENABLE_NGINX_PROXY = 'true';
        process.env.NGINX_PROXY_DIR = root;
        process.env.NGINX_PROXY_DOMAIN = 'ex.test';
        const reloads = { n: 0 };
        try { await fn(root, reloads, async () => { reloads.n++; await new Promise(r => setTimeout(r, 2)); }); }
        finally {
            if (old.a === undefined) delete process.env.ENABLE_NGINX_PROXY; else process.env.ENABLE_NGINX_PROXY = old.a;
            if (old.b === undefined) delete process.env.NGINX_PROXY_DIR; else process.env.NGINX_PROXY_DIR = old.b;
            if (old.c === undefined) delete process.env.NGINX_PROXY_DOMAIN; else process.env.NGINX_PROXY_DOMAIN = old.c;
            await fs.rm(root, { recursive: true, force: true });
        }
    }

    test('two concurrent registrations both succeed and leave no temp files', async () => {
        await withRoutes(async (root, reloads, reload) => {
            const stack = await fs.mkdtemp(path.join(os.tmpdir(), 'box-stack-'));
            try {
                const results = await Promise.all([
                    registerNginxProxyRoute(stack, 'demo', compose, undefined, reload),
                    registerNginxProxyRoute(stack, 'demo', compose, undefined, reload),
                ]);
                expect(results[0]).toBe(results[1]);
                const files = await fs.readdir(root);
                expect(files.filter(f => f.endsWith('.tmp'))).toEqual([]);
                expect(await fs.readFile(path.join(root, 'demo.carapa.conf'), 'utf8')).toContain('proxy_pass http://host.docker.internal:22001;');
                // Unchanged config skips the reload.
                expect(reloads.n).toBe(1);
                await registerNginxProxyRoute(stack, 'demo', compose, undefined, reload);
                expect(reloads.n).toBe(1);
            } finally { await fs.rm(stack, { recursive: true, force: true }); }
        });
    });

    test('register then unregister ends unregistered; unregister then register ends registered', async () => {
        await withRoutes(async (root, _reloads, reload) => {
            const stack = await fs.mkdtemp(path.join(os.tmpdir(), 'box-stack-'));
            const file = path.join(root, 'demo.carapa.conf');
            try {
                await Promise.all([
                    registerNginxProxyRoute(stack, 'demo', compose, undefined, reload),
                    unregisterNginxProxyRoute('demo', reload),
                ]);
                expect(await fs.readdir(root)).toEqual([]);
                await Promise.all([
                    unregisterNginxProxyRoute('demo', reload),
                    registerNginxProxyRoute(stack, 'demo', compose, undefined, reload),
                ]);
                expect((await fs.readdir(root)).sort()).toEqual(['demo.carapa.conf']);
                expect(await fs.readFile(file, 'utf8')).toContain('22001');
            } finally { await fs.rm(stack, { recursive: true, force: true }); }
        });
    });

    test('instances differing only by _ versus - get separate routes and survive each other\'s unregister', async () => {
        await withRoutes(async (root, _reloads, reload) => {
            const stack = await fs.mkdtemp(path.join(os.tmpdir(), 'box-stack-'));
            const composeFor = (port: number): Parameters<typeof registerNginxProxyRoute>[2] => async () => ({ code: 0, stdout: `0.0.0.0:${port}\n`, stderr: '' });
            try {
                const first = await registerNginxProxyRoute(stack, 'demo-a_b', composeFor(8001), undefined, reload);
                const second = await registerNginxProxyRoute(stack, 'demo-a-b', composeFor(8002), undefined, reload);
                expect(first).not.toBe(second);
                expect(await fs.readdir(root)).toHaveLength(2);
                await unregisterNginxProxyRoute('demo-a-b', reload);
                const left = await fs.readdir(root);
                expect(left).toHaveLength(1);
                expect(await fs.readFile(path.join(root, left[0]!), 'utf8')).toContain(':8001;');
                expect(await listNginxProxyUrls('demo-a_b')).toEqual([first!]);
            } finally { await fs.rm(stack, { recursive: true, force: true }); }
        });
    });

    test('with ingress enabled, a project without an ingress model gets no published-port route', async () => {
        await withRoutes(async (root, reloads, reload) => {
            const stack = await fs.mkdtemp(path.join(os.tmpdir(), 'box-stack-'));
            const ingressDir = await fs.mkdtemp(path.join(os.tmpdir(), 'box-ingress-'));
            const old = { a: process.env.ENABLE_INGRESS_PROXY, b: process.env.INGRESS_STATE_DIR };
            process.env.ENABLE_INGRESS_PROXY = 'true';
            process.env.INGRESS_STATE_DIR = ingressDir;
            try {
                expect(await registerNginxProxyRoute(stack, 'demo', compose, undefined, reload)).toBeUndefined();
                expect(await fs.readdir(root)).toEqual([]);
                expect(reloads.n).toBe(0);
            } finally {
                if (old.a === undefined) delete process.env.ENABLE_INGRESS_PROXY; else process.env.ENABLE_INGRESS_PROXY = old.a;
                if (old.b === undefined) delete process.env.INGRESS_STATE_DIR; else process.env.INGRESS_STATE_DIR = old.b;
                await fs.rm(stack, { recursive: true, force: true });
                await fs.rm(ingressDir, { recursive: true, force: true });
            }
        });
    });

    test('a failed registration does not poison later calls', async () => {
        await withRoutes(async (_root, _reloads, reload) => {
            const stack = await fs.mkdtemp(path.join(os.tmpdir(), 'box-stack-'));
            try {
                const failing = registerNginxProxyRoute(stack, 'demo', compose, undefined, async () => { throw new Error('boom'); });
                const ok = registerNginxProxyRoute(stack, 'demo', compose, undefined, reload);
                await expect(failing).rejects.toThrow('boom');
                await expect(ok).resolves.toContain('ex.test');
            } finally { await fs.rm(stack, { recursive: true, force: true }); }
        });
    });
});

describe('cross-project hostname claims', () => {
    const compose: Parameters<typeof registerNginxProxyRoute>[2] = async () => ({ code: 0, stdout: '0.0.0.0:22001\n', stderr: '' });
    const reload = async () => {};
    async function withRoot(fn: (root: string, stackFor: (routes?: unknown) => Promise<string>) => Promise<void>) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'box-proxy-claims-'));
        const old = { a: process.env.ENABLE_NGINX_PROXY, b: process.env.NGINX_PROXY_DIR, c: process.env.NGINX_PROXY_DOMAIN, d: process.env.NGINX_PROXY_DOMAIN2 };
        process.env.ENABLE_NGINX_PROXY = 'true';
        process.env.NGINX_PROXY_DIR = root;
        process.env.NGINX_PROXY_DOMAIN = 'ex.test';
        delete process.env.NGINX_PROXY_DOMAIN2;
        const stacks: string[] = [];
        const stackFor = async (routes?: unknown) => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'box-claims-stack-'));
            stacks.push(dir);
            if (routes) await fs.writeFile(path.join(dir, 'nginx-proxy-routes.json'), JSON.stringify(routes));
            return dir;
        };
        const warn = spyOn(logger, 'warn').mockImplementation(() => logger);
        try { await fn(root, stackFor); }
        finally {
            warn.mockRestore();
            for (const [k, v] of [['ENABLE_NGINX_PROXY', old.a], ['NGINX_PROXY_DIR', old.b], ['NGINX_PROXY_DOMAIN', old.c], ['NGINX_PROXY_DOMAIN2', old.d]] as const) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
            for (const dir of stacks) await fs.rm(dir, { recursive: true, force: true });
            await fs.rm(root, { recursive: true, force: true });
        }
    }
    const names = (conf: string) => [...conf.matchAll(/server_name\s+([^;]+);/g)].flatMap(m => m[1].trim().split(/\s+/));

    test("an alias equal to another project's default hostname is not rendered and warns", async () => {
        await withRoot(async (root, stackFor) => {
            await registerNginxProxyRoute(await stackFor(), 'victim', compose, undefined, reload);
            const warn = logger.warn as unknown as { mock: { calls: unknown[][] } };
            await registerNginxProxyRoute(await stackFor(), 'zattacker', compose, JSON.stringify(['victim.ex.test', 'ok.ex.test']), reload);
            const conf = await fs.readFile(path.join(root, 'zattacker.carapa.conf'), 'utf8');
            expect(names(conf)).toEqual(['zattacker.ex.test', 'ok.ex.test']);
            expect(warn.mock.calls.some((call: unknown[]) => JSON.stringify(call).includes('victim.ex.test') && JSON.stringify(call).includes('victim.carapa.conf'))).toBe(true);
        });
    });

    test('a shared alias stays only with the lexically first file, stably across repeated registration', async () => {
        await withRoot(async (root, stackFor) => {
            const a = await stackFor();
            const b = await stackFor();
            for (let i = 0; i < 2; i++) {
                await registerNginxProxyRoute(a, 'alpha', compose, JSON.stringify(['shared.ex.test']), reload);
                await registerNginxProxyRoute(b, 'beta', compose, JSON.stringify(['shared.ex.test']), reload);
            }
            // alpha re-registers last and must still keep it; beta never gets it.
            await registerNginxProxyRoute(a, 'alpha', compose, JSON.stringify(['shared.ex.test']), reload);
            expect(names(await fs.readFile(path.join(root, 'alpha.carapa.conf'), 'utf8'))).toContain('shared.ex.test');
            expect(names(await fs.readFile(path.join(root, 'beta.carapa.conf'), 'utf8'))).not.toContain('shared.ex.test');
        });
    });

    test('an extra-route hostname that collides with another default hostname is dropped', async () => {
        await withRoot(async (root, stackFor) => {
            await registerNginxProxyRoute(await stackFor(), 'victim', compose, undefined, reload);
            const stack = await stackFor({ routes: [{ label: 'victim', service: 'web', targetPort: 80 }, { label: 'api', service: 'web', targetPort: 80 }] });
            await registerNginxProxyRoute(stack, 'zattacker', compose, undefined, reload);
            const conf = names(await fs.readFile(path.join(root, 'zattacker.carapa.conf'), 'utf8'));
            expect(conf).not.toContain('victim.ex.test');
            expect(conf).toContain('api.ex.test');
        });
    });

    test('non-colliding aliases are unchanged and an unreadable other file does not throw', async () => {
        await withRoot(async (root, stackFor) => {
            await registerNginxProxyRoute(await stackFor(), 'other', compose, undefined, reload);
            await fs.mkdir(path.join(root, 'broken.carapa.conf')); // readFile fails with EISDIR
            await registerNginxProxyRoute(await stackFor(), 'mine', compose, JSON.stringify(['one.ex.test', 'two.ex.test']), reload);
            expect(names(await fs.readFile(path.join(root, 'mine.carapa.conf'), 'utf8'))).toEqual(['mine.ex.test', 'one.ex.test', 'two.ex.test']);
        });
    });
});
