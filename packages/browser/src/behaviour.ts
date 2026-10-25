import {
  KEY_CLASSES,
  POINTER_TYPES,
  type Frame,
  type FrameBatch,
  type KeyClass,
  type Page,
  type PointerTypeCode,
} from './wire.js';

/**
 * Raw behaviour, timing only, loaded apart from the rest of the script: what
 * FP-Agent's 50 behaviour features and Known By Their Actions read
 * (`docs/research/agent-journey-correlation.md`, 15.4), with nothing of what
 * was typed, pasted or chosen. Features are computed in the collector, so a
 * new paper is a new derivation over the frames already kept.
 *
 * Kept as it happened: every mouse move the browser delivers, and how many
 * raw moves it coalesced into it, since an automation protocol never emits
 * the raw stream a physical device does; every button, key, scroll and
 * wheel event, with whether the browser says a person caused it.
 */

/** A batch is sent once it holds this many frames, or its page ends. */
const BATCH_FRAMES = 400;

const STRUCTURAL_KEYS = new Set([
  'Tab',
  'Enter',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
const EDITING_KEYS = new Set(['Backspace', 'Delete']);

export interface BehaviourContext {
  /** The page view the frames happen on: its event's id. */
  readonly page: () => string;
  readonly now: () => number;
  readonly emit: (batch: FrameBatch) => void;
}

export interface Behaviour {
  /** Hands over what is buffered, as a batch of the page it happened on. */
  flush(): void;
  stop(): void;
}

function keyClass(key: string): KeyClass {
  if (EDITING_KEYS.has(key)) return KEY_CLASSES.editing;
  if (STRUCTURAL_KEYS.has(key)) return KEY_CLASSES.structural;
  return KEY_CLASSES.other;
}

function pointerType(type: string): PointerTypeCode {
  return type === 'mouse' || type === 'touch' || type === 'pen'
    ? POINTER_TYPES[type]
    : POINTER_TYPES.other;
}

/** The raw moves a pointer event stands for; one where a browser cannot tell (Safari before 18). */
function coalescedOf(event: PointerEvent): number {
  const read: unknown = Reflect.get(event, 'getCoalescedEvents');
  if (typeof read !== 'function') return 1;
  const moves: unknown = read.call(event);
  return Array.isArray(moves) ? moves.length : 1;
}

function wheelSize(event: WheelEvent): 0 | 1 | 2 | 3 {
  const size = Math.abs(event.deltaX) + Math.abs(event.deltaY);
  if (size === 0) return 0;
  if (size < 10) return 1;
  return size < 100 ? 2 : 3;
}

export function recordBehaviour(
  window: Page,
  context: BehaviourContext,
): Behaviour {
  const { document } = window;
  let frames: Frame[] = [];
  let framesPage = context.page();

  // Elements by number, in order of first use; the document is 0.
  const numbers = new WeakMap<EventTarget, number>();
  let elements = 0;
  const targetOf = (event: Event): number => {
    const target = event.target;
    // The window, or anything else that is no element of the page, is the
    // document's.
    if (
      !(target instanceof window.Node) ||
      target === document ||
      target === document.documentElement
    )
      return 0;
    let number = numbers.get(target);
    if (number === undefined) {
      elements += 1;
      number = elements;
      numbers.set(target, number);
    }
    return number;
  };

  // A key held is one press, its down and up paired by number; which key it
  // is stays here.
  const held = new Map<string, number>();
  let presses = 0;
  const pressOf = (key: string, down: boolean): number => {
    const press = held.get(key);
    if (press !== undefined) {
      if (!down) held.delete(key);
      return press;
    }
    presses += 1;
    if (down) held.set(key, presses);
    return presses;
  };

  // The browser fires a pointer move just before the mouse move it becomes:
  // what it coalesced is read off the pointer event.
  let coalesced = 0;

  function flush(): void {
    if (frames.length === 0) return;
    context.emit({ id: crypto.randomUUID(), page: framesPage, frames });
    frames = [];
  }

  function push(frame: Frame): void {
    const page = context.page();
    // A batch holds one page's frames.
    if (page !== framesPage) {
      flush();
      framesPage = page;
    }
    frames.push(frame);
    if (frames.length >= BATCH_FRAMES) flush();
  }

  const untrusted = (event: Event) => (event.isTrusted ? 0 : 1);

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') coalesced = coalescedOf(event);
  };
  const onMouse = (event: MouseEvent) => {
    const t = context.now();
    const target = targetOf(event);
    switch (event.type) {
      case 'mousemove':
        push([
          'mm',
          target,
          event.clientX,
          event.clientY,
          coalesced,
          untrusted(event),
          t,
        ]);
        coalesced = 0;
        return;
      case 'mousedown':
      case 'mouseup':
        push([
          event.type === 'mousedown' ? 'md' : 'mu',
          target,
          event.button,
          event.clientX,
          event.clientY,
          untrusted(event),
          t,
        ]);
        return;
      case 'click': {
        const element =
          event.target instanceof window.Element ? event.target : null;
        const link = element?.closest('a[href]') == null ? 0 : 1;
        push([
          'ck',
          target,
          event.button,
          event.clientX,
          event.clientY,
          link,
          untrusted(event),
          t,
        ]);
      }
    }
  };
  const onKey = (event: KeyboardEvent) => {
    const down = event.type === 'keydown';
    push([
      down ? 'kd' : 'ku',
      targetOf(event),
      pressOf(event.key, down),
      event.repeat ? 1 : 0,
      keyClass(event.key),
      untrusted(event),
      context.now(),
    ]);
  };
  const onScroll = (event: Event) => {
    const t = context.now();
    const type = event.type === 'scroll' ? 'sc' : 'se';
    const target = targetOf(event);
    if (target === 0) {
      const root = document.documentElement;
      const depth =
        root.scrollHeight > 0
          ? Math.min(
              1,
              (window.scrollY + window.innerHeight) / root.scrollHeight,
            )
          : 0;
      push([type, 0, window.scrollX, window.scrollY, depth, t]);
      return;
    }
    const element =
      event.target instanceof window.Element ? event.target : null;
    push([
      type,
      target,
      element?.scrollLeft ?? 0,
      element?.scrollTop ?? 0,
      -1,
      t,
    ]);
  };
  const onWheel = (event: WheelEvent) => {
    push([
      'wh',
      targetOf(event),
      wheelSize(event),
      untrusted(event),
      context.now(),
    ]);
  };
  const onEntry = (event: Event) => {
    const type =
      event.type === 'paste' ? 'p' : event.type === 'input' ? 'i' : 'c';
    push([type, targetOf(event), context.now()]);
  };
  const onPointerDown = (event: PointerEvent) => {
    push([
      'pd',
      targetOf(event),
      pointerType(event.pointerType),
      context.now(),
    ]);
  };
  const onFocus = (event: FocusEvent) => {
    // The window's own focus, not each field's.
    if (event.target !== window) return;
    push([event.type === 'focus' ? 'fo' : 'bl', context.now()]);
  };
  const onVisibility = () => {
    push(['vs', document.visibilityState === 'visible' ? 1 : 0, context.now()]);
  };

  const listeners: [
    EventTarget,
    string,
    EventListener,
    AddEventListenerOptions,
  ][] = [
    [
      window,
      'pointermove',
      onPointerMove as EventListener,
      { passive: true, capture: true },
    ],
    [window, 'mousemove', onMouse as EventListener, { passive: true }],
    [window, 'mousedown', onMouse as EventListener, { passive: true }],
    [window, 'mouseup', onMouse as EventListener, { passive: true }],
    [
      window,
      'click',
      onMouse as EventListener,
      { passive: true, capture: true },
    ],
    [window, 'keydown', onKey as EventListener, { passive: true }],
    [window, 'keyup', onKey as EventListener, { passive: true }],
    [window, 'paste', onEntry, { passive: true }],
    [window, 'input', onEntry, { passive: true }],
    [window, 'change', onEntry, { passive: true }],
    [window, 'wheel', onWheel as EventListener, { passive: true }],
    [
      window,
      'pointerdown',
      onPointerDown as EventListener,
      { passive: true, capture: true },
    ],
    [window, 'focus', onFocus as EventListener, { passive: true }],
    [window, 'blur', onFocus as EventListener, { passive: true }],
    // Scrolls do not bubble: caught on the way down, for any element.
    [document, 'scroll', onScroll, { passive: true, capture: true }],
    [document, 'scrollend', onScroll, { passive: true, capture: true }],
    [document, 'visibilitychange', onVisibility, { passive: true }],
  ];
  for (const [target, type, listener, options] of listeners)
    target.addEventListener(type, listener, options);

  return {
    flush,
    stop() {
      for (const [target, type, listener, options] of listeners)
        target.removeEventListener(type, listener, options);
      flush();
    },
  };
}
