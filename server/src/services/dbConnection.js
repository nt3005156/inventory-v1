/**
 * Phase 26 — explicit MongoDB connection settings.
 *
 * `mongoose.connect(uri)` was called with NO options, so every one of these
 * was an inherited driver default rather than a decision:
 *
 *   maxPoolSize 100  — far more than a single Node process can use. Node runs
 *                      one event loop; 100 sockets per instance mostly buys
 *                      connection-slot exhaustion on the server when several
 *                      API instances start up. Mongo counts connections per
 *                      cluster, not per client.
 *   minPoolSize 0    — the first request after an idle period pays TCP + TLS +
 *                      auth before it can run a query.
 *   no serverSelectionTimeout ceiling that suits a request/response API, so a
 *                      primary election could hang requests for 30s.
 *   no maxIdleTimeMS — idle sockets are kept forever, which upsets proxies and
 *                      keeps server-side resources pinned.
 *
 * All are now explicit and overridable by environment variable, so an operator
 * can size the pool for their deployment instead of editing code. The defaults
 * suit one API container serving a normal restaurant load.
 *
 * `writeConcern: majority` is deliberate: this system posts inventory and
 * money through multi-document transactions, and acknowledging a write that a
 * failover could still lose is not acceptable for a stock ledger.
 */

const int = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function mongoConnectionOptions(env = process.env) {
  return {
    // Concurrency ceiling per API instance. 10 comfortably saturates one event
    // loop; raise it only with evidence of pool waiting, not on instinct.
    maxPoolSize: int(env.MONGO_MAX_POOL_SIZE, 10),
    // Keep a couple of sockets warm so a quiet period does not make the next
    // order pay the handshake.
    minPoolSize: int(env.MONGO_MIN_POOL_SIZE, 2),
    // Recycle idle sockets rather than holding them open indefinitely.
    maxIdleTimeMS: int(env.MONGO_MAX_IDLE_MS, 60_000),
    // Fail fast when there is no reachable primary. The default 30s turns a
    // brief election into a pile of hung HTTP requests and an exhausted pool.
    serverSelectionTimeoutMS: int(env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 8_000),
    // A single operation that has not answered in this long is not going to.
    socketTimeoutMS: int(env.MONGO_SOCKET_TIMEOUT_MS, 45_000),
    connectTimeoutMS: int(env.MONGO_CONNECT_TIMEOUT_MS, 10_000),
    // Never let a query queue behind an unavailable server without an error.
    waitQueueTimeoutMS: int(env.MONGO_WAIT_QUEUE_TIMEOUT_MS, 10_000),
    // Money and stock: a write that a failover can lose is not a write.
    writeConcern: {w: 'majority'},
    retryWrites: true,
    retryReads: true,
    // Compress the wire when the payload is worth it. zstd is not always
    // available in the base image, so only zlib is requested.
    compressors: ['zlib']
  };
}

/** Pool telemetry for /health, so pressure is visible before it is an outage. */
export function poolStats(connection) {
  const client = connection?.getClient?.();
  const options = client?.options || {};
  return {
    readyState: connection?.readyState ?? 0,
    maxPoolSize: options.maxPoolSize ?? null,
    minPoolSize: options.minPoolSize ?? null
  };
}
