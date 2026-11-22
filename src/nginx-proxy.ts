import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { execDocker, fileExists } from "./utils.js";
import { logger } from "./logger.js";
import type { ComposeResult } from "./compose/client.js";
import { ingressEnabled, reserveIngressPort, waitIngressRoute } from './ingress.js';
import { ingressComposePath } from './compose/ingress.js';

type ExecCompose = (
    stackDir: string,
    args: string[],
    options: { projectName: string; allowFailure: boolean },
) => Promise<ComposeResult>;

const ROUTE_SUFFIX = ".carapa.conf";

export function nginxProxyEnabled(): boolean {
    const value = process.env.ENABLE_NGINX_PROXY?.trim().toLowerCase();
    return value === "true" || value === "1";
}

function routesDir(): string | undefined {
    if (!nginxProxyEnabled()) return undefined;
    const value = process.env.NGINX_PROXY_DIR?.trim();
    return value || undefined;
}

function safeProjectLabel(projectName: string): string {
    return projectName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function hashSuffix(lowered: string): string {
    return createHash("sha256").update(lowered).digest("hex").slice(0, 8);
}

/**
 * Route file label for a project. Names that sanitizing alters beyond case
 * (`a_b`, `a--b`) get a hash suffix so they never share a file with a
 * different project such as `a-b`.
 */
function projectRouteLabel(projectName: string): string {
    const label = safeProjectLabel(projectName);
    const lowered = projectName.toLowerCase();
    return !label || label === lowered ? label : `${label}-${hashSuffix(lowered)}`;
}

export function defaultNginxProxyLabel(
    stackDir: string,
    projectName: string,
): string {
    const stackName = path.basename(stackDir).toLowerCase();
    const stackLabel = safeProjectLabel(stackName);
    const lowered = projectName.toLowerCase();
    const projectLabel = safeProjectLabel(projectName);
    const instancePrefix = `${stackLabel}-`;
    const hasInstance = !!stackLabel && projectLabel.startsWith(instancePrefix);
    const label = hasInstance ? projectLabel.slice(instancePrefix.length) : projectLabel;
    // Hash only the instance part that sanitizing altered, so readable names
    // such as `my_stack-dev` -> `dev` keep their hostname.
    const rawInstance = [`${stackName}-`, instancePrefix].find((prefix) => hasInstance && lowered.startsWith(prefix));
    const rawLabel = rawInstance ? lowered.slice(rawInstance.length) : lowered;
    return !label || rawLabel === label ? label : `${label}-${hashSuffix(lowered)}`;
}

export function configuredNginxProxyDomains(
    env: {
        NGINX_PROXY_DOMAIN?: string;
        NGINX_PROXY_DOMAIN2?: string;
    } = process.env as {
        NGINX_PROXY_DOMAIN?: string;
        NGINX_PROXY_DOMAIN2?: string;
    },
): string[] {
    const primary = env.NGINX_PROXY_DOMAIN?.trim() || "carapa.box";
    const secondary = env.NGINX_PROXY_DOMAIN2?.trim();
    return [...new Set(
        [primary, secondary]
            .filter((domain): domain is string => !!domain)
            .map((domain) =>
                domain.toLowerCase().replace(/^\.+|\.+$/g, ""),
            ),
    )];
}

export function defaultNginxProxyHostnames(
    stackDir: string,
    projectName: string,
    domains: string[],
): string[] {
    const label = defaultNginxProxyLabel(stackDir, projectName);
    return domains.map((domain) => `${label}.${domain}`);
}

function appRoutePath(dir: string, identity: string): string {
    return path.join(dir, `app-${identity}${ROUTE_SUFFIX}`);
}

function routePath(projectName: string): string | undefined {
    const dir = routesDir();
    const label = projectRouteLabel(projectName);
    if (!dir || !label) return undefined;
    return path.join(dir, `${label}${ROUTE_SUFFIX}`);
}

function aliasesPath(projectName: string): string | undefined {
    const destination = routePath(projectName);
    return destination ? destination.replace(/\.carapa\.conf$/, ".aliases.json") : undefined;
}

async function readProjectAliases(projectAliasesFile: string | undefined): Promise<string[]> {
    if (!projectAliasesFile || !(await fileExists(projectAliasesFile))) return [];
    return validateAliases(
        JSON.parse(await fsp.readFile(projectAliasesFile, "utf8")),
        projectAliasesFile,
        "aliases",
    );
}

function parsePublishedPort(output: string): number | undefined {
    for (const line of output.split(/\r?\n/)) {
        const match = line.trim().match(/:(\d+)$/);
        if (!match) continue;
        const port = Number(match[1]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    }
    return undefined;
}

export function renderRoute(hostnames: string[], port: number, upstreamHost = 'host.docker.internal'): string {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(upstreamHost)) {
        throw new Error('Invalid nginx proxy upstream host');
    }
    const uniqueHostnames = [...new Set(hostnames)];
    return `server {
    listen 80;
    listen 443 ssl;
    server_name ${uniqueHostnames.join(" ")};

    location / {
        proxy_pass http://${upstreamHost}:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
}

function toHttpsUrls(hostnames: string[]): string[] {
    return hostnames.map((hostname) => `https://${hostname}/`);
}

type ExtraRoute = {
    hostname: string;
    aliases: string[];
    service: string;
    targetPort: number;
};

type ProxyRouteConfig = {
    primaryAliases: string[];
    routes: ExtraRoute[];
};

type IngressComposeModel = {
    services?: Record<string, unknown>;
};

function validateAliases(
    aliases: unknown,
    configPath: string,
    field: string,
): string[] {
    if (aliases === undefined) return [];
    if (!Array.isArray(aliases)) throw new Error(`${configPath}: ${field} must be an array`);
    return aliases.map((value, index) => {
        const hostname = typeof value === "string"
            ? value.trim().toLowerCase().replace(/\.$/, "")
            : "";
        if (
            !hostname ||
            hostname.length > 253 ||
            !hostname.includes(".") ||
            !hostname.split(".").every(
                (label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
            )
        ) {
            throw new Error(`${configPath}: ${field}[${index}] is not a valid hostname`);
        }
        return hostname;
    });
}

async function readProxyRouteConfig(stackDir: string, domain: string): Promise<ProxyRouteConfig> {
    const configPath = path.join(stackDir, "nginx-proxy-routes.json");
    if (!(await fileExists(configPath))) return { primaryAliases: [], routes: [] };

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8")) as {
        primary?: { aliases?: unknown };
        routes?: Array<{
            label?: string;
            aliases?: unknown;
            service?: string;
            targetPort?: number;
        }>;
    };
    if (!Array.isArray(parsed.routes)) {
        throw new Error(`${configPath}: "routes" must be an array`);
    }

    const routes = parsed.routes.map((route, index) => {
        const label = route.label?.trim().toLowerCase();
        const service = route.service?.trim();
        const targetPort = Number(route.targetPort);
        if (!label || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
            throw new Error(`${configPath}: routes[${index}].label is not a valid DNS label`);
        }
        if (!service || !/^[a-zA-Z0-9_-]+$/.test(service)) {
            throw new Error(`${configPath}: routes[${index}].service is invalid`);
        }
        if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
            throw new Error(`${configPath}: routes[${index}].targetPort is invalid`);
        }
        return {
            hostname: `${label}.${domain}`,
            aliases: validateAliases(route.aliases, configPath, `routes[${index}].aliases`),
            service,
            targetPort,
        };
    });
    return {
        primaryAliases: validateAliases(parsed.primary?.aliases, configPath, "primary.aliases"),
        routes,
    };
}

