import type { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import {
  ModuleDatasetResponseSchema,
  ModuleDatasetReferenceSchema,
  type ModuleDatasetDescriptor,
} from "@hubble/module-sdk";

/** A package-owned designer picker, composed beside the actual host workbook. */
export function installSourcePicker(
  client: Awaited<ReturnType<typeof connectModuleFrontend>>,
  root: HTMLElement,
  preview: (value: unknown) => void,
) {
  const panel = document.createElement("fieldset");
  panel.innerHTML =
    '<legend>Linked label data</legend><button id="browse">Browse shared data</button><button id="more-sources" hidden>More sources</button><label>Data source <select id="source"></select></label><label>Source sheet <select id="sheet"></select></label><label>Source column <select id="column"></select></label><label>Source row <select id="row"></select></label><button id="more-rows" hidden>More rows</button><button id="link" disabled>Link selected cell</button><button id="preview-link">Preview linked data</button><span id="source-status" role="status"></span>';
  root.append(panel);
  const find = <T extends HTMLElement>(id: string) =>
    panel.querySelector<T>(`#${id}`)!;
  const source = find<HTMLSelectElement>("source"),
    sheet = find<HTMLSelectElement>("sheet"),
    column = find<HTMLSelectElement>("column"),
    row = find<HTMLSelectElement>("row");
  for (const [element, label] of [
    [source, "Data source"],
    [sheet, "Source sheet"],
    [column, "Source column"],
    [row, "Source row"],
  ] as const)
    element.setAttribute("aria-label", label);
  const more = find<HTMLButtonElement>("more-sources"),
    moreRows = find<HTMLButtonElement>("more-rows"),
    link = find<HTMLButtonElement>("link");
  let sources: ModuleDatasetDescriptor[] = [],
    cursor: { revision: string; offset: number } | null = null;
  let nextRow: string | null = null,
    revision: string | null = null,
    query = 0;
  const status = find("source-status");
  const run = (action: () => Promise<void>) => {
    void action().catch((error) => {
      status.textContent =
        error instanceof Error ? error.message : "Source unavailable";
    });
  };
  const selected = () => sources[Number(source.value)];
  const rows = async (append = false) => {
    const generation = ++query,
      dataset = selected();
    if (!dataset || !sheet.value) return;
    link.disabled = true;
    if (!append) {
      row.replaceChildren();
      nextRow = null;
      revision = null;
    }
    const result = ModuleDatasetResponseSchema.parse(
      await client.call("source-rows", {
        source: dataset.source,
        sheetId: sheet.value,
        version: dataset.version,
        revision,
        afterRowId: nextRow,
        limit: 25,
      }),
    );
    if (generation !== query) return;
    if (result.status !== "data")
      throw new Error(
        `Source unavailable: ${result.status === "unavailable" ? result.reason : result.status}; browse again`,
      );
    for (const item of result.rows)
      row.add(
        new Option(
          `${item.id}: ${String(item.values[column.value] ?? "")}`,
          item.id,
        ),
      );
    nextRow = result.nextRowId;
    revision = result.dataset.revision;
    moreRows.hidden = !nextRow;
    link.disabled = !row.value || !column.value;
    status.textContent = `${row.options.length} rows loaded`;
  };
  const sheets = async () => {
    column.replaceChildren();
    for (const item of selected()?.sheets.find(
      (item) => item.id === sheet.value,
    )?.columns ?? [])
      column.add(new Option(item.label, item.id));
    await rows();
  };
  const selectSource = async () => {
    sheet.replaceChildren();
    for (const item of selected()?.sheets ?? [])
      sheet.add(new Option(item.label, item.id));
    await sheets();
  };
  const browse = async (append = false) => {
    const result = ModuleDatasetResponseSchema.parse(
      await client.call("sources", {
        cursor: append ? cursor : null,
        limit: 25,
      }),
    );
    if (result.status !== "catalog")
      throw new Error("Source list changed; browse again");
    if (!append) {
      sources = [];
      source.replaceChildren();
    }
    for (const item of result.sources) {
      const option = new Option(item.label, String(sources.length));
      option.disabled = !item.available;
      sources.push(item);
      source.add(option);
    }
    cursor = result.nextCursor;
    more.hidden = !cursor;
    if (!append) {
      source.value = String(sources.findIndex((item) => item.available));
      await selectSource();
    }
  };
  find<HTMLButtonElement>("browse").onclick = () => run(() => browse());
  more.onclick = () => run(() => browse(true));
  moreRows.onclick = () => run(() => rows(true));
  source.onchange = () => run(selectSource);
  sheet.onchange = () => run(sheets);
  column.onchange = () => run(() => rows());
  link.onclick = () =>
    run(async () => {
      const dataset = selected();
      if (!dataset) return;
      const reference = ModuleDatasetReferenceSchema.parse({
        kind: "hubble-dataset-reference",
        formatVersion: 1,
        source: dataset.source,
        schemaVersion: dataset.version,
        sheetId: sheet.value,
        columnIds: [column.value],
        rowIds: [row.value],
      });
      preview(await client.call("link-source", reference));
      status.textContent = "Source cell saved";
    });
  find<HTMLButtonElement>("preview-link").onclick = () =>
    run(async () => preview(await client.call("preview-linked", null)));
}
