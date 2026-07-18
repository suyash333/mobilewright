import { test, expect } from '@playwright/test';
import { Device } from '@mobilewright/core';
import { AgentSession } from './session.js';
import { executeAction } from './actions.js';
import { createFakeDriver, node } from './fake-driver.js';

function setup(hierarchy = [node({ type: 'Button', label: 'Go', bounds: { x: 0, y: 0, width: 100, height: 40 } })]) {
  const driver = createFakeDriver(hierarchy);
  const session = new AgentSession(new Device(driver));
  return { driver, session };
}

test.describe('executeAction', () => {
  test('rejects malformed input without throwing', async () => {
    const { session } = setup();

    const result = await executeAction(session, { action: 'tap' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid action');
  });

  test('rejects unknown action names', async () => {
    const { session } = setup();

    const result = await executeAction(session, { action: 'self_destruct' });

    expect(result.ok).toBe(false);
  });

  test('tap executes and returns a fresh snapshot', async () => {
    const { driver, session } = setup();
    await session.snapshot();

    const result = await executeAction(session, { action: 'tap', ref: 'e1' });

    expect(result.ok).toBe(true);
    expect(driver.calls.taps).toEqual([[50, 20]]);
    expect(result.snapshot).toContain('- button "Go" [ref=e1]');
  });

  test('runtime failures come back as ok:false with the agent-facing message', async () => {
    const { session } = setup();
    await session.snapshot();

    const result = await executeAction(session, { action: 'tap', ref: 'e42' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('e42');
  });

  test('press_button and swipe drive the device', async () => {
    const { driver, session } = setup();

    expect((await executeAction(session, { action: 'press_button', button: 'HOME' })).ok).toBe(true);
    expect((await executeAction(session, { action: 'swipe', direction: 'up' })).ok).toBe(true);

    expect(driver.calls.buttons).toEqual(['HOME']);
    expect(driver.calls.swipes[0]?.direction).toBe('up');
  });

  test('launch_app waits for foreground via the device', async () => {
    const { driver, session } = setup();

    const result = await executeAction(session, { action: 'launch_app', bundleId: 'com.example.app' });

    expect(result.ok).toBe(true);
    expect(driver.calls.launchedApps).toEqual(['com.example.app']);
  });

  test('fill validates ref shape before touching the device', async () => {
    const { driver, session } = setup();

    const result = await executeAction(session, { action: 'fill', ref: 'not-a-ref', text: 'x' });

    expect(result.ok).toBe(false);
    expect(driver.calls.taps).toEqual([]);
  });
});
