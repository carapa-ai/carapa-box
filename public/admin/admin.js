/**
 * CarapaBox Admin Dashboard Logic
 */

const API_BASE = '/api/admin';
let authToken = localStorage.getItem('carapabox_token');
let refreshTimer = null;

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initNavigation();
    initEventListeners();

    if (authToken) {
        startPolling();
    }
});

// --- Authentication ---
function initAuth() {
    const overlay = document.getElementById('auth-overlay');
    const tokenInput = document.getElementById('token-input');
    const loginBtn = document.getElementById('login-btn');

    if (!authToken) {
        overlay.classList.add('active');
    } else {
        overlay.style.display = 'none';
    }

    loginBtn.addEventListener('click', () => {
        const token = tokenInput.value.trim();
        if (token) {
            authToken = token;
            localStorage.setItem('carapabox_token', token);
            overlay.style.display = 'none';
            startPolling();
        }
    });

    tokenInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loginBtn.click();
    });
}

function getHeaders() {
    return {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
    };
}

async function apiFetch(endpoint) {
    try {
        const response = await fetch(`${API_BASE}${endpoint}`, { headers: getHeaders() });
        if (response.status === 401) {
            handleUnauthorized();
            return null;
        }
        if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
        return await response.json();
    } catch (err) {
        console.error(`Fetch error (${endpoint}):`, err);
        return null;
    }
}

function handleUnauthorized() {
    authToken = null;
    localStorage.removeItem('carapabox_token');
    document.getElementById('auth-overlay').style.display = 'flex';
    stopPolling();
}

// --- Navigation ---
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabViews = document.querySelectorAll('.tab-view');
    const title = document.getElementById('view-title');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const tabId = item.getAttribute('data-tab');

            // UI state
            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            tabViews.forEach(view => {
                view.classList.remove('active');
                if (view.id === `${tabId}-view`) view.classList.add('active');
            });

            title.textContent = item.textContent.trim();

            // URL hash (optional)
            window.location.hash = tabId;

            // Immediate manual refresh on tab change
            refreshData(true);
        });
    });

    // Handle initial hash
    const hash = window.location.hash.substring(1);
    if (hash) {
        const item = document.querySelector(`.nav-item[data-tab="${hash}"]`);
        if (item) item.click();
    }
}

function initEventListeners() {
    document.getElementById('refresh-btn').addEventListener('click', () => refreshData(true));

    // Instance action buttons (start/stop) are re-created on every poll, so
    // delegate on the table.
    document.getElementById('instances-table').addEventListener('click', (e) => {
        const btn = e.target.closest('.instance-action');
        if (!btn || btn.disabled) return;
        const row = btn.closest('tr');
        if (!row) return;
        runStackAction(
            row.getAttribute('data-project'),
            row.getAttribute('data-stack'),
            row.getAttribute('data-instance') || '',
            btn.getAttribute('data-action'),
            btn,
        );
    });

    document.getElementById('logout-btn').addEventListener('click', (e) => {
        e.preventDefault();
        handleLogout();
    });

    // Toggle switch logic
    document.querySelectorAll('.toggle-switch').forEach(toggle => {
        toggle.addEventListener('click', () => {
            toggle.classList.toggle('enabled');
        });
    });

    initSettingsTabs();

    // Global save setting event delegator
    document.querySelectorAll('.save-settings-action').forEach(btn => {
        btn.addEventListener('click', (e) => saveSettings(e.target));
    });

    // Clear error on input
    document.addEventListener('input', (e) => {
        if (e.target.tagName === 'INPUT') {
            e.target.classList.remove('error');
        }
    });
}

function initSettingsTabs() {
    const btns = document.querySelectorAll('.settings-tab-btn');
    const views = document.querySelectorAll('.settings-sub-view');

    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-settings-tab');
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            views.forEach(v => {
                v.classList.remove('active');
                if (v.id === `settings-${target}`) v.classList.add('active');
            });
        });
    });
}

