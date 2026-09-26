// ============================================================
// Explorer Module – web-test-agent / src/explorer/explorer.ts
// Main entry point for BFS web application exploration engine.
// ============================================================

export * from './types';
export * from './state-hash';
export * from './state';
export * from './frontier';
export * from './action-discovery';
export * from './bfs-explorer';

// Backward compatibility alias
export { BfsExplorer as Explorer } from './bfs-explorer';
