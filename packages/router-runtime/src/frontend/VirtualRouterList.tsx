import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface VirtualRouterAddressedItem {
  readonly address: number;
}

export interface VirtualRouterSelectionGesture {
  readonly range: boolean;
  readonly toggle: boolean;
}

export interface VirtualRouterListProps<
  Item extends VirtualRouterAddressedItem,
> {
  readonly activeAddress: number | null;
  readonly ariaLabel: string;
  readonly busy?: boolean;
  readonly className?: string;
  readonly hasMore?: boolean;
  readonly itemOffset?: number;
  readonly items: readonly Item[];
  readonly isAddressChecked?: (address: number) => boolean;
  readonly loadPage: (afterAddress: number | null) => Promise<void>;
  readonly nextAfterAddress?: number | null;
  readonly onActivateAddress?: (
    address: number,
    gesture: VirtualRouterSelectionGesture,
  ) => void;
  readonly onActiveAddressChange: (address: number) => void;
  readonly onToggleAddress?: (
    address: number,
    gesture: VirtualRouterSelectionGesture,
  ) => void;
  readonly overscan: number;
  readonly pageIdentity?: string;
  readonly renderRow: (item: Item) => ReactNode;
  readonly rowHeight: number;
  readonly selectedAddress?: number | null;
  readonly totalCount: number;
}

interface RenderedItem<Item> {
  readonly index: number;
  readonly item: Item;
}

interface PageRequest {
  readonly afterAddress: number | null;
  readonly promise: Promise<void>;
}

const MAX_RENDERED_ROUTER_ROWS = 200;