function handleLogout() {
    authToken = null;
    localStorage.removeItem('carapabox_token');
    stopPolling();

    // Reset UI
    const overlay = document.getElementById('auth-overlay');
    overlay.style.display = 'flex';
    document.getElementById('token-input').value = '';

    // Optional: hard reload to clear all states
    // window.location.reload();
}

// --- Data Polling ---
function startPolling() {
    refreshData(true); // Initial manual fetch
    if (!refreshTimer) {
        refreshTimer = setInterval(() => refreshData(false), 5000);
    }
}

function stopPolling() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

async function refreshData(isManual = false) {
    const info = await apiFetch('/info');
    if (info) updateDashboardUI(info);

    const activeTab = document.querySelector('.nav-item.active').getAttribute('data-tab');
    if (activeTab === 'logs') {
        const logs = await apiFetch('/logs');
        if (logs) updateLogsUI(logs);
    } else if (activeTab === 'stacks') {
        const stacks = await apiFetch('/stacks');
        if (stacks) updateStacksUI(stacks);
    } else if (activeTab === 'settings' && isManual) {
        const [rootConfig, egressConfig] = await Promise.all([
            apiFetch('/config?file=root'),
            apiFetch('/config?file=egress'),
        ]);
        if (rootConfig && egressConfig) populateSettings(rootConfig, egressConfig);
        await loadProviderAccounts();
    }
}

function populateSettings(root, egress) {
    const safeSet = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
    };

    // General
    safeSet('conf-port', root.MCP_SANDBOX_PORT);
    safeSet('conf-host-dir', root.SANDBOX_HOST_DIR);
    safeSet('conf-stacks-dir', root.SANDBOX_STACKS_DIR);
    safeSet('conf-audit-log', root.AUDIT_LOG_PATH);

    // Docker
    safeSet('conf-docker-gid', root.DOCKER_GID);

    // Carapa Integration
    safeSet('conf-carapa-data-dir', root.CARAPA_DATA_DIR);
    safeSet('conf-ipc-mount', root.IPC_MOUNT);

    // Features
    // CarapaBox enables a feature when its variable is present, whatever the value.
    const setToggle = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (val) el.classList.add('enabled');
        else el.classList.remove('enabled');
    };
    setToggle('toggle-git', root.ENABLE_SANDBOX_GIT);
    setToggle('toggle-issues', root.ENABLE_GIT_ISSUES);

    // Egress
    safeSet('conf-egress-rl-client', egress.RATE_LIMIT_PER_CLIENT);
    safeSet('conf-egress-rl-global', egress.RATE_LIMIT_GLOBAL);
    safeSet('conf-egress-rl-window', egress.RATE_LIMIT_WINDOW_S);
    safeSet('conf-egress-secrets', egress.SECRETS_DIR);

    // Relay Runtime
    safeSet('conf-relay-clients-dir', egress.RELAY_CLIENTS_DIR);
    safeSet('conf-relay-uid', egress.RELAY_UID);
    safeSet('conf-relay-gid', egress.RELAY_GID);
    safeSet('conf-llama-port', egress.LLAMA_PORT);

    safeSet('conf-keys-folder', root.SSH_KEYS_FOLDER);
    safeSet('conf-gitlab-host', egress.GITLAB_HOST_URL);

    // Provider accounts
    safeSet('conf-provider-accounts-dir', root.PROVIDER_ACCOUNTS_DIR || egress.PROVIDER_ACCOUNTS_DIR);
    safeSet('conf-provider-relay-clients-dir', root.PROVIDER_RELAY_CLIENTS_DIR);
    safeSet('conf-provider-login-image', root.PROVIDER_LOGIN_IMAGE);
    safeSet('conf-provider-login-volume', root.PROVIDER_LOGIN_HARNESS_VOLUME);
    safeSet('conf-provider-login-network', root.PROVIDER_LOGIN_NETWORK);
    safeSet('conf-provider-login-proxy', root.PROVIDER_LOGIN_PROXY);
    safeSet('conf-provider-login-uid', root.PROVIDER_LOGIN_UID);
}

