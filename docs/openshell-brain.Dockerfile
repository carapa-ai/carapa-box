# CarapaBrain image for an OpenShell sandbox. OpenShell refuses an image whose working directory the
# sandbox user cannot write, and carapa-brain keeps its code in a root-owned /app.
#   docker build -f docs/openshell-brain.Dockerfile -t carapa-brain-openshell:latest .
FROM carapa-brain:latest
WORKDIR /home/ubuntu
