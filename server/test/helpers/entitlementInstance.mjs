/**
 * P2G.6 — a SEPARATE OS PROCESS acting as a second application instance.
 *
 * The cross-instance claim cannot be proven inside one process: a single
 * process shares one `Map`, so any "invalidation" it observes might simply be
 * the same in-memory object being mutated. `roleChangeStream.js` says as much
 * in its own header — its multi-instance behaviour is "stated as designed, not
 * as proven". This exists so P2G.6 does not have to make that excuse.
 *
 * The parent spawns this with a MONGODB_URI pointing at the same replica set,
 * then drives it over stdin/stdout with newline-delimited JSON:
 *
 *   {"cmd":"resolve","restaurantId":"..."}  -> {"ok":true,"entitlement":{...}}
 *   {"cmd":"cacheSize"}                     -> {"ok":true,"size":n}
 *   {"cmd":"stats"}                         -> {"ok":true,"stats":{...}}
 *   {"cmd":"stopStream"} / {"cmd":"startStream"} / {"cmd":"restartStream"}
 *   {"cmd":"exit"}
 *
 * Its cache is genuinely its own, so when it stops serving a stale entitlement
 * the only path by which it could have learned is the change stream.
 */
import mongoose from 'mongoose';

const send = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    send({ok: false, error: 'MONGODB_URI missing'});
    process.exit(1);
  }
  await mongoose.connect(uri);

  const entitlements = await import('../../src/services/entitlements.js');
  const billing = await import('../../src/services/billingChangeStream.js');

  await billing.startBillingChangeStream();
  send({ok: true, ready: true, streamActive: billing.billingStreamActive()});

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async chunk => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) await handle(JSON.parse(line));
      index = buffer.indexOf('\n');
    }
  });

  async function handle(message) {
    try {
      switch (message.cmd) {
        case 'resolve': {
          const entitlement = await entitlements.resolveEntitlement(message.restaurantId);
          send({
            ok: true,
            id: message.id,
            entitlement: {
              operational: entitlement.operational,
              reason: entitlement.reason,
              planCode: entitlement.planCode || null,
              maxUsers: entitlement.limits?.maxUsers ?? null,
              maxMenuItems: entitlement.limits?.maxMenuItems ?? null,
              timezone: entitlement.timezone ?? null
            }
          });
          break;
        }
        case 'cacheSize':
          send({ok: true, id: message.id, size: entitlements.__entitlementCacheSize()});
          break;
        case 'stats':
          send({
            ok: true, id: message.id,
            stats: {...billing.billingStreamStats},
            active: billing.billingStreamActive()
          });
          break;
        case 'stopStream':
          send({ok: true, id: message.id, stopped: await billing.stopBillingChangeStream()});
          break;
        case 'startStream':
          send({ok: true, id: message.id, started: await billing.startBillingChangeStream()});
          break;
        case 'restartStream':
          send({ok: true, id: message.id, restarted: await billing.restartBillingChangeStream()});
          break;
        case 'exit':
          await billing.stopBillingChangeStream();
          await mongoose.disconnect();
          send({ok: true, id: message.id, bye: true});
          process.exit(0);
          break;
        default:
          send({ok: false, id: message.id, error: `unknown cmd ${message.cmd}`});
      }
    } catch (error) {
      send({ok: false, id: message.id, error: error?.message || String(error)});
    }
  }
}

main().catch(error => {
  send({ok: false, error: error?.message || String(error)});
  process.exit(1);
});