const PROVIDER_STATES = {
    connected: ['green', 'Connected'],
    refreshPending: ['orange', 'Refreshing'],
    loginRequired: ['red', 'Login required'],
};

async function loadProviderAccounts() {
    const tbody = document.querySelector('#provider-accounts-table tbody');
    const message = (text) => {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-msg">${escapeHtml(text)}</td></tr>`;
    };
    let data;
    try {
        const response = await fetch(`${API_BASE}/provider-accounts`, { headers: getHeaders() });
        if (response.status === 401) return handleUnauthorized();
        data = await response.json();
        if (!response.ok) return message(data?.error || 'Provider accounts are unavailable.');
    } catch {
        return message('Could not load provider accounts.');
    }

    const rows = (data.accounts || []).map(account => {
        const [color, label] = PROVIDER_STATES[account.state] || ['red', account.state];
        const scope = account.scope === 'client' ? `Client: ${account.client}` : 'Shared default';
        return `<tr>
            <td><span class="status-dot ${color}"></span> ${escapeHtml(label)}</td>
            <td><strong>${escapeHtml(account.provider)}</strong></td>
            <td>${escapeHtml(account.label)}</td>
            <td>${escapeHtml(scope)}</td>
        </tr>`;
    });
    for (const login of data.logins || []) {
        rows.push(`<tr>
            <td><span class="status-dot orange"></span> Login ${escapeHtml(login.state)}</td>
            <td><strong>${escapeHtml(login.provider)}</strong></td>
            <td>${escapeHtml(login.label)}</td>
            <td>Pending in CarapaBoard</td>
        </tr>`);
    }
    if (rows.length === 0) return message('No provider accounts yet. Connect one in CarapaBoard.');
    tbody.innerHTML = rows.join('');
}

async function saveSettings(btn) {
    const fileType = btn.getAttribute('data-config-file');
    const status = btn.nextElementSibling;
    const subView = btn.closest('.settings-sub-view');

    // Clear previous errors
    subView.querySelectorAll('input.error').forEach(i => i.classList.remove('error'));

    // Validation
    const requiredFields = subView.querySelectorAll('input[required]');
    let missing = [];
    requiredFields.forEach(field => {
        if (!field.value.trim()) {
            field.classList.add('error');
            missing.push(field.previousElementSibling.textContent);
        }
    });

    if (missing.length > 0) {
        status.textContent = 'Required fields missing';
        status.className = 'settings-status-msg text-red';
        return;
    }

    status.textContent = 'Saving...';
    status.className = 'settings-status-msg text-secondary';

    const getVal = (id) => document.getElementById(id).value;
    // Feature flags are enabled by presence, so a disabled toggle must write an empty value.
    const isEnabled = (id) => document.getElementById(id).classList.contains('enabled') ? 'true' : '';

    // Each settings view writes only its own keys; other keys in the file are preserved.
    const updates = {};
    if (fileType === 'git-unified') {
        updates.root = {
            ENABLE_SANDBOX_GIT: isEnabled('toggle-git'),
            ENABLE_GIT_ISSUES: isEnabled('toggle-issues'),
            SSH_KEYS_FOLDER: getVal('conf-keys-folder'),
        };
        updates.egress = { GITLAB_HOST_URL: getVal('conf-gitlab-host') };
    } else if (fileType === 'provider-accounts') {
        const accountsDir = getVal('conf-provider-accounts-dir');
        updates.root = {
            PROVIDER_ACCOUNTS_DIR: accountsDir,
            PROVIDER_RELAY_CLIENTS_DIR: getVal('conf-provider-relay-clients-dir'),
            PROVIDER_LOGIN_IMAGE: getVal('conf-provider-login-image'),
            PROVIDER_LOGIN_HARNESS_VOLUME: getVal('conf-provider-login-volume'),
            PROVIDER_LOGIN_NETWORK: getVal('conf-provider-login-network'),
            PROVIDER_LOGIN_PROXY: getVal('conf-provider-login-proxy'),
            PROVIDER_LOGIN_UID: getVal('conf-provider-login-uid'),
        };
        // The relay must use the same account directory as CarapaBox.
        updates.egress = { PROVIDER_ACCOUNTS_DIR: accountsDir };
    } else if (fileType === 'credentials') {
        updates.egress = { SECRETS_DIR: getVal('conf-egress-secrets') };
    } else if (fileType === 'root') {
        updates.root = {
            MCP_SANDBOX_PORT: getVal('conf-port'),
            SANDBOX_HOST_DIR: getVal('conf-host-dir'),
            SANDBOX_STACKS_DIR: getVal('conf-stacks-dir'),
            AUDIT_LOG_PATH: getVal('conf-audit-log'),
            DOCKER_GID: getVal('conf-docker-gid'),
            CARAPA_DATA_DIR: getVal('conf-carapa-data-dir'),
            IPC_MOUNT: getVal('conf-ipc-mount'),
            ENABLE_SANDBOX_GIT: isEnabled('toggle-git'),
            ENABLE_GIT_ISSUES: isEnabled('toggle-issues'),
        };
    } else {
        updates.egress = {
            RATE_LIMIT_PER_CLIENT: getVal('conf-egress-rl-client'),
            RATE_LIMIT_GLOBAL: getVal('conf-egress-rl-global'),
            RATE_LIMIT_WINDOW_S: getVal('conf-egress-rl-window'),
            RELAY_CLIENTS_DIR: getVal('conf-relay-clients-dir'),
            RELAY_UID: getVal('conf-relay-uid'),
            RELAY_GID: getVal('conf-relay-gid'),
            LLAMA_PORT: getVal('conf-llama-port'),
        };
    }

    try {
        // Root and egress must stay in sync (relay and CarapaBox share these settings), so a paired save is one all-or-nothing request.
        const paired = updates.root && updates.egress;
        const requests = paired ? [['both', updates]] : Object.entries(updates);
        for (const [file, values] of requests) {
            const response = await fetch(`${API_BASE}/config?file=${file}`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify(values)
            });
            if (!response.ok) throw new Error(await response.text());
        }
        status.textContent = 'Changes Saved Successfully';
        status.className = 'settings-status-msg text-cyan';
        setTimeout(() => status.textContent = '', 5000);
    } catch (err) {
        status.textContent = `Error: ${err.message}`;
        status.className = 'settings-status-msg text-red';
    }
}

