import type { Device } from '@mobilewright/core';
import type { HardwareButton, Orientation, SwipeDirection, ViewNode } from '@mobilewright/protocol';
import {
  buildSnapshot,
  centerOf,
  findByDescriptor,
  type RefDescriptor,
  type ScreenSnapshot,
  type SnapshotOptions,
} from './snapshot.js';

/** Machine-readable failure reasons, surfaced to agents alongside guidance. */
export type AgentErrorCode = 'no_snapshot' | 'unknown_ref' | 'stale_ref' | 'timeout' | 'invalid_action';

/** Error whose message tells the agent what to do next, not just what broke. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(message: string, code: AgentErrorCode) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export interface WaitForTextOptions {
  /** Maximum time to wait in ms. Default: 5000. */
  timeout?: number;
  /** Poll interval in ms. Default: 250. */
  pollInterval?: number;
}

const DEFAULT_WAIT_TIMEOUT = 5_000;
const DEFAULT_POLL_INTERVAL = 250;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stateful bridge between an LLM agent and a connected Device.
 *
 * The loop it enables: `snapshot()` gives the agent a readable view of the
 * screen with element refs; ref-based methods (`tap`, `fill`, …) act on those
 * elements, re-resolving each ref against the live hierarchy so snapshots can
 * be a little stale without breaking the run.
 */
export class AgentSession {
  #lastSnapshot: ScreenSnapshot | null = null;

  constructor(readonly device: Device) {}

  /** The most recent snapshot, or null before the first call to snapshot(). */
  get lastSnapshot(): ScreenSnapshot | null {
    return this.#lastSnapshot;
  }

  /** Capture and remember a fresh snapshot of the current screen. */
  async snapshot(opts?: SnapshotOptions): Promise<ScreenSnapshot> {
    const roots = await this.device.driver.getViewHierarchy();
    this.#lastSnapshot = buildSnapshot(roots, opts);
    return this.#lastSnapshot;
  }

  /** Look up a ref from the last snapshot and re-resolve it in the live hierarchy. */
  async resolveRef(ref: string): Promise<{ node: ViewNode; desc: RefDescriptor }> {
    if (!this.#lastSnapshot) {
      throw new AgentError(
        `No snapshot taken yet — call snapshot() before acting on ref "${ref}".`,
        'no_snapshot',
      );
    }
    const desc = this.#lastSnapshot.refs.get(ref);
    if (!desc) {
      throw new AgentError(
        `Unknown ref "${ref}" — it is not part of the latest snapshot. Take a new snapshot and use a ref from it.`,
        'unknown_ref',
      );
    }
    const roots = await this.device.driver.getViewHierarchy();
    const node = findByDescriptor(roots, desc);
    if (!node) {
      throw new AgentError(
        `Element for ref "${ref}" (${describeRef(desc)}) is no longer on screen. The UI has changed — take a new snapshot.`,
        'stale_ref',
      );
    }
    return { node, desc };
  }

  // ─── Element actions (by ref) ────────────────────────────────

  async tap(ref: string): Promise<void> {
    const { node } = await this.resolveRef(ref);
    const { x, y } = centerOf(node.bounds);
    await this.device.driver.tap(x, y);
  }

  async doubleTap(ref: string): Promise<void> {
    const { node } = await this.resolveRef(ref);
    const { x, y } = centerOf(node.bounds);
    await this.device.driver.doubleTap(x, y);
  }

  async longPress(ref: string, duration?: number): Promise<void> {
    const { node } = await this.resolveRef(ref);
    const { x, y } = centerOf(node.bounds);
    await this.device.driver.longPress(x, y, duration);
  }

  /** Tap the element to focus it, clear existing content, then type the text. */
  async fill(ref: string, text: string): Promise<void> {
    await this.tap(ref);
    await this.device.driver.clearText();
    await this.device.driver.typeText(text);
  }

  /** Swipe starting from the element's center. */
  async swipeElement(ref: string, direction: SwipeDirection, distance?: number): Promise<void> {
    const { node } = await this.resolveRef(ref);
    const { x, y } = centerOf(node.bounds);
    await this.device.driver.swipe(direction, { startX: x, startY: y, distance });
  }

  // ─── Coordinate & device actions ─────────────────────────────

  async tapAt(x: number, y: number): Promise<void> {
    await this.device.driver.tap(x, y);
  }

  async typeText(text: string): Promise<void> {
    await this.device.driver.typeText(text);
  }

  async pressKeys(keys: string[]): Promise<void> {
    await this.device.driver.pressKeys(keys);
  }

  async swipe(direction: SwipeDirection, distance?: number): Promise<void> {
    await this.device.driver.swipe(direction, { distance });
  }

  async pressButton(button: HardwareButton): Promise<void> {
    await this.device.driver.pressButton(button);
  }

  async openUrl(url: string): Promise<void> {
    await this.device.openUrl(url);
  }

  async setOrientation(orientation: Orientation): Promise<void> {
    await this.device.setOrientation(orientation);
  }

  /**
   * Poll the hierarchy until an element containing the text appears
   * (case-insensitive substring over text, label, and value).
   */
  async waitForText(text: string, opts?: WaitForTextOptions): Promise<void> {
    const timeout = opts?.timeout ?? DEFAULT_WAIT_TIMEOUT;
    const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const wanted = text.toLowerCase();
    const deadline = Date.now() + timeout;

    while (true) {
      const roots = await this.device.driver.getViewHierarchy();
      if (treeContainsText(roots, wanted)) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new AgentError(
          `Timed out after ${timeout}ms waiting for text ${JSON.stringify(text)} to appear. Take a snapshot to see the current screen.`,
          'timeout',
        );
      }
      await sleep(pollInterval);
    }
  }
}

/** Short human-readable identity of a captured element, for error messages. */
export function describeRef(desc: RefDescriptor): string {
  const name = desc.label ?? desc.text ?? desc.placeholder;
  const role = desc.role ?? desc.type;
  return name ? `${role} ${JSON.stringify(name)}` : role;
}

function treeContainsText(roots: ViewNode[], wantedLower: string): boolean {
  for (const node of roots) {
    const text = node.text ?? node.label ?? node.value ?? '';
    if (text.toLowerCase().includes(wantedLower)) {
      return true;
    }
    if (treeContainsText(node.children, wantedLower)) {
      return true;
    }
  }
  return false;
}
