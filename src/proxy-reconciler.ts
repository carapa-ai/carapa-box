import { getStacksDir } from './config.js';
import { execCompose, listProjects } from './compose/client.js';
import { resolveOwnedProjects } from './utils.js';
import { nginxProxyEnabled, registerNginxProxyRoute } from './nginx-proxy.js';
import { logger } from './logger.js';

/** Recover routes after controller/configuration changes independently of UI polling.
 * Explicit sandbox starts and alias changes still register their routes immediately.
 */
export function startNginxProxyReconciler() {
    if (!nginxProxyEnabled()) return;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const projects = await listProjects();
            for (const project of await resolveOwnedProjects(JSON.parse(projects.stdout), getStacksDir())) {
                try {
                    await registerNginxProxyRoute(project.localStackPath, project.name, execCompose);
                } catch (error) {
                    logger.warn({ projectName: project.name, err: error }, 'Could not reconcile nginx proxy route');
                }
            }
        } catch (error) {
            logger.warn({ err: error }, 'Could not discover nginx proxy projects');
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(tick, 60_000);
    timer.unref();
    return () => clearInterval(timer);
}