// --- UI Updates ---
function updateDashboardUI(data) {
    document.getElementById('uptime-val').textContent = formatUptime(data.uptime);
    document.getElementById('active-sandboxes-count').textContent = data.active_sandboxes || 0;

    // Egress Status
    const egressEl = document.getElementById('egress-status');
    egressEl.textContent = data.egress_proxy?.running ? 'Active' : 'Stopped';
    egressEl.className = `stat-value ${data.egress_proxy?.running ? 'text-cyan' : 'text-red'}`;

    // Uptime subtext
    document.getElementById('auth-mode').textContent = data.auth_enabled ? 'Token' : 'None';

    // Instances Table
    updateInstancesTable(data.instances || []);
}

const INSTANCE_STATUS = {
    running: ['green', 'Running'],
    partial: ['orange', 'Degraded'],
    stopped: ['red', 'Stopped'],
};

// Projects with a start/stop action in flight — survives the polling re-renders.
const inFlightActions = new Map();

function updateInstancesTable(instances) {
    const tbody = document.querySelector('#instances-table tbody');
    if (!instances || instances.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No sandbox instances found.</td></tr>';
        return;
    }

    tbody.innerHTML = instances.map(inst => {
        const [color, label] = INSTANCE_STATUS[inst.status] || ['orange', inst.status || 'Unknown'];
        const serviceTags = (inst.services || []).map(svc =>
            `<span class="svc-tag ${svc.running ? 'green' : 'red'}" title="${escapeHtml(svc.hostname)}: ${escapeHtml(svc.status)}">${escapeHtml(svc.service)}</span>`
        ).join('');
        const meta = inst.instance
            ? `<div class="instance-meta">${escapeHtml(inst.stack)}:${escapeHtml(inst.instance)}</div>`
            : '';
        const action = inst.status === 'stopped' ? 'start' : 'stop';
        const inFlight = inFlightActions.get(inst.project) === action;

        return `
        <tr data-project="${escapeHtml(inst.project)}" data-stack="${escapeHtml(inst.stack)}" data-instance="${escapeHtml(inst.instance)}">
            <td><span class="status-dot ${color}"></span> ${label}</td>
            <td>
                <strong>${escapeHtml(inst.project)}</strong>
                ${meta}
                ${serviceTags ? `<div class="svc-tags">${serviceTags}</div>` : ''}
            </td>
            <td><span class="uptime">${inst.uptime != null ? escapeHtml(formatUptime(inst.uptime)) : '—'}</span></td>
            <td><code>${escapeHtml(inst.ip) || '—'}</code></td>
            <td>
                <button class="icon-button instance-action" data-action="${action}" ${inFlight ? 'disabled' : ''}
                    title="${action === 'stop' ? 'Stop instance' : 'Start instance'}${inFlight ? ' — in progress' : ''}">
                    ${action === 'stop'
                        ? '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>'
                        : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'}
                </button>
            </td>
        </tr>`;
    }).join('');
}

