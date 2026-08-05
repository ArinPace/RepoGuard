# RepoGuard agent

Local HTTP service that shallow-clones a public GitHub repo and runs **install + build** inside Docker.

```bash
npm start
```

Binds to `127.0.0.1:3847`. Requires Docker and `git`.

See the root [README](../README.md#local-build-check-docker-agent) for stack support and extension wiring.
