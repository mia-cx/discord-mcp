# The image a workflow's compiled artifact runs in.
#
# Deliberately close to empty. The artifact arrives on a read-only volume, the capability socket is
# the only channel out, and there is no network — so anything else in this image is attack surface
# for no benefit. In particular there is no shell utility set, no package manager, and no curl.
FROM node:24.22.1-alpine

# `nobody`. The supervisor also passes --user, so this is belt and braces rather than the control.
USER 65534:65534

# Every path a workflow can write is supplied by the supervisor: a tmpfs at /tmp and the capability
# socket. Nothing here is writable.
WORKDIR /artifact

# The runner is part of the artifact, not the image, so a runner fix ships with a rebuild rather
# than forcing every published revision to be re-pinned to a new base image.
CMD ["node", "/artifact/runner.js"]