export function VirtualRouterList<Item extends VirtualRouterAddressedItem>({
  activeAddress,
  ariaLabel,
  busy = false,
  className,
  hasMore,
  itemOffset = 0,
  items,
  isAddressChecked,
  loadPage,
  nextAfterAddress,
  onActivateAddress,
  onActiveAddressChange,
  onToggleAddress,
  overscan,
  pageIdentity,
  renderRow,
  rowHeight,
  selectedAddress,
  totalCount,
}: VirtualRouterListProps<Item>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const focusRequestedAddressRef = useRef<number | null>(null);
  const pageRequestRef = useRef<PageRequest | null>(null);
  const pageIdentityRef = useRef(pageIdentity);
  const loadPageRef = useRef(loadPage);
  const listId = useId();
  const safeRowHeight = finitePositive(rowHeight, 1);
  const safeOverscan = finiteNonNegativeInteger(overscan);
  const renderedOverscan = Math.min(
    safeOverscan,
    Math.floor((MAX_RENDERED_ROUTER_ROWS - 1) / 2),
  );
  const safeTotalCount = finiteNonNegativeInteger(totalCount);
  const safeItemOffset = clamp(
    finiteNonNegativeInteger(itemOffset),
    0,
    safeTotalCount,
  );
  const windowEndIndex = Math.min(
    safeTotalCount,
    safeItemOffset + items.length,
  );
  const effectiveHasMore = hasMore ?? windowEndIndex < safeTotalCount;
  const pageCursor =
    nextAfterAddress === undefined
      ? (items.at(-1)?.address ?? null)
      : nextAfterAddress;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(safeRowHeight);
  const [focusWithin, setFocusWithin] = useState(false);

  useLayoutEffect(() => {
    loadPageRef.current = loadPage;
  }, [loadPage]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;

    const measure = (): void => {
      setViewportHeight(Math.max(safeRowHeight, viewport.clientHeight));
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [safeRowHeight]);

  const activeIndex = useMemo(
    () =>
      activeAddress === null
        ? -1
        : items.findIndex(({ address }) => address === activeAddress),
    [activeAddress, items],
  );
  const effectiveActiveIndex =
    activeIndex >= 0 ? activeIndex : items.length > 0 ? 0 : -1;
  const effectiveActiveGlobalIndex =
    effectiveActiveIndex >= 0 ? safeItemOffset + effectiveActiveIndex : -1;
  const effectiveActiveAddress =
    effectiveActiveIndex >= 0
      ? (items[effectiveActiveIndex]?.address ?? null)
      : null;
  const effectiveSelectedAddress =
    selectedAddress === undefined ? activeAddress : selectedAddress;
  const firstVisibleIndex = clamp(
    Math.floor(scrollTop / safeRowHeight),
    safeItemOffset,
    Math.max(safeItemOffset, windowEndIndex - 1),
  );
  const visibleRowCount = Math.min(
    Math.max(1, Math.ceil(viewportHeight / safeRowHeight)),
    MAX_RENDERED_ROUTER_ROWS - renderedOverscan * 2,
  );
  const startIndex = Math.max(
    safeItemOffset,
    firstVisibleIndex - renderedOverscan,
  );
  const endIndex = Math.min(
    windowEndIndex,
    firstVisibleIndex + visibleRowCount + renderedOverscan,
  );
  const renderedItems = useMemo<readonly RenderedItem<Item>[]>(
    () =>
      items
        .slice(startIndex - safeItemOffset, endIndex - safeItemOffset)
        .map((item, offset) => ({ index: startIndex + offset, item })),
    [endIndex, items, safeItemOffset, startIndex],
  );
  const activeRowRendered =
    effectiveActiveGlobalIndex >= startIndex &&
    effectiveActiveGlobalIndex < endIndex;
  const activeRowId =
    effectiveActiveAddress !== null && activeRowRendered
      ? rowId(listId, effectiveActiveAddress)
      : undefined;

  const beginPageRequest = useCallback(
    (afterAddress: number | null, force = false): void => {
      if ((!force && !effectiveHasMore) || (force && safeTotalCount === 0))
        return;
      if (pageRequestRef.current !== null) return;

      const promise = Promise.resolve().then(() =>
        loadPageRef.current(afterAddress),
      );
      const request = { afterAddress, promise };
      pageRequestRef.current = request;
      const clearRequest = (): void => {
        if (pageRequestRef.current === request) pageRequestRef.current = null;
      };
      void promise.then(clearRequest, clearRequest);
    },
    [effectiveHasMore, safeTotalCount],
  );

  const requestNextPage = useCallback((): void => {
    beginPageRequest(pageCursor);
  }, [beginPageRequest, pageCursor]);

  useLayoutEffect(() => {
    if (pageIdentityRef.current === pageIdentity) return;
    pageIdentityRef.current = pageIdentity;
    pageRequestRef.current = null;
    if (safeItemOffset > 0) {
      beginPageRequest(null, true);
      return;
    }
    requestNextPage();
  }, [beginPageRequest, pageIdentity, requestNextPage, safeItemOffset]);

  useLayoutEffect(() => {
    if (items.length === 0) {
      requestNextPage();
      return;
    }
    if (endIndex >= windowEndIndex) requestNextPage();
  }, [endIndex, items.length, requestNextPage, windowEndIndex]);

  useLayoutEffect(() => {
    if (items.length === 0) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;

    const firstRetainedTop = safeItemOffset * safeRowHeight;
    const lastRetainedTop = Math.max(
      firstRetainedTop,
      (windowEndIndex - 1) * safeRowHeight,
    );
    if (
      viewport.scrollTop >= firstRetainedTop &&
      viewport.scrollTop <= lastRetainedTop
    )
      return;

    const nextScrollTop = clamp(
      viewport.scrollTop,
      firstRetainedTop,
      lastRetainedTop,
    );
    viewport.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, [items.length, safeItemOffset, safeRowHeight, windowEndIndex]);

  const revealIndex = useCallback(
    (index: number): void => {
      const viewport = viewportRef.current;
      if (viewport === null) return;
      const itemTop = index * safeRowHeight;
      const itemBottom = itemTop + safeRowHeight;
      const visibleTop = viewport.scrollTop;
      const visibleBottom =
        visibleTop + Math.max(safeRowHeight, viewport.clientHeight);
      let nextScrollTop = visibleTop;
      if (itemTop < visibleTop) nextScrollTop = itemTop;
      else if (itemBottom > visibleBottom) {
        nextScrollTop =
          itemBottom - Math.max(safeRowHeight, viewport.clientHeight);
      }
      if (nextScrollTop === visibleTop) return;
      viewport.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    },
    [safeRowHeight, setScrollTop],
  );

  useLayoutEffect(() => {
    if (
      effectiveActiveAddress === null ||
      effectiveActiveAddress === activeAddress
    )
      return;
    onActiveAddressChange(effectiveActiveAddress);
  }, [activeAddress, effectiveActiveAddress, onActiveAddressChange]);

  useLayoutEffect(() => {
    if (
      !focusWithin ||
      effectiveActiveAddress === null ||
      effectiveActiveGlobalIndex < 0
    )
      return;
    const row = rowRefs.current.get(effectiveActiveAddress);
    if (row !== undefined) {
      focusRequestedAddressRef.current = null;
      if (row.ownerDocument.activeElement !== row) row.focus();
      return;
    }
    focusRequestedAddressRef.current = effectiveActiveAddress;
    revealIndex(effectiveActiveGlobalIndex);
  }, [
    effectiveActiveAddress,
    effectiveActiveGlobalIndex,
    focusWithin,
    revealIndex,
  ]);

  useLayoutEffect(() => {
    const requestedAddress = focusRequestedAddressRef.current;
    if (requestedAddress === null) return;
    const row = rowRefs.current.get(requestedAddress);
    if (row === undefined) return;
    focusRequestedAddressRef.current = null;
    row.focus();
  }, [effectiveActiveAddress, endIndex, startIndex]);

  useLayoutEffect(() => {
    if (effectiveActiveGlobalIndex < 0) return;
    const viewport = viewportRef.current;
    if (viewport === null) return;

    const currentFirstVisibleIndex = Math.floor(
      viewport.scrollTop / safeRowHeight,
    );
    const currentStartIndex = Math.max(
      safeItemOffset,
      currentFirstVisibleIndex - renderedOverscan,
    );
    const currentEndIndex = Math.min(
      windowEndIndex,
      currentFirstVisibleIndex + visibleRowCount + renderedOverscan,
    );
    if (
      effectiveActiveGlobalIndex >= currentStartIndex &&
      effectiveActiveGlobalIndex < currentEndIndex
    ) {
      return;
    }
    revealIndex(effectiveActiveGlobalIndex);
  }, [
    effectiveActiveGlobalIndex,
    revealIndex,
    safeItemOffset,
    renderedOverscan,
    safeRowHeight,
    visibleRowCount,
    windowEndIndex,
  ]);

  const moveActiveAddress = useCallback(
    (currentIndex: number, nextIndex: number): void => {
      const boundedIndex = clamp(nextIndex, 0, Math.max(0, items.length - 1));
      const nextAddress = items[boundedIndex]?.address;
      if (nextAddress === undefined || boundedIndex === currentIndex) return;
      focusRequestedAddressRef.current = nextAddress;
      revealIndex(safeItemOffset + boundedIndex);
      onActiveAddressChange(nextAddress);
    },
    [items, onActiveAddressChange, revealIndex, safeItemOffset],
  );

  const handleRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, address: number): void => {
      const currentIndex = items.findIndex((item) => item.address === address);
      if (currentIndex < 0) return;

      let nextIndex: number | null = null;
      switch (event.key) {
        case "ArrowDown":
          nextIndex = currentIndex + 1;
          break;
        case "ArrowUp":
          nextIndex = currentIndex - 1;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = items.length - 1;
          break;
        case "PageDown":
          nextIndex =
            currentIndex +
            Math.max(1, Math.floor(viewportHeight / safeRowHeight));
          break;
        case "PageUp":
          nextIndex =
            currentIndex -
            Math.max(1, Math.floor(viewportHeight / safeRowHeight));
          break;
        case "Enter":
          event.preventDefault();
          onActivateAddress?.(address, selectionGesture(event));
          return;
        case " ":
          if (onToggleAddress === undefined) return;
          event.preventDefault();
          onToggleAddress(address, selectionGesture(event));
          return;
        default:
          return;
      }

      event.preventDefault();
      if (nextIndex >= items.length && effectiveHasMore) requestNextPage();
      moveActiveAddress(currentIndex, nextIndex);
    },
    [
      items,
      effectiveHasMore,
      moveActiveAddress,
      onActivateAddress,
      onToggleAddress,
      requestNextPage,
      safeRowHeight,
      viewportHeight,
    ],
  );

  const handleScroll = useCallback(
    (viewport: HTMLDivElement): void => {
      const nextScrollTop = viewport.scrollTop;
      setScrollTop(nextScrollTop);
      if (items.length === 0 || effectiveActiveGlobalIndex < 0) return;

      const nextFirstVisibleIndex = clamp(
        Math.floor(nextScrollTop / safeRowHeight),
        safeItemOffset,
        Math.max(safeItemOffset, windowEndIndex - 1),
      );
      const nextStartIndex = Math.max(
        safeItemOffset,
        nextFirstVisibleIndex - renderedOverscan,
      );
      const nextEndIndex = Math.min(
        windowEndIndex,
        nextFirstVisibleIndex + visibleRowCount + renderedOverscan,
      );
      if (
        effectiveActiveGlobalIndex >= nextStartIndex &&
        effectiveActiveGlobalIndex < nextEndIndex
      ) {
        return;
      }

      const nextLocalIndex = clamp(
        nextFirstVisibleIndex - safeItemOffset,
        0,
        items.length - 1,
      );
      const nextAddress = items[nextLocalIndex]?.address;
      if (nextAddress === undefined || nextAddress === effectiveActiveAddress)
        return;
      if (viewport.contains(viewport.ownerDocument.activeElement)) {
        focusRequestedAddressRef.current = nextAddress;
      }
      onActiveAddressChange(nextAddress);
    },
    [
      effectiveActiveAddress,
      effectiveActiveGlobalIndex,
      items,
      onActiveAddressChange,
      safeItemOffset,
      renderedOverscan,
      safeRowHeight,
      setScrollTop,
      visibleRowCount,
      windowEndIndex,
    ],
  );

  const spacerStyle = useMemo<CSSProperties>(
    () => ({ height: safeTotalCount * safeRowHeight, position: "relative" }),
    [safeRowHeight, safeTotalCount],
  );

  return (
    <div
      aria-activedescendant={activeRowId}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      className={className}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocusWithin(false);
      }}
      onFocusCapture={() => {
        setFocusWithin(true);
      }}
      onScroll={(event) => {
        handleScroll(event.currentTarget);
      }}
      ref={viewportRef}
      role="listbox"
      style={{ overflowY: "auto" }}
      tabIndex={effectiveActiveAddress === null ? 0 : -1}
    >
      <div data-testid="virtual-router-list-spacer" style={spacerStyle}>
        {renderedItems.map(({ index, item }) => {
          const active = item.address === effectiveActiveAddress;
          const selected = item.address === effectiveSelectedAddress;
          return (
            <div
              aria-posinset={index + 1}
              aria-checked={isAddressChecked?.(item.address)}
              aria-selected={selected}
              aria-setsize={safeTotalCount}
              id={rowId(listId, item.address)}
              key={item.address}
              onClick={(event) => {
                onActiveAddressChange(item.address);
                onActivateAddress?.(item.address, selectionGesture(event));
              }}
              onFocus={() => {
                if (!active) onActiveAddressChange(item.address);
              }}
              onKeyDown={(event) => {
                handleRowKeyDown(event, item.address);
              }}
              ref={(element) => {
                if (element === null) rowRefs.current.delete(item.address);
                else rowRefs.current.set(item.address, element);
              }}
              role="option"
              style={{
                height: safeRowHeight,
                left: 0,
                position: "absolute",
                right: 0,
                top: index * safeRowHeight,
              }}
              tabIndex={active ? 0 : -1}
            >
              {renderRow(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function rowId(listId: string, address: number): string {
  return `virtual-router-${listId.replaceAll(":", "")}-${String(address)}`;
}

function selectionGesture(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): VirtualRouterSelectionGesture {
  return {
    range: event.shiftKey,
    toggle: event.metaKey || event.ctrlKey,
  };
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