/** URLs advertised to clients after a project's routes were registered successfully. */
export async function listNginxProxyUrls(projectName: string): Promise<string[]> {
    const destination = routePath(projectName);
    if (!destination) return [];
    let rendered: string;
    try { rendered = await fsp.readFile(destination, 'utf8'); }
    catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    // Advertise the registered names, not desired configuration which may not
    // have been reconciled yet. Status reads never reserve ports or reload nginx.
    const hostnames = [...rendered.matchAll(/^\s*server_name\s+([^;]+);/gm)]
        .flatMap(match => match[1].trim().split(/\s+/))
        .filter(host => /^[a-z0-9.-]+$/.test(host));
    return toHttpsUrls([...new Set(hostnames)]);
}

async function validateAndReloadNginx(): Promise<void> {
    const container = process.env.NGINX_PROXY_CONTAINER?.trim() || "nginx_app";
    const validation = await execDocker(["exec", container, "nginx", "-t"]);
    if (validation.status !== 0) {
        throw new Error(validation.stderr.trim() || "nginx -t failed");
    }
    const reload = await execDocker(["exec", container, "nginx", "-s", "reload"]);
    if (reload.status !== 0) {
        throw new Error(reload.stderr.trim() || "nginx reload failed");
    }
}

/** Write via a unique temp file so concurrent writers never share one. */
async function atomicWriteRoute(destination: string, content: string): Promise<void> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
        await fsp.writeFile(temporary, content, { mode: 0o644 });
        await fsp.rename(temporary, destination);
    } finally {
        await fsp.rm(temporary, { force: true });
    }
}

