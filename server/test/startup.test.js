import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import mongoose from 'mongoose';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {
  configuredClientOrigins,
  ensureOperationalIndexes,
  validateRuntimeEnvironment,
  verifyTransactionCapableDatabase
} from '../src/services/startup.js';

const validEnvironment = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://mongo:27017/mittho_ops?replicaSet=rs0',
  JWT_SECRET: '3f88962c111762160e8a97d2430c105272788ee32f2855fe',
  CLIENT_URL: 'https://ops.example.com',
  PORT: '4000'
};

describe('production startup configuration', () => {
  test('accepts explicit production settings and normalizes configured origins', () => {
    assert.doesNotThrow(() => validateRuntimeEnvironment(validEnvironment));
    assert.deepEqual(
      configuredClientOrigins({...validEnvironment, CLIENT_URL: ' https://ops.example.com/, http://localhost:5173 '}),
      ['https://ops.example.com', 'http://localhost:5173']
    );
  });

  test('rejects missing, unsafe, malformed, or ambiguous runtime settings', () => {
    assert.throws(
      () => validateRuntimeEnvironment({...validEnvironment, MONGODB_URI: ''}),
      /MONGODB_URI is required/
    );
    assert.throws(
      () => validateRuntimeEnvironment({...validEnvironment, JWT_SECRET: 'short'}),
      /at least 32 characters/
    );
    assert.throws(
      () => validateRuntimeEnvironment({...validEnvironment, JWT_SECRET: 'replace-with-a-long-random-secret'}),
      /must be replaced/
    );
    assert.throws(
      () => validateRuntimeEnvironment({...validEnvironment, CLIENT_URL: ''}),
      /CLIENT_URL is required/
    );
    assert.throws(
      () => validateRuntimeEnvironment({...validEnvironment, CLIENT_URL: '*'}),
      /explicit HTTP\(S\) origins/
    );
    assert.throws(
      () => validateRuntimeEnvironment({...validEnvironment, CLIENT_URL: 'https://ops.example.com/app'}),
      /origins only/
    );
    assert.throws(
      () => validateRuntimeEnvironment({...validEnvironment, PORT: '4000.5'}),
      /PORT must be an integer/
    );
  });
});

describe('operational database startup', () => {
  let replset;

  before(async () => {
    replset = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine: 'wiredTiger'}});
    await mongoose.connect(replset.getUri());
  });

  after(async () => {
    if (mongoose.connection.readyState) await mongoose.disconnect();
    if (replset) await replset.stop();
  });

  test('requires a writable transaction-capable MongoDB deployment', async () => {
    const hello = await verifyTransactionCapableDatabase();
    assert.equal(hello.setName, 'testset');
    assert.equal(hello.isWritablePrimary, true);

    await assert.rejects(
      verifyTransactionCapableDatabase({db: {admin: () => ({command: async () => ({isWritablePrimary: true})})}}),
      /replica set or sharded cluster/
    );
    await assert.rejects(
      verifyTransactionCapableDatabase({db: {admin: () => ({command: async () => ({setName: 'rs0', isWritablePrimary: false})})}}),
      /writable primary/
    );
  });

  test('runs every operational migration safely more than once', async () => {
    await ensureOperationalIndexes();
    await ensureOperationalIndexes();

    const collections = await mongoose.connection.db.listCollections().toArray();
    const names = new Set(collections.map(collection => collection.name));
    assert.ok(names.has('suppliers'));
    assert.ok(names.has('purchaseorders'));
    assert.ok(names.has('goodsreceipts'));
    assert.ok(names.has('supplierinvoices'));
    assert.ok(names.has('supplierpayments'));
    assert.ok(names.has('stockcounts'));
    const stockCountIndexes = new Set((await mongoose.connection.db.collection('stockcounts').indexes()).map(index => index.name));
    for (const name of [
      'stock_count_restaurant_number',
      'stock_count_request_key',
      'stock_count_active_branch',
      'stock_count_branch_status_created'
    ]) assert.ok(stockCountIndexes.has(name), `missing ${name}`);
  });
});
