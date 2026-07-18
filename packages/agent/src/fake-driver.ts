// In-memory MobilewrightDriver used by the agent package's unit tests.
// Mirrors core's fake-webview-session.ts pattern: lives in src so tests can
// import it relatively, but is not exported from the package index.

import type {
  AppInfo,
  DeviceInfo,
  MobilewrightDriver,
  Orientation,
  SwipeDirection,
  SwipeOptions,
  ViewNode,
} from '@mobilewright/protocol';

export interface FakeDriverCalls {
  taps: Array<[number, number]>;
  doubleTaps: Array<[number, number]>;
  longPresses: Array<[number, number, number | undefined]>;
  typed: string[];
  clearTextCount: number;
  pressedKeys: string[][];
  swipes: Array<{ direction: SwipeDirection; opts?: SwipeOptions }>;
  buttons: string[];
  launchedApps: string[];
  terminatedApps: string[];
  openedUrls: string[];
  orientations: Orientation[];
}

export interface FakeDriver extends MobilewrightDriver {
  calls: FakeDriverCalls;
  /** Replace the hierarchy returned by getViewHierarchy. */
  setHierarchy(roots: ViewNode[]): void;
  /** Queue hierarchies returned on successive getViewHierarchy calls (last one repeats). */
  setHierarchySequence(sequence: ViewNode[][]): void;
  screenshotBuffer: Buffer;
  apps: AppInfo[];
  devices: DeviceInfo[];
}

/** Build a ViewNode with sensible defaults so tests stay terse. */
export function node(partial: Partial<ViewNode> & { type: string }, children: ViewNode[] = []): ViewNode {
  return {
    isVisible: true,
    isEnabled: true,
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    ...partial,
    children,
  };
}

export function createFakeDriver(initialHierarchy: ViewNode[] = []): FakeDriver {
  const calls: FakeDriverCalls = {
    taps: [],
    doubleTaps: [],
    longPresses: [],
    typed: [],
    clearTextCount: 0,
    pressedKeys: [],
    swipes: [],
    buttons: [],
    launchedApps: [],
    terminatedApps: [],
    openedUrls: [],
    orientations: [],
  };

  let sequence: ViewNode[][] = [initialHierarchy];

  const driver: FakeDriver = {
    calls,
    screenshotBuffer: Buffer.alloc(0),
    apps: [],
    devices: [],

    setHierarchy(roots) { sequence = [roots]; },
    setHierarchySequence(seq) { sequence = [...seq]; },

    connect: async () => ({ deviceId: 'fake-device', platform: 'ios' as const }),
    disconnect: async () => {},
    getViewHierarchy: async () => (sequence.length > 1 ? sequence.shift()! : sequence[0]),
    tap: async (x, y) => { calls.taps.push([x, y]); },
    doubleTap: async (x, y) => { calls.doubleTaps.push([x, y]); },
    longPress: async (x, y, duration) => { calls.longPresses.push([x, y, duration]); },
    typeText: async (text) => { calls.typed.push(text); },
    pressKeys: async (keys) => { calls.pressedKeys.push(keys); },
    clearText: async () => { calls.clearTextCount += 1; },
    swipe: async (direction, opts) => { calls.swipes.push({ direction, opts }); },
    gesture: async () => {},
    pressButton: async (button) => { calls.buttons.push(button); },
    screenshot: async () => driver.screenshotBuffer,
    getScreenSize: async () => ({ width: 390, height: 844, scale: 3 }),
    getOrientation: async () => 'portrait' as Orientation,
    setOrientation: async (orientation) => { calls.orientations.push(orientation); },
    launchApp: async (bundleId) => { calls.launchedApps.push(bundleId); },
    terminateApp: async (bundleId) => { calls.terminatedApps.push(bundleId); },
    listApps: async () => driver.apps,
    getForegroundApp: async () => ({ bundleId: calls.launchedApps.at(-1) ?? 'com.fake.app' }),
    installApp: async () => {},
    uninstallApp: async () => {},
    listDevices: async () => driver.devices,
    openUrl: async (url) => { calls.openedUrls.push(url); },
    startRecording: async () => {},
    stopRecording: async () => ({}),
  };

  return driver;
}