const routeTails = new Map<string, Promise<unknown>>();

/** Serialize operations per project; failures do not poison the chain. */
function serializeRoute<T>(projectName: string, operation: () => Promise<T>): Promise<T> {
    const previous = routeTails.get(projectName) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.catch(() => undefined);
    routeTails.set(projectName, tail);
    void tail.then(() => {
        if (routeTails.get(projectName) === tail) routeTails.delete(projectName);
    });
    return current;
}

/**
 * Remove controller app routes that claim hostnames now owned by a project
 * route. Best effort: never throws, since a throw would let another project
 * block this project's start.
 */
async function evictSquattingAppRoutes(
    dir: string,
    claimed: string[],
    projectName: string,
): Promise<Array<{ path: string; content: string }>> {
    const evicted: Array<{ path: string; content: string }> = [];
    const owned = new Set(claimed.map((hostname) => hostname.toLowerCase()));
    try {
        for (const name of await fsp.readdir(dir)) {
            if (!name.startsWith("app-") || !name.endsWith(ROUTE_SUFFIX)) continue;
            const file = path.join(dir, name);
            try {
                const content = await fsp.readFile(file, "utf8");
                const squatted = [...content.matchAll(/server_name\s+([^;]+);/g)]
                    .flatMap((match) => match[1].trim().split(/\s+/))
                    .filter((hostname) => owned.has(hostname.toLowerCase()));
                if (squatted.length === 0) continue;
                await fsp.rm(file);
                evicted.push({ path: file, content });
                logger.warn(
                    { projectName, file: name, hostnames: squatted },
                    "Removed app nginx route that claims a project hostname",
                );
            } catch (error) {
                logger.warn({ projectName, file: name, err: error }, "Could not inspect app nginx route");
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn({ projectName, err: error }, "Could not scan app nginx routes");
        }
    }
    return evicted;
}

/**
 * Drop hostnames that another project's route file already owns. A file owns
 * the first server_name of each of its server blocks (and its default
 * hostname on every configured domain) outright; any other name it lists is an
 * alias that only wins when its file name sorts before ours. Best effort:
 * never throws, since a throw would let another project block this start.
 */
async function findForeignHostnameClaims(
    dir: string,
    ownFile: string,
    projectName: string,
    domains: string[],
): Promise<{ primary: Map<string, string>; alias: Map<string, string> }> {
    const primary = new Map<string, string>();
    const alias = new Map<string, string>();
    try {
        const names = (await fsp.readdir(dir)).filter((name) =>
            name.endsWith(ROUTE_SUFFIX) && !name.startsWith("app-") && name !== ownFile).sort();
        for (const name of names) {
            try {
                const content = await fsp.readFile(path.join(dir, name), "utf8");
                const blocks = [...content.matchAll(/server_name\s+([^;]+);/g)]
                    .map((match) => match[1].trim().split(/\s+/).map((hostname) => hostname.toLowerCase()));
                const defaultLabel = blocks[0]?.[0]?.split(".")[0];
                for (const block of blocks) {
                    if (block[0]) primary.set(block[0], primary.get(block[0]) ?? name);
                    for (const hostname of block.slice(1)) {
                        if (!alias.has(hostname) && name < ownFile) alias.set(hostname, name);
                    }
                }
                if (defaultLabel) {
                    for (const domain of domains) {
                        const hostname = `${defaultLabel}.${domain}`;
                        if (!primary.has(hostname)) primary.set(hostname, name);
                    }
                }
            } catch (error) {
                logger.warn({ projectName, file: name, err: error }, "Could not inspect other project nginx route");
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn({ projectName, err: error }, "Could not scan other project nginx routes");
        }
    }
    return { primary, alias };
}

export function registerNginxProxyRoute(
    stackDir: string,
    projectName: string,
    execCompose: ExecCompose,
    projectAliasesJson?: string,
    reload: () => Promise<void> = validateAndReloadNginx,
): Promise<string | undefined> {
    return serializeRoute(projectName, () =>
        registerNginxProxyRouteUnlocked(stackDir, projectName, execCompose, projectAliasesJson, reload));
}

async function registerNginxProxyRouteUnlocked(
    stackDir: string,
    projectName: string,
    execCompose: ExecCompose,
    projectAliasesJson: string | undefined,
    reload: () => Promise<void>,
): Promise<string | undefined> {
    const destination = routePath(projectName);
    if (!destination) return undefined;

    const useIngress = ingressEnabled();
    if (useIngress && !await fileExists(ingressComposePath(projectName))) {
        // A published host port must never be exposed while ingress is enabled.
        logger.warn({ projectName }, "No ingress compose model; skipping host proxy route");
        return undefined;
    }
    const upstreamHost = useIngress && process.env.NGINX_PROXY_INGRESS_HOST?.trim() || 'host.docker.internal';
    let ingressModel: IngressComposeModel | undefined;
    const endpointPort = async (service: string, targetPort: number): Promise<number | undefined> => {
        if (useIngress) {
            const model = ingressModel ??= JSON.parse(await fsp.readFile(ingressComposePath(projectName), 'utf8'));
            if (!model.services?.[service]) return undefined;
            const port = await reserveIngressPort({ project: projectName, service, targetPort, kind: 'http' });
            await waitIngressRoute(port);
            return port;
        }
        const result = await execCompose(stackDir, ['port', service, String(targetPort)], { projectName, allowFailure: true });
        return result.code === 0 ? parsePublishedPort(result.stdout) : undefined;
    };
    const mainPort = await endpointPort('nginx', 80);
    if (!mainPort) {
        logger.debug({ projectName }, "No published nginx:80 port; skipping host proxy route");
        return undefined;
    }

    const domains = configuredNginxProxyDomains();
    const invalidDomainIndex = domains.findIndex(
        (domain) => !/^[a-z0-9.-]+$/.test(domain),
    );
    if (invalidDomainIndex >= 0) {
        const variable = invalidDomainIndex === 0
            ? "NGINX_PROXY_DOMAIN"
            : "NGINX_PROXY_DOMAIN2";
        throw new Error(`Invalid ${variable}: ${domains[invalidDomainIndex]}`);
    }
    const hostnames = defaultNginxProxyHostnames(
        stackDir,
        projectName,
        domains,
    );
    const url = toHttpsUrls(hostnames)[0];
    const config = await readProxyRouteConfig(stackDir, domains[0]);
    const projectAliasesFile = aliasesPath(projectName);
    let projectAliases: string[] = [];
    if (projectAliasesJson !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(projectAliasesJson);
        } catch {
            throw new Error("NGINX_PROXY_ALIASES must be a JSON array");
        }
        projectAliases = validateAliases(parsed, "project settings", "proxyHostnameAliases");
        if (projectAliasesFile) {
            await fsp.mkdir(path.dirname(projectAliasesFile), { recursive: true });
            await fsp.writeFile(projectAliasesFile, JSON.stringify(projectAliases), { mode: 0o644 });
        }
    } else {
        projectAliases = await readProjectAliases(projectAliasesFile);
    }
    config.primaryAliases = [...new Set([...config.primaryAliases, ...projectAliases])];
    const resolvedExtraRoutes: Array<ExtraRoute & { publishedPort: number }> = [];
    for (const route of config.routes) {
        const publishedPort = await endpointPort(route.service, route.targetPort);
        if (!publishedPort) {
            throw new Error(
                `No published port for ${route.service}:${route.targetPort} (${route.hostname})`,
            );
        }
        resolvedExtraRoutes.push({ ...route, publishedPort });
    }
    const claims = await findForeignHostnameClaims(
        path.dirname(destination),
        path.basename(destination),
        projectName,
        domains,
    );
    const dropForeign = (names: string[]): string[] => names.filter((hostname) => {
        const key = hostname.toLowerCase();
        const owner = claims.primary.get(key) ?? claims.alias.get(key);
        if (!owner) return true;
        logger.warn(
            { projectName, hostname, owner },
            "Dropped nginx hostname already claimed by another project route",
        );
        return false;
    });
    const primaryAliases = dropForeign(config.primaryAliases);
    const extraRoutes = resolvedExtraRoutes
        .map((route) => ({ route, names: dropForeign([route.hostname, ...route.aliases]) }))
        .filter(({ names }) => names.length > 0);
    const rendered = [
        "# Generated by CarapaBox. Manual changes will be overwritten.\n",
        renderRoute([...hostnames, ...primaryAliases], mainPort, upstreamHost),
        ...extraRoutes.map(({ route, names }) => renderRoute(names, route.publishedPort, upstreamHost)),
    ].join("");
    const previous = await fileExists(destination) ? await fsp.readFile(destination, "utf8") : undefined;
    const evicted = await evictSquattingAppRoutes(
        path.dirname(destination),
        [
            ...hostnames,
            ...primaryAliases,
            ...extraRoutes.flatMap(({ names }) => names),
        ],
        projectName,
    );
    // Background reconciliation also handles already-running stacks. Avoid
    // nginx validation/reloads when their configuration has not changed.
    if (previous === rendered && evicted.length === 0) return url;

    try {
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        if (previous !== rendered) await atomicWriteRoute(destination, rendered);
        await reload();
    } catch (error) {
        if (previous === undefined) await fsp.rm(destination, { force: true });
        else await fsp.writeFile(destination, previous, { mode: 0o644 });
        for (const file of evicted) await fsp.writeFile(file.path, file.content, { mode: 0o644 });
        await reload().catch(() => undefined);
        throw error;
    }

    logger.info(
        {
            projectName,
            hostnames,
            port: mainPort,
            extraRoutes: resolvedExtraRoutes.map((route) => ({
                hostname: route.hostname,
                port: route.publishedPort,
            })),
        },
        "Registered nginx proxy route",
    );
    return url;
}

export function unregisterNginxProxyRoute(
    projectName: string,
    reload: () => Promise<void> = validateAndReloadNginx,
): Promise<void> {
    return serializeRoute(projectName, () => unregisterNginxProxyRouteUnlocked(projectName, reload));
}

async function unregisterNginxProxyRouteUnlocked(
    projectName: string,
    reload: () => Promise<void>,
): Promise<void> {
    const destination = routePath(projectName);
    if (!destination) return;
    if (!await fileExists(destination)) return;

    const previous = await fsp.readFile(destination, "utf8");
    await fsp.rm(destination);
    try {
        await reload();
    } catch (error) {
        await fsp.writeFile(destination, previous, { mode: 0o644 });
        await reload().catch(() => undefined);
        throw error;
    }
    const projectAliasesFile = aliasesPath(projectName);
    if (projectAliasesFile) await fsp.rm(projectAliasesFile, { force: true });
    logger.info({ projectName }, "Removed nginx proxy route");
}

function appRouteIdentity(project: string, id: string): string {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(project) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid app route identity');
    return createHash("sha256").update(JSON.stringify([project, id])).digest("hex");
}

/**
 * Reject an app hostname without changing any route. `ownHostnames` are the
 * publishing project's own default hostnames and admin-configured aliases;
 * every other single-label name on a configured domain stays reserved for the
 * project whose default hostname it is.
 */
export async function checkAppNginxHostname(project: string, id: string, hostname: string, ownHostnames: string[] = []): Promise<string> {
    const identity = appRouteIdentity(project, id);
    const dir = routesDir();
    if (!dir) throw new Error('Nginx proxy integration is not configured');
    const [normalized] = validateAliases([hostname], 'app publication', 'hostname');
    const ownLabel = `app-${identity.slice(0, 16)}`;
    const own = new Set(ownHostnames.map((name) => name.trim().toLowerCase().replace(/\.$/, '')));
    for (const domain of configuredNginxProxyDomains()) {
        const label = normalized.endsWith(`.${domain}`) ? normalized.slice(0, -(domain.length + 1)) : undefined;
        if (label && !label.includes('.') && label !== ownLabel && !own.has(normalized)) throw new Error('Hostname is reserved for a project default hostname');
    }
    const destination = appRoutePath(dir, identity);
    const names = await fsp.readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    for (const name of names) {
        const other = path.join(dir, name);
        if (!name.endsWith('.conf') || other === destination) continue;
        const content = await fsp.readFile(other, 'utf8');
        if ([...content.matchAll(/server_name\s+([^;]+);/g)].some(match => match[1].split(/\s+/).includes(normalized))) throw new Error('Hostname is already assigned to another route');
    }
    return normalized;
}

/** Read-only: whether the app's generated route still exists (true when nginx integration is not configured). */
export async function appNginxRoutePresent(project: string, id: string): Promise<boolean> {
    const identity = appRouteIdentity(project, id);
    const dir = routesDir();
    if (!dir) return true;
    return fileExists(appRoutePath(dir, identity));
}

/** One controller-owned app route, independent of a stack nginx service. */
export async function setAppNginxRoute(project: string, id: string, target?: { hostname: string; port: number; ownHostnames?: string[] }, reload = validateAndReloadNginx): Promise<void> {
    const identity = appRouteIdentity(project, id);
    const dir = routesDir();
    if (!dir) { if (target) throw new Error('Nginx proxy integration is not configured'); return; }
    const destination = appRoutePath(dir, identity);
    const previous = await fileExists(destination) ? await fsp.readFile(destination, 'utf8') : undefined;
    if (!target) {
        if (previous !== undefined) await fsp.rm(destination);
        // Retry reload even when a previous failed disable already removed the file.
        await reload();
        return;
    }
    if (!Number.isInteger(target.port) || target.port < 1024 || target.port > 65535) throw new Error('Invalid app ingress port');
    const hostname = await checkAppNginxHostname(project, id, target.hostname, target.ownHostnames);
    await fsp.mkdir(dir, { recursive: true });
    const rendered = '# Generated app route by CarapaBox. Do not edit.\n' + renderRoute([hostname], target.port, process.env.NGINX_PROXY_INGRESS_HOST?.trim() || 'host.docker.internal');
    if (rendered === previous) return;
    await atomicWriteRoute(destination, rendered);
    try { await reload(); }
    catch (error) {
        if (previous === undefined) await fsp.rm(destination, { force: true });
        else await fsp.writeFile(destination, previous);
        await reload().catch(() => {});
        throw error;
    }
}
