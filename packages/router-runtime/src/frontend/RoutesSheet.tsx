import {
  mountSpreadsheetControls,
  type SpreadsheetCell,
  type SpreadsheetColumn,
  type SpreadsheetControls,
} from "@hubble/module-sdk/spreadsheet-controls";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RouterDestinationRow, RouterState } from "./router-state.js";
import {
  routePickFromEdit,
  routesSheetCell,
  type RouteCellOverlay,
  type RoutePick,
  type RoutesSheetColumn,
} from "./routes-sheet-model.js";

const ROW_HEIGHT = 26;
const OVERSCAN_ROWS = 8;

type Overlay = (
  destination: number,
  level: number,
) => RouteCellOverlay | undefined;

export interface RoutesSheetRowEntry {
  readonly address: number;
  readonly label: string | null;
}

export interface RoutesSheetProps {
  readonly state: RouterState;
  readonly columns: readonly RoutesSheetColumn[];
  readonly rows: readonly RoutesSheetRowEntry[];
  /** The destination search narrowing `rows`. */
  readonly search: string | null;
  /** Source names by address. */
  readonly labels: ReadonlyMap<number, string | null>;
  readonly choices: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly editable: boolean;
  readonly overlay: Overlay;
  /** Changes whenever `overlay` would return something new. */
  readonly overlayRevision: string;
  readonly onPick: (pick: RoutePick) => void;
  /** A paste or fill was refused because only a single pick sends a route. */
  readonly onRefusedEdit: () => void;
  readonly onError: (message: string) => void;
}

/**
 * Hubble supplies selection, keyboard handling and the type-to-search source
 * list; this package owns the cells, their data and what a pick does.
 */
