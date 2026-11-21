# Troubleshooting

## Trivy: permission denied while connecting to Docker daemon

**Symptom:**

```
unable to inspect the image (...): permission denied while trying to connect to the Docker daemon socket
```

**Cause:** Trivy installed via Snap runs in a sandboxed environment that cannot access `/var/run/docker.sock`. The `snap connect trivy:docker docker:docker-daemon` workaround only works if Docker itself is also installed as a Snap — which is uncommon.

**Fix A — Both Docker and Trivy installed via Snap:**

If Docker is also a Snap, you can grant Trivy access to the Docker socket directly:

```bash
sudo snap connect trivy:docker docker:docker-daemon
```

This connects Trivy's `docker` plug to the Docker Snap's `docker-daemon` slot, allowing socket access within Snap's confinement.

**Fix B — Docker installed via apt, Trivy via Snap (most common):**

The `snap connect` approach won't work because there's no `docker` snap to connect to. Install Trivy via apt instead:

```bash
sudo snap remove trivy

wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key \
  | gpg --dearmor | sudo tee /usr/share/keyrings/trivy.gpg > /dev/null

echo "deb [signed-by=/usr/share/keyrings/trivy.gpg] https://aquasecurity.github.io/trivy-repo/deb generic main" \
  | sudo tee /etc/apt/sources.list.d/trivy.list

sudo apt-get update && sudo apt-get install -y trivy
```

The apt package runs without Snap confinement and can access the Docker socket directly (as long as your user is in the `docker` group).

## Authorization failed when pulling DHI base images

**Symptom:**

```
ERROR: pull access denied, repository does not exist or may require authorization
```

During `bash build.sh` or `docker compose build`, Docker fails to pull `dhi.io/` base images.

**Fix:** Log in to the DHI registry:

```bash
docker login dhi.io
```