// Start/stop a sandbox instance through the admin tools endpoint. The tool
// runs the same lifecycle as the board/MCP path (hooks, agent stop, cleanup).
async function runStackAction(project, stack, instance, action, btn) {
    if (inFlightActions.has(project)) return;
    inFlightActions.set(project, action);
    btn.disabled = true;

    // The handler resolves both a stack name (+ instance) and a raw project name.
    const tool = action === 'stop' ? 'sandbox_stop' : 'sandbox_start';
    const payload = instance ? { name: stack, instance } : { name: project };

    try {
        const response = await fetch(`${API_BASE}/tools/${tool}`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(payload),
        });
        if (response.status === 401) {
            handleUnauthorized();
            return;
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.isError) {
            alert(`${action === 'stop' ? 'Stop' : 'Start'} failed: ${data.error || data.result || response.statusText}`);
        }
    } catch (err) {
        alert(`${action === 'stop' ? 'Stop' : 'Start'} failed: ${err.message}`);
    } finally {
        inFlightActions.delete(project);
        if (authToken) refreshData(true);
    }
}

function updateLogsUI(logs) {
    const container = document.getElementById('audit-logs');
    if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="log-line system">No log entries found.</div>';
        return;
    }

    container.innerHTML = logs.map(log => {
        const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '—';
        const isError = log.exitCode !== undefined && log.exitCode !== 0;
        const className = isError ? 'error' : log.tool === 'sandbox_exec' ? 'exec' : '';

        return `<div class="log-line ${className}">
            <span class="text-secondary">[${escapeHtml(time)}]</span>
            <strong>${escapeHtml(log.stack)}</strong>: ${escapeHtml(log.command || log.tool)}
            ${log.exitCode !== undefined ? `(exit: ${escapeHtml(log.exitCode)})` : ''}
            ${log.reason ? `<br><small>→ ${escapeHtml(log.reason)}</small>` : ''}
        </div>`;
    }).join('');

    // Auto scroll to bottom
    container.scrollTop = container.scrollHeight;
}

function updateStacksUI(stacks) {
    const list = document.getElementById('stacks-list');
    if (!stacks || stacks.length === 0) {
        list.innerHTML = '<div class="empty-msg">No registered stacks found.</div>';
        return;
    }

    list.innerHTML = stacks.map(stack => `
        <div class="glass-panel stack-card">
            <div class="stack-name">${escapeHtml(stack.name)}</div>
            <div class="stack-path">${escapeHtml(stack.path)}</div>
            <div class="stack-caps">
                ${stack.capabilities?.map(cap => `<span class="cap-tag">${escapeHtml(cap)}</span>`).join('') || '<span class="cap-tag">Native</span>'}
            </div>
        </div>
    `).join('');
}

// --- Helpers ---
function formatUptime(seconds) {
    if (!seconds) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}