export function RoutesSheet({
  state,
  columns,
  rows,
  search,
  labels,
  choices,
  editable,
  overlay,
  overlayRevision,
  onPick,
  onRefusedEdit,
  onError,
}: RoutesSheetProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLTableElement | null>(null);
  const controlsRef = useRef<SpreadsheetControls | null>(null);
  const [firstVisible, setFirstVisible] = useState(0);
  const [viewportRows, setViewportRows] = useState(40);

  const rowIds = useMemo(
    () => rows.map(({ address }) => String(address)),
    [rows],
  );
  const hostColumns = useMemo<readonly SpreadsheetColumn[]>(
    () => columns.map(({ id, label }) => ({ id, label })),
    [columns],
  );

  const latest = useRef({
    state,
    columns,
    rowIds,
    hostColumns,
    choices,
    editable,
    overlay,
    onPick,
    onRefusedEdit,
    onError,
  });
  useLayoutEffect(() => {
    latest.current = {
      state,
      columns,
      rowIds,
      hostColumns,
      choices,
      editable,
      overlay,
      onPick,
      onRefusedEdit,
      onError,
    };
  });

  useEffect(() => {
    const root = gridRef.current;
    const viewport = viewportRef.current;
    if (root === null || viewport === null) return;
    let cancelled = false;
    let mounted: SpreadsheetControls | null = null;
    void mountSpreadsheetControls({
      root,
      viewport,
      getRows: () => latest.current.rowIds,
      getColumns: () => latest.current.hostColumns,
      getCell: ({ rowId, columnId }): SpreadsheetCell | null => {
        const current = latest.current;
        const column = current.columns.find(({ id }) => id === columnId);
        const destination = Number(rowId);
        if (column === undefined || !Number.isInteger(destination)) return null;
        const row = current.state.destinations.get(destination);
        const cell = routesSheetCell(
          column,
          (level) => row?.routes.get(level),
          (level) => current.overlay(destination, level),
        );
        return {
          value: cell.kind === "source" ? String(cell.source) : "",
          readOnly: !current.editable || cell.kind === "unknown",
          choices: current.choices,
        };
      },
      onEdit: (batch) => {
        const current = latest.current;
        const pick = routePickFromEdit(batch, current.columns);
        if (pick === null) current.onRefusedEdit();
        else current.onPick(pick);
      },
      onError: (error) => {
        latest.current.onError(error.message);
      },
    }).then(
      (controls) => {
        if (cancelled) {
          controls.dispose();
          return;
        }
        mounted = controls;
        controlsRef.current = controls;
      },
      (error: unknown) => {
        if (!cancelled)
          latest.current.onError(
            `Routes sheet unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
      },
    );
    return () => {
      cancelled = true;
      mounted?.dispose();
      controlsRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const measure = (): void => {
      setViewportRows(Math.ceil(viewport.clientHeight / ROW_HEIGHT));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, []);

  // A new search starts at its first match.
  useLayoutEffect(() => {
    if (viewportRef.current !== null) viewportRef.current.scrollTop = 0;
    setFirstVisible(0);
  }, [search]);

  const start = Math.max(0, firstVisible - OVERSCAN_ROWS);
  const end = Math.min(
    rows.length,
    firstVisible + viewportRows + OVERSCAN_ROWS,
  );

  // Rows that scroll into view need the selection painted onto their new cells.
  useLayoutEffect(() => {
    controlsRef.current?.refresh();
  }, [start, end, rowIds, columns, editable]);

  const visibleRows = useMemo(() => rows.slice(start, end), [end, rows, start]);

  return (
    <div
      ref={viewportRef}
      className="router-sheet-viewport"
      onScroll={(event) => {
        setFirstVisible(Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT));
      }}
    >
      <table
        ref={gridRef}
        className="router-sheet"
        role="grid"
        aria-label="Routes"
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length + 2}
        data-editable={editable}
      >
        <colgroup>
          <col className="router-sheet-gutter-column" />
          <col className="router-sheet-name-column" />
          {columns.map(({ id }) => (
            <col key={id} className="router-sheet-route-column" />
          ))}
        </colgroup>
        <thead>
          <tr role="row" aria-rowindex={1}>
            <th role="columnheader" className="router-sheet-gutter">
              #
            </th>
            <th role="columnheader" className="router-sheet-name">
              DST
            </th>
            {columns.map(({ id, label }) => (
              <th key={id} role="columnheader">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {start > 0 ? <SpacerRow height={start * ROW_HEIGHT} /> : null}
          {visibleRows.map(({ address, label }, offset) => (
            <RoutesSheetRow
              key={address}
              address={address}
              rowIndex={start + offset + 2}
              name={state.destinations.get(address)?.label ?? label}
              row={state.destinations.get(address)}
              columns={columns}
              labels={labels}
              editable={editable}
              overlay={overlay}
              overlayRevision={overlayRevision}
            />
          ))}
          {end < rows.length ? (
            <SpacerRow height={(rows.length - end) * ROW_HEIGHT} />
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function SpacerRow({ height }: { readonly height: number }): React.JSX.Element {
  return (
    <tr aria-hidden="true" style={{ height }}>
      <td className="router-sheet-spacer" colSpan={999} />
    </tr>
  );
}

interface RoutesSheetRowProps {
  readonly address: number;
  readonly rowIndex: number;
  readonly name: string | null;
  readonly row: RouterDestinationRow | undefined;
  readonly columns: readonly RoutesSheetColumn[];
  readonly labels: ReadonlyMap<number, string | null>;
  readonly editable: boolean;
  readonly overlay: Overlay;
  readonly overlayRevision: string;
}

const RoutesSheetRow = memo(
  function RoutesSheetRow({
    address,
    rowIndex,
    name,
    row,
    columns,
    labels,
    editable,
    overlay,
  }: RoutesSheetRowProps): React.JSX.Element {
    return (
      <tr role="row" aria-rowindex={rowIndex}>
        <th role="rowheader" scope="row" className="router-sheet-gutter">
          {address}
        </th>
        <th
          role="rowheader"
          className="router-sheet-name"
          title={name ?? undefined}
        >
          {name ?? ""}
        </th>
        {columns.map((column) => {
          const cell = routesSheetCell(
            column,
            (level) => row?.routes.get(level),
            (level) => overlay(address, level),
          );
          return (
            <td
              key={column.id}
              role="gridcell"
              aria-readonly={!editable || cell.kind === "unknown"}
              data-hubble-row={String(address)}
              data-hubble-column={column.id}
              data-route-phase={cell.phase ?? undefined}
              data-route-kind={cell.kind}
            >
              <RouteCellText
                cell={cell}
                label={
                  cell.kind === "source"
                    ? (labels.get(cell.source) ?? null)
                    : null
                }
              />
            </td>
          );
        })}
      </tr>
    );
  },
  (previous, next) =>
    previous.row === next.row &&
    previous.overlayRevision === next.overlayRevision &&
    previous.labels === next.labels &&
    previous.columns === next.columns &&
    previous.editable === next.editable &&
    previous.name === next.name &&
    previous.address === next.address &&
    previous.rowIndex === next.rowIndex,
);

function RouteCellText({
  cell,
  label,
}: {
  readonly cell: ReturnType<typeof routesSheetCell>;
  readonly label: string | null;
}): React.JSX.Element {
  if (cell.kind === "unknown") return <>—</>;
  if (cell.kind === "mixed") return <>Mixed</>;
  return (
    <>
      <span className="router-sheet-number">{cell.source}</span> {label ?? ""}
    </>
  );
}
