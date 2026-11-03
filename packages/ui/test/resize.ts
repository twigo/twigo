const observers = new Set<Observer>();

/**
 * jsdom lays nothing out, so its ResizeObserver reports only when a test
 * says the layout changed, and then, as a browser's, only the sizes that
 * changed since it last reported them.
 */
class Observer implements ResizeObserver {
  readonly targets = new Map<Element, string | undefined>();

  constructor(readonly report: ResizeObserverCallback) {
    observers.add(this);
  }

  observe(target: Element) {
    this.targets.set(target, undefined);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
}

export { Observer as ResizeObserver };

const sizeOf = (target: Element) =>
  target instanceof HTMLElement
    ? `${String(target.clientHeight)} ${String(target.offsetHeight)}`
    : "";

export function resize(): void {
  for (const observer of [...observers]) {
    const entries = [...observer.targets]
      .filter(([target, was]) => sizeOf(target) !== was)
      .map(([target]) => {
        observer.targets.set(target, sizeOf(target));
        return {
          target,
          contentRect: new DOMRectReadOnly(
            0,
            0,
            target.clientWidth,
            target.clientHeight,
          ),
        } as ResizeObserverEntry;
      });
    if (entries.length > 0) observer.report(entries, observer);
  }
}
