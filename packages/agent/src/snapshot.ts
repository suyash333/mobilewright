import type { Bounds, ViewNode } from '@mobilewright/protocol';
import { roleOf } from '@mobilewright/core';

/**
 * Everything an agent (or the action executor) needs to re-find an element
 * after the snapshot was taken. Descriptors are plain data — safe to hold
 * across hierarchy refreshes, unlike ViewNode references.
 */
export interface RefDescriptor {
  ref: string;
  type: string;
  role: string | null;
  identifier?: string;
  resourceId?: string;
  label?: string;
  text?: string;
  value?: string;
  placeholder?: string;
  bounds: Bounds;
}

export interface ScreenSnapshot {
  /** Token-efficient, human/LLM-readable rendering of the view hierarchy. */
  text: string;
  /** Descriptors keyed by ref ("e1", "e2", …) for acting on elements later. */
  refs: Map<string, RefDescriptor>;
  /** Epoch ms when the snapshot was captured. */
  capturedAt: number;
}

export interface SnapshotOptions {
  /** Include elements whose isVisible flag is false. Default: false. */
  includeInvisible?: boolean;
  /** Cap on rendered elements — guards agents against pathological trees. Default: 500. */
  maxElements?: number;
}

const DEFAULT_MAX_ELEMENTS = 500;

/** Roles whose value is worth showing separately from the name (form inputs). */
const VALUE_ROLES = new Set(['textfield', 'slider', 'switch', 'checkbox']);

/**
 * Decide whether a node carries information an agent can act on or learn from.
 * Structural containers with no semantics are skipped and their children promoted,
 * which keeps deep Android/React Native trees from drowning the snapshot in noise.
 */
function isInteresting(node: ViewNode): boolean {
  return Boolean(
    node.label ||
    node.text ||
    node.value ||
    node.placeholder ||
    node.identifier ||
    node.resourceId ||
    node.isChecked !== undefined ||
    node.isSelected === true ||
    node.isFocused === true ||
    roleOf(node) !== null,
  );
}

function descriptorFor(ref: string, node: ViewNode): RefDescriptor {
  return {
    ref,
    type: node.type,
    role: roleOf(node),
    identifier: node.identifier,
    resourceId: node.resourceId,
    label: node.label,
    text: node.text,
    value: node.value,
    placeholder: node.placeholder,
    bounds: { ...node.bounds },
  };
}

function renderLine(node: ViewNode, ref: string, depth: number): string {
  const role = roleOf(node) ?? node.type.toLowerCase();
  const parts: string[] = [`${'  '.repeat(depth)}- ${role}`];

  const name = node.label ?? node.text;
  if (name) {
    parts.push(JSON.stringify(name));
  } else if (node.placeholder) {
    parts.push(`placeholder=${JSON.stringify(node.placeholder)}`);
  }

  parts.push(`[ref=${ref}]`);

  const testId = node.identifier || node.resourceId;
  if (testId) parts.push(`[testId=${testId}]`);

  if (!node.isEnabled) parts.push('[disabled]');
  if (node.isFocused) parts.push('[focused]');
  if (node.isSelected) parts.push('[selected]');
  if (node.isChecked !== undefined) parts.push(node.isChecked ? '[checked]' : '[unchecked]');
  if (!node.isVisible) parts.push('[hidden]');

  let line = parts.join(' ');
  const showValue = node.value !== undefined && node.value !== '' && node.value !== name &&
    (VALUE_ROLES.has(roleOf(node) ?? '') || !name);
  if (showValue) {
    line += `: ${JSON.stringify(node.value)}`;
  }
  return line;
}

/**
 * Build a deterministic, token-efficient snapshot of a view hierarchy.
 *
 * Every informative element gets a stable per-snapshot ref ("e1", "e2", … in
 * document order) that agents pass back to act on it — no coordinates, no
 * vision model, no XPath.
 */
export function buildSnapshot(roots: ViewNode[], opts: SnapshotOptions = {}): ScreenSnapshot {
  const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
  const lines: string[] = [];
  const refs = new Map<string, RefDescriptor>();
  let counter = 0;
  let truncated = false;

  function walk(nodes: ViewNode[], depth: number): void {
    for (const node of nodes) {
      if (truncated) return;

      const visible = node.isVisible || opts.includeInvisible === true;
      if (visible && isInteresting(node)) {
        if (counter >= maxElements) {
          truncated = true;
          return;
        }
        counter += 1;
        const ref = `e${counter}`;
        refs.set(ref, descriptorFor(ref, node));
        lines.push(renderLine(node, ref, depth));
        walk(node.children, depth + 1);
      } else {
        // Skip the container but keep its children at the same depth.
        walk(node.children, depth);
      }
    }
  }

  walk(roots, 0);

  if (lines.length === 0) {
    lines.push('(no interactive or labeled elements on screen)');
  }
  if (truncated) {
    lines.push(`(snapshot truncated at ${maxElements} elements)`);
  }

  return { text: lines.join('\n'), refs, capturedAt: Date.now() };
}

/**
 * Re-find the element a descriptor was captured from in a fresh hierarchy.
 * Matching degrades gracefully: exact testId, then label/text/placeholder with
 * the same type, then same type at the same or overlapping bounds. Ties are
 * broken by proximity to the captured bounds, so "the same button after a
 * scroll or re-render" wins over lookalikes elsewhere on screen.
 */
export function findByDescriptor(roots: ViewNode[], desc: RefDescriptor): ViewNode | null {
  const all: ViewNode[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.shift()!;
    all.push(node);
    stack.unshift(...node.children);
  }

  const sameType = (n: ViewNode): boolean => n.type === desc.type;
  const byProximity = (candidates: ViewNode[]): ViewNode | null => {
    if (candidates.length === 0) return null;
    return candidates.reduce((best, n) =>
      boundsDistance(n.bounds, desc.bounds) < boundsDistance(best.bounds, desc.bounds) ? n : best,
    );
  };

  const testId = desc.identifier || desc.resourceId;
  if (testId) {
    const matched = all.filter(n => n.identifier === testId || n.resourceId === testId);
    const found = byProximity(matched);
    if (found) return found;
  }

  for (const key of ['label', 'text', 'placeholder'] as const) {
    const wanted = desc[key];
    if (!wanted) continue;
    const matched = all.filter(n => sameType(n) && n[key] === wanted);
    const found = byProximity(matched);
    if (found) return found;
  }

  const exact = all.find(n => sameType(n) && boundsEqual(n.bounds, desc.bounds));
  if (exact) return exact;

  const center = centerOf(desc.bounds);
  const overlapping = all.filter(n => sameType(n) && containsPoint(n.bounds, center));
  return byProximity(overlapping);
}

export function centerOf(bounds: Bounds): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}

function boundsEqual(a: Bounds, b: Bounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function containsPoint(bounds: Bounds, point: { x: number; y: number }): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function boundsDistance(a: Bounds, b: Bounds): number {
  const ca = centerOf(a);
  const cb = centerOf(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}
