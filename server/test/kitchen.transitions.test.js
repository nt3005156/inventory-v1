import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {canTransition, assertOrderTransition, assertBranchAccess, KITCHEN_QUEUE_STATUSES} from '../src/services/kitchen.js';

describe('kitchen transition matrix', () => {
  it('allows the KDS happy path', () => {
    assert.equal(canTransition('pending', 'accepted'), true);
    assert.equal(canTransition('accepted', 'preparing'), true);
    assert.equal(canTransition('preparing', 'ready'), true);
    assert.equal(canTransition('ready', 'completed'), true);
    assert.equal(canTransition('pending', 'cancelled'), true);
  });

  it('allows confirmed into the kitchen flow and cancel from active tickets', () => {
    assert.equal(canTransition('confirmed', 'accepted'), true);
    assert.equal(canTransition('accepted', 'cancelled'), true);
    assert.equal(canTransition('preparing', 'cancelled'), true);
  });

  it('rejects backwards, skip-ahead, and terminal-state moves', () => {
    assert.equal(canTransition('completed', 'preparing'), false);
    assert.equal(canTransition('ready', 'accepted'), false);
    assert.equal(canTransition('cancelled', 'preparing'), false);
    assert.equal(canTransition('pending', 'preparing'), false);
    assert.equal(canTransition('pending', 'ready'), false);
    assert.equal(canTransition('pending', 'completed'), false);
    assert.equal(canTransition('ready', 'cancelled'), false);
    assert.equal(canTransition('completed', 'cancelled'), false);
  });

  it('throws 409 for invalid transitions and 400 when status is missing', () => {
    assert.throws(() => assertOrderTransition('completed', 'preparing'), e => e.status === 409);
    assert.throws(() => assertOrderTransition('pending', undefined), e => e.status === 400);
  });

  it('keeps kitchen queue statuses exclusive of completed and cancelled', () => {
    assert.deepEqual(KITCHEN_QUEUE_STATUSES, ['pending', 'confirmed', 'accepted', 'preparing', 'ready']);
  });
});

describe('branch access', () => {
  const branchA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const branchB = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  it('lets an owner access any branch', () => {
    assert.doesNotThrow(() => assertBranchAccess({role: 'owner'}, branchB));
  });

  it('blocks assigned staff from another branch', () => {
    assert.throws(() => assertBranchAccess({role: 'staff', branch: branchA}, branchB), e => e.status === 403);
  });

  it('requires a branch id', () => {
    assert.throws(() => assertBranchAccess({role: 'owner'}, null), e => e.status === 400);
  });
});
