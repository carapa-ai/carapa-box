import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    atomicJson,
    ingressDirectory,
    ingressEnabled,
    ingressSettings,
    isValidIngressIdentifier,
    listIngressEndpoints,
    requireIngressMigration,
    reserveIngressPort,
    waitIngressRoute,
} from './ingress.js';
import {
    appNginxRoutePresent,
    checkAppNginxHostname,
    configuredNginxProxyDomains,
    listNginxProxyUrls,
    nginxProxyEnabled,
    setAppNginxRoute,
} from './nginx-proxy.js';

export interface AppPublication {
    id: string;
    enabled: boolean;
    service: string;
    targetPort: number;
    port: number;
    hostname?: string;
}
export interface PublicationRequest {
    action: 'status' | 'publish' | 'unpublish';
    id: string;
    service?: string;
    targetPort?: number;
    hostname?: string;
    /** The project's default hostnames and admin-configured proxy aliases. */
    ownHostnames?: string[];
}
const validId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
export function publicationFile(
    directory: string,
    project: string,
    id: string,
) {
    if (!isValidIngressIdentifier(project) || !validId(id))
        throw new Error('Invalid app publication identity');
    return path.join(directory, 'publications', project, `${id}.json`);
}
export async function readPublications(
    directory: string,
    project: string,
): Promise<AppPublication[]> {
    const parent = path.dirname(publicationFile(directory, project, 'app'));
    const names = await fs.readdir(parent).catch((error: any) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    return Promise.all(
        names
            .filter((name) => name.endsWith('.json'))
            .map(async (name) => {
                const value = JSON.parse(
                    await fs.readFile(
                        publicationFile(directory, project, name.slice(0, -5)),
                        'utf8',
                    ),
                ) as AppPublication;
                if (
                    value.id !== name.slice(0, -5) ||
                    typeof value.enabled !== 'boolean' ||
                    !isValidIngressIdentifier(value.service) ||
                    !Number.isInteger(value.targetPort) ||
                    value.targetPort < 1024 ||
                    value.targetPort > 65535 ||
                    value.targetPort === 2222 ||
                    !Number.isInteger(value.port) ||
                    value.port < 1024 ||
                    value.port > 65535
                )
                    throw new Error('Invalid app publication state');
                return value;
            }),
    );
}

/**
 * Hostnames the host nginx currently routes to this project: its registered
 * project route and its enabled app publications whose route still exists
 * (a project that later claimed the name evicts the app route).
 */
export async function projectPublishedHostnames(project: string): Promise<string[]> {
    if (!nginxProxyEnabled() || !isValidIngressIdentifier(project)) return [];
    const names = (await listNginxProxyUrls(project)).map((url) => new URL(url).hostname);
    if (ingressEnabled()) {
        for (const item of await readPublications(ingressDirectory(), project)) {
            if (item.enabled && item.hostname && (await appNginxRoutePresent(project, item.id))) names.push(item.hostname);
        }
    }
    return [...new Set(names)].sort();
}

// Serializes intent changes and hostname allocation in the persistent controller.
let mutationTail: Promise<unknown> = Promise.resolve();
export async function controlAppPublication(
    project: string,
    request: PublicationRequest,
    deps = {
        directory: ingressDirectory(),
        enabled: ingressEnabled,
        proxyEnabled: nginxProxyEnabled,
        migrate: requireIngressMigration,
        reserve: reserveIngressPort,
        wait: waitIngressRoute,
        endpoints: listIngressEndpoints,
        route: setAppNginxRoute,
        checkHostname: checkAppNginxHostname,
        routePresent: appNginxRoutePresent,
    },
) {
    const operation = async () => {
        const file = publicationFile(deps.directory, project, request.id);
        const entries = await readPublications(deps.directory, project);
        const previous = entries.find((item) => item.id === request.id);
        const describe = async (publication?: AppPublication) => {
            const endpoints = deps.enabled()
                ? await deps.endpoints(project)
                : [];
            // A project that later claims the hostname evicts the app's route.
            const routeMissing =
                !!publication?.enabled &&
                !!publication.hostname &&
                deps.proxyEnabled() &&
                !(await deps.routePresent(project, request.id));
            const ready =
                !!publication?.enabled &&
                !routeMissing &&
                endpoints.some(
                    (item) =>
                        item.kind === 'http' &&
                        item.service === publication.service &&
                        item.targetPort === publication.targetPort &&
                        item.port === publication.port,
                );
            const host =
                publication && deps.enabled()
                    ? ingressSettings().host
                    : undefined;
            return {
                id: request.id,
                enabled: publication?.enabled ?? false,
                ready,
                service: publication?.service,
                targetPort: publication?.targetPort,
                hostname: publication?.hostname,
                host,
                port: publication?.port,
                url:
                    publication?.enabled && host
                        ? publication.hostname
                            ? routeMissing
                                ? undefined
                                : `https://${publication.hostname}/`
                            : `http://${host}:${publication.port}/`
                        : undefined,
                ...(routeMissing && {
                    routeMissing: true,
                    message:
                        "The app's hostname route was removed because a project now uses this hostname; unpublish and publish with another hostname",
                }),
                ingressUrl:
                    publication?.enabled && host
                        ? `http://${host}:${publication.port}/`
                        : undefined,
            };
        };
        if (request.action === 'status') return describe(previous);
        if (request.action === 'unpublish') {
            if (previous)
                await atomicJson(file, { ...previous, enabled: false });
            await deps.route(project, request.id, undefined);
            if (previous && deps.enabled())
                await deps.wait(previous.port, false);
            return describe(
                previous ? { ...previous, enabled: false } : undefined,
            );
        }
        if (request.action !== 'publish')
            throw new Error('Invalid publication action');
        if (!deps.enabled())
            throw new Error(
                'App publishing requires the CarapaBox ingress proxy',
            );
        if (!request.service || !isValidIngressIdentifier(request.service))
            throw new Error('Invalid app service');
        if (
            !Number.isInteger(request.targetPort) ||
            request.targetPort! < 1024 ||
            request.targetPort! > 65535 ||
            request.targetPort === 2222
        )
            throw new Error(
                'App port must be 1024–65535, excluding the managed SSH port',
            );
        await deps.migrate(project);
        const model = JSON.parse(
            await fs.readFile(
                path.join(deps.directory, 'compose', `${project}.json`),
                'utf8',
            ),
        );
        if (!Object.hasOwn(model.services ?? {}, request.service))
            throw new Error('App service does not belong to this sandbox');
        const staticTargets = JSON.parse(
            await fs.readFile(
                path.join(deps.directory, 'targets', `${project}.json`),
                'utf8',
            ),
        ) as { service: string; targetPort: number }[];
        if (
            staticTargets.some(
                (target) =>
                    target.service === request.service &&
                    target.targetPort === request.targetPort,
            ) ||
            entries.some(
                (item) =>
                    item.enabled &&
                    item.id !== request.id &&
                    item.service === request.service &&
                    item.targetPort === request.targetPort,
            )
        ) {
            throw new Error(
                'This service port is already published by another route; use that route or choose a dedicated app port',
            );
        }
        const proxy = deps.proxyEnabled();
        if (request.hostname && !proxy)
            throw new Error(
                'A hostname requires CarapaBox nginx proxy integration',
            );
        // The full stack + Board publication ID can exceed nginx's default
        // server-name hash bucket, even while remaining valid DNS. Keep the
        // automatic label compact and unambiguous; custom hostnames are unchanged.
        const defaultLabel = `app-${createHash('sha256')
            .update(JSON.stringify([project, request.id]))
            .digest('hex')
            .slice(0, 16)}`;
        const hostname = proxy
            ? request.hostname?.trim().toLowerCase().replace(/\.$/, '') ||
              `${defaultLabel}.${configuredNginxProxyDomains()[0]}`
            : undefined;
        // Reject an unavailable hostname before revoking or replacing anything,
        // so a refused name never takes the current publication offline.
        if (hostname)
            await deps.checkHostname(
                project,
                request.id,
                hostname,
                request.ownHostnames,
            );
        const port = await deps.reserve({
            project,
            service: request.service,
            targetPort: request.targetPort!,
            kind: 'http',
        });
        const next: AppPublication = {
            id: request.id,
            enabled: true,
            service: request.service,
            targetPort: request.targetPort!,
            port,
            hostname,
        };
        // Revoke the old target before activating a replacement. A failure leaves
        // the new intent disabled, never an unreported live endpoint.
        if (previous?.enabled && previous.port !== port) {
            await atomicJson(file, { ...previous, enabled: false });
            await deps.wait(previous.port, false);
        }
        try {
            await deps.route(
                project,
                request.id,
                hostname
                    ? { hostname, port, ownHostnames: request.ownHostnames }
                    : undefined,
            );
            await atomicJson(file, next);
            await deps.wait(port);
        } catch (error) {
            await atomicJson(file, { ...next, enabled: false });
            await deps.route(project, request.id, undefined).catch(() => {});
            throw error;
        }
        return describe(next);
    };
    const result = mutationTail.then(operation, operation);
    mutationTail = result.catch(() => {});
    return result;
}
