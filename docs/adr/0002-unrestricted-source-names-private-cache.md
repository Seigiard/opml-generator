# Unrestricted source names and a private cache projection

Source naming is unrestricted. Generated metadata names must not hide a source directory or change its public feed URL or Episode identity. We use a reversible private cache projection instead of rejecting source names or changing public paths.

Ordinary cache segments keep their existing layout. A service name, temporary-file name, or literal `~` segment is stored beneath an internal `~` container. The original segment remains unchanged below that container. This keeps each filename within its original filesystem length limit. A source `feed.xml` directory and the parent podcast's generated `feed.xml` can therefore coexist.

The shared projection module owns physical paths, logical inverse paths, and public metadata URI resolution. Bun traversal treats containers as structural, and nginx resolves public metadata URLs through the same projection. Audio streaming still uses the original source paths. Synchronization and status interfaces remain unchanged.

Legacy namespace upgrade is superseded. Current deployments must already use the canonical private `~` layout; old legacy or mixed cache directories are not migrated or journaled by this lifecycle. Publication uses the original filesystem lock identity for the canonical layout.

Source and cache ownership remain separate. Root validation, mutation containment, metadata collection errors, and bounded shutdown remain mandatory during upgrade. A missing or invalid podcast file is still an error. Private projection is not permission to omit a source branch or swallow publication failures.
