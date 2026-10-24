// A sortable table on TanStack Table v9. Screens pass stable columns (module scope) and their rows.
import {
  type ColumnDef, type RowData, createColumnHelper, createSortedRowModel, rowSortingFeature, sortFn_alphanumeric, sortFn_text, tableFeatures, useTable,
} from '@tanstack/react-table';
import type { ReactNode } from 'react';

export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});

export const columnHelper = <T extends RowData>() => createColumnHelper<typeof features, T>();

// columns mix value types, so the value parameter is `any` (as in the library's own examples)
type Columns<T extends RowData> = ColumnDef<typeof features, T, any>[];

export function DataTable<T extends RowData>({ columns, data, empty, footer }: { columns: Columns<T>; data: T[]; empty?: ReactNode; footer?: ReactNode }) {
  const table = useTable({ features, columns, data });
  const rows = table.getRowModel().rows;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id}>
              {g.headers.map((h) => {
                const sort = h.column.getIsSorted();
                return (
                  <th key={h.id} aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}>
                    {h.isPlaceholder ? null : h.column.getCanSort() ? (
                      <button type="button" className="th-sort" onClick={h.column.getToggleSortingHandler()}>
                        <table.FlexRender header={h} />
                        <span className="sort-mark" aria-hidden>{sort === 'asc' ? '▲' : sort === 'desc' ? '▼' : ''}</span>
                      </button>
                    ) : (
                      <table.FlexRender header={h} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="empty" colSpan={table.getAllLeafColumns().length}>{empty ?? 'Nothing here.'}</td></tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                {r.getAllCells().map((c) => <td key={c.id}><table.FlexRender cell={c} /></td>)}
              </tr>
            ))
          )}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}
