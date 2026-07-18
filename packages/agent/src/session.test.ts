import { test, expect } from '@playwright/test';
import { Device } from '@mobilewright/core';
import { AgentError, AgentSession } from './session.js';
import { createFakeDriver, node } from './fake-driver.js';

function makeSession(driver = createFakeDriver()): AgentSession {
  return new AgentSession(new Device(driver));
}

test.describe('AgentSession ref actions', () => {
  test('tap taps the center of the resolved element', async () => {
    const driver = createFakeDriver([
      node({ type: 'Button', label: 'Go', bounds: { x: 100, y: 200, width: 100, height: 40 } }),
    ]);
    const session = makeSession(driver);

    await session.snapshot();
    await session.tap('e1');

    expect(driver.calls.taps).toEqual([[150, 220]]);
  });

  test('tap follows an element that moved since the snapshot', async () => {
    const driver = createFakeDriver();
    driver.setHierarchySequence([
      [node({ type: 'Button', label: 'Go', bounds: { x: 0, y: 0, width: 100, height: 40 } })],
      [node({ type: 'Button', label: 'Go', bounds: { x: 0, y: 400, width: 100, height: 40 } })],
    ]);
    const session = makeSession(driver);

    await session.snapshot();
    await session.tap('e1');

    expect(driver.calls.taps).toEqual([[50, 420]]);
  });

  test('fill taps, clears, then types', async () => {
    const driver = createFakeDriver([
      node({ type: 'TextField', label: 'Email', bounds: { x: 0, y: 0, width: 200, height: 40 } }),
    ]);
    const session = makeSession(driver);

    await session.snapshot();
    await session.fill('e1', 'a@b.co');

    expect(driver.calls.taps).toEqual([[100, 20]]);
    expect(driver.calls.clearTextCount).toBe(1);
    expect(driver.calls.typed).toEqual(['a@b.co']);
  });

  test('acting before any snapshot fails with guidance', async () => {
    const session = makeSession();

    const err = await session.tap('e1').catch(e => e);

    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('no_snapshot');
  });

  test('unknown ref fails with guidance', async () => {
    const session = makeSession(createFakeDriver([node({ type: 'Button', label: 'Go' })]));

    await session.snapshot();
    const err = await session.tap('e99').catch(e => e);

    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('unknown_ref');
  });

  test('ref that left the screen fails as stale', async () => {
    const driver = createFakeDriver();
    driver.setHierarchySequence([
      [node({ type: 'Button', label: 'Go' })],
      [node({ type: 'StaticText', text: 'Done', bounds: { x: 500, y: 500, width: 10, height: 10 } })],
    ]);
    const session = makeSession(driver);

    await session.snapshot();
    const err = await session.tap('e1').catch(e => e);

    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('stale_ref');
    expect(err.message).toContain('take a new snapshot');
  });
});

test.describe('AgentSession waitForText', () => {
  test('resolves when the text appears', async () => {
    const driver = createFakeDriver();
    driver.setHierarchySequence([
      [],
      [node({ type: 'StaticText', text: 'Welcome back' })],
    ]);
    const session = makeSession(driver);

    await session.waitForText('welcome', { pollInterval: 10 });
  });

  test('times out with an AgentError', async () => {
    const session = makeSession(createFakeDriver([]));

    const err = await session.waitForText('never', { timeout: 50, pollInterval: 10 }).catch(e => e);

    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe('timeout');
  });
});
